module mutant_interim_admission {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2), CAP = 2, FAIR_CYCLE = false, MUTATION = "interim_queue_only").* from "./translation"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_final_cleanup {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2), CAP = 2, FAIR_CYCLE = false, MUTATION = "leak_final").* from "./translation"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_interim_cleanup {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2), CAP = 2, FAIR_CYCLE = false, MUTATION = "leak_interim").* from "./translation"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_interim_total {
  import translation(TOKENS = Set(0, 1, 2), BACKGROUND = Set(0), IDENTITIES = Map(0 -> 0, 1 -> 1, 2 -> 2), CAP = 2, FAIR_CYCLE = false, MUTATION = "interim_ignore_total").* from "./translation"
  action Init = init
  action Step = step
  val Safety = safety
}
