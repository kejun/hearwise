# UTF-16 name interval verification (KEJ-70)

This profile verifies the deterministic coordinate core of HW-07. It reuses the
pinned Lean 4.35.0 toolchain, process watchdogs, source/artifact evidence helpers,
and CI installation from [revision verification](verification-revision.md).
A minimal production guard now rejects malformed imported active support coordinates
with the existing 409 error before remapping. Public API shapes are unchanged. Broader name-edit idempotency,
transactions and UI synchronization remain KEJ-71; this profile is not full HW-07
or full-project acceptance.

## Run

```sh
npm ci --ignore-scripts
npm run preflight
scripts/setup-revision-lean.sh /tmp/hearwise-lean
export PATH="/tmp/hearwise-lean/lean-4.35.0-linux/bin:$PATH"
npm run verify:name-interval -- --release
```

The exact Lean toolchain/commit, official-download SHA-256, Lake and bundled Std
are unchanged from KEJ-68. There are no new runtime dependencies. CI runs this
profile after revision verification in the existing Lean job and uploads a separate
`name-interval-evidence-<source SHA>` artifact. Existing Node, Chromium and relation
protocol checks remain intact.

Development runs may omit `--release`; release runs reject dirty/uncommitted source.
`NAME_INTERVAL_EVIDENCE_DIR` selects the output root. Each run gets a new directory.
The compiled oracle can replay its preserved corpus without JavaScript:

```sh
verification/lean/.lake/build/bin/name_interval_oracle corpus.ndjson replay.ndjson
```

## Exact model and production mapping

All coordinates and lengths are **UTF-16 code units**, not Unicode scalar values,
code points, bytes or grapheme clusters. Text is transported as arrays of integers
0..65535, retaining supplementary pairs, combining characters and lone surrogates.

`NameInterval.lean` represents a text as a list of pieces:

- `keep text`: an unchanged run, possibly empty
- `replace old fresh`: an old match and its replacement, both nonempty for `Valid`

Concatenating old pieces gives the original text; concatenating fresh pieces gives
the replacement text. Match positions are derived from cumulative old lengths.
This representation allows adjacent matches with empty unchanged gaps and makes
ordered, positive-width, nonoverlapping matches explicit. Actual production uses
one target name for all matches; the model also permits distinct nonempty targets,
so the production case is a specialization of the general statements.

`NameIntervalMain.lean` validates the incoming absolute match list, decomposes the
old text into these pieces, and returns the reconstructed old text, reconstructed
absolute match coordinates, raw replacement text, effective public text, mapped endpoints and new quote for
every anchor. The JavaScript driver compares both reconstructions to their exact
inputs, as well as comparing transformed output. The parser, compiled execution
and production linkage are tested boundaries, not a theorem claiming all of
JavaScript/SQLite is formally verified.

| Production boundary | Formal/executable mapping |
| --- | --- |
| `knowledgeTermMatches(text, source)` | Actual ordered intervals, independently checked by finite-alphabet literal scanner |
| `replaceKnowledgeTerm(text, source, target)` | `before`/`after` concatenation; direct output comparison |
| Public no-op branches | `effectivePlan enabled plan`: keep the original when item edit is disabled or segment text would not change |
| private `mappedOffset` inside `replaceKnowledgeName` | `mapPoint plan offset isEnd`; checked through public store saves and persisted supports, never exported/instrumented |
| `relation_supports.start/end/quote/source_revision` | New endpoints/UTF-16 slice plus actual transformed source hash |
| `state='active'` query | Only active supports are transformed; stale historical rows remain byte-for-byte unchanged in the fixture |

The recursive local-coordinate model avoids signed deltas: after a replaced piece,
it subtracts the old piece length and adds the fresh length. This corresponds to
the production cumulative `name.length - (match.end - match.start)` adjustment.
The implementation correspondence is checked on actual public results; it is not
assumed because two helper functions have similar source code.

The bridge transports `enabled = (target !== source || Boolean(name_override))`,
matching the public transaction branch after API trimming. `effectivePlan` replaces
the whole plan by one unchanged piece when disabled or when `before = after`.
Thus a case-fold match can exist while every persisted coordinate stays unchanged.
The oracle exposes raw `after plan` separately: pure replacement can change `DEEBO`
to `Deebo` even when the public same-name operation skips the edit. Four fixed
SQLite cases cover identical names, per-segment case-fold no-op, global no-op with
mixed case, and an existing override that enables that otherwise-disabled edit.

## Endpoint and intersection rules

For an enabled segment whose text changes, a match `[s,e)` with cumulative prior length change `delta` and replacement
length `n`, the existing production rules are preserved:

- Offset exactly at `s` stays at `s + delta` for start and end endpoints.
- A start offset strictly inside `(s,e)` moves to `s + delta`.
- An end offset strictly inside `(s,e)` moves to `s + delta + n`.
- Offset at `e` or after it includes that match's complete length change.

Thus a nonempty old quote contained within a matched name expands to the complete
new name. Quotes that cross matches may change text. Two disjoint old intervals
inside the same replaced name can map to the **same** new interval. There is no
claim that all old quote text, all interval disjointness, or grapheme boundaries
are preserved.

Example: replacing `Deebo` with `😀X` in `Deebo Camera.` uses a 3-unit target.
The old `Camera` interval `[6,12)` becomes `[4,10)` and still quotes `Camera`.
The old interior intervals `[1,2)` and `[3,4)` both become `[0,3)` and quote `😀X`.

## General theorems and audit

All names below are in `Hearwise.NameInterval` and are checked by the Lean kernel.
The old anchor premise is `0 ≤ start < end ≤ oldLength`; natural-number coordinates
supply nonnegativity. `Valid` requires positive old/replacement lengths. Empty
unchanged pieces and any finite number of edits are allowed.

| Theorem | Premise and conclusion |
| --- | --- |
| `mapPoint_zero` | Zero maps to zero for either endpoint flag |
| `mapped_bound` | For a valid plan and in-bounds old offset, its mapped offset is within the new text |
| `mapped_end_positive` | A positive in-bounds old end maps to a positive new end |
| `mapped_strict_interval` | A legal nonempty old interval maps to strictly ordered start/end |
| `mapped_anchor_valid` | Combines strict nonemptiness and final upper bound for every legal anchor, including intersecting anchors |
| `mapPoint_append` | Passing a whole valid prefix adds its new length to the suffix's mapped coordinate |
| `slice_inside` | A slice wholly within a concatenated run equals the corresponding local slice |
| `unchanged_quote` | An interval wholly within an unchanged run retains exactly the same UTF-16 text after any valid prefix edits |
| `intersecting_quote` | A nonempty interval wholly within one matched run maps to exactly the entire replacement text |
| `ordered_matches` | Derived absolute matches are ordered, positive and nonoverlapping |
| `bounded_matches` | Every derived match ends within the complete original text |
| `effective_valid` | Public no-op selection preserves plan validity |
| `effective_noop` | Either skip condition leaves every offset exactly unchanged |
| `effective_before` | Public no-op selection preserves the complete original text |

The unchanged-quote theorem explicitly requires the interval to lie within an
unchanged run. It is not extended to all intersections. The contained-intersection
theorem states the different, explicit expansion rule. Crossing multiple matches
has the general bounds/nonemptiness guarantee and executable quote comparisons;
it does not have an old-text-preservation claim.

`NameIntervalAxiomAudit.lean` guards each theorem's exact transitive `#print axioms`
output. `mapPoint_zero` uses `propext`; `mapPoint_append`, `unchanged_quote` and
`intersecting_quote` use `propext`, `Classical.choice`, `Quot.sound`.
`effective_valid` uses no axioms and `effective_before` uses only `propext`; the
remaining listed theorems use `propext`, `Quot.sound`. Only Lean's standard logical axioms are
present. Unfinished proofs, custom axioms and native-evaluation proof shortcuts
are rejected. Compile/audit logs and `axioms.json` are required evidence.

## Input and trust boundaries

The proof bridge accepts finite UTF-16 strings, a nonempty target, ordered positive
nonoverlapping matches within the original text, and nonempty in-bounds old anchors.
JavaScript coordinates must be exact safe integers; Lean's model uses unbounded
natural numbers. Plain deterministic data is supplied by the corpus, with no
getters, proxies or external/user content.

The pure function's empty-target behavior is deliberately outside the nonempty
target theorem: it can delete matched text. The public save API instead trims the
name and requires 1..160 UTF-16 units without controls. Trimming, malformed requests,
160/162-unit boundaries, stale revision tokens, and API errors are separately
recorded implementation tests, not widened proof assumptions.

Persistent SQLite evidence is a subset of the UTF-16 corpus: text/source/target
must roundtrip as well-formed Unicode; old quotes must be nonblank and well-formed,
and new quotes must be well-formed. In particular, a slice splitting a surrogate
pair remains in the pure/Lean corpus but cannot be honestly claimed as a preserved
SQLite string. Every excluded persistence anchor is counted in `sqlite-evidence.json`.
These limits do not remove those intervals from the mathematical model or pure tests.

A legal active old support additionally has the correct source revision and its
quote equals the old UTF-16 slice. Tests inject source-hash or quote mismatches and
verify the public transaction rejects them without partial writes. Already-stale
supports, even with bad historical coordinates/hash/quote, are unchanged and never
reactivated.

Public append/restore imports accept structurally valid historical backups without
validating interval coordinates. A fixed regression demonstrates that an active
reversed `[3,2)` empty quote previously became active `[0,4)` / `Tibo`. The minimal
production fix strengthens the existing 409 guard with safe integers and
`0 <= start < end <= original_text.length`; source-hash/quote checks remain.
Both public import paths now reject empty, negative, reversed, out-of-bounds,
fractional-start and fractional-end active anchors during replacement. All business
rows and the attempted receipt remain unchanged, including after reopening.
The import contract and stale-row behavior are unchanged. The regression was first
run failing against the old implementation, then passed with the separate guard fix.

Mapping does not guarantee every legal anchor collection can be persisted. Two
same-group/same-role interior anchors can collapse to identical coordinates and
violate the existing SQLite uniqueness constraint. A normal public relation commit
with `[1,2)` / `e` and `[3,4)` / `b` reproduces this during `Deebo` -> `Tibo`;
the existing `ERR_SQLITE_ERROR` is retained and all business rows/receipt roll back.
The differential assigns distinct synthetic groups per anchor to isolate coordinate
comparison. It does not claim arbitrary grouped supports always save successfully.

## Matching is independently tested

Correct coordinates alone do not prove the intended term was selected. The
separate matcher oracle walks Unicode points, counts their UTF-16 widths, performs
literal comparisons with an explicit finite simple-fold table, and applies the
Latin/digit/underscore boundary policy. Production regex construction is not copied.
Both matcher outputs and replacement strings are compared to public functions.

Fixed expectations cover CJK adjacency; emoji; supplementary-before-match offsets;
Latin word interiors; digits/underscores; literal regex metacharacters; replacement
`$&`; exact whitespace versus doubled spaces; composed versus decomposed accents;
combining marks; Kelvin sign, long s and sharp-s folding; and consecutive matches.
Whitespace and Unicode normalization are not silently introduced into term matching.
The finite fold alphabet is documented in `corpus.mjs`; it is not an implementation
or proof of the entire Unicode case-folding database.

## Frozen differential scope and queryable witness

Seed **1262832240**, xorshift32; 40 fixed plus 256 generated cases: **296** cases and
**10,333** legal old anchors. Short fixed strings enumerate every nonempty UTF-16
interval; generated cases include endpoint-directed and seeded anchors. The scope
is frozen in the profile and corpus regression tests.

The public SQLite save runs **81** cases, with **3,675** persistent anchors, closing
and reopening every database. Each records actual supports before/after, source
text, original source hash, identities, grouping/state, unlinked segments and other
listenings. The existing synthetic name-replacement fixture creates genuine graph,
job and support records; production triggers stay installed. Test data is reseeded
through SQLite, then the public operation performs the transformation or its checked no-op.

`sqlite-witness.sqlite` retains one closed, synthetic emoji-target case. Query it
with a read-only SQLite client (or query a copy to avoid creating local sidecars):

```sql
SELECT s.id, s.state, s.source_revision, s.start, s.end, s.quote, g.original_text
FROM relation_supports s JOIN segments g ON g.id = s.segment_id
ORDER BY s.id;
```

`sqlite-evidence.json` includes this query and full before/after rows. Its database
contains no credentials or real content. Fixture UUIDs/timestamps are recorded as
observed values, not falsely attributed to the PRNG seed.

A mutation copies the actual `knowledge-name-replacement.mjs`, changes both mapper
`name.length` uses to `[...name].length`, and installs its exported public method
on a temporary store subclass. It does not call/export the private mapper. The
persisted `Camera` witness becomes `[3,9)` / ` Camer` instead of `[4,10)` / `Camera`,
so the production-copy fault is detected. Original/mutated/runnable digests and the
exact input/output witness are preserved. The real source file remains unchanged.

## Evidence and failures

The output directory contains the report, source/profile digests, tool/environment
versions, stage exits, full corpus/index, Lean outputs, oracle exits, invalid-input
exits, SQLite rows and witness database, mutation witness, theorem audit and logs.
Methods are registered locally as HW-07-02..06; this is not a fake pilot-schema row.
The project-wide release selector remains separate later work.

The existing 7 name-replacement integration regressions plus 2 import/collision
regressions (9 total) also run with TAP counts
verified, inherited `NODE_TEST_CONTEXT` removed, and no skips/cancellations allowed.
Twelve invalid-oracle inputs must explicitly exit 1, not merely fail to start or
time out. Thirteen API/source-boundary observations include invalid inputs and
positive trimming/160-unit boundaries. Twelve imported-invalid-coordinate cases
and the same-group collision retain their actual rejected/unchanged outcomes. They
are implementation regressions, not accepted proof inputs.

Stage limits are 15 seconds each for tool versions, 120 seconds for proof build,
30 seconds for axiom audit, 90 seconds for the differential (oracle 60 seconds;
invalid-oracle cases 1 second each), and 90 seconds for implementation regressions
(individual Node tests 30 seconds), under a 360-second runner deadline. Process
groups, temporary databases and mutant files are cleaned up on failure/interruption;
the synthetic witness is intentionally retained and hashed.

The shared Lean CI job has a bounded 20-minute outer deadline: two sequential
360-second profiles require up to 12 minutes, leaving 8 minutes for checkout,
dependency/toolchain setup and artifact upload. Both profile deadlines and every
per-stage limit remain unchanged. Node, Chromium and relation-model job budgets
are unchanged.

The runner hashes its declared source files both before and after execution, so a
changed or missing file fails even when the checkout was already dirty. The gate
rejects wrong/missing tools, changed source/profile, dirty release source,
missing artifacts, failed/incomplete execution, scope reduction, unexecuted tests,
undetected mutation, missing reopen/stale/isolation checks and invalid-input checks
that timed out rather than rejected. `fullHW07Acceptance` and
`fullProjectAcceptance` remain false even on a complete profile pass.
