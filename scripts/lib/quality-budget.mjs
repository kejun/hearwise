import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;

// Evaluation-only ledger. Reservation is committed before the caller opens an
// upstream connection. An ambiguous, failed or cancelled attempt is never refunded.
export function openQualityBudget(filename, config, freezeDigest) {
  config = structuredClone(config);
  if (!config || !config.id || !['CNY', 'USD'].includes(config.currency) || !positive(config.ceilingMicros) ||
      !['asr', 'mt'].every(kind => positive(config.maxAttempts?.[kind]) && positive(config.attemptMicros?.[kind])) ||
      (config.expiresAt !== undefined && !Number.isFinite(Date.parse(config.expiresAt))) ||
      !/^[a-f0-9]{64}$/.test(freezeDigest)) throw new Error('INVALID_BUDGET');
  const binding = digest({ config, freezeDigest }), db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec('CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, trial_id TEXT NOT NULL, reserved_micros INTEGER NOT NULL, reserved_at TEXT NOT NULL, observation_json TEXT)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT digest FROM binding WHERE id=1').get();
      if (previous && previous.digest !== binding) throw new Error('BUDGET_BINDING_CHANGED');
      if (!previous) db.prepare('INSERT INTO binding VALUES(1,?)').run(binding);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db.close(); throw error; }
  let closed = false;
  return {
    reserve({ kind, trialId }) {
      if (!['asr', 'mt'].includes(kind) || typeof trialId !== 'string' || !trialId) throw new Error('INVALID_ATTEMPT');
      if (config.expiresAt && Date.now() >= Date.parse(config.expiresAt)) throw new Error('BUDGET_APPROVAL_EXPIRED');
      db.exec('BEGIN IMMEDIATE');
      try {
        const total = db.prepare('SELECT COALESCE(SUM(reserved_micros),0) AS amount FROM attempts').get().amount;
        const count = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE kind=?').get(kind).n;
        const trialCount = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE kind=? AND trial_id=?').get(kind, trialId).n;
        if (trialCount >= (kind === 'asr' ? 2 : 1)) throw new Error('TRIAL_ATTEMPT_LIMIT');
        const amount = config.attemptMicros[kind];
        if (count >= config.maxAttempts[kind] || amount > config.ceilingMicros - total) throw new Error('BUDGET_EXHAUSTED');
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
    snapshot() {
      const attempts = db.prepare('SELECT * FROM attempts ORDER BY id').all().map(row => ({ ...row }));
      return { id: config.id, currency: config.currency, binding, freezeDigest, ceilingMicros: config.ceilingMicros,
        reservedMicros: attempts.reduce((sum, row) => sum + row.reserved_micros, 0), attempts };
    },
    close() { if (!closed) { closed = true; db.close(); } }
  };
}
