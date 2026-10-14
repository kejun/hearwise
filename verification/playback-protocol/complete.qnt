module single_complete {
  import protocol(OWNERS = Set(1), MAX_PCM = 2, CONTROL_ABA = false, TRACK_ACTIONS = false, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}

module pair_complete {
  import protocol(OWNERS = Set(1, 2), MAX_PCM = 1, CONTROL_ABA = false, TRACK_ACTIONS = false, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}

module aba_complete {
  import protocol(OWNERS = Set(1, 2, 3), MAX_PCM = 0, CONTROL_ABA = true, TRACK_ACTIONS = false, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
