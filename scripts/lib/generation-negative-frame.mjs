import { isDeepStrictEqual as equal } from 'node:util';
import { ListeningStore } from '../../storage.mjs';
import { loadRelationCommitGuardVariant } from '../../test-support/generation-commit-variant.mjs';
import { validateGenerationReplayEvidence } from './generation-protocol-evidence.mjs';

const tables = ['listenings', 'listening_runs', 'segments', 'relation_rounds', 'relation_windows', 'relation_jobs', 'relation_requests',
  'knowledge_items', 'knowledge_facts', 'knowledge_aliases', 'knowledge_mentions', 'knowledge_revisions', 'relations', 'relation_assertions', 'relation_supports', 'relation_revisions'];
const json = value => JSON.parse(JSON.stringify(value));
const quote = value => `"${value.replaceAll('"', '""')}"`;
// Re-execute only the frozen old-context transaction in a fresh in-memory copy
// of its independently validated raw input. No live database is opened or edited.
async function transactionFrame(trial, raw, interval) {
  const store = new ListeningStore(':memory:');
  try {
    const triggers = store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    store.db.exec('PRAGMA foreign_keys=OFF');
    for (const row of triggers) store.db.exec(`DROP TRIGGER ${quote(row.name)}`);
    for (const table of tables) {
      const columns = store.db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
      for (const row of trial.before.durable[table]) {
        if (!equal(Object.keys(row).sort(), [...columns].sort())) return false;
        store.db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
      }
    }
    for (const row of triggers) store.db.exec(row.sql);
    store.db.exec('PRAGMA foreign_keys=ON');
    for (const table of tables) if (!equal(json(store.db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all()), trial.before.durable[table])) return false;
    if (store.db.prepare('PRAGMA foreign_key_check').all().length) return false;
    const variant = await loadRelationCommitGuardVariant(), result = variant.commit.call(store, trial.jobId, trial.payload);
    if (!equal(json(result), trial.variant)) return false;
    for (const table of tables) {
      const expected = json(store.db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all()), observed = raw.durable[table];
      if (!Array.isArray(observed) || observed.length !== expected.length) return false;
      for (const [i, row] of expected.entries()) for (const [key, value] of Object.entries(row)) {
        const before = trial.before.durable[table][i];
        if (table === 'relation_revisions' && !before && key === 'id') {
          if (typeof observed[i].id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(observed[i].id) || new Set(observed.map(row => row.id)).size !== observed.length) return false;
          continue;
        }
        // Only fields actually generated/changed by this exact transaction may
        // have another clock value. Pre-existing timestamps stay byte-exact.
        if (['created_at', 'updated_at', 'finished_at'].includes(key) && value !== before?.[key] && value !== null) {
          const actual = observed[i][key], ms = typeof actual === 'number' ? actual : Date.parse(actual);
          if (typeof actual !== typeof value || !Number.isFinite(ms) || ms < Date.parse(interval.startedAt) || ms > Date.parse(interval.finishedAt)) return false;
        } else if (!equal(observed[i][key], value)) return false;
      }
    }
    return true;
  } finally { store.close(); }
}
export async function validateGenerationNegativeFrame(trace, broken, control) {
  const replay = structuredClone(broken), original = replay.observations.at(-1), index = broken.difference.step;
  const changed = structuredClone(trace); changed.steps = changed.steps.slice(0, index + 1);
  const expected = structuredClone(changed.steps.at(-1).expected), raw = original.durable.raw;
  let allowed = [];
  if (control.mutation === 'skip_reservation') {
    expected.reserved[0] = 0;
    if (control.protocol === 'relation') {
      allowed = ['relation_job_identity', 'relation_active_state'];
      const job = raw.durable.relation_jobs[0], call = raw.calls[0];
      if (job.state !== 'pending' || job.request_count !== 0 || call.attempt !== 0 || job.epoch !== 1 || job.listening_id !== call.listeningId) return false;
    }
  } else if (control.mutation === 'corrupt_accepted_fact') {
    allowed = ['accepted_fact'];
    const call = raw.calls[0], fact = raw.durable.facts[0];
    if (raw.durable.facts.length !== 1 || fact.content !== 'Corrupted accepted fact' || fact.surface_text !== call.name ||
      fact.segment_id !== call.input.focus_segments[0].id || fact.certainty !== 'clear' ||
      fact.item_id !== raw.durable.jobs[0].parts[0].results.find(row => row.itemId)?.itemId) return false;
  } else if (control.mutation === 'omit_transaction_guard') {
    allowed = ['usage_action_binding', 'late_callback_changed_persistence', 'late_usage_wrong_attempt'];
    expected.business[0] = [0]; expected.usage[0] = 'response_received';
    const trial = original.durable.boundaryTrials[0];
    if (!await transactionFrame(trial, raw, broken)) return false;
    const call = raw.calls[0], start = trial.before.ledger.length;
    const extra = [
      { event: 'usage_persisted', jobId: call.jobId }, { event: 'usage_persisted', jobId: call.jobId, outcome: 'stale' },
      { event: 'provider_usage', index: call.index, totalTokens: 11 },
      { event: 'workflow_presence_checked', jobId: call.jobId, listeningId: call.listeningId, present: true, error: null },
      { event: 'usage_persisted', jobId: call.jobId, attempt: 1, outcome: 'late_response' },
      { event: 'settlement_barrier', executions: 2, calls: 2 },
      { event: 'usage_persisted', jobId: call.jobId }, { event: 'usage_persisted', jobId: call.jobId, outcome: 'complete' }
    ].map((row, i) => ({ sequence: start + i, ...row }));
    if (!equal(raw.ledger, [...trial.before.ledger, ...extra])) return false;
  } else return false;
  if (!equal(original.actual, expected)) return false;
  changed.steps.at(-1).expected = expected;
  replay.ok = true; replay.classification = 'matched';
  for (const observation of replay.observations) { observation.durable.mutation = 'none'; observation.durable.boundaryTrials = []; observation.durableViolations = []; }
  const checked = validateGenerationReplayEvidence(changed, replay);
  return checked.reasons.every(reason => allowed.includes(reason));
}
