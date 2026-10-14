module knowledge_core {
  import knowledge(JOBS = Set(0, 1, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = false, INITIAL_BUSY = false, MUTATION = "none").* from "./knowledge"
  action Init = init
  action Step = coreStep
  val Safety = safety
}
module knowledge_deadlines {
  import knowledge(JOBS = Set(0), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = false, INITIAL_BUSY = false, MUTATION = "none").* from "./knowledge"
  action Init = init
  action Step = step
  val Safety = safety
}
module knowledge_cooldown_shared {
  import knowledge(JOBS = Set(0, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 0), FAIR_CYCLE = false, INITIAL_BUSY = true, MUTATION = "none").* from "./knowledge"
  action Init = init
  action Step = cooldownStep
  val Safety = safety
}
module knowledge_cooldown_separate {
  import knowledge(JOBS = Set(0, 2), KEY_FOR_SESSION = Map(0 -> 0, 1 -> 1), FAIR_CYCLE = false, INITIAL_BUSY = true, MUTATION = "none").* from "./knowledge"
  action Init = init
  action Step = cooldownStep
  val Safety = safety
}
