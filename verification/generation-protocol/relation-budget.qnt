// Full unchanged product-budget domain; no envelope retry-budget reduction.
module relation_budget {
  import protocol(ACTORS = Set(0), CAP = 1, SCRIPTED = false, MUTATION = "none").* from "../relation-protocol/protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
