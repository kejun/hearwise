// Full unchanged product-budget domain; no envelope retry-budget reduction.
module knowledge_budget {
  import protocol(PARTS = Set(0, 1), MUTATION = "none").* from "../knowledge-protocol/protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
