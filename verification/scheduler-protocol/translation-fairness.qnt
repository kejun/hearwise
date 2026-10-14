module translation_fair {
  import translation(TOKENS = Set(0, 1, 2, 3), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2, 3 -> 3), CAP = 4, FAIR_CYCLE = true, MUTATION = "none").* from "./translation"
  action Init = init
  action Step = fairStep
  val Safety = safety
}
module mutant_translation_starvation {
  import translation(TOKENS = Set(0, 1, 2, 3), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2, 3 -> 3), CAP = 4, FAIR_CYCLE = true, MUTATION = "starve_background").* from "./translation"
  action Init = init
  action Step = fairStep
  val Safety = finiteDomain and queuedIdentityUnique and lifecycle and sharedBudget
}
