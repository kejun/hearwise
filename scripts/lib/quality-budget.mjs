import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
function semanticTrialLimits(config) {
  const descriptor = config && Object.getOwnPropertyDescriptor(config, 'trialLimits');
  if (!descriptor) return undefined;
  const invalid = () => { throw new Error('INVALID_BUDGET'); };
  const entries = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')) invalid();
    }
    return keys;
  };
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  const limits = descriptor.value, ids = entries(limits);
  if (!ids.length || ids.length > 16) invalid();
  for (const id of ids) {
    if (id.length > 200 || !/^(?:baseline|candidate):[a-zA-Z0-9][a-zA-Z0-9._:-]*:(?:0|[1-9]\d*)$/.test(id) ||
        !Number.isSafeInteger(Number(id.slice(id.lastIndexOf(':') + 1)))) invalid();
    const kinds = entries(limits[id]);
    if (kinds.length !== 2 || !['knowledge', 'relation'].every(kind => kinds.includes(kind) && positive(limits[id][kind]))) invalid();
  }
  return limits;
}

// Evaluation-only ledger. Reservation is committed before the caller opens an
// upstream connection. An ambiguous, failed or cancelled attempt is never refunded.
export function openQualityBudget(filename, config, freezeDigest) {
  return openBudget(filename, config, freezeDigest, { asr: 2, mt: 1 });
}

// Evaluation-only semantic policy. These explicit bounds must come from the
// future frozen semantic plan; accepting them is not approval or billing proof.
// Reuse the same transactional ledger without inheriting ASR2/MT1 semantics.
export function openSemanticQualityBudget(filename, config, freezeDigest) {
  // Check descriptors before cloning so a batch roster cannot execute getters
  // or hide entries that JSON would omit from the durable binding.
  semanticTrialLimits(config);
  config = structuredClone(config);
  if (!config || !['knowledge', 'relation'].every(kind => positive(config.maxTrialAttempts?.[kind])) ||
      !Number.isFinite(Date.parse(config.expiresAt)) ||
      (config.requireRunClaim !== undefined && config.requireRunClaim !== true)) throw new Error('INVALID_BUDGET');
  if (config.trialLimits && Object.values(config.trialLimits).some(limits =>
    ['knowledge', 'relation'].some(kind => limits[kind] > config.maxTrialAttempts[kind] || limits[kind] > config.maxAttempts?.[kind]))) throw new Error('INVALID_BUDGET');
  // The wrapper forces this flag: omission and any caller key position must
  // produce the same semantic binding, without changing legacy digests.
  delete config.requireRunClaim;
  return openBudget(filename, { ...config, requireRunClaim: true }, freezeDigest,
    { knowledge: config.maxTrialAttempts.knowledge, relation: config.maxTrialAttempts.relation }, 'semantic-v1', config.trialLimits);
}

function openBudget(filename, config, freezeDigest, trialLimits, domain, trialLimitsById) {
  config = structuredClone(config);
  const kinds = Object.keys(trialLimits);
  if (!config || !config.id || !['CNY', 'USD'].includes(config.currency) || !positive(config.ceilingMicros) ||
      !kinds.every(kind => positive(config.maxAttempts?.[kind]) && positive(config.attemptMicros?.[kind])) ||
      (config.expiresAt !== undefined && !Number.isFinite(Date.parse(config.expiresAt))) ||
      (config.requireRunClaim !== undefined && typeof config.requireRunClaim !== 'boolean') ||
      !/^[a-f0-9]{64}$/.test(freezeDigest)) throw new Error('INVALID_BUDGET');
  const binding = digest(domain ? { config, freezeDigest, domain } : { config, freezeDigest }), db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec('CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, trial_id TEXT NOT NULL, reserved_micros INTEGER NOT NULL, reserved_at TEXT NOT NULL, observation_json TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS runs (role TEXT PRIMARY KEY, source_sha TEXT NOT NULL, directory TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT digest FROM binding WHERE id=1').get();
      if (previous && previous.digest !== binding) throw new Error('BUDGET_BINDING_CHANGED');
      if (!previous) db.prepare('INSERT INTO binding VALUES(1,?)').run(binding);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db.close(); throw error; }
  let closed = false;
  const unexpired = () => { if (config.expiresAt && Date.now() >= Date.parse(config.expiresAt)) throw new Error('BUDGET_APPROVAL_EXPIRED'); };
  const snapshot = () => {
    const attempts = db.prepare('SELECT * FROM attempts ORDER BY id').all().map(row => ({ ...row }));
    return { id: config.id, currency: config.currency, binding, freezeDigest, ceilingMicros: config.ceilingMicros,
      reservedMicros: attempts.reduce((sum, row) => sum + row.reserved_micros, 0), attempts, runs: db.prepare('SELECT * FROM runs ORDER BY role').all().map(row => ({ ...row })) };
  };
  return {
    claimRun({ role, sourceSha, directory, expectedSnapshot }) {
      if (!['baseline','candidate'].includes(role) || !/^[a-f0-9]{40}$/.test(sourceSha) || typeof directory !== 'string' || !directory) throw new Error('INVALID_RUN_CLAIM');
      db.exec('BEGIN IMMEDIATE');
      try {
        unexpired(); const current = snapshot();
        if (digest(current) !== digest(expectedSnapshot)) throw new Error('BUDGET_SNAPSHOT_CHANGED');
        if (role === 'baseline' ? current.attempts.length || current.runs.length : current.runs.length !== 1 || current.runs[0].role !== 'baseline' || current.runs[0].state !== 'complete') throw new Error('RUN_ORDER_OR_ALREADY_CLAIMED');
        db.prepare('INSERT INTO runs(role,source_sha,directory,state,started_at) VALUES(?,?,?,?,?)').run(role, sourceSha, directory, 'running', new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    finishRun(role, complete) {
      if (!['baseline','candidate'].includes(role) || typeof complete !== 'boolean') throw new Error('INVALID_RUN_CLAIM');
      const result = db.prepare("UPDATE runs SET state=?,finished_at=? WHERE role=? AND state='running'").run(complete ? 'complete' : 'incomplete', new Date().toISOString(), role);
      if (result.changes !== 1) throw new Error('RUN_CLAIM_MISSING');
    },
    reserve({ kind, trialId }) {
      if (!kinds.includes(kind) || typeof trialId !== 'string' || !trialId) throw new Error('INVALID_ATTEMPT');
      unexpired();
      db.exec('BEGIN IMMEDIATE');
      try {
        unexpired();
        const limit = trialLimitsById ? Object.hasOwn(trialLimitsById, trialId) && trialLimitsById[trialId][kind] : trialLimits[kind];
        if (!positive(limit)) throw new Error('INVALID_ATTEMPT');
        if (config.requireRunClaim && !db.prepare("SELECT 1 FROM runs WHERE role=? AND state='running'").get(trialId.split(':')[0])) throw new Error('RUN_CLAIM_MISSING');
        const total = db.prepare('SELECT COALESCE(SUM(reserved_micros),0) AS amount FROM attempts').get().amount;
        const count = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE kind=?').get(kind).n;
        const trialCount = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE kind=? AND trial_id=?').get(kind, trialId).n;
        if (trialCount >= limit) throw new Error('TRIAL_ATTEMPT_LIMIT');
        const amount = config.attemptMicros[kind];
        if (count >= config.maxAttempts[kind] || amount > config.ceilingMicros - total) throw new Error('BUDGET_EXHAUSTED');
        unexpired();
        const id = Number(db.prepare('INSERT INTO attempts(kind,trial_id,reserved_micros,reserved_at) VALUES(?,?,?,?)').run(kind, trialId, amount, new Date().toISOString()).lastInsertRowid);
        db.exec('COMMIT'); return id;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    observe(id, observation) {
      const value = JSON.stringify(observation);
      if (value.length > 10000) throw new Error('OBSERVATION_LIMIT');
      const result = db.prepare('UPDATE attempts SET observation_json=? WHERE id=?').run(value, id);
      if (result.changes !== 1) throw new Error('UNKNOWN_ATTEMPT');
    },
    snapshot,
    close() { if (!closed) { closed = true; db.close(); } }
  };
}
