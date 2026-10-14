import { isDeepStrictEqual } from 'node:util';
import { knowledgeRevision } from '../../knowledge-revision.mjs';

const names = ['Deebo', 'Tibo', 'Mira'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const overridden = snapshot => snapshot.item.name_override != null || snapshot.item.name_override_identity != null;
function validSnapshot(value) {
  return record(value) && record(value.item) && uuid(value.item.id) && uuid(value.item.listening_id) &&
    names.includes(value.item.canonical_name) && ['aliases', 'mentions', 'revisions', 'facts'].every(key => Array.isArray(value.item[key])) &&
    Array.isArray(value.segments) && value.segments.length > 0 && value.segments.every(segment => record(segment) && uuid(segment.id) &&
      segment.listening_id === value.item.listening_id && typeof segment.original_text === 'string') &&
    value.revisionVersion === 1 && hash(value.revision) && knowledgeRevision(value) === value.revision;
}

// Recheck minimum recorded HTTP/SQLite facts independently of the adapter's
// cached durableViolations. This is evidence consistency, not authentication of
// arbitrary fabricated files or another proof of the production revision codec.
export function validEditDurableEnvelope(observation, config) {
  try {
    const { actual: state, durable: raw } = observation;
    if (!record(state) || !record(raw) || raw.providerCalls !== 0 || !validSnapshot(raw.snapshot) ||
        !Array.isArray(raw.versions) || !raw.versions.every(hash) || new Set(raw.versions).size !== raw.versions.length ||
        raw.versions.length !== state.revision + 1 || raw.versions[state.revision] !== raw.snapshot.revision ||
        raw.snapshot.item.canonical_name !== names[state.name] || overridden(raw.snapshot) !== state.override ||
        !Array.isArray(raw.clients) || raw.clients.length !== config.clients || !Array.isArray(raw.jobs) || !Array.isArray(raw.events) ||
        !record(raw.graph) || raw.graph.listeningId !== raw.snapshot.item.listening_id ||
        !['nodes', 'relations', 'assertions', 'supports', 'revisions', 'deletedItemIds'].every(key => Array.isArray(raw.graph[key]))) return false;
    const node = raw.graph.nodes.filter(value => value?.id === raw.snapshot.item.id);
    if (node.length !== 1 || node[0].canonical_name !== raw.snapshot.item.canonical_name || overridden({ item: node[0] }) !== state.override) return false;
    if (raw.jobs.some(job => !record(job) || !uuid(job.id) || !hash(job.revision) || job.state !== 'succeeded' ||
      !names.includes(job.name) || !names.includes(job.source)) || new Set(raw.jobs.map(job => job.id)).size !== raw.jobs.length) return false;
    return true;
  } catch { return false; }
}

export function validMatchedEditDurable(observation, config) {
  try {
    if (!validEditDurableEnvelope(observation, config)) return false;
    const { actual: state, durable: raw } = observation;
    const expectedJobs = [];
    for (const [actor, client] of raw.clients.entries()) {
      if (!record(client) || client.actor !== actor || client.codec !== config.codecs[actor] || client.phase !== state.phase[actor] ||
          client.requests !== state.requests[actor] || client.userSaves !== state.userSaves[actor] || client.requests > client.userSaves ||
          !Number.isSafeInteger(client.lookups) || client.lookups < 0 || !Array.isArray(client.jobs) || client.jobs.length !== client.requests ||
          !client.jobs.every(uuid) || new Set(client.jobs).size !== client.jobs.length) return false;
      for (const field of ['loaded', 'submitted']) {
        const ordinal = state[field + 'Revision'][actor], token = client[field + 'Token'];
        if (ordinal === -1 ? token !== null : !hash(token) || client.codec === 'v1' && token !== raw.versions[ordinal]) return false;
      }
      if (client.requests === 0 ? client.actualRequest !== null : !isDeepStrictEqual(client.actualRequest,
        { name: names[state.submittedName[actor]], revision: client.submittedToken })) return false;
      const id = client.jobs.at(-1), jobs = raw.jobs.filter(job => job.id === id), committed = state.txResult[actor] === 'committed';
      if ((state.receipt[actor] === 'succeeded') !== committed || jobs.length !== (committed ? 1 : 0)) return false;
      if (committed) {
        expectedJobs.push(id);
        if (jobs[0].revision !== client.submittedToken || jobs[0].name !== names[state.submittedName[actor]]) return false;
      }
      const transactions = raw.events.filter(event => event.actor === actor && event.action === 'transaction');
      if (transactions.length !== (state.txResult[actor] === 'none' ? 0 : 1)) return false;
      if (transactions.length) {
        const checkpoint = transactions[0].checkpoint;
        if (!validSnapshot(checkpoint?.before) || !validSnapshot(checkpoint?.after) ||
            checkpoint.before.revision !== raw.versions[state.commitBaseRevision[actor]] ||
            overridden(checkpoint.before) !== state.commitBaseOverride[actor] || !raw.versions.includes(checkpoint.after.revision)) return false;
        if (committed) {
          if (checkpoint.error || checkpoint.after.item.canonical_name !== names[state.submittedName[actor]] ||
              checkpoint.result?.job?.id !== id || checkpoint.result.job.state !== 'succeeded' || checkpoint.result.job.saved !== true ||
              checkpoint.result.job.name !== jobs[0].name || checkpoint.result.job.source !== jobs[0].source) return false;
        } else if (!isDeepStrictEqual(checkpoint.before, checkpoint.after) || !checkpoint.error ||
          (state.txResult[actor] === 'conflict' ? checkpoint.error.code !== 'KNOWLEDGE_EDIT_STALE' : checkpoint.error.code === 'KNOWLEDGE_EDIT_STALE')) return false;
      }
      const notifications = raw.events.filter(event => event.actor === actor && event.action === 'notify');
      if (notifications.length !== (['ok', 'fail'].includes(state.notification[actor]) ? 1 : 0) ||
          notifications.some(event => event.checkpoint?.outcome !== state.notification[actor])) return false;
      if (state.txResult[actor] === 'none' || state.serverOwner === actor) {
        if (client.actualResponse !== null) return false;
      } else {
        const response = client.actualResponse;
        if (!record(response) || typeof response.text !== 'string') return false;
        const body = JSON.parse(response.text);
        if (committed ? response.status !== 200 || body.job?.id !== id || body.job.state !== 'succeeded' || body.job.saved !== true ||
            body.job.name !== jobs[0].name || body.job.source !== jobs[0].source :
          state.txResult[actor] === 'conflict' ? response.status !== 409 || body.code !== 'KNOWLEDGE_EDIT_STALE' || body.saved !== false ||
            body.revision !== raw.versions[state.commitBaseRevision[actor]] :
          response.status !== 502 || body.code !== 'KNOWLEDGE_EDIT_FAILED' || body.saved !== false) return false;
      }
    }
    return isDeepStrictEqual(raw.jobs.map(job => job.id).sort(), expectedJobs.sort());
  } catch { return false; }
}
