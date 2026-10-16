# Knowledge and relation semantic quality preparation (KEJ-78)

## Delivery status

This stage delivers an executable **offline rehearsal**, not the real semantic
quality acceptance. `HW-05-04` is always `not_run`; `qualityEvaluated`,
`fullQualityAcceptance` and `releaseEligible` are always false. An exit code of
zero from `offline` means the capture/review/evidence plumbing passed.

The evaluation transport boundary is implemented in
`scripts/lib/semantic-quality-gateway.mjs`, but the complete live collector is
still not wired. `collect` and any `--live` request continue to reject before
reading credentials or making requests. The ASR/MT toolkit's fixed attempt
counts must not be reused for this domain; its transactional ledger is shared
through an explicit semantic-domain policy. No production behavior or
database schema changes.

### Domain transport boundary

`createSemanticGateway` exposes separate loopback knowledge/relation endpoints
and a fresh local capability. It forwards the production request bytes unchanged
to one configured endpoint, substituting the upstream credential only there.
Offline mode accepts literal loopback HTTP only; live mode requires explicit
caller authorization, HTTPS, an unexpired configuration, and refuses ordinary
CI. This library's flag is a caller attestation, not evidence of user approval.

Every actual upstream attempt first calls the mandatory `authorize` callback,
then waits for `reserve` to commit a unique worst-case-cost reservation. Both
receive the exact request/hash/domain and an abort signal. The eventual collector
must bind that request to the frozen corpus/model/prompt and actual production
SQLite request reservation. Knowledge split parts, shared extra attempts and
repair counts, and relation window counts remain production-domain obligations;
this transport's total-request cap is not a replacement for them. It neither
borrows ASR/MT counts nor computes or approves semantic billing bounds.

No automatic retry, redirect, refund or arbitrary extra provider option is
allowed. The boundary enforces request/response bytes, overall attempt time,
model identity, request shape and local capability, and cancels upstream work
on disconnect/close. Provider errors preserve status and safe Retry-After but
never relay untrusted error bodies. Successful protocol-invalid content is
retained for the production parser's normal repair behavior. Byte/time caps do
not limit provider token generation or billed work after disconnect: the caller
must reserve a verified official worst-case billing bound before each attempt.

Observations retain request bytes/hash, non-secret successful response bytes/hash,
status, timestamps and reservation identity. They are diagnostic records, not a
validated live quality report or automatically safe public content. Credential
matches are rejected before persistence/forwarding. A late reservation after
cancellation remains recorded and is never forwarded or refunded; a callback
that never settles leaves `reservationStatus=pending`, and a callback failure is
`rejected_or_unknown`. Such uncertainty cannot become complete billing evidence.
Close stays bounded rather than waiting forever on an uncooperative callback.

The new tests use original synthetic text and a loopback provider through the
real knowledge/relation workflows and SQLite, confirming that durable request
reservations precede network access and the resulting entities/assertions are
persisted. They also cover denial, expiry, duplicate reservations, byte limits,
redirects, stalls and cancellation. No real provider has been called. A frozen
semantic plan, verified domain billing bounds, complete paired collection/reader and
human review are still required before enabling the CLI or claiming acceptance.

### Persistent semantic budget

`openSemanticQualityBudget` in `scripts/lib/quality-budget.mjs` reuses the
ASR/MT SQLite transaction and run-claim implementation. It binds a separate
`semantic-v1` policy, frozen-plan digest, explicit knowledge/relation per-trial
and total-attempt limits, per-attempt worst-case costs, currency, total ceiling
and expiry. Baseline must be claimed before reservations; candidate may be
claimed once, only after the baseline is complete. A failed or cancelled
reservation still spends its full bound, including after process restart.
No domain inherits the ASR2/MT1 constants. Existing ASR/MT bindings and defaults
are unchanged, and cross-domain reuse of an existing ledger is rejected.

The transport's reserve callback can return
`String(budget.reserve({ kind: context.kind, trialId }))` after the collector
has authorized the exact request and mapped it to its frozen trial. Tests use
that path with actual loopback HTTP and an independent SQLite connection at
upstream arrival; two independent child processes also race for one budget.
Only one can reserve the final affordable attempt, and a reopened ledger cannot
recover that cost. This adapter does not establish provenance, human approval,
correct trial mapping, production part/window counts, or official provider
billing limits. Those must be verified by the future frozen-plan collector;
passing synthetic numeric bounds to this library does not authorize spending.
The CLI remains disabled and no real model quality is evaluated.

### Frozen same-source paired rehearsal

`paired-offline` now connects the transport, persistent budget and production
knowledge→relation capture in one executable path. Before any output, it freezes
the current source/files, fixed models/contracts, original synthetic `qualified`
and `empty` samples, two repetitions, and synthetic accounting bounds. Both
baseline and candidate deliberately run the same source and fixture recipe;
this checks collection pairing, not model improvement or real quality.

A baseline claim must complete before candidate starts. The ledger is closed
and reopened between roles; every request is matched against its active
production SQLite reservation and reconstructed request before the accounting
reservation commits and forwarding begins. Successful captures preserve gateway
wire evidence and the unique durable attempt ID. The independent paired reader
reopens all eight production SQLite captures and the shared budget, calls the
existing request/source/result validator, checks frozen samples, role order,
exact pairs, per-trial charges, request/response hashes and pre-send reservation
timestamps. It also reparses the fixed responses through the production parsers
and compares persisted entities, facts, mentions, assertion qualifiers and
supports; changing SQLite plus its reported snapshot/hash cannot silently change
those meanings. Missing, edited, duplicated or incomplete evidence is rejected.
It only reads the original evidence. Replaying an existing output directory or
completed ledger role is rejected. An interrupted role stays incomplete; this
version does not resume interrupted collections or reset their spent budget.

Use `npm run quality:semantic -- paired-offline --release`, then
`npm run quality:semantic -- check-paired-offline --out <reported-directory> --release`.
No endpoint, credential, user corpus, arbitrary output or live switch is accepted
by this runner. The fixed accounting values are test units, not provider price
estimates or spending permission. Valid synthetic outputs exercise extraction
and relation requests; repair/retry behavior remains covered by separate
production/transport tests and is not claimed as paired-case coverage here.
Actual distinct-source/live comparison, approved real corpus/gold/thresholds,
official billing bounds and human review remain unimplemented or unprovided.
Every result retains `qualityStatus=not_run` and `fullQualityAcceptance=false`.

## Reproduce

Use Node24 and the repository development preflight. No audio, user material,
external model, key, browser, model grader or paid service is required.

```sh
npm ci --ignore-scripts
npm run preflight
npm run quality:semantic -- plan
npm run quality:semantic -- offline --release
npm run quality:semantic -- check-offline --out <printed-run-directory> --release
node --test --test-timeout=25000 test/semantic-quality-*.test.mjs
```

`offline` creates a fresh ignored evidence directory. `check-offline` requires
that exact source commit/tree, all tracked/untracked source and generated build
hashes, Node/SQLite/platform and environment recorded by the run. A changed
source, interrupted run, missing database, changed attachment, false annotation
or incomplete review fails closed. `--release` additionally requires clean
source. Do not change old report SHAs or reuse a previous source's green report.
CI runs the explicit offline command and preserves `verification-evidence/`
on success/failure/cancellation alongside ordinary tests.

## What actually runs

Eleven cases execute production `createKnowledgeWorkflow` and
`createRelationWorkflow`, their default model request/parser contracts, durable
request reservations and `ListeningStore`. Synthetic HTTP replies are served
only on a fresh loopback endpoint with a fixed test-only credential. Transcripts
are inserted through the store with identity translation; ASR/MT quality is not
measured. Knowledge output supplies the actual candidate entities to the
relation phase: this is **knowledge-to-relation cascade**, not a relation-only
fixed-candidate score. Omitted upstream nodes cannot erase downstream gold.

Three ordinary fixtures cover qualified acquisition, unrelated entities and a
valid empty greeting. Eight structurally accepted, hand-authored mutations
cover wrong number, dropped negation, lost condition/plan, wrong attribution,
wrong entity merge, duplicate fact, unsupported relation and upstream omission.
All use original synthetic prose, not downloaded/user/acceptance corpus data.
The mutation replies remain protocol-valid; no repair is needed to turn them
into parser successes. The duplicate case uses two genuine extraction batches.

Every case saves the final SQLite file, all tables before and after reopen,
integrity/FK results, raw request text/hash/bytes, synthetic response, request
reservation observed at the actual HTTP handler, terminal results and full
semantic units. Reopen's existing `relation_waiting_key=relation_enabled`
transition is explicitly allowed; all other stored fields must be unchanged.
Entity units retain aliases and mentions, facts retain their owning item and
source, and assertions retain relation IDs/endpoints and full source supports.
The reader reopens the actual SQLite artifact read-only and derives these units
again, rather than trusting summary counts.

Each capture has a 12-second cancellation deadline, bounded server cleanup,
a 128000-byte request cap and 24-dispatch/call caps. The eleven-case run has a
150-second cancellation deadline; a cancelled capture remains incomplete.
Workflow logical time advances existing retry readiness for deterministic
fixtures. These timings are not provider latency or billing guarantees.

## Review protocol

```sh
node scripts/evaluate-semantic-quality.mjs prepare-review \
  --capture <run/qualified> --reviewers <labels.json> --out <fresh-review.json>
node scripts/evaluate-semantic-quality.mjs assess \
  --capture <run/qualified> --reviewers <labels.json> \
  --review <completed-review.json> --out <fresh-assessment.json>
```

The roster file is a JSON array of declared reviewer labels. The template starts
unfilled. The reviewer selects one whole accepted gold variant, matches each
actual output ID to at most one same-kind gold ID, checks all seven severe-error
categories, explicitly lists every missing gold ID and adds decision notes.
Every displayed source, gold variant, output and owner/support field is bound to
the revalidated capture. Changed or missing display context is rejected even if
someone leaves the original hash in place. IDs, duplicate references, reviewer
and review timestamp must agree. Labels do not authenticate a human identity.

Precision is matched output IDs / all actual output IDs; recall is matched gold
IDs / every gold unit of the selected variant, separately for entity/fact/
relation. There is no automated prose normalization or semantic similarity
score. Multiple reasonable meanings use explicit gold variants/alternatives and
human matches. Both empty gives `valid_empty` with null denominators; nonempty
gold and empty output gives recall zero, including omitted downstream relations.
Serious numeric/negation/condition/attribution/merge/duplicate/unsupported errors
veto an offline review regardless of aggregate counts. Missing outputs also
fail the complete-match rehearsal. These are annotation-contract results, not
calibrated real-world release thresholds.

The automated eleven-case run uses visibly labeled, predetermined synthetic
annotation inputs. It independently recomputes their expected recipe, complete
review and metrics from actual stored units. The eight expected negative
assessments must fail while their annotation contracts remain valid. These
inputs exercise the reader; they do not claim that an AI graded its own output
or that a human approved the corpus. Every report still says quality `not_run`.
The run has 56 required raw attachments (five per case plus the run manifest).

## Failure samples for review and regression work

After completing an offline review, export its failure-focused excerpt:

```sh
node scripts/evaluate-semantic-quality.mjs failure-cases \
  --capture <run/qualified> --reviewers <labels.json> \
  --review <completed-review.json> --out <fresh-failures.json> --release
```

This reopens and validates the original SQLite/capture against the current
source, then reassesses the completed annotation. Incomplete, changed or forged
display context is rejected. Exit 0 means the export succeeded, including when
the review contains failures; use `assess` for the review's pass/fail exit code.
Passing and valid-empty reviews export no cases. Output must be a new file.

Each case points to the actual failed output or missing gold unit, with separate
severe-error reasons. Duplicate targets, fact owners, relation endpoints and
correction targets stay present. All original input segments and the complete
selected gold variant remain available, so removing context cannot hide a
condition or remove a missing downstream relation from recall. This is a compact
diagnostic excerpt, not an automatically minimized input or an executable replay.
Reproduce it with the original capture, reviewer roster and completed review;
the export binds their digests, source, model contracts and assessment. Original
artifacts remain authoritative and are required for revalidation.

Operational database IDs become local references. The export omits request
payloads, provider endpoints, local paths and reviewer names/notes. Semantic
prose and gold meanings are retained: it does not automatically redact personal
content and is not an approved public fixture. Current support remains synthetic
offline captures only; no live adapter, paid call or quality approval is added.

## Work still required for actual quality acceptance

`verification/semantic-quality/plan.template.json` is an **unapproved proposal**.
It has null thresholds and no credentials, live adapter, approved corpus or
budget. The remaining steps are explicit:

1. Assemble legally usable development and held-out acceptance material across
   the proposed categories, including ambiguity, proper names and several
   domains. Freeze source hashes and separation; human reviewers approve
   reasonable alternative gold meanings, ownership and source evidence.
2. Use the isolated development split to propose numeric precision/recall and
   duplicate/mismerge limits, directions, paired repetitions and blind review
   allocation. An owner confirms the whole rule set before candidate output is
   generated. Critical semantic errors retain a separate veto. Baseline and
   candidate sources, model/prompt/temperature/configuration must be frozen.
3. Implement and independently review a bounded live adapter only after a
   finite explicit budget and official worst-case billing bounds are approved.
   Knowledge must count actual `splitFocusSegments` parts, shared extra requests
   at most two and at most one repair per part; relation must count at most three
   requests per window and at most two consecutive protocol errors. Retries,
   repair, fallback and cancellation require pre-send reservation. ASR2/MT1
   limits are not this domain's plan. Then collect actual output and complete
   human adjudication and paired quality assessment.

None of those approvals or live evaluations is implied by the present CI.
KEJ-78 remains In Progress after this preparation is merged.

## Distinct-source offline execution and annotation comparison

`distinct-offline` executes two explicitly selected, trusted local checkouts in
separate processes. This is an offline synthetic comparison with the existing
knowledge-v2.1 / relations-v3 capture schema, not real model quality acceptance.
The baseline must already contain the bounded capture/ledger interfaces (PR99
or newer). Both checkouts need their own locked dependencies and exact clean
build; the command does not clone, install, rebuild or alter either checkout.
In each checkout run `npm ci --ignore-scripts` and `npm run build` beforehand.
The two roots, Git commits and trees must differ. A changed Git label alone is
insufficient: actual target-local production workflows make the requests.

From the clean coordinator checkout, with a JSON array of declared reviewer
labels in reviewers.json and a new output path outside both target checkouts:

```bash
npm run quality:semantic -- distinct-offline --baseline /path/base --candidate /path/candidate --reviewers /path/reviewers.json --out /path/new-run --release
npm run quality:semantic -- check-distinct-offline --baseline /path/base --candidate /path/candidate --reviewers /path/reviewers.json --out /path/new-run --release
npm run quality:semantic -- assess-distinct-offline --baseline /path/base --candidate /path/candidate --reviewers /path/reviewers.json --out /path/new-run --release
```

Before capturing, freeze the coordinator source, both target source/build
manifests, all installed dependency file bytes and link targets, model/prompt
profiles, identical synthetic samples, repetitions, declared reviewers and
shared finite accounting plan. Each role claims that same persistent SQLite
ledger; each HTTP forward needs a committed reservation. Targets are checked
before and after their work and after the pair. Failure/cancellation leaves an
incomplete role, preserves charges and prevents candidate admission. Existing
output cannot be replaced or replayed. Per-role processes have bounded lifetime
and process-group cleanup; the overall collection retains its 150-second bound.
No inherited provider credentials, NODE_OPTIONS or Git environment overrides
are passed to children.

A fresh check requires the two explicit checkout arguments again. Executable
paths are never selected from an artifact. Target-local readers validate their
version's requests; the coordinator's trusted reader independently reopens each
SQLite and validates structural evidence, fixed response meaning, ledger,
ordering and exact sample coverage. Protocol changes outside the supported
contract fail closed. Model changes must be internally consistent with the
selected source's storage/workflow version checks. These are trusted-code
executions, not a sandbox for hostile repositories. The coordinator must run
from its own checkout. Escaping source/build/dependency symlinks are rejected.
The workflow directly exercises root production knowledge/relation modules;
freezing the compiled server build does not claim an HTTP server was exercised.

Each capture gets an unfilled review.json using the existing annotation
contract. Fill those files explicitly; the collector never creates review
decisions. Reinspection validates displayed evidence, reviewer roster, full
output and missing-gold coverage. Paired completed reviews must choose the same
gold variant. Reports expose per-role metrics and candidate-minus-baseline
deltas; undefined precision/recall stays null. `check-distinct-offline` exits
success for valid infrastructure even with reviews pending.
`assess-distinct-offline` also requires every offline review to be complete and
pass its existing severe-error/missing-output checks. Declared names are not
authenticated human approval, and synthetic annotations do not calibrate a
real-world threshold. Every result keeps qualityStatus=not_run,
fullQualityAcceptance=false, releaseEligible=false and liveCalls=0.

Still unimplemented: a general real-corpus plan/part/window mapper, official
worst-case billing integration and authorized live collection/readback (including
repair/retry accounting and real-domain review comparison). Those are code
work, not merely human sign-off. Separately required are lawful development and
held-out data, human gold/adjudication, frozen thresholds/repetitions/rules and
explicit finite paid-provider authorization. `collect` and `--live` still reject.

## Configurable offline text-corpus collection

`corpus-offline`, `check-corpus-offline` and `assess-corpus-offline` extend the
existing knowledge→relation capture, gateway, transactional budget and review
contracts. They accept a strict JSON plan with one text sample (up to 24 segments,
6,000 characters per segment and 60,000 total), ingestion batch size, unapproved
multi-answer gold, declared reviewers, finite synthetic accounting units and
request/response/time limits. The input is transcript text, not audio or an ASR
quality claim. The caller must provide the same plan for independent readback;
changing the corpus, gold, batch policy or budget invalidates the frozen binding.

The plan derives request bounds through actual `ListeningStore.extractionRange`
and `splitFocusSegments`: each knowledge job reserves capacity for two requests
per part plus the two shared extras, and each six-segment relation window for
three requests. Every actual extract, repair or relation request is rebuilt from
its active persisted production reservation before a durable budget reservation
allows forwarding. Budgets can deliberately be too small: already reserved cost
is retained and an unreserved continuation cannot be reported as complete.
Amounts are **synthetic accounting units**, not official provider prices or
permission to spend. There is still no live CLI or credential argument.

Start from `verification/semantic-quality/corpus-plan.template.json`. Its expiry
is deliberately in the past: set a finite future expiry, review the sample and
replace the reviewer label before running. The empty gold is an unreviewed
placeholder, never an acceptance gold. Combined request/response evidence is
bounded before collection; oversized configurations are rejected.

Example commands (all paths are explicit):

```sh
npm run quality:semantic -- corpus-offline --plan /private/plan.json --provider http://127.0.0.1:12345/ --out /private/new-run
npm run quality:semantic -- check-corpus-offline --plan /private/plan.json --out /private/new-run --release
npm run quality:semantic -- assess-corpus-offline --plan /private/plan.json --out /private/new-run --release
```

The provider is an explicitly selected loopback fixture service that receives
ordinary chat-completion request JSON and returns an HTTP response. HTTPS,
non-loopback hosts, redirects, endpoint credentials and credential CLI options
are rejected. Provider status, delivered bytes and bounded numeric Retry-After
are recorded, including malformed JSON, protocol failure and retryable errors.
The old fixed synthetic commands retain their contracts and limits.

Independent verification starts a fresh SQLite database and re-executes the
actual workflows against the recorded raw HTTP responses. It compares every
request, final database table, checkpoints, candidates, aliases, relations,
supports, observations and budget rows. It never seeds replay from the reported
before/after snapshots. Coordinated edits to a database, snapshots, units and
checksums therefore do not suffice to change a fact. Original databases and the
original budget are opened read-only; replay uses a separate temporary budget.

Collection records actual wall-clock reads and production UUID generation inside
an isolated child; it does not freeze collection time. Replay consumes this
literal runtime tape to preserve persisted IDs, repair identities and ordering.
Transport capabilities remain random and are excluded from the UUID tape. Real
parent deadlines remain active in collection and replay. The existing offline
logical scheduler advances waits; this is not latency or real-time behavior
measurement. No SQL runtime fields or semantic text are erased to make replay
match. An unsupported nondeterministic database transition or changed runtime
sequence fails closed instead of manufacturing a match. Corpus text that looks
like a UUID is never rewritten. Evidence contains original text and responses;
it is not anonymized and must not be published as safe public data.

Successful collection means the bounded attempt sequence was captured and can
be independently reproduced. It can include a terminal model/protocol failure;
that outcome remains visible in the final job state and diagnostics. Unfilled
review templates are generated automatically, but decisions are never filled.
`check-corpus-offline` can succeed with review pending; `assess-corpus-offline`
requires the existing review contract to pass. Neither grants human identity,
model quality, or release acceptance: `qualityStatus=not_run`,
`fullQualityAcceptance=false`, `releaseEligible=false`, and `liveCalls=0`.

Remaining live work includes official billing upper-bound verification, explicit
provider/corpus authorization, real-time collection semantics and live evidence
integration. This configurable corpus path is not yet joined to the earlier
distinct-source paired CLI; that command still uses its fixed synthetic corpus.
Real quality additionally needs lawful split corpus, human adjudicated gold,
calibrated frozen rules and an approved finite provider budget.
