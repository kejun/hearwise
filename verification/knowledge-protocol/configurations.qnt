module single {
  import protocol(PARTS = Set(0), MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module two_parts {
  import protocol(PARTS = Set(0, 1), MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_send_without_reserve {
  import protocol(PARTS = Set(0), MUTATION = "send_without_reserve").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_third_extra {
  import protocol(PARTS = Set(0), MUTATION = "third_extra").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_accepted_loss {
  import protocol(PARTS = Set(0), MUTATION = "accepted_loss").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_wrong_terminal_outcome {
  import protocol(PARTS = Set(0), MUTATION = "wrong_terminal_outcome").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
