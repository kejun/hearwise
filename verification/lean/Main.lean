import Revision
import Lean.Data.Json

open Lean Hearwise.Revision

/-- Transport JSON is only a tagged AST. It never serializes business strings:
UTF-16 code units cross this boundary losslessly, including lone surrogates. -/
def parseScalar (json : Json) : Except String Scalar := do
  match ← json.getObjValAs? String "tag" with
  | "null" => return .null
  | "boolean" => return .boolean (← json.getObjValAs? Bool "value")
  | "integer" =>
    let value ← json.getObjValAs? Int "value"
    unless -9007199254740991 ≤ value && value ≤ 9007199254740991 do
      throw "integer exceeds exact JavaScript safe-integer domain"
    return .integer value
  | "text" =>
    let units ← json.getObjValAs? (List Nat) "units"
    unless units.all (· ≤ 65535) do throw "invalid UTF-16 code unit"
    return .text units
  | _ => throw "unknown scalar tag"

def parseRow (json : Json) : Except String Row := do
  let entries ← json.getArr?
  let fields ← entries.toList.mapM fun entry => do
    let values ← entry.getArr?
    unless values.size == 2 do throw "invalid row entry"
    let key ← values[0]!.getStr?
    let value ← parseScalar values[1]!
    return (key, value)
  unless (fields.map Prod.fst).eraseDups.length == fields.length do throw "duplicate row keys"
  return fun key => (fields.find? fun pair => pair.1 == key).map Prod.snd

def parseRows (json : Json) (key : String) : Except String (List Row) := do
  let rows ← json.getObjValAs? (List Json) key
  rows.mapM parseRow

def parseSnapshot (json : Json) : Except String Snapshot := do
  let item ← parseRow (← json.getObjVal? "item")
  let aliases ← (← json.getObjValAs? (List Json) "aliases").mapM parseScalar
  let mentions ← parseRows json "mentions"
  let revisions ← parseRows json "revisions"
  let facts ← parseRows json "facts"
  let segments ← parseRows json "segments"
  return ⟨item, aliases, mentions, revisions, facts, segments⟩

def main (args : List String) : IO UInt32 := do
  match args with
  | [input, output] =>
    let text ← IO.FS.readFile input
    let file ← IO.FS.Handle.mk output .write
    for line in text.splitOn "\n" do
      unless line.isEmpty do
        let result := do
          let json ← Json.parse line
          let snapshot ← parseSnapshot json
          return normalize snapshot
        match result with
        | .ok value => file.putStrLn ((toJson value).compress)
        | .error message =>
          (← IO.getStderr).putStrLn message
          return 1
    return 0
  | _ =>
    (← IO.getStderr).putStrLn "Usage: revision_oracle INPUT.ndjson OUTPUT.ndjson"
    return 1
