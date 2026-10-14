import Std

namespace Hearwise.Revision

/-- JavaScript strings are UTF-16 code units, not Lean Unicode scalar strings.
The executable boundary restricts every unit to 0..65535. -/
abbrev Units := List Nat

inductive Scalar where
  | null
  | boolean (value : Bool)
  | integer (value : Int)
  | text (value : Units)
  deriving BEq, Repr

abbrev Row := String → Option Scalar

def nullish : Option Scalar → Scalar
  | none => .null
  | some value => value

def itemKeys := ["id", "listening_id", "type", "canonical_name", "normalized_name",
  "dialogue_summary", "background_note", "certainty", "display_label", "short_description",
  "policy_version", "content_version", "name_override", "name_override_identity"]
def segmentKeys := ["id", "listening_id", "run_id", "sequence_no", "asr_sentence_id",
  "original_text", "translation_text", "translation_state", "begin_ms", "end_ms"]
def mentionKeys := ["item_id", "segment_id", "surface_text"]
def revisionKeys := ["id", "item_id", "action", "old_value", "new_value", "merged_from_id", "reason"]
def factKeys := ["id", "item_id", "segment_id", "surface_text", "content", "certainty"]

def pick (keys : List String) (row : Row) : List (String × Scalar) :=
  keys.map fun key => (key, nullish (row key))

def SameFields (keys : List String) (left right : Row) : Prop :=
  ∀ key ∈ keys, nullish (left key) = nullish (right key)

theorem pick_irrelevant (keys : List String) (left right : Row)
    (h : SameFields keys left right) : pick keys left = pick keys right := by
  apply List.map_congr_left
  intro key hk
  simp only [h key hk]

theorem missing_equals_null : nullish none = nullish (some .null) := rfl

/-- Only ASCII constants and exact integer decimal text use Lean's String. -/
def ascii (value : String) : Units := value.toList.map Char.toNat

def hexDigit (value : Nat) : Nat := if value < 10 then 48 + value else 87 + value
def escapeUnit (unit : Nat) : Units := [92, 117, hexDigit (unit / 4096 % 16),
  hexDigit (unit / 256 % 16), hexDigit (unit / 16 % 16), hexDigit (unit % 16)]
def highSurrogate (unit : Nat) : Bool := 55296 ≤ unit && unit ≤ 56319
def lowSurrogate (unit : Nat) : Bool := 56320 ≤ unit && unit ≤ 57343

/-- ECMAScript JSON.stringify: short control escapes, lowercase escaped hex for
other controls and unpaired surrogates; preserve valid surrogate pairs. -/
def escapeText : Units → Units
  | [] => []
  | unit :: rest =>
    if highSurrogate unit then
      match rest with
      | next :: tail => if lowSurrogate next then unit :: next :: escapeText tail
        else escapeUnit unit ++ escapeText (next :: tail)
      | [] => escapeUnit unit
    else if lowSurrogate unit then escapeUnit unit ++ escapeText rest
    else (match unit with
      | 34 => [92, 34]
      | 92 => [92, 92]
      | 8 => [92, 98]
      | 9 => [92, 116]
      | 10 => [92, 110]
      | 12 => [92, 102]
      | 13 => [92, 114]
      | n => if n < 32 then escapeUnit n else [n]) ++ escapeText rest

def quote (text : Units) : Units := [34] ++ escapeText text ++ [34]
def encodeScalar : Scalar → Units
  | .null => ascii "null"
  | .boolean true => ascii "true"
  | .boolean false => ascii "false"
  | .integer value => ascii (toString value)
  | .text value => quote value

def join (values : List Units) : Units := (List.intersperse [44] values).flatten

def object (fields : List (String × Units)) : Units :=
  [123] ++ join (fields.map fun (key, value) => quote (ascii key) ++ [58] ++ value) ++ [125]
def array (values : List Units) : Units := [91] ++ join values ++ [93]
def encodeRow (keys : List String) (row : Row) : Units :=
  object ((pick keys row).map fun (key, value) => (key, encodeScalar value))

/-- Lexicographic order of already serialized UTF-16 units, exactly the ordering
used by JavaScript `<`/`>` on JSON.stringify output. Multiplicity is preserved. -/
def unitsLE (a b : Units) : Bool := decide (a ≤ b)
def canonical (values : List Units) : List Units := values.mergeSort unitsLE

theorem canonical_permutation {left right : List Units} (h : left.Perm right) :
    canonical left = canonical right := by
  have trans : ∀ a b c, unitsLE a b → unitsLE b c → unitsLE a c := by
    intro a b c hab hbc
    simpa [unitsLE] using (List.le_trans (of_decide_eq_true hab) (of_decide_eq_true hbc))
  have total : ∀ a b, unitsLE a b || unitsLE b a := by
    intro a b
    simpa [unitsLE] using (List.le_total a b)
  apply List.Perm.eq_of_pairwise (le := fun a b => unitsLE a b = true)
  · intro a b _ _ hab hba
    exact List.le_antisymm (of_decide_eq_true hab) (of_decide_eq_true hba)
  · exact List.pairwise_mergeSort trans total left
  · exact List.pairwise_mergeSort trans total right
  · exact (List.mergeSort_perm left unitsLE).trans (h.trans (List.mergeSort_perm right unitsLE).symm)

theorem canonical_preserves_multiplicity (values : List Units) :
    (canonical values).Perm values := List.mergeSort_perm values unitsLE

structure Snapshot where
  item : Row
  aliases : List Scalar
  mentions : List Row
  revisions : List Row
  facts : List Row
  segments : List Row

def normalize (snapshot : Snapshot) : Units :=
  object [("version", ascii "1"), ("item", object
    (((pick itemKeys snapshot.item).map fun (key, value) => (key, encodeScalar value)) ++
      [("aliases", array (canonical (snapshot.aliases.map encodeScalar))),
       ("mentions", array (canonical (snapshot.mentions.map (encodeRow mentionKeys)))),
       ("revisions", array (canonical (snapshot.revisions.map (encodeRow revisionKeys)))),
       ("facts", array (canonical (snapshot.facts.map (encodeRow factKeys))))])),
    ("segments", array (canonical (snapshot.segments.map (encodeRow segmentKeys))))]

/-- The inputs agree on item business fields, and child projections are
permutations (allowing irrelevant-field/nullish changes within child rows). -/
structure Equivalent (left right : Snapshot) : Prop where
  item : SameFields itemKeys left.item right.item
  aliases : (left.aliases.map encodeScalar).Perm (right.aliases.map encodeScalar)
  mentions : (left.mentions.map (encodeRow mentionKeys)).Perm (right.mentions.map (encodeRow mentionKeys))
  revisions : (left.revisions.map (encodeRow revisionKeys)).Perm (right.revisions.map (encodeRow revisionKeys))
  facts : (left.facts.map (encodeRow factKeys)).Perm (right.facts.map (encodeRow factKeys))
  segments : (left.segments.map (encodeRow segmentKeys)).Perm (right.segments.map (encodeRow segmentKeys))

theorem normalization_equivalent {left right : Snapshot} (h : Equivalent left right) :
    normalize left = normalize right := by
  simp only [normalize, pick_irrelevant _ _ _ h.item,
    canonical_permutation h.aliases, canonical_permutation h.mentions,
    canonical_permutation h.revisions, canonical_permutation h.facts,
    canonical_permutation h.segments]

theorem normalization_permutation (left right : Snapshot)
    (item : left.item = right.item)
    (aliases : left.aliases.Perm right.aliases)
    (mentions : left.mentions.Perm right.mentions)
    (revisions : left.revisions.Perm right.revisions)
    (facts : left.facts.Perm right.facts)
    (segments : left.segments.Perm right.segments) : normalize left = normalize right := by
  apply normalization_equivalent
  exact ⟨by simp [SameFields, item], aliases.map _, mentions.map _, revisions.map _, facts.map _, segments.map _⟩

theorem row_irrelevant (keys : List String) (left right : Row)
    (h : SameFields keys left right) : encodeRow keys left = encodeRow keys right := by
  simp only [encodeRow, pick_irrelevant keys left right h]

inductive Rowwise (relation : Row → Row → Prop) : List Row → List Row → Prop where
  | nil : Rowwise relation [] []
  | cons {a b as bs} : relation a b → Rowwise relation as bs → Rowwise relation (a :: as) (b :: bs)

theorem rows_irrelevant (keys : List String) (left right : List Row)
    (h : Rowwise (SameFields keys) left right) :
    left.map (encodeRow keys) = right.map (encodeRow keys) := by
  induction h with
  | nil => rfl
  | cons h _ ih => simp only [List.map_cons, row_irrelevant _ _ _ h, ih]

theorem normalization_irrelevant (left right : Snapshot)
    (item : SameFields itemKeys left.item right.item)
    (aliases : left.aliases = right.aliases)
    (mentions : Rowwise (SameFields mentionKeys) left.mentions right.mentions)
    (revisions : Rowwise (SameFields revisionKeys) left.revisions right.revisions)
    (facts : Rowwise (SameFields factKeys) left.facts right.facts)
    (segments : Rowwise (SameFields segmentKeys) left.segments right.segments) :
    normalize left = normalize right := by
  apply normalization_equivalent
  exact ⟨item, List.Perm.of_eq (congrArg _ aliases),
    List.Perm.of_eq (rows_irrelevant _ _ _ mentions),
    List.Perm.of_eq (rows_irrelevant _ _ _ revisions),
    List.Perm.of_eq (rows_irrelevant _ _ _ facts),
    List.Perm.of_eq (rows_irrelevant _ _ _ segments)⟩

theorem row_missing_null (keys : List String) (row : Row) (key : String) :
    encodeRow keys (fun k => if k = key then none else row k) =
    encodeRow keys (fun k => if k = key then some .null else row k) := by
  apply row_irrelevant
  intro k _
  by_cases h : k = key <;> simp [h, nullish]

end Hearwise.Revision
