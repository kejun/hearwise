# KEJ-85 continuous user journey verification

Status: the collector and strict raw reader are integrated in main
`4631de0100d554ad9715cfdff2a1159156516e57`, including KEJ-66 generation and KEJ-83
upgrade checks. The implementation started on `f826319cf2b0cac0326a83c60caa2f656024b4fc`;
that historical source is not evidence for a later candidate. Real Chromium CI and
independent review must be checked for the exact candidate SHA. Node fixture checks
alone do not establish browser acceptance. This work does not include the unpublished
performance or Trace changes from GitHub PR #85 (a different issue from KEJ-85).

## Requirement and reuse boundary

The existing KEJ-85 ticket requires one repeatable user journey on a real server
and temporary SQLite: listening, source/translation, knowledge/graph, correction,
playback, history, export and import. It also requires conflict/uncertain-save,
cancelled late delivery, stale import review, seek, keyboard/focus and narrow-screen
recovery. Its dependencies are KEJ-66, 71, 73, 74, 75 and 76. All are integrated at the baseline above; integration does not replace current-source evidence.

Existing per-feature browser programs create separate fixtures. Calling them in
sequence is useful regression coverage but does not establish this journey.
Use the existing `speechFixture`, `relationWireEnvelope`/`relationWireRow`, native
read-only `databaseSnapshot`, import `Response.clone` observer and lifecycle
helpers. Use the existing browser runner and KEJ-86's integrated strict thin release
reader. Do not introduce a second application, production debug API or a large
cross-product model.

## One continuous happy path, at 1280 and 390 pixels

Each width starts with an empty real database and one fresh browser context. Its
main listening is created by the actual Start button, not a seeded business row.

1. Configure the synthetic provider key through Settings. Focus Start and press
   Enter. Capture the real `/ws` listening-ready identity and actual audio frames.
2. Deliver two named ASR final sentences through the supplier WebSocket. Wait for
   matching persisted final translations and visible source/translation text.
   Supplier knowledge proposals refer only to IDs/text from the actual prompt.
3. Stop using the UI and wait for the run and extraction jobs to reach their real
   durable terminal states. Open knowledge cards and the graph with UI controls.
   Start relationship generation through the public graph button and check two
   exact nodes, one authored relation, evidence and actual request budget.
4. Open the real name editor, preserve its item ID, save a correction using Enter,
   and compare the receipt, SQLite source/facts/anchors, list, details and graph.
   Verify unrelated records remain unchanged. Do not rewrite expected source
   text to match an unexpected observed result. Existing translation intentionally
   remains unchanged after a name correction; source and translation playback
   therefore have separately authored expectations.
5. Start full original and translated speech using UI controls. Observe actual
   transport and worklet consumption, pause, seek through the public transcript
   control, assert paused state is retained, then resume. The authored normalized
   text ledger and actual consumed frames establish what was played.
6. Visit history and reopen the same listening by its displayed title/identity.
   Close the browser context and reopen the page with a new context; compare
   visible text, public detail/graph responses and a new read-only SQLite snapshot.
7. Export using the data-settings download button. Save the browser's downloaded
   SQLite file, its hash and a read-only business projection; do not replace this
   step with a direct export API call.
8. Delete the archived main record using the actual history control and explicit
   confirmation, then upload that exact downloaded backup through the file input.
   Preview and explicitly confirm append; verify the same identities and complete
   business contents are restored. This is an explicit user import, not automatic
   resurrection after deletion. Reopen history/details/graph and compare again.

HTTP GET and SQLite reads are independent assertions. Public HTTP writes may be
used only for explicitly identified competing actors or fault setup, never as a
substitute for the main user's UI transitions. Prefer a second real page for
competing edits so the competing mutation is also user reachable.

## Cross-feature failure/recovery branches

- **Conflict:** two pages open one revision. The first saves through UI; the stale
  page receives 409, retains its draft, shows current content and sends no hidden
  second POST. Explicit user confirmation/reopen permits recovery.
- **Uncertain save:** allow the actual POST to commit, then replace only its
  transport response with 502. Cover receipt recovery and separately unavailable
  receipt. Preserve actual upstream response, idempotency ID, request body,
  visible draft/status, disabled controls and full persisted checkpoint. Close
  and reopen explicitly; verify list/detail/graph synchronize with stored data.
- **Cancel/late:** exercise public graph Cancel and listening Stop/Delete with a
  named held supplier operation. Separate physical provider completion from
  delivery actually observed by the application. New legitimate work must finish
  while the obsolete operation remains held. Late data must not alter current
  identity, content or budget. Attach same-target KEJ-66 generation evidence; do not claim a disconnected HTTP response traversed a callback.
- **Stale import review:** upload the actual journey export, then perform a real
  UI edit in the other page before confirm. The stale attempt must not write;
  refresh/review and a second explicit confirmation are recorded independently.
  Append collisions preserve the full changed local record, not only its title.
- **Playback:** pause/seek/reopen are checked using the live production controller
  and worklet. Refer to KEJ-75's same-target generation/late-frame evidence rather
  than describing an injected duplicate Promise resolve as another callback.

The implemented public cancellation scenario and owner projection are described
below. Same-target KEJ-66 evidence remains independently required; the HTTP
journey does not establish delivery of an obsolete runtime callback.

## Evidence and negative controls

The independent cards `HW-11-06` through `HW-11-10` cover continuous identity/content,
conflict/uncertainty recovery, cancellation/deletion continuation, migration
continuity, and keyboard/focus/narrow-screen usability. Existing HW-11-02 through
05 remain separately owned. The fixed roster and each raw contract require independent review.

Record each real UI action, exact required stage sequence, browser URL/context and
listening/item IDs, relevant wire request/response, provider invocation/delivery,
read-only SQLite checkpoint, public queries and visible UI projection. Preserve
downloaded backup hash and body, screenshots and failure DOM/status. Source and
served/build hashes, tool/environment versions, start/end times, outer/inner
exit results and bounded cleanup are mandatory. Do not persist credentials or
import capability tokens; retain only their hashes when correlation is needed.

The gate reconstructs expected contents from raw source/SQLite/wire data. It must
reject skipped/reordered stages, mismatched IDs, fabricated summaries, changed
backup, missing screenshots, absent browser results, wrong source, timeout and
incomplete cleanup. A small isolated source variant that omits the actual
post-save view refresh can demonstrate that stale UI with correctly committed
SQLite is rejected; retain original and mutated source hashes and a unique
replacement anchor. If another refresh path masks it, report no effect rather
than declaring a caught negative.

Use fixed stage deadlines with bounded collection/cleanup and existing subprocess
supervision. Measure actual CI cost before freezing the profile; do not increase
old product/model deadlines to make it pass. Node-only preparation cannot mark a
browser property passed. Real provider quality, real audio/device and performance
reports are separate referenced acceptance items and may remain not_run.

## Running the fixed profile

- `npm run verify:user-journey` builds and runs the actual Chromium collector.
- `node scripts/verify-user-journey-browser.mjs --release` enforces clean candidate
  provenance in addition to the raw checks. Build the final candidate first.
- `npm run test:browser -- user-journey` invokes it through the existing bounded
  browser runner. It is a mandatory part of the default aggregate roster.
- `node scripts/verify-user-journey-browser.mjs --node-only` deliberately does not
  start Chromium. It returns nonzero/not_run and cannot count as UI acceptance.
- `node --test test/user-journey-fixture.test.mjs` checks the empty upstream fixture,
  separate actual focus batches, and held-HTTP cancellation/continuation only.

`USER_JOURNEY_EVIDENCE_DIR` selects the artifact root. Each unique nested directory
contains `report.json`, raw `browser.json`, process/server logs, every required
stage PNG, and both actual browser-downloaded SQLite backups per viewport. The
parent retains the existing 180-second profile watchdog; the journey child has
140 seconds and its wrapper 150 seconds. No existing deadline is increased.

The fixed 35-stage sequence starts in an empty store at 1280 and 390 pixels. Each
width creates its main listening and an unrelated listening via actual microphone
UI/ASR. The unrelated record contains the same original name, so a main name edit
must preserve every descendant of that unrelated record. The initial UI export
contains both records. Deleting the unrelated record permits a real append with
one added and one skipped ID. A competing UI metadata edit invalidates its review;
the first explicit import returns 409. Delivering the existing production import
expiry callback then makes a second explicit attempt return 410. Re-uploading the
same downloaded bytes and explicitly confirming again restores the auxiliary
record while preserving the complete changed main record. A fresh actual export,
UI main deletion and explicit append restores the main identity/content.

The existing import Response.clone observer optionally hashes the actual immutable
File passed to fetch, without waiting before calling the original fetch. The raw
reader binds that observed hash/size/name, upload request, explicit confirmation,
HTTP response, local SQLite checkpoint, and saved download bytes. Missing Chromium
inspector upload bodies are not filled from expected local file contents.
When Chromium omits page-level download requests, the existing isolated server
response observer records the actual export stream's hash, byte count and three
download headers. These must match the real Download URL, suggested filename,
UI action, saved backup bytes and SQLite contents; no page HTTP event is invented.
The fetch URL, method and ordinal must match that document's HTTP requests;
closing settings after a successful import reloads the document and resets those
ordinals. An old-document response cannot borrow the next document's clone ledger.
Rendered graph relations include the actual relation ID, visible text and
accessible label, all checked against the stored edge and current node names.
Graph reads also retain real fetch/AbortSignal observations. A cancelled GET is
not a successful response: accepting intentional supersession requires the actual
production loader-stop stack, a bounded abort time and a successful same-document
replacement bound to the subsequent durable/UI checkpoint. A network abort or
the graph loader's ten-second timeout alone cannot satisfy that contract.

The graph cancellation case holds the real supplier HTTP response while a new
legitimate round completes on the same listening. Releasing the old supplier
leaves the complete database unchanged. The artifact distinguishes the provider's
physical return from the earlier disconnected transport. It does not assert that
the cancelled HTTP callback was delivered to the app. KEJ-66's same-source raw
runtime callback/model evidence and KEJ-75's independent playback generation
profile remain required for their broader claims.

A production editor source copy with exactly the post-save onSaved refresh omitted
runs in a final page on the same store. Its true database name change and stale
visible card must disagree; the strict validator checks the complete legitimate
name transaction as well as the visible mismatch. An unrelated corruption cannot
be classified as that targeted negative control.

All code, build, raw-response, PNG, backup-byte, subprocess, timing and cleanup
bindings are re-read by the existing release aggregate via its thin nested adapter.
Each diagnostic and each resource close is attempted independently, including on
failure. Unrun real provider quality, physical device and performance checks remain
not_run. A passing synthetic journey never clears those external acceptance items.

The local cloud Chromium sandbox has already denied startup. Do not retry with
weaker security flags or use an unauthorized offline user computer. Actual browser
evidence must come from the supported GitHub CI environment for the final source.
