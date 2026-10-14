module knowledge_fair {
  import knowledge(JOBS = Set(0, 1, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = true, INITIAL_BUSY = true, MUTATION = "none").* from "./knowledge"
  action Init = init
  action Step = fairStep
  val Safety = safety
}
module mutant_knowledge_starvation {
  import knowledge(JOBS = Set(0, 1, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = true, INITIAL_BUSY = true, MUTATION = "starve_session").* from "./knowledge"
  action Init = init
  action Step = fairStep
  val Safety = safety
}
