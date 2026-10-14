// Requirements and scope only; these are never substitutes for run evidence.
export const properties = [
  { id: 'HW-06-06', version: 1, title: 'Concurrent revision check and atomic save',
    requirement: 'Check the submitted current/frozen-compatible revision inside the actual SQLite transaction. Stale submissions and mid-transaction failure preserve all business records and receipts. Refresh never resends a write automatically.',
    implementation: ['knowledge-name-replacement.mjs:replaceKnowledgeName', 'knowledge-revision.mjs:assertKnowledgeRevision', 'storage.mjs:tx', 'public/knowledge-editor.js:refreshStale'],
    invariants: ['revisionCheckedInTransaction', 'noAutomaticOverwrite', 'receiptAtomic'],
    witnesses: ['sameRevisionConflictTest', 'backgroundConflictTest', 'rollbackTest', 'noOpTest', 'legacyConcurrentConflictTest', 'legacyV12SuccessTest', 'legacyV11OverrideRejectedTest'],
    negativeControls: ['bypass_revision', 'auto_revision_resend'], additionalRequiredEvidence: ['Actual-browser conflict, explicit subsequent user save, and automatic-resend mutant'],
    domain: 'One logical knowledge item, two clients each saving at most once, v1/v1 or v11/v12; one v11-with-override rejection configuration; one optional background translation completion.', evidenceStatus: 'not_run' },
  { id: 'HW-06-07', version: 1, title: 'Uncertain save and late response recovery',
    requirement: 'A committed receipt remains successful after notification failure. Lost or proxy-502 responses do not imply rollback; read-only receipt recovery or reopen observes actual persistence. A late successful response triggers a fresh read, never replaying old response data over a newer save.',
    implementation: ['server.mjs:name-replacements route', 'server.mjs:notifyNameCorrection', 'public/knowledge-editor.js:save', 'public/knowledge-editor.js:readKnowledgeEditorResponse'],
    invariants: ['honestSaveResult', 'draftRetained', 'currentRead', 'noAutomaticOverwrite'],
    witnesses: ['successTest', 'notificationFailureTest', 'lostResponseReceiptRecoveryTest', 'proxy502UnknownReopenTest', 'failedUnknownReopenTest', 'lateSuccessReadsLatestTest'],
    negativeControls: [], additionalRequiredEvidence: ['Actual-browser proxy failure, failed receipt read, and late response'],
    domain: 'Delayed delivery of a real completed HTTP response; aborted fetches never produce a later client callback. Server transaction and notification are distinct, synchronous ordered checkpoints.', evidenceStatus: 'not_run' },
  { id: 'HW-11-04', version: 1, title: 'Failed draft and recoverable editor interaction',
    requirement: 'Failure/uncertainty keeps current input and explains verification. Closing and reopening observes actual stored data. Manual POST busy state disallows close/Escape; closing an idle draft cancels without writes.',
    implementation: ['public/knowledge-editor.js:createKnowledgeEditor'],
    invariants: ['draftRetained', 'currentRead', 'closedPhase'],
    witnesses: ['cancelledDraftTest', 'rollbackTest', 'proxy502UnknownReopenTest'], negativeControls: [],
    additionalRequiredEvidence: ['Real Chromium controls, draft contents, status text, close/reopen, focus and usable subsequent action'],
    domain: 'Formal client state is a protocol abstraction; HTTP replay is not browser interaction evidence. No persistent local-draft storage or liveness claim.', evidenceStatus: 'not_run' }
];
