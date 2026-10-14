// KEJ-72 requirements, not cached pass claims. HW-09-01 remains the original pilot.
export const specification = { id: 'hearwise-import-protocol', version: '1.0', registryVersion: 1 };
const shared = {
  group: 'HW-09', version: 1, issues: ['KEJ-72'], evidenceStatus: 'not_run',
  preconditions: 'Valid schema-compatible synthetic backup, idle runtime, real HTTP server and SQLite. Provider endpoints are local counting stubs.',
  assumptions: 'Finite domain only: one/two uploaded tokens, two preview generations, two external writes, one restart and one post-write fault. The synchronous commit critical section is atomic at the JavaScript task boundary; cleanup is a stutter.',
  owners: ['Implementation maintainer: HTTP/storage projection', 'Verification maintainer: model and replay', 'Release reviewer: exact source and completed evidence'],
  implementation: ['server.mjs', 'data-transfer.mjs', 'public/app.js'],
  assets: ['verification/import-protocol/protocol.qnt', 'verification/import-protocol/witnesses.qnt', 'test-support/import-protocol-adapter.mjs', 'test/import-protocol-http.test.mjs'],
  invalidatedBy: ['Token, TTL, preview, revision, import or restart semantics change', 'Model, projection, fixtures, toolchain or configured bounds change'],
  gaps: ['No unbounded/liveness proof, real-time deadline guarantee or fairness assumption', 'Row-copy crash atomicity is KEJ-73; the injected rollback check here is a protocol boundary witness']
};
export const properties = [
  { ...shared, id: 'HW-09-02', title: 'Token qualification and single consumption',
    requirement: 'Mode, preview generation, process lifetime and expiry must qualify a commit. A consumed token cannot commit again; expiry uses the original timer without preview renewal.',
    consequence: 'An old confirmation could import a different preview or repeat a destructive operation.',
    state: 'Public HTTP status/code, client-held preview metadata and persisted listening IDs; internal token state remains model-only.',
    domain: 'Complete declared finite domains plus actual callback, process death, replay and concurrent duplicate HTTP witnesses.',
    methods: ['tlc-finite-complete', 'apalache-bounded', 'itf-real-http-sqlite-replay'], acceptance: ['KEJ-72 token/mode/expiry/replay/restart'],
    modelInvariants: ['expiryBound', 'modeBound', 'generationBound', 'restartBound', 'singleConsumption'],
    deterministicWitnesses: ['expiredCommitTest', 'previewDoesNotRenewExpiryTest', 'duplicateAppendTest', 'restartCommitTest'] },
  { ...shared, id: 'HW-09-03', title: 'Mandatory stored revision and explicit recovery',
    requirement: 'Same-connection and other-connection child edits invalidate an old preview. The HTTP path always passes its stored revision. Rejected commits preserve business rows; a refreshed preview permits explicit retry.',
    consequence: 'A stale confirmation could overwrite data created after review.',
    state: 'Real total_changes/data_version effects observed through HTTP rejection, all-table/schema snapshots and import results.',
    domain: 'Both append/replace, two-token invalidation, real post-write COMMIT fault and actual HTTP revision-omission mutant.',
    methods: ['tlc-finite-complete', 'apalache-bounded', 'itf-real-http-sqlite-replay', 'real-server-source-mutation'],
    acceptance: ['KEJ-72 same/other connection revision', 'KEJ-72 HTTP required revision', 'KEJ-72 controlled commit'],
    modelInvariants: ['versionBound', 'refusedCommitUnchanged', 'successfulCommitResult'],
    deterministicWitnesses: ['sameConnectionStaleTest', 'staleOtherConnectionTest', 'appendThenReplaceRecoveryTest'] },
  { ...shared, id: 'HW-09-04', title: 'Imported unfinished work stays stopped',
    requirement: 'Append/restore and subsequent process restart must not automatically send imported unfinished translation, extraction, relation or edit work to providers.',
    consequence: 'Import could silently resume paid work or mutate imported evidence.',
    state: 'Persisted failed/cancelled/paused job states and actual local HTTP/WebSocket provider request counts.',
    domain: 'Both import modes, real unfinished backup and genuine process restart.',
    methods: ['real-http-sqlite-regression'], acceptance: ['KEJ-72 no automatic provider calls'], modelInvariants: [], deterministicWitnesses: [] },
  { ...shared, id: 'HW-09-05', title: 'Browser requires a new explicit confirmation',
    requirement: 'Stale commit refreshes the review without retrying automatically; only another explicit confirmation may commit. Expired token requires a fresh upload.',
    consequence: 'UI refresh could silently turn a rejected action into a destructive import.',
    state: 'Actual Chromium controls/dialogs, HTTP requests, persisted rows and provider calls.',
    domain: 'Desktop/mobile real browser acceptance, append and replace.',
    methods: ['chromium-real-http-sqlite'], acceptance: ['KEJ-72 stale browser re-preview/confirm'],
    modelInvariants: [], deterministicWitnesses: [], gaps: [...shared.gaps, 'Not established by the formal/Node-only report; requires the separate browser report.'] }
];
