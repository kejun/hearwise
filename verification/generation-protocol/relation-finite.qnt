// Only action-observation labels are erased; every semantic choice remains.
module relation_single_finite {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "relation", MUTATION = "none", TRACE = false).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module relation_multi_cap1_finite {
  import generation_protocol(ACTORS = Set(0, 1, 2), CAP = 1, PROTOCOL = "relation", MUTATION = "none", TRACE = false).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
module relation_multi_cap2_finite {
  import generation_protocol(ACTORS = Set(0, 1, 2), CAP = 2, PROTOCOL = "relation", MUTATION = "none", TRACE = false).* from "./protocol"
  action Init = init
  action Step = step
  val Safety = safety
}
