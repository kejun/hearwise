module single {
  import protocol(TOKENS = Set(0), MAX_GENERATIONS = 2, MAX_WRITES = 2, MAX_RESTARTS = 1, MAX_FAILURES = 1, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module two_tokens {
  import protocol(TOKENS = Set(0, 1), MAX_GENERATIONS = 2, MAX_WRITES = 2, MAX_RESTARTS = 1, MAX_FAILURES = 1, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_skip_version {
  import protocol(TOKENS = Set(0), MAX_GENERATIONS = 2, MAX_WRITES = 2, MAX_RESTARTS = 1, MAX_FAILURES = 1, MUTATION = "skip_version").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_skip_expiry {
  import protocol(TOKENS = Set(0), MAX_GENERATIONS = 2, MAX_WRITES = 2, MAX_RESTARTS = 1, MAX_FAILURES = 1, MUTATION = "skip_expiry").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_retain_token {
  import protocol(TOKENS = Set(0), MAX_GENERATIONS = 2, MAX_WRITES = 2, MAX_RESTARTS = 1, MAX_FAILURES = 1, MUTATION = "retain_token").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
