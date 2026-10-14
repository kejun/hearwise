module relation_single {
  import relation_protocol(ACTORS = Set(0), CAP = 1, SCRIPTED = false, MAX_CRASHES = 1, MUTATION = "none").* from "./relation-protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module relation_multi_cap1 {
  import relation_protocol(ACTORS = Set(0, 1, 2), CAP = 1, SCRIPTED = true, MAX_CRASHES = 1, MUTATION = "none").* from "./relation-protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module relation_multi_cap2 {
  import relation_protocol(ACTORS = Set(0, 1, 2), CAP = 2, SCRIPTED = true, MAX_CRASHES = 1, MUTATION = "none").* from "./relation-protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module knowledge_single {
  import knowledge_protocol(PARTS = Set(0), MAX_CRASHES = 1, MUTATION = "none").* from "./knowledge-protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module knowledge_two_parts {
  import knowledge_protocol(PARTS = Set(0, 1), MAX_CRASHES = 1, MUTATION = "none").* from "./knowledge-protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_relation_reset_on_recovery {
  import relation_protocol(ACTORS = Set(0), CAP = 1, SCRIPTED = false, MAX_CRASHES = 1, MUTATION = "reset_on_recovery").* from "./relation-protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_knowledge_reset_on_recovery {
  import knowledge_protocol(PARTS = Set(0), MAX_CRASHES = 1, MUTATION = "reset_on_recovery").* from "./knowledge-protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_knowledge_reapply_committed {
  import knowledge_protocol(PARTS = Set(0), MAX_CRASHES = 1, MUTATION = "reapply_committed").* from "./knowledge-protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
