// KEJ-64 requirements and evidence scope, not pass records.
// HW-04-01 is the original relation pilot; KEJ-63 owns HW-04-02..05.
export const specification = {
  id: 'hearwise-knowledge-protocol', version: '1.0', registryVersion: 1
};

const shared = {
  group: 'HW-04', version: 1,
  preconditions: '进程持续存活，一个知识任务、一个或两个顺序分片、不可变合法 focus_refs、可用密钥；供应商使用确定性桩，真实 SQLite 与知识调度器执行检查点。',
  assumptions: '模型只含一个 automatic cycle；每次合法响应均可自由选择，无固定多分片响应脚本。TLC 仅覆盖声明有限域；Apalache 仅覆盖所选 profile 的深度；时间只抽象为未到期/到期，provider/commit 期间不前进，advance_time 才跳持久截止时间。',
  owners: ['模块维护者：知识工作流与持久投影', '验证维护者：Quint、重放与证据', '发布负责人：范围与证据门禁'],
  methods: ['quint-typecheck', 'quint-deterministic-witness', 'quint-seeded-simulation', 'tlc-finite-complete',
    'apalache-bounded', 'itf-real-sqlite-scheduler-workflow-replay', 'focused-persistence-recovery'],
  implementation: ['knowledge-workflow.mjs', 'knowledge-queue.mjs', 'storage.mjs', 'knowledge.mjs'],
  assets: ['verification/knowledge-protocol/protocol.qnt', 'verification/knowledge-protocol/configurations.qnt',
    'verification/knowledge-protocol/witnesses.qnt', 'test-support/knowledge-protocol-adapter.mjs',
    'scripts/lib/knowledge-protocol-replay.mjs', 'scripts/lib/protocol-replay.mjs',
    'test/knowledge-protocol-replay.test.mjs', 'test/knowledge-checkpoint.test.mjs', 'test/knowledge-workflow.test.mjs'],
  issues: ['KEJ-64'],
  invalidatedBy: ['知识请求与纠正预算、重试分类、持久阶段、sourceIndex 应用或通知语义变化',
    '模型、投影、驱动、配置、工具链或证据校验变化', '供应商响应和纠正锚点契约变化'],
  evidenceStatus: 'not_run'
};

export const properties = [
  {
    ...shared,
    id: 'HW-04-06',
    title: '知识调用前预留与共享周期预算',
    requirement: '每次抽取或纠正调用前先持久预留；预留事务失败不调用供应商。同一自动周期的额外抽取最多两次、协议错误重试最多一次；所有分片共享这两个预算，每个分片独立最多一次纠正，纠正不消耗 extra_requests。',
    consequence: '把分片预算误作独立预算、在调用后记账或让纠正挤占额外抽取额度会造成额外付费或过早放弃。',
    state: 'progress.extra_requests/protocol_retries/cycle、每分片 initial_requests/repair_reserved、独立供应商 extract_calls/repair_calls。',
    domain: 'PARTS={0} 与 PARTS={0,1}；初始/纠正预留失败、所有合法响应和故障选择；单一自动周期。',
    acceptance: ['KEJ-64 AC-P01', 'KEJ-64 AC-P02'],
    modelInvariants: ['budgetBeforeSend', 'sharedBudget', 'protocolBudget', 'repairBudget', 'oneAutomaticCycle'],
    deterministicWitnesses: ['normalSuccessTest', 'initialReserveFailureTest', 'repairReserveFailureTest',
      'sharedExtraBudgetTest', 'sharedProtocolBudgetTest', 'independentRepairBudgetTest'],
    gaps: ['重开数据库保留预算与人工重试开启新周期由真实实现补充测试覆盖；模型本身没有崩溃或新周期转换。',
      '不证明任意分片数量、多任务共享密钥准入或调度公平性。']
  },
  {
    ...shared,
    id: 'HW-04-07',
    title: '已接受结果保留与定向一次纠正',
    requirement: '初始已接受条目在纠正前可见，后续分片和失败不能丢失或重复应用。已提交 sourceIndex 至多应用一次；纠正只处理带锚点的未解目标，无目标不调用；有效空初始响应正常 empty 完成，空纠正保留未解目标；全部分片完成后的 outcome 必须等于完整结果判定，包含先前初始失败分片。',
    consequence: '全批重放或错误纠正目标会重复更新事实、丢失已接受结果或把正常空结果误作失败。',
    state: '每分片 accepted/unresolved/anchored 的 sourceIndex 集合、initial_complete；历史集合与应用次数 ghost；真实结果、事实与 content_version。',
    domain: '每分片最多两个 sourceIndex 槽：初始有效 slot0，partial 的未解 slot1；全拒绝/无锚点使用 slot0。纠正成功、空、协议或暂态失败。',
    acceptance: ['KEJ-64 AC-P02', 'KEJ-64 AC-P10'],
    modelInvariants: ['repairTargets', 'acceptedPreserved', 'sourceIndexExactlyOnce', 'completedInitialNotRepeated', 'terminalOutcome'],
    deterministicWitnesses: ['partialRepairSuccessTest', 'allRejectedRepairSuccessTest', 'partialRepairEmptyTest',
      'allRejectedRepairEmptyTest', 'partialRepairErrorTest', 'unrepairableTest', 'emptyResultTest', 'retainedFirstPartTest',
      'initialFailureThenNextTest'],
    negativeControls: [{ main: 'mutant_wrong_terminal_outcome', expectedViolation: 'terminalOutcome' }],
    gaps: ['集合与计数模型不证明自然语言语义质量、任意身份冲突或超过两个条目的响应；真实 sourceIndex 去重另有 SQLite 回归断言。']
  },
  {
    ...shared,
    id: 'HW-04-08',
    title: '付费响应后存储与通知故障边界',
    requirement: '成功付费响应后的存储异常不得自动重发抽取或纠正；调度器按已接受结果收敛 partial/invalid。成功提交后的通知异常不得回滚结果、修改既有预算或触发新付费请求。',
    consequence: '将存储或通知错误误分为网络重试会重复付费、重复写入或隐藏已保存的部分结果。',
    state: 'observational stage 与 durable phase 分开；received 后 commit、commit_fail、commit_notify_failure；真实 job outcome 和独立调用数。',
    domain: '初始和纠正成功响应后的单次事务故障；提交与同步通知在同一模型动作中完成，通知回调可抛错。',
    acceptance: ['KEJ-64 AC-P05', 'KEJ-64 AC-P06'],
    modelInvariants: ['acceptedPreserved', 'sourceIndexExactlyOnce', 'terminalOutcome', 'budgetBeforeSend'],
    deterministicWitnesses: ['initialCommitFailureTest', 'repairCommitFailureTest', 'secondPartCommitFailureTest',
      'initialNotifyFailureTest', 'repairNotifyFailureTest', 'rejectedNotifyFailureTest'],
    gaps: ['只覆盖故障后失败终态可以持久写入的环境；不覆盖持续磁盘故障、真实进程终止或未捕获 context.event 异常的全部位置。']
  },
  {
    ...shared,
    id: 'HW-04-09',
    title: '错误分类、混合预算与分片冷却',
    requirement: '协议与暂态重试共享 extra_requests，协议重试另受一次上限；认证配置错误终止未完成分片，429 保留冷却，过长 Retry-After 不自动重试。第二分片及纠正调用满足至少2000毫秒间隔和现有冷却。',
    consequence: '混合错误或跨分片重置预算会突破自动付费上限；忽略间隔/冷却会重复撞限。',
    state: 'retry_kind、replies、全局 ready、持久 ready_at/last_request_at/rate_limit_until、注入时钟和调度器返回的下一次到期时间。',
    domain: '协议/暂态双向混合、重复协议、重复暂态、auth、429、Retry-After>300000；纠正429后仍须等待的第二分片。',
    acceptance: ['KEJ-64 AC-P09'],
    modelInvariants: ['sharedBudget', 'protocolBudget', 'continuationWaits', 'terminalOutcome'],
    deterministicWitnesses: ['protocolLimitTest', 'transientLimitTest', 'mixedProtocolThenTransientTest',
      'mixedTransientThenProtocolTest', 'authTerminalTest', 'authStopsRemainingTest', 'authAfterAcceptedTest',
      'rateLimitThenSuccessTest', 'retryAfterOverLimitTest', 'sequentialPartsIntervalTest',
      'repairRateLimitNextPartTest', 'repairLongCooldownNextPartTest'],
    gaps: ['有限模型只表示到期前不能准入；精确毫秒和持久冷却由真实时钟注入与重开数据库测试覆盖，不构成多任务共享密钥公平性的证明；慢响应已越过2000毫秒而可即时续执行的时序不在当前时间域。']
  }
];
