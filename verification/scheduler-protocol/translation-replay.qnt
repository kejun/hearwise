module translation_replay {
  import translation(TOKENS = Set(0, 1, 2, 3), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2, 3 -> 3), CAP = 500, FAIR_CYCLE = false, MUTATION = "none").* from "./translation"
  action Init = init
  action Step = step
  val Safety = safety
}
module translation_alias_replay {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 1), CAP = 500, FAIR_CYCLE = false, MUTATION = "none").* from "./translation"
  action Init = init
  action Step = step
  val Safety = safety
}
