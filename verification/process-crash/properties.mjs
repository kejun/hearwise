// KEJ-65 requirement cards. Evidence is computed from the final report, not here.
export const specification = { id: 'hearwise-process-crash', version: '1.0', registryVersion: 1 };
const shared = {
  group: 'HW-04', version: 1,
  preconditions: '真实隔离应用进程、同一SQLite文件、独立且不会随应用被杀的HTTP供应商账本；固定合法输入、可用密钥、一个自动周期。只在四个已握手active边界SIGKILL，随后启动新PID。',
  assumptions: '最多一次全进程崩溃；关系1 actor自由响应与故障，3 actors/CAP1或2使用固定响应脚本；知识1或2顺序分片、每片两个sourceIndex槽、自由响应和一次性故障。请求/提交/恢复期间虚拟时钟不前进。',
  owners: ['工作流与存储维护者', 'Quint/进程重放与证据维护者', '发布与验收负责人'],
  methods: ['quint-typecheck', 'quint-deterministic-witness', 'quint-seeded-simulation', 'tlc-finite-complete',
    'apalache-bounded', 'itf-sigkill-fresh-pid-sqlite-workflow-replay', 'independent-http-ledger', 'model-and-implementation-negative-controls'],
  implementation: ['storage.mjs', 'relation-storage.mjs', 'knowledge-workflow.mjs', 'knowledge-queue.mjs', 'relation-workflow.mjs', 'relation-queue.mjs'],
  assets: ['verification/process-crash/config.json', 'verification/process-crash/relation-protocol.qnt', 'verification/process-crash/knowledge-protocol.qnt',
    'verification/process-crash/configurations.qnt', 'verification/process-crash/witnesses.qnt', 'test-support/process-crash-adapter.mjs',
    'test-support/process-crash-worker.mjs', 'test-support/process-crash-knowledge-worker.mjs', 'test-support/process-crash-relation-worker.mjs',
    'test-support/process-crash-fixture.mjs', 'test/process-crash-lock.test.mjs', 'test/process-crash-trace.test.mjs', 'test/process-crash-replay.test.mjs', 'docs/process-crash-verification.md'],
  issues: ['KEJ-65'],
  invalidatedBy: ['恢复构造顺序、持久预算/阶段/事务提交边界或调度器截止时间变化', '付费调用、结果sourceIndex去重或通知语义变化',
    '模型、全局进程边界、projection、ITF驱动、配置、工具链与证据校验变化'],
  evidenceStatus: 'not_run'
};
export const properties = [
  {
    ...shared, id: 'HW-04-10', title: '全进程终止后的保守预留与预算保留',
    requirement: '预留后未发送、发送后结果未知和收到结果未提交时，真正终止整个工作进程；恢复不能清零持久预留。独立供应商累计调用始终不超过持久预留；预算耗尽的恢复路径不再外呼，且仍可无外呼收敛。',
    consequence: '把已预留或结果未知的尝试清零会产生无账可查的重付费；耗尽预算的pending阶段若无无调用终结路径会永久卡住。',
    state: 'processState/generation、关系counts/calls、知识initial_requests/repair_reserved/extra_requests/protocol_retries、持久retry_kind与last_request_at；reservation-history ghost不用于实现恢复。',
    domain: '最多一次全局crash，关系ACTORS={0}/{0,1,2}及CAP1/2；知识PARTS={0}/{0,1}、共享extra<=2/protocol<=1、每片repair<=1。',
    acceptance: ['KEJ-65 AC-P03', 'KEJ-65 AC-P04'],
    modelInvariants: ['processDomain', 'budgetBeforeSend', 'durableReservationHistory', 'requestLimit', 'sharedBudget', 'protocolBudget', 'repairBudget', 'recoverableProgress'],
    deterministicWitnesses: ['normalSuccessTest', 'relationSentUnknownCrashTest', 'relationReceivedUncommittedCrashTest',
      'relationExhaustedReservationCrashTest', 'relationExhaustedSentCrashTest', 'knowledgeReservedCrashTest', 'knowledgeSentUnknownCrashTest',
      'knowledgeReceivedUncommittedCrashTest', 'knowledgeExhaustedReservedCrashTest', 'knowledgeExhaustedSentCrashTest',
      'knowledgeExhaustedReceivedCrashTest', 'knowledgeProtocolBudgetCrashTest', 'knowledgeExhaustedNextPartTest'],
    negativeControls: [{ main: 'mutant_relation_reset_on_recovery', expectedViolation: 'durableReservationHistory' },
      { main: 'mutant_knowledge_reset_on_recovery', expectedViolation: 'durableReservationHistory' }],
    gaps: ['不能从SIGKILL推出断电、磁盘损坏或硬件缓存持久性保证；没有供应商幂等键，结果丢失后的新预算调用可能重复供应商工作。']
  },
  {
    ...shared, id: 'HW-04-11', title: '提交前后、纠正中断与已接受结果保留',
    requirement: '已返回但尚未提交的响应随进程消失，不能假装持久化。已提交结果在首通知前崩溃仍保留，恢复不重复应用或付费重跑。知识repair_inflight恢复为done并保留repair_reserved=1、已接受条目、未解目标及REPAIR_INTERRUPTED诊断；后续分片仍能处理。',
    consequence: '重用丢失响应、重发一次性纠正或重复应用sourceIndex会伪造结果、丢失部分进度、重复更新事实或重复付费。',
    state: '知识accepted/unresolved/anchored/initial_complete与apply_counts/accepted_ever ghost；关系relations/outcome、已提交job状态；两域volatile replies恢复清none。',
    domain: '四个边界都含知识初始请求与纠正；关系全局并发进程；COMMIT返回后同步文件握手，在第一结果通知之前阻塞全部JS。',
    acceptance: ['KEJ-65 AC-P04', 'KEJ-65 AC-P05'],
    modelInvariants: ['recoveredVolatileCleared', 'acceptedPreserved', 'sourceIndexExactlyOnce', 'completedInitialNotRepeated', 'resultConsistency', 'terminalOutcome'],
    deterministicWitnesses: ['relationCommittedBeforeNotifyCrashTest', 'relationCap1RetainedCommittedTest', 'relationGlobalTwoInflightCrashTest',
      'relationGlobalReservedAndCommittedCrashTest', 'knowledgeCommittedBeforeNotifyCrashTest', 'knowledgeRepairReservedCrashTest',
      'knowledgeRepairSentUnknownCrashTest', 'knowledgeRepairReceivedUncommittedCrashTest', 'knowledgeRepairCommittedCrashTest',
      'knowledgeRetainedFirstPartCrashTest', 'knowledgeRepairInterruptedNextPartTest', 'knowledgeCommittedFirstPartCrashTest'],
    negativeControls: [{ main: 'mutant_knowledge_reapply_committed', expectedViolation: 'sourceIndexExactlyOnce' }],
    gaps: ['没有通知outbox，不承诺恢复后补发遗漏通知或通知exactly-once；关系多actor只穷举固定脚本的合法交错。']
  },
  {
    ...shared, id: 'HW-04-12', title: '恢复后的可继续执行与存储故障诊断边界',
    requirement: '恢复保留待重试分类和截止时间，按真实调度器到期后继续。所有知识part已done但job尚pending时必须无外呼settle，预算耗尽必须无外呼settle_exhausted。一次性预留/提交失败与通知异常不能伪装成网络重试；真实SQLite写失败或锁必须有明确证据和诊断。',
    consequence: '恢复后直接捏造terminal会掩盖调度器死锁；错误分类或忽略2000毫秒间隔会多付费；吞掉BUSY会把未完成任务报成功。',
    state: 'stage与durable phase分离、job outcome、ready、持久last_request_at/ready_at/rate_limit_until；真实SQLite错误码和终结写入结果。',
    domain: '固定虚拟时钟，advance_time才跳真实持久截止点；模型存储故障是一次性且随后终结写入可用，真实锁检查与此假设分开。',
    acceptance: ['KEJ-65 AC-P05', 'KEJ-65 AC-P06'],
    modelInvariants: ['continuationWaits', 'recoverableProgress', 'terminalOutcome', 'budgetBeforeSend'],
    deterministicWitnesses: ['knowledgeCommittedBeforeNotifyCrashTest', 'knowledgeProtocolBudgetCrashTest', 'knowledgeExhaustedNextPartTest',
      'knowledgePostRecoveryCommitFailureTest', 'knowledgePostRecoveryNotifyFailureTest', 'relationPostRecoveryCommitFailureTest'],
    gaps: ['持续SQLITE_BUSY、磁盘写满或终结写入持续失败不在有限模型的安全终结保证内；必须明确报告真实测试发现，不能用可写故障桩替代持续锁。',
      'ready抽象不证明真实墙钟公平性、慢响应恰好越过截止时间或任意延时分布。']
  },
  {
    ...shared, id: 'HW-04-13', title: '独立进程轨迹与有界验证证据',
    requirement: '每个固定崩溃见证导出原生ITF并逐动作驱动实际scheduler/workflow/SQLite；SIGKILL确认旧PID退出后才新PID恢复，父HTTP账本与readonlySQLite独立观察。TLC只有完整有限枚举且queue=0算通过；Apalache报告具体深度，负例须包含实际合法模型轨迹和首差异。',
    consequence: '同进程close/reopen、模型预期驱动数据库、只看局部passed日志或把超时当成功会制造没有实现意义的保证。',
    state: '模型lastAction/actor/response、processState/generation；实际pid/exit signal、握手marker、真实数据库投影、HTTP累计账本和首差异prefix。',
    domain: 'config.json五个独立main、29条固定ITF见证及固定种子模拟；旧KEJ-63/64完整域、性质和证据仍需独立运行。',
    acceptance: ['KEJ-65 AC-P03', 'KEJ-65 AC-P04', 'KEJ-65 AC-P05', 'KEJ-65 AC-P06'],
    modelInvariants: ['processDomain', 'concurrencyLimit', 'finiteDomain'],
    deterministicWitnesses: ['normalSuccessTest', 'relationGlobalTwoInflightCrashTest', 'knowledgeCommittedBeforeNotifyCrashTest', 'knowledgeRepairInterruptedNextPartTest'],
    gaps: ['固定测试、随机模拟、有限穷举、指定深度BMC和真实进程重放分别标注，任一项不能冒充无限域证明或M1全部验收。',
      '开发期成本日志不是干净已提交源码的发布证据；最终门禁必须重新核对源码摘要与所有执行终态。']
  }
];
