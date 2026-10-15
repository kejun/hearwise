module knowledge_reservation_negative {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "knowledge", MUTATION = "skip_reservation", TRACE = true).* from "./protocol"
  run reservationGuardKilledTest = init.then(reserve(0)).then(send(0))
    .expect(not(safety) and not(budgetBeforeSend) and calls.get(0) == 1 and reserved.get(0) == 0)
}
module knowledge_generation_negative {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "knowledge", MUTATION = "skip_generation_guard", TRACE = true).* from "./protocol"
  run generationGuardKilledTest = init.then(reserve(0)).then(send(0)).then(cancel(0)).then(newGeneration(0))
    .then(reserve(0)).then(send(1)).then(respond(0, "ok"))
    .expect(not(safety) and not(generationIsolation) and activeOwner.get(0) == 1 and business.get(0) == Set(0))
  run staleFailureGuardKilledTest = init.then(reserve(0)).then(send(0)).then(cancel(0)).then(newGeneration(0))
    .then(reserve(0)).then(send(1)).then(respond(0, "failed"))
    .expect(not(safety) and not(generationIsolation) and activeOwner.get(0) == 1 and outcome.get(0) == "failed")
}
module relation_reservation_negative {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "relation", MUTATION = "skip_reservation", TRACE = true).* from "./protocol"
  run reservationGuardKilledTest = init.then(reserve(0)).then(send(0))
    .expect(not(safety) and not(budgetBeforeSend) and calls.get(0) == 1 and reserved.get(0) == 0)
}
module relation_generation_negative {
  import generation_protocol(ACTORS = Set(0), CAP = 1, PROTOCOL = "relation", MUTATION = "skip_generation_guard", TRACE = true).* from "./protocol"
  run generationGuardKilledTest = init.then(reserve(0)).then(send(0)).then(cancel(0)).then(newGeneration(0))
    .then(reserve(0)).then(send(1)).then(respond(0, "ok"))
    .expect(not(safety) and not(generationIsolation) and activeOwner.get(0) == 1 and business.get(0) == Set(0))
  run staleFailureGuardKilledTest = init.then(reserve(0)).then(send(0)).then(cancel(0)).then(newGeneration(0))
    .then(reserve(0)).then(send(1)).then(respond(0, "failed"))
    .expect(not(safety) and not(generationIsolation) and activeOwner.get(0) == 1 and outcome.get(0) == "failed")
}
