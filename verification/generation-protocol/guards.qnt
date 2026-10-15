module knowledge_guards {
  import generation_protocol(ACTORS = Set(0, 1, 2), CAP = 2, PROTOCOL = "knowledge", MUTATION = "none", TRACE = true).* from "./protocol"
  run noUnreservedSendTest = init.then(send(0).fail())
  run noCancelledSendTest = init.then(reserve(0)).then(cancel(0)).then(send(0).fail())
  run noThirdGenerationTest = init.then(reserve(0)).then(send(0)).then(cancel(0)).then(newGeneration(0))
    .then(reserve(0)).then(send(1)).then(cancel(0)).then(newGeneration(0).fail())
  run noRestartRecreationTest = init.then(deleteListening(0)).then(restart).then(reserve(0).fail())
  run noSecondBusinessCallbackTest = init.then(reserve(0)).then(send(0)).then(respond(0, "ok"))
    .then(respond(0, "ok").fail())
  run noNewGenerationWithoutCancelTest = init.then(newGeneration(0).fail())
  run oneKnowledgeTaskPerListeningTest = init.then(reserve(0)).then(send(0)).then(reserve(2).fail())
}
module relation_guards {
  import generation_protocol(ACTORS = Set(0, 1, 2), CAP = 2, PROTOCOL = "relation", MUTATION = "none", TRACE = true).* from "./protocol"
  run noUnreservedSendTest = init.then(send(0).fail())
  run noCancelledSendTest = init.then(reserve(0)).then(cancel(0)).then(send(0).fail())
  run noThirdGenerationTest = init.then(reserve(0)).then(send(0)).then(cancel(0)).then(newGeneration(0))
    .then(reserve(0)).then(send(1)).then(cancel(0)).then(newGeneration(0).fail())
  run noRestartRecreationTest = init.then(deleteListening(0)).then(restart).then(reserve(0).fail())
  run noSecondBusinessCallbackTest = init.then(reserve(0)).then(send(0)).then(respond(0, "ok"))
    .then(respond(0, "ok").fail())
  run noNewGenerationWithoutCancelTest = init.then(newGeneration(0).fail())
}
