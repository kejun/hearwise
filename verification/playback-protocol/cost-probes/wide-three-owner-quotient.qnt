// Archived wider development probe. NOT part of the passing finite-domain plan.
module isolation_complete {
  import protocol(OWNERS = Set(1, 2, 3), MAX_PCM = 1, CONTROL_ABA = false, TRACK_ACTIONS = false, MUTATION = "none").* from "../protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
