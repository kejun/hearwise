import Revision

namespace Hearwise.NameInterval
open Hearwise.Revision (Units)

/-- A decomposition of UTF-16 text into unchanged runs and positive, disjoint
matched runs. Empty unchanged runs allow adjacent spans. -/
inductive Piece where
  | keep (text : Units)
  | replace (old fresh : Units)
  deriving Repr
abbrev Plan := List Piece

def before : Plan → Units
  | [] => []
  | .keep text :: rest => text ++ before rest
  | .replace old _ :: rest => old ++ before rest

def after : Plan → Units
  | [] => []
  | .keep text :: rest => text ++ after rest
  | .replace _ fresh :: rest => fresh ++ after rest

def oldLength (plan : Plan) : Nat := (before plan).length
def newLength (plan : Plan) : Nat := (after plan).length

def Valid : Plan → Prop
  | [] => True
  | .keep _ :: rest => Valid rest
  | .replace old fresh :: rest => 0 < old.length ∧ 0 < fresh.length ∧ Valid rest

@[simp] theorem oldLength_nil : oldLength [] = 0 := rfl
@[simp] theorem newLength_nil : newLength [] = 0 := rfl
@[simp] theorem oldLength_keep (text : Units) (rest : Plan) :
    oldLength (.keep text :: rest) = text.length + oldLength rest := by simp [oldLength, before]
@[simp] theorem newLength_keep (text : Units) (rest : Plan) :
    newLength (.keep text :: rest) = text.length + newLength rest := by simp [newLength, after]
@[simp] theorem oldLength_replace (old fresh : Units) (rest : Plan) :
    oldLength (.replace old fresh :: rest) = old.length + oldLength rest := by simp [oldLength, before]
@[simp] theorem newLength_replace (old fresh : Units) (rest : Plan) :
    newLength (.replace old fresh :: rest) = fresh.length + newLength rest := by simp [newLength, after]

/-- Endpoints inside a replaced run expand to the start/end of its replacement.
An endpoint exactly at the old start stays before the replacement for both flags. -/
def mapPoint : Plan → Nat → Bool → Nat
  | [], offset, _ => offset
  | .keep text :: rest, offset, isEnd =>
    if offset ≤ text.length then offset else text.length + mapPoint rest (offset - text.length) isEnd
  | .replace old fresh :: rest, offset, isEnd =>
    if offset = 0 then 0 else if offset < old.length then
      (if isEnd then fresh.length else 0)
    else fresh.length + mapPoint rest (offset - old.length) isEnd

@[simp] theorem mapPoint_zero (plan : Plan) (isEnd : Bool) : mapPoint plan 0 isEnd = 0 := by
  cases plan with
  | nil => rfl
  | cons piece rest => cases piece <;> simp [mapPoint]

theorem mapped_bound (plan : Plan) (offset : Nat) (isEnd : Bool)
    (valid : Valid plan) (bound : offset ≤ oldLength plan) :
    mapPoint plan offset isEnd ≤ newLength plan := by
  induction plan generalizing offset with
  | nil => simpa [mapPoint] using bound
  | cons piece rest ih =>
    cases piece with
    | keep text =>
      simp only [Valid] at valid
      simp only [oldLength_keep] at bound
      simp only [mapPoint, newLength_keep]
      split
      · omega
      · have hr := ih (offset - text.length) valid (by omega)
        omega
    | replace old fresh =>
      obtain ⟨ho, hn, valid⟩ := valid
      simp only [oldLength_replace] at bound
      simp only [mapPoint, newLength_replace]
      split
      · omega
      · split
        · cases isEnd <;> simp <;> omega
        · have hr := ih (offset - old.length) valid (by omega)
          omega

theorem mapped_end_positive (plan : Plan) (offset : Nat)
    (valid : Valid plan) (positive : 0 < offset) (bound : offset ≤ oldLength plan) :
    0 < mapPoint plan offset true := by
  induction plan generalizing offset with
  | nil => simpa [mapPoint] using positive
  | cons piece rest ih =>
    cases piece with
    | keep text =>
      simp only [Valid] at valid
      simp only [oldLength_keep] at bound
      simp only [mapPoint]
      split
      · exact positive
      · have hr := ih (offset - text.length) valid (by omega) (by omega)
        omega
    | replace old fresh =>
      obtain ⟨ho, hn, valid⟩ := valid
      simp only [mapPoint, ite_true]
      split
      · omega
      · split <;> simp_all <;> omega

theorem mapped_strict_interval (plan : Plan) (start stop : Nat)
    (valid : Valid plan) (ordered : start < stop) (bound : stop ≤ oldLength plan) :
    mapPoint plan start false < mapPoint plan stop true := by
  induction plan generalizing start stop with
  | nil => simpa [mapPoint] using ordered
  | cons piece rest ih =>
    cases piece with
    | keep text =>
      simp only [Valid] at valid
      simp only [oldLength_keep] at bound
      simp only [mapPoint]
      split
      · split
        · exact ordered
        · have hr := mapped_end_positive rest (stop - text.length) valid (by omega) (by omega)
          omega
      · split
        · omega
        · have hr := ih (start - text.length) (stop - text.length) valid (by omega) (by omega)
          omega
    | replace old fresh =>
      obtain ⟨ho, hn, valid⟩ := valid
      simp only [oldLength_replace] at bound
      simp only [mapPoint, Bool.false_eq_true, ite_false, ite_true]
      split
      · split
        · omega
        · split <;> simp_all <;> omega
      · split
        · split
          · omega
          · split <;> simp_all <;> omega
        · split
          · omega
          · split
            · omega
            · have hr := ih (start - old.length) (stop - old.length) valid (by omega) (by omega)
              omega

/-- Every legal nonempty old anchor has strictly ordered, in-bounds new endpoints.
Replacement strings must be nonempty, as required by the production save API. -/
theorem mapped_anchor_valid (plan : Plan) (start stop : Nat)
    (valid : Valid plan) (ordered : start < stop) (bound : stop ≤ oldLength plan) :
    mapPoint plan start false < mapPoint plan stop true ∧
    mapPoint plan stop true ≤ newLength plan :=
  ⟨mapped_strict_interval plan start stop valid ordered bound,
    mapped_bound plan stop true valid bound⟩

theorem mapPoint_append (pre suffix : Plan) (offset : Nat) (isEnd : Bool)
    (valid : Valid pre) :
    mapPoint (pre ++ suffix) (oldLength pre + offset) isEnd =
      newLength pre + mapPoint suffix offset isEnd := by
  induction pre with
  | nil => simp
  | cons piece rest ih =>
    cases piece with
    | keep text =>
      simp only [Valid] at valid
      simp only [List.cons_append, oldLength_keep, newLength_keep, mapPoint]
      split
      · have hz : oldLength rest = 0 ∧ offset = 0 := by omega
        have hr := ih valid
        simp only [hz.1, hz.2, Nat.zero_add, mapPoint_zero] at hr
        have he : newLength rest = 0 := by simpa using hr.symm
        simp [hz, he]
      · have hs : text.length + oldLength rest + offset - text.length = oldLength rest + offset := by omega
        rw [hs, ih valid]
        omega
    | replace old fresh =>
      obtain ⟨ho, hn, valid⟩ := valid
      simp only [List.cons_append, oldLength_replace, newLength_replace, mapPoint]
      split
      · omega
      · split
        · omega
        · have hs : old.length + oldLength rest + offset - old.length = oldLength rest + offset := by omega
          rw [hs, ih valid]
          omega

def slice (text : Units) (start stop : Nat) : Units := (text.drop start).take (stop - start)

@[simp] theorem before_append (pre post : Plan) : before (pre ++ post) = before pre ++ before post := by
  induction pre with
  | nil => simp [before]
  | cons piece rest ih => cases piece <;> simp [before, ih, List.append_assoc]

@[simp] theorem after_append (pre post : Plan) : after (pre ++ post) = after pre ++ after post := by
  induction pre with
  | nil => simp [after]
  | cons piece rest ih => cases piece <;> simp [after, ih, List.append_assoc]

theorem slice_inside (pre text post : Units) (start stop : Nat) (bound : stop ≤ text.length) :
    slice (pre ++ (text ++ post)) (pre.length + start) (pre.length + stop) = slice text start stop := by
  simp only [slice, List.drop_append]
  rw [List.drop_eq_nil_of_le (by omega : pre.length ≤ pre.length + start)]
  simp only [List.nil_append, Nat.add_sub_cancel_left]
  rw [List.take_append_of_le_length (by simp only [List.length_drop]; omega)]
  congr 1
  omega

/-- An anchor wholly contained in an unchanged run keeps its precise UTF-16 text.
It may be before, between, or after any number of replacements. -/
theorem unchanged_quote (pre post : Plan) (text : Units) (start stop : Nat)
    (valid : Valid pre) (ordered : start ≤ stop) (bound : stop ≤ text.length) :
    slice (after (pre ++ .keep text :: post))
      (mapPoint (pre ++ .keep text :: post) (oldLength pre + start) false)
      (mapPoint (pre ++ .keep text :: post) (oldLength pre + stop) true) =
    slice (before (pre ++ .keep text :: post)) (oldLength pre + start) (oldLength pre + stop) := by
  rw [mapPoint_append pre _ _ _ valid, mapPoint_append pre _ _ _ valid]
  have hs : start ≤ text.length := by omega
  simp only [mapPoint, ite_eq_left hs, ite_eq_left bound, after_append, before_append, after, before]
  unfold newLength oldLength
  rw [slice_inside _ _ _ _ _ bound, slice_inside _ _ _ _ _ bound]

/-- A nonempty old anchor wholly inside one matched run expands to its entire
replacement, including when either endpoint was in the interior. -/
theorem intersecting_quote (pre post : Plan) (old fresh : Units) (start stop : Nat)
    (valid : Valid pre) (ordered : start < stop) (bound : stop ≤ old.length) :
    slice (after (pre ++ .replace old fresh :: post))
      (mapPoint (pre ++ .replace old fresh :: post) (oldLength pre + start) false)
      (mapPoint (pre ++ .replace old fresh :: post) (oldLength pre + stop) true) = fresh := by
  rw [mapPoint_append pre _ _ _ valid, mapPoint_append pre _ _ _ valid]
  have hs : start < old.length := by omega
  have hz : stop ≠ 0 := by omega
  have hstart : mapPoint (.replace old fresh :: post) start false = 0 := by
    simp only [mapPoint, ite_eq_left hs, Bool.false_eq_true, ite_false]
    split <;> rfl
  have hend : mapPoint (.replace old fresh :: post) stop true = fresh.length := by
    simp only [mapPoint, ite_eq_right hz, ite_true]
    split
    · rfl
    · have he : stop = old.length := by omega
      simp [he]
  rw [hstart, hend]
  simp only [Nat.add_zero, after_append, after]
  unfold newLength
  have h := slice_inside (after pre) fresh (after post) 0 fresh.length (by omega)
  simpa only [slice, List.drop_zero, List.take_length, Nat.add_zero, Nat.sub_zero] using h

def positions : Plan → Nat → List (Nat × Nat)
  | [], _ => []
  | .keep text :: rest, cursor => positions rest (cursor + text.length)
  | .replace old _ :: rest, cursor => (cursor, cursor + old.length) :: positions rest (cursor + old.length)

def OrderedFrom (cursor : Nat) : List (Nat × Nat) → Prop
  | [] => True
  | (start, stop) :: rest => cursor ≤ start ∧ start < stop ∧ OrderedFrom stop rest

theorem ordered_weaken (spans : List (Nat × Nat)) (left right : Nat)
    (h : left ≤ right) (ordered : OrderedFrom right spans) : OrderedFrom left spans := by
  cases spans with
  | nil => trivial
  | cons first rest => obtain ⟨hs, he, hr⟩ := ordered; exact ⟨by omega, he, hr⟩

/-- The chunk model's match coordinates are ordered, positive-width, disjoint. -/
theorem ordered_matches (plan : Plan) (cursor : Nat) (valid : Valid plan) :
    OrderedFrom cursor (positions plan cursor) := by
  induction plan generalizing cursor with
  | nil => trivial
  | cons piece rest ih =>
    cases piece with
    | keep text =>
      exact ordered_weaken _ cursor (cursor + text.length) (by omega) (ih _ valid)
    | replace old fresh =>
      obtain ⟨ho, hn, hr⟩ := valid
      exact ⟨by omega, by omega, ih _ hr⟩

theorem bounded_matches (plan : Plan) (cursor : Nat) (valid : Valid plan) :
    ∀ matchSpan ∈ positions plan cursor, matchSpan.2 ≤ cursor + oldLength plan := by
  induction plan generalizing cursor with
  | nil => simp [positions]
  | cons piece rest ih =>
    cases piece with
    | keep text =>
      intro span hm
      have hb := ih (cursor + text.length) valid span hm
      simp only [oldLength_keep]
      omega
    | replace old fresh =>
      obtain ⟨ho, hn, hr⟩ := valid
      intro span hm
      simp only [positions, List.mem_cons] at hm
      simp only [oldLength_replace]
      rcases hm with he | hm
      · simp only [he]; omega
      · have hb := ih (cursor + old.length) hr span hm
        omega

/-- Public replacement skips mapping when the item operation is disabled or
when this segment's replacement text is unchanged. -/
def effectivePlan (enabled : Bool) (plan : Plan) : Plan :=
  if enabled = false ∨ before plan = after plan then [.keep (before plan)] else plan

theorem effective_valid (enabled : Bool) (plan : Plan) (valid : Valid plan) :
    Valid (effectivePlan enabled plan) := by
  unfold effectivePlan
  split
  · trivial
  · exact valid

theorem effective_noop (enabled : Bool) (plan : Plan) (offset : Nat) (isEnd : Bool)
    (skip : enabled = false ∨ before plan = after plan) :
    mapPoint (effectivePlan enabled plan) offset isEnd = offset := by
  simp only [effectivePlan, ite_eq_left skip, mapPoint]
  split <;> omega

theorem effective_before (enabled : Bool) (plan : Plan) :
    before (effectivePlan enabled plan) = before plan := by
  unfold effectivePlan
  split <;> simp [before]

end Hearwise.NameInterval
