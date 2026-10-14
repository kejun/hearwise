module translation_small {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2), CAP = 2, FAIR_CYCLE = false, MUTATION = "none").* from "./translation"
  action Init = init
  action Step = step
  val Safety = safety
}
module translation_alias {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 1), CAP = 2, FAIR_CYCLE = false, MUTATION = "none").* from "./translation"
  action Init = init
  action Step = step
  val Safety = safety
}
module translation_soft_cap {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2), CAP = 2, FAIR_CYCLE = false, MUTATION = "none").* from "./translation"
  action Init = init
  action Step = step
  val Safety = safety
}
