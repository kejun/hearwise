module two_current {
  import edit_protocol(CLIENTS = Set(0, 1), CODECS = Map(0 -> "v1", 1 -> "v1"),
    INITIAL_OVERRIDE = false, BACKGROUND = true, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module two_legacy {
  import edit_protocol(CLIENTS = Set(0, 1), CODECS = Map(0 -> "v11", 1 -> "v12"),
    INITIAL_OVERRIDE = false, BACKGROUND = true, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module v11_override {
  import edit_protocol(CLIENTS = Set(0), CODECS = Map(0 -> "v11"),
    INITIAL_OVERRIDE = true, BACKGROUND = true, MUTATION = "none").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_bypass_revision {
  import edit_protocol(CLIENTS = Set(0), CODECS = Map(0 -> "v1"),
    INITIAL_OVERRIDE = false, BACKGROUND = true, MUTATION = "bypass_revision").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module mutant_auto_revision_resend {
  import edit_protocol(CLIENTS = Set(0), CODECS = Map(0 -> "v1"),
    INITIAL_OVERRIDE = false, BACKGROUND = true, MUTATION = "auto_revision_resend").* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
