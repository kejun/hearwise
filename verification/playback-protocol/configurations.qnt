module single {
  import protocol(OWNERS = Set(1), MAX_PCM = 2, CONTROL_ABA = false, TRACK_ACTIONS = true, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}

module pair {
  import protocol(OWNERS = Set(1, 2), MAX_PCM = 1, CONTROL_ABA = false, TRACK_ACTIONS = true, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}

module aba {
  import protocol(OWNERS = Set(1, 2, 3), MAX_PCM = 0, CONTROL_ABA = true, TRACK_ACTIONS = true, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
