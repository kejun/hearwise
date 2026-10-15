// Trace labels retained so model-checker counterexamples can be diagnosed.
module mutant_relation_skip_reservation {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "relation", MUTATION = "skip_reservation", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_relation_skip_generation_guard {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "relation", MUTATION = "skip_generation_guard", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_knowledge_skip_reservation {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "knowledge", MUTATION = "skip_reservation", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_knowledge_skip_generation_guard {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "knowledge", MUTATION = "skip_generation_guard", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
