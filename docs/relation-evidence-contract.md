# Relation evidence contract v3

## Product behavior

Knowledge items are allowed to remain independent. One model pass reads each eligible window and returns only relations supported by the source. An empty array or filtered proposals are normal completed results, including when every proposed relation is filtered. They do not trigger retries, a partial-failure banner, or a requirement to create more edges.

Actual HTTP/timeouts, invalid response envelopes and truncated output remain failures with bounded retries. Incomplete input coverage or storage validation problems remain partial. Both preserve previously saved relations. Windows with fewer than two candidate nodes finish without a model call; new nodes can make them eligible later.

## Semantic responsibility

The model decides predicates, direction, negation, plans, conditions, attribution and pronoun resolution from the full original context. It is instructed to omit unsupported/co-occurring or ambiguous relationships, use translations only as auxiliary context, and preserve qualifications. Synonyms, non-English wording and same-segment references no longer have to satisfy an English/Chinese verb dictionary or a second, heuristic coreference validator.

The server does **not** independently prove that a natural-language claim follows from its selected text. Source integrity and model semantic accuracy are separate. The tests with constructed provider responses verify parsing, source preservation and lifecycle behavior; they do not demonstrate live-model precision or recall. A semantically wrong but structurally valid model decision remains a model error, inspectable through its saved original evidence. This replaces the former regex-based semantic gate rather than adding another model call.

## Compact wire format

The current model and dispatch limits are unchanged: `qwen3.8-flash`, thinking disabled, up to two concurrent requests, 30 seconds per request, three attempts per window, and 6,000 output tokens. There is no whole-history quota.

- `focus_segments` / `context_segments` carry short IDs, sequence and optional final translations. Original source appears once, in `evidence`.
- Evidence is a complete ASR segment, split only when required by the 2,000-character evidence bound. The model sees the whole segment, including surrounding qualifications; it does not select an artificially shortened affirmative clause.
- The model selects short candidate IDs (`n0`), evidence IDs (`e0`) and optional correction IDs (`a0`). It no longer emits mention IDs, quotes, offsets, support roles or display statements.
- The envelope binds `contract_version: relations-v3` and the request's `evidence_version`. Each row requires endpoints, predicate, polarity, modality, status and 1–12 evidence IDs. Optional conditions/time/attribution/correction fields may be omitted. `relations: []` is valid.
- Source/evidence revisions and exact UTF-16 offsets stay server-owned. Model-provided extra prose/fields cannot become stored facts. Statements are generated from canonical structured fields.

## Remaining integrity checks

Endpoints must be distinct, real candidates in this listening. Selected evidence must exist in this request and include focus text. Each endpoint must have an unambiguous approved name/alias in the selected evidence; include context evidence when it supplies identity. There is no per-sentence mention-ID matching, position-order proof or competing-pronoun heuristic.

Name matching uses the shared NFKC/case/whitespace/quotation/dash equivalence while retaining original source slices. Shared aliases and overlapping different identities remain ambiguous, not fuzzy-merged. Protocol tokens tolerate case, width and surrounding whitespace. Provided qualifier strings are matched with the same formatting tolerance and stored in the source spelling. Arbitrary invented qualifiers are filtered.

Existing explicit-correction protection, source/identity fingerprint checks, cross-listening isolation, deterministic relation keys, cancellation fences and saved support invalidation remain. A correction must target the same endpoints/predicate and have explicit source correction wording. Uncertain endpoint identity or fragmented evidence stays `needs_review`.

## Upgrade and UI

On startup, historical partial jobs caused only by candidate filtering become complete locally. Existing edges, rejected-reason diagnostics, unknown legacy counts, original protocol versions, epochs and paid-attempt journals are preserved. Clipped inputs, storage failures, unknown rejection types, and changed source windows are not marked complete. This status migration never starts paid work.

Pending old-protocol requests cannot commit or be retried silently under the new contract. They retain the existing explicit recovery path; settled historical windows remain cached. There is no automatic re-extraction of previously filtered history.

The primary UI says “关系整理完成” or “关系整理完成，未发现有充分依据的关系；知识条目可独立查看”. Counts and candidate filtering details are in a collapsed “整理详情” disclosure. Only genuine unfinished work offers “重试未完成窗口”. Unknown historical counts remain unknown in diagnostics.

## Validation

Regression coverage includes the real knowledge parser → SQLite → compact provider wire → relation decoder → storage → graph path, normalized identities and qualifiers, synonyms/multilingual fixtures, empty outputs, mixed valid/filtered candidates, exact source revisions, cancellation and stale responses, HTTP retries, historical-state migration, and no replay after reads/restarts/repeated starts.

A 32-window / 92-filtered-proposal fixture verifies 32 requests, 32 completed windows, zero failed/partial windows and no retry eligibility. This is lifecycle verification, not a real-provider latency or accuracy measurement.
