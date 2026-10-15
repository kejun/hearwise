# Knowledge and relation semantic quality preparation (KEJ-78)

## Delivery status

This stage delivers an executable **offline rehearsal**, not the real semantic
quality acceptance. `HW-05-04` is always `not_run`; `qualityEvaluated`,
`fullQualityAcceptance` and `releaseEligible` are always false. An exit code of
zero from `offline` means the capture/review/evidence plumbing passed.

There is no paid knowledge/relation adapter in this stage. `collect` and any
`--live` request reject before reading credentials or making requests. The
ASR/MT quality toolkit merged in PR83 supplies only source hashing, deterministic
JSON digests and file helpers. Its live adapter, attempt counts and budget are
not reused for this domain. No production behavior or database schema changes.

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
