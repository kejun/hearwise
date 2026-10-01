# Relation evidence contract v2

## Why this changes the contract

The knowledge parser and relation validator previously used different identity matching rules. A canonical node named `Atlas` could be created from `atlas`, while the relation validator required a case-sensitive literal name. The relation model also had to regenerate quotes, offsets, support roles and IDs. A limited verb vocabulary was treated as universal semantic proof, rejecting valid synonyms and same-ASR-segment references.

V2 separates source grounding, transport validation and semantic uncertainty. It is not a claim that a language model or a finite local recognizer can prove every natural-language relation.

## Server evidence registry

- `identity-grounding.mjs` is the shared name-equivalence implementation for knowledge identity acceptance and relation evidence. NFKC, case, whitespace and supported quotation/dash variants affect matching only. Evidence always retains original UTF-16 positions and exact original text
- Word boundaries, Unicode grapheme expansion, shared aliases and overlapping different identities are guarded. Similar-looking names are never fuzzy-merged
- `knowledge_mentions` is preserved as source provenance. Its often sentence-sized `surface_text` is never promoted to an entity alias
- `relation-evidence.mjs` creates immutable sentence/clause spans and exclusive identity mentions. IDs bind source identity, source revision and exact positions; mention IDs also bind the candidate. The registry version binds the source/candidate/scope snapshot
- Focus/context scope is explicit. Prefix/suffix source frames remain visible. Fragmented or uncertain frames are review-only; capped coverage is partial, never silently complete

## Model output

The request continues to use `qwen3.8-flash`, `enable_thinking:false`, a JSON object response, 6,000 output tokens, two concurrent requests, a 30-second per-request timeout and bounded attempts. No whole-history request/token/time pause is added.

A response echoes `contract_version: relations-v2` and the exact `evidence_version`. Each row selects:

- Candidate `subject_item_id`, `object_item_id`, supported `predicate`
- One to ten `evidence_ids` for assertion spans, including genuine focus evidence
- `subject_mention_id` and `object_mention_id`; context identity anchors are selected here, not padded into assertion evidence
- Explicit polarity, modality, status, optional conditions/time_scope/attribution and correction target

The model does not generate quotes, offsets, support roles or revisions. The server restores those from the registry. Unknown IDs, stale versions, wrong mention owners, malformed fields and cross-listening identities are rejected. Legacy quote-shaped output is not silently accepted by the v2 provider path. Legacy parsing remains available for historical diagnostics/tests.

Display statements are generated from canonical endpoints, predicate and truth qualifiers. Optional model prose cannot inject extra or reversed facts into a stored statement. Conditions, time and attribution remain separate persisted/displayed fields and must be grounded in the related source frame.

## Grounding and semantics

Every selected assertion span must ground its endpoints with exclusive registry mentions or an earlier explicit reference. Cross-sentence order uses segment sequence plus character position, including multiple sentences inside one ASR segment. A named counterpart is not automatically a competing antecedent, but another plausible antecedent is not guessed. A prior identity mention cannot replace a different explicit source endpoint.

An irrelevant focus span cannot make an old context-only fact new. Shared aliases cannot become unambiguous merely by appending an earlier unique-name sentence. Source qualifiers cannot be stripped by selecting an embedded affirmative clause. Wrong direction, known contradictory predicate, co-occurrence, negation/plan/condition/attribution/time omissions and invalid qualifier contents remain guarded.

Known simple lexical cases may be active; unknown wording, unfamiliar languages, complex syntax, uncertain identities, source/translation conflicts and cross-reference proposals are explicitly `needs_review`. This state is visible as 待核对 and does not mean independently confirmed fact. Unknown phrasing is handled consistently across languages; `built` and `shipped` are not rejected merely because they are absent from a verb list. Conversely, review status is not permission to ignore structural or known contradiction failures.

Finite lexical checks cannot certify general semantic entailment, complete multilingual scope, or pronoun resolution. The fixtures establish implementation invariants, not real-provider accuracy, acceptance rate or latency.

## Recovery, retry and diagnostics

- Terminal successful windows and already stored edges survive the upgrade. Updating this contract never automatically starts paid work or replays successful windows
- Interrupted/pending old-protocol jobs are fenced before reservation/commit and require explicit retry. The existing failed/partial selective retry is the upgrade route for problematic windows
- Source/translation/candidate identity changes remain revision/fingerprint fences; redundant mention provenance and protocol changes alone do not invalidate a terminal semantic cache
- Reject samples retain only bounded enums, booleans and counts: schema, validation stage, row shape, known endpoint/mention flags, evidence counts and legacy-shape flag. No raw rejected model text, transcript, candidate ID, credentials or error body is added to diagnostic logs
- Diagnostics distinguish review counts, protocol/identity/semantic rejection stages and unknown legacy information. Existing legacy rejected rows cannot be reconstructed retrospectively

## Verification and live-provider boundary

`test/relation-evidence-e2e.test.mjs` uses independently authored semantic proposals through real `parseKnowledgeV2 → SQLite knowledge mentions → request wire → provider-shaped response → relation validation → SQLite → graph filtering`. It covers canonical case/space/punctuation differences, multilingual source/translation, synonyms, same-segment references, collisions, repeated text, stale IDs, context/focus laundering, wrong facts, direction, qualifiers and malicious statements. Registry unit tests cover exact positions, collisions, stable IDs, frame provenance and caps. Transport, scheduler, cancellation, retry and graph/browser fixtures remain separate.

No paid provider call or private transcript was used to develop these changes. A separately approved, capped real-provider evaluation remains necessary to measure model compliance, recall and precision on actual listening content. Historical rejected raw model rows were not stored, so past rejection accuracy cannot be recovered or claimed from aggregate codes alone.
