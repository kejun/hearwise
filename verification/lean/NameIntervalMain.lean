import NameInterval
import Lean.Data.Json

open Lean Hearwise.NameInterval
open Hearwise.Revision (Units)

def parseUnits (json : Json) (key : String) : Except String Units := do
  let values ← json.getObjValAs? (List Nat) key
  unless values.all (· ≤ 65535) do throw "invalid UTF-16 unit"
  return values

def parsePlan (text target : Units) (json : Json) : Except String Plan := do
  if target.isEmpty then throw "replacement must be nonempty"
  let spans ← json.getObjValAs? (List Json) "matches"
  let mut cursor := 0
  let mut pieces : Array Piece := #[]
  for span in spans do
    let start ← span.getObjValAs? Nat "start"
    let stop ← span.getObjValAs? Nat "end"
    unless cursor ≤ start && start < stop && stop ≤ text.length do
      throw "spans must be ordered, disjoint, positive, and in bounds"
    pieces := pieces.push (.keep (slice text cursor start))
    pieces := pieces.push (.replace (slice text start stop) target)
    cursor := stop
  return (pieces.push (.keep (text.drop cursor))).toList

def evaluate (json : Json) : Except String Json := do
  let text ← parseUnits json "text"
  let target ← parseUnits json "target"
  let plan ← parsePlan text target json
  let enabled ← json.getObjValAs? Bool "enabled"
  let applied := effectivePlan enabled plan
  let anchors ← json.getObjValAs? (List Json) "anchors"
  let mapped ← anchors.mapM fun anchor => do
    let start ← anchor.getObjValAs? Nat "start"
    let stop ← anchor.getObjValAs? Nat "end"
    unless start < stop && stop ≤ text.length do throw "anchor must be nonempty and within the old text"
    let first := mapPoint applied start false
    let last := mapPoint applied stop true
    return Json.mkObj [("start", toJson first), ("end", toJson last),
      ("quote", toJson (slice (after applied) first last))]
  return Json.mkObj [("old", toJson (before plan)), ("text", toJson (after applied)), ("rawText", toJson (after plan)),
    ("matches", toJson ((positions plan 0).map fun (start, stop) =>
      Json.mkObj [("start", toJson start), ("end", toJson stop)])), ("anchors", toJson mapped)]

def main (args : List String) : IO UInt32 := do
  match args with
  | [input, output] =>
    let text ← IO.FS.readFile input
    let file ← IO.FS.Handle.mk output .write
    for line in text.splitOn "\n" do
      unless line.isEmpty do
        match Json.parse line >>= evaluate with
        | .ok result => file.putStrLn result.compress
        | .error message =>
          (← IO.getStderr).putStrLn message
          return 1
    return 0
  | _ =>
    (← IO.getStderr).putStrLn "Usage: name_interval_oracle INPUT.ndjson OUTPUT.ndjson"
    return 1
