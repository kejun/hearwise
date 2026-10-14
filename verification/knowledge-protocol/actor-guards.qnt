// A response/commit belongs to the in-flight part captured by the workflow,
// never an earlier completed part. These are disabled-action regressions;
// they are not exported as implementation replay steps.
module actor_guards {
  import protocol(PARTS = Set(0, 1), MUTATION = "none").* from "./protocol"
  run wrongResponseActorTest = init.then(admit(0)).then(send(0)).then(respond(0, "rate_limit_long"))
    .then(advanceTime).then(admit(1)).then(send(1)).then(respond(0, "protocol").fail())
  run wrongCommitActorTest = init.then(admit(0)).then(send(0)).then(respond(0, "rate_limit_long"))
    .then(advanceTime).then(admit(1)).then(send(1)).then(respond(1, "ok")).then(commit(0).fail())
  run wrongCommitFailureActorTest = init.then(admit(0)).then(send(0)).then(respond(0, "rate_limit_long"))
    .then(advanceTime).then(admit(1)).then(send(1)).then(respond(1, "ok")).then(commitFail(0).fail())
}
