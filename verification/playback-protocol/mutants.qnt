module mutant_old_callback {
  import protocol(OWNERS = Set(1, 2, 3), MAX_PCM = 1, CONTROL_ABA = false, TRACK_ACTIONS = true, MUTATION = "old_callback").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}

module mutant_accepted_loss {
  import protocol(OWNERS = Set(1), MAX_PCM = 2, CONTROL_ABA = false, TRACK_ACTIONS = true, MUTATION = "accepted_loss").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}

module mutant_wrong_frame {
  import protocol(OWNERS = Set(1), MAX_PCM = 2, CONTROL_ABA = false, TRACK_ACTIONS = true, MUTATION = "wrong_frame").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}

module mutant_seek_unpaused {
  import protocol(OWNERS = Set(1, 2, 3), MAX_PCM = 1, CONTROL_ABA = false, TRACK_ACTIONS = true, MUTATION = "seek_unpaused").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
