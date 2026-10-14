module mutant_knowledge_cleanup {
  import knowledge(JOBS = Set(0, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = false, INITIAL_BUSY = false, MUTATION = "leak_cleanup").* from "./knowledge"
  action Init = init
  action Step = coreStep
  val Safety = safety
}
module mutant_knowledge_busy {
  import knowledge(JOBS = Set(0, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = false, INITIAL_BUSY = false, MUTATION = "revoke_on_busy").* from "./knowledge"
  action Init = init
  action Step = coreStep
  val Safety = safety
}
module mutant_knowledge_readiness {
  import knowledge(JOBS = Set(0, 1, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = false, INITIAL_BUSY = true, MUTATION = "ignore_ready").* from "./knowledge"
  action Init = init
  action Step = coreStep
  val Safety = safety
}
