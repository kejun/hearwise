import test from 'node:test';
import assert from 'node:assert/strict';
import { testExecutionPlan } from '../scripts/lib/test-schedule.mjs';
import { validateNodeTestSchedule } from '../scripts/lib/node-test-evidence.mjs';
const time = offset => new Date(Date.UTC(2026, 9, 14) + offset).toISOString();
const row = (file, start, end) => ({ file, scheduling: testExecutionPlan(file), startedAt: time(start), finishedAt: time(end), durationMs: end - start, timedOut: false });
const files = ['test/ordinary-a.test.mjs', 'test/ordinary-b.test.mjs', 'test/session-evidence.test.mjs', 'test/ordinary-c.test.mjs'];
const fixture = () => [row(files[1], 0, 8), row(files[0], 0, 10), row(files[2], 10, 100010), row(files[3], 100010, 100020)];
test('observed Node schedule accepts completion ordering, exclusive barriers and actual shared long-profile budgets', () => {
  assert.equal(validateNodeTestSchedule(fixture(), files), true);
  assert.equal(fixture()[2].scheduling.timeoutMs, 190000);
});
for (const [name, mutate] of [
  ['missing plan', rows => { delete rows[0].scheduling; }],
  ['uniform 90s budget for nested profile', rows => { rows[2].scheduling.timeoutMs = 90000; }],
  ['wrong exclusive flag', rows => { rows[2].scheduling.exclusive = false; }],
  ['missing timestamp', rows => { delete rows[0].startedAt; }],
  ['invalid timestamp', rows => { rows[0].finishedAt = 'not a time'; }],
  ['reversed interval', rows => { rows[0].startedAt = time(9); }],
  ['duration outside reported interval', rows => { rows[0].durationMs++; }],
  ['negative duration', rows => { rows[0].durationMs = -1; }],
  ['exclusive overlap despite correct flags', rows => { rows[2].startedAt = time(9); rows[2].durationMs++; }],
  ['later work before exclusive drain despite correct flags', rows => { rows[3].startedAt = time(100009); rows[3].durationMs++; }],
  ['reordered exclusive barrier without overlap', rows => { rows[3].startedAt = time(-100); rows[3].finishedAt = time(-90); }],
  ['successful file beyond watchdog', rows => { rows[2].finishedAt = time(200010); rows[2].durationMs = 200000; rows[3].startedAt = time(200010); rows[3].finishedAt = time(200020); }],
  ['missing file', rows => { rows.pop(); }],
  ['duplicate file', rows => { rows[0] = rows[1]; }]
]) test(`observed Node schedule rejects ${name}`, () => {
  const rows = fixture(); mutate(rows); assert.throws(() => validateNodeTestSchedule(rows, files));
});
test('observed ordinary intervals cannot exceed four simultaneous workers', () => {
  const files = Array.from({ length: 5 }, (_, index) => `test/ordinary-${index}.test.mjs`);
  const rows = files.map(file => row(file, 0, 10));
  assert.throws(() => validateNodeTestSchedule(rows, files), /test_concurrency_exceeded/);
  rows[4] = row(files[4], 10, 20); assert.equal(validateNodeTestSchedule(rows, files), true);
});
