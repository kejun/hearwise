module single {
  import protocol(ACTORS = Set(0), CAP = 1, SCRIPTED = false, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module multi_cap1 {
  import protocol(ACTORS = Set(0, 1, 2), CAP = 1, SCRIPTED = true, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module multi_cap2 {
  import protocol(ACTORS = Set(0, 1, 2), CAP = 2, SCRIPTED = true, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_send_without_reserve {
  import protocol(ACTORS = Set(0), CAP = 1, SCRIPTED = false, MUTATION = "send_without_reserve").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_retry_commit_failure {
  import protocol(ACTORS = Set(0), CAP = 1, SCRIPTED = false, MUTATION = "retry_commit_failure").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_fourth_request {
  import protocol(ACTORS = Set(0), CAP = 1, SCRIPTED = false, MUTATION = "fourth_request").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
