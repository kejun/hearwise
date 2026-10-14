// Trace-enabled semantic model instances.
module relation_single {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "relation", MUTATION = "none", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module relation_multi_cap1 {
  import generation_protocol(ACTORS = Set(0, 1, 2), CAP = 1, PROTOCOL = "relation", MUTATION = "none", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module relation_multi_cap2 {
  import generation_protocol(ACTORS = Set(0, 1, 2), CAP = 2, PROTOCOL = "relation", MUTATION = "none", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module knowledge_single {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "knowledge", MUTATION = "none", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module knowledge_multi_cap1 {
  import generation_protocol(ACTORS = Set(0, 1, 2), CAP = 1, PROTOCOL = "knowledge", MUTATION = "none", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module knowledge_multi_cap2 {
  import generation_protocol(ACTORS = Set(0, 1, 2), CAP = 2, PROTOCOL = "knowledge", MUTATION = "none", TRACE = true).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
