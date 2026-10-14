// Requirement cards, not completed verification records.
const shared = {
  group: 'HW-04', version: 1, issues: ['KEJ-66'], evidenceStatus: 'not_run',
  preconditions: '两协议的合成合法输入，真实 scheduler/workflow/SQLite；供应商由可忽略 abort 的确定性桩控制。',
  assumptions: '八个原始安全域完整有限枚举；预算域与并发代次域分开。真实重放采用显式 provider permit 的固定 ready refinement，不证明一般调度公平性。',
  owners: ['业务维护者：实现映射', '验证维护者：模型、原始证据与门禁', '发布负责人：M1范围'],
  methods: ['tlc-finite-complete', 'apalache-bounded', 'quint-native-itf', 'seeded-simulation', 'real-runtime-sqlite-replay', 'isolated-implementation-mutation'],
  implementation: ['knowledge-queue.mjs', 'knowledge-workflow.mjs', 'relation-queue.mjs', 'relation-workflow.mjs', 'relation-storage.mjs', 'storage.mjs', 'src/server/runtime/tasks.ts'],
  assets: ['verification/generation-protocol/protocol.qnt', 'verification/generation-protocol/replay-refinement.qnt', 'test-support/generation-protocol-adapter.mjs', 'scripts/lib/generation-protocol-evidence.mjs'],
  invalidatedBy: ['取消/删除/代次或预算语义变化', '模型、refinement、实际驱动、工具链或门禁变化'],
  gaps: ['不证明第三代次、无限任务或任意时间精度', '无供应商exactly-once保证；物理请求可多于本地槽', 'runtime重建不替代KEJ-65 SIGKILL；旧宿主callback不能跨进程死亡存活']
};
export const properties = [
  { ...shared, id: 'HW-04-14', title: '取消释放本地所有权并隔离迟到工作', acceptance: ['KEJ-66 AC-P07'],
    requirement: '供应商忽略取消时仍释放逻辑槽，其他合法任务可继续；旧响应不得写入业务结果。',
    consequence: '逻辑槽泄漏阻塞后续任务，取消后写入破坏用户操作。',
    state: '实际runtime注册、execute结算、物理Promise、SQLite预算和业务表。',
    domain: '知识/关系、单任务及双收听三任务、CAP1/2、两代；另有无许可节流的真实矩阵。' },
  { ...shared, id: 'HW-04-15', title: '新代次所有权与原attempt使用量隔离', acceptance: ['KEJ-66 AC-P08'],
    requirement: '同收听新job或round启动后，旧回调不能修改新预算/数据/资源；允许的迟到usage仅归原attempt。',
    consequence: '旧cleanup会清理新任务或错记付费使用量。', state: '不可变job/epoch/attempt、activeOwner、外部回调顺序与独立SQLite账本。',
    domain: '乱序成功/失败、重复Promise resolve、重复onUsage、两收听隔离与物理请求超过本地CAP。' },
  { ...shared, id: 'HW-04-16', title: '在途删除与公开查询不复活', acceptance: ['KEJ-66 AC-P11'],
    requirement: '删除时在途的旧工作不能复活记录；重建后持久库与独立server公开detail/graph保持删除。',
    consequence: '用户删除的数据会因迟到响应重新出现。', state: '真实删除、所有业务表、同库身份、新server PID/退出与HTTP200/404正文。',
    domain: '删除前后响应、删除后先重建再响应、已提交成功后静止重建与继续准入。' },
  { ...shared, id: 'HW-04-17', title: '预算和旧上下文守卫负例检错能力', acceptance: ['KEJ-66 AC-P12'],
    requirement: '真实省略预留和唯一旧事务guard变体均被驱动检出，正常源码同轨迹通过；原模型负控有实际checker反例。',
    consequence: '只执行正确样例会把漏掉关键约束的门禁误当安全保证。', state: '首差异prefix、原/变体源码SHA、精确替换anchor、实际SQLite与返回值。',
    domain: '两协议预留负控；关系定向旧上下文事务调用负控；知识已接受事实内容负控；四个模型checkermutant。' }
];
