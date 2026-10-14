module independent {
  import name_protocol(MODE = "independent", MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module reuse {
  import name_protocol(MODE = "reuse", MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_fingerprint {
  import name_protocol(MODE = "reuse", MUTATION = "ignore_fingerprint").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_revision {
  import name_protocol(MODE = "independent", MUTATION = "bypass_revision").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_anchor {
  import name_protocol(MODE = "independent", MUTATION = "bypass_anchor").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_rollback {
  import name_protocol(MODE = "independent", MUTATION = "partial_rollback").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_receipt {
  import name_protocol(MODE = "independent", MUTATION = "receipt_without_commit").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
