// KEJ-63 property cards are separate from the original HW-04-01 pilot.
// These cards define requirements and evidence scope. They are not pass records.
export const specification = {
  id: 'hearwise-relation-protocol', version: '1.0', registryVersion: 1
};

const shared = {
  group: 'HW-04', version: 1,
  preconditions: '进程持续存活，来源和 epoch 不变；合成有效窗口、可用密钥、显式准入上限，供应商由确定性桩控制。',
  assumptions: 'CAP 是模型和重放环境的准入约束，不是对生产调度器公平性或任意供应商行为的证明。TLC 仅覆盖声明的有限域；Apalache 仅覆盖所选 profile 的深度。',
  owners: ['模块维护者：实现投影', '验证维护者：模型、驱动与证据', '发布负责人：范围与证据门禁'],
  methods: ['quint-typecheck', 'quint-deterministic-witness', 'quint-seeded-simulation', 'tlc-finite-complete', 'apalache-bounded', 'itf-real-sqlite-workflow-replay'],
  implementation: ['relation-workflow.mjs', 'relation-storage.mjs', 'relations.mjs'],
  assets: ['verification/relation-protocol/protocol.qnt', 'verification/relation-protocol/configurations.qnt',
    'verification/relation-protocol/witnesses.qnt', 'test-support/relation-protocol-adapter.mjs',
    'scripts/lib/protocol-replay.mjs', 'test/relation-protocol-replay.test.mjs'],
  issues: ['KEJ-63'],
  invalidatedBy: ['关系请求预算、重试分类、持久提交或通知语义变化', '模型、投影、驱动、工具链或配置变化', '供应商响应契约变化'],
  evidenceStatus: 'not_run'
};

export const properties = [
  {
    ...shared,
    id: 'HW-04-02',
    title: '关系请求预留与账本',
    requirement: '每次外部调用前，同 epoch 窗口请求计数与账本已持久增加；预留事务失败不能发起调用；窗口累计调用不超过三次。',
    consequence: '未预留即调用或预算重置会造成未记账付费请求和重试超额。',
    state: '每个 actor 的持久窗口累计计数、请求账本、独立供应商调用计数与异步阶段。',
    domain: '单任务三种初始化模式；双会话三窗口、cap1/cap2，固定异质响应脚本的全部模型交错。',
    acceptance: ['KEJ-63 AC-P01', 'KEJ-63 AC-P02'],
    modelInvariants: ['budgetBeforeSend', 'requestLimit', 'reserveFailureNoCharge', 'concurrencyLimit'],
    deterministicWitnesses: ['normalSuccessTest', 'reserveFailureTest', 'sequentialThreeTest', 'interleavedThreeTest', 'laterWindowDuringRetryTest'],
    gaps: ['不覆盖崩溃恢复、取消、删除、旧 epoch 或来源变化；准入 CAP 不构成对整个生产调度器的证明。']
  },
  {
    ...shared,
    id: 'HW-04-03',
    title: '关系重试边界与冷却',
    requirement: '协议错误仅在窗口累计请求数小于二时重试；暂态错误仅在累计请求数小于三时重试；认证错误及超过300000毫秒的Retry-After终止自动重试。冷却到期前不得再次准入该重试。',
    consequence: '分类或累计计数错误会扩大付费重试；忽略冷却会重复撞限。',
    state: 'counts、replies、retry_wait/idle、持久ready_at与注入时钟。',
    domain: '单任务自由响应类别及混合顺序；多任务固定protocol→ok、transient→empty、filtered脚本。逻辑时钟统一跳至待重试时间。',
    acceptance: ['KEJ-63 AC-P09'],
    modelInvariants: ['protocolLimit', 'terminalBudget', 'retryReadiness', 'requestLimit'],
    deterministicWitnesses: ['protocolLimitTest', 'transientLimitTest', 'mixedProtocolThenTransientTest',
      'mixedTransientThenProtocolTest', 'authTerminalTest', 'rateLimitThenSuccessTest', 'retryAfterOverLimitTest'],
    gaps: ['共享密钥冷却由独立真实实现补充测试覆盖，不属于本模型的多任务TLC域；不证明任意时间精度或调度公平性。']
  },
  {
    ...shared,
    id: 'HW-04-04',
    title: '响应后提交与通知',
    requirement: '已取得有效付费响应后，提交失败必须终止自动请求重试；提交成功后的通知失败不能撤销持久结果或触发新付费请求。',
    consequence: '把存储或通知错误当成网络错误会重复付费，或把已完成图谱误报为失败。',
    state: 'received、committed、done，真实SQLite事务结果、图谱关系数和业务outcome。',
    domain: '正常响应、提交前注入存储异常、提交后注入通知异常；进程持续存活且失败终态可以持久写入。',
    acceptance: ['KEJ-63 AC-P05', 'KEJ-63 AC-P06'],
    modelInvariants: ['paidResponseNoRetry', 'resultConsistency', 'budgetBeforeSend'],
    deterministicWitnesses: ['normalSuccessTest', 'commitFailureTest', 'notifyFailureTest'],
    gaps: ['不覆盖提交成功但进程随后崩溃、失败终态自身持续写入失败、取消或过时代次。']
  },
  {
    ...shared,
    id: 'HW-04-05',
    title: '正常空结果与候选不足',
    requirement: '有效空结果和全部过滤结果均正常完成，保留已消耗请求且不自动重试；候选不足进入waiting_nodes，不消耗请求且不是业务失败。',
    consequence: '把正常空结果当失败会产生无意义重试；把候选不足当终态失败会误导状态和计费判断。',
    state: '持久job/window状态、关系数、outcome、请求账本及候选不足时的无job状态。',
    domain: 'empty、filtered、no_candidates三个不同路径；filtered的业务outcome为空结果，replies保留其分类。',
    acceptance: ['KEJ-63 AC-P10'],
    modelInvariants: ['noCandidateNoCharge', 'resultConsistency', 'paidResponseNoRetry'],
    deterministicWitnesses: ['emptyResultTest', 'allFilteredTest', 'noCandidatesTest'],
    gaps: ['不证明真实供应商的关系语义质量或任意过滤原因；候选后续变化和唤醒属于其他范围。']
  }
];
