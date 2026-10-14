const definitions = [
  ['HW-15-10', '完整变更链与保守验证选择', '完整 Git 祖先链、每个合并父、改名删除及依赖变化决定影响域；未知变化扩大，普通文档不自动调用付费服务。',
    ['scripts/lib/verification-impact.mjs', 'verification/release/policy.mjs'], ['test/verification-impact.test.mjs']],
  ['HW-15-11', '原始技术证据独立复核', '当前源码的必需 Node、Chromium、Quint/实现桥、Lean/差分报告必须从完整日志和绑定附件复核；计数、缓存摘要与伪反例不能代替真实结果。',
    ['scripts/lib/release-evidence.mjs', 'scripts/lib/formal-release-evidence.mjs', 'scripts/lib/lean-report-evidence.mjs', 'scripts/lib/runner-report-evidence.mjs'],
    ['test/formal-release-evidence.test.mjs', 'test/verification-lean-report.test.mjs', 'test/runner-report-evidence.test.mjs']],
  ['HW-15-12', '历史适用性与完整发布失败关闭', '历史来源保留原 SHA，仅完整影响链和冻结上下文可继续适用；缺失失败不完整或质量门槛未冻结时拒绝完整项目通过。',
    ['scripts/lib/historical-release-evidence.mjs', 'scripts/lib/release-evidence.mjs'], ['test/release-evidence.test.mjs', 'scripts/release-demo.mjs']]
];
export const releaseProperties = definitions.map(([id, title, requirement, implementation, assets]) => ({
  id, group: 'HW-15', version: 1, title, requirement,
  consequence: '不完整或陈旧证据导致错误发布决定。', preconditions: '已知目标 Git 源码、受版本管理的配置和真实报告；历史证据原源仍可读取。',
  state: '源码/模型/工具/环境/参数/日志/附件/状态与原始来源', domain: '现有七类技术报告、全部十五业务领域及外部质量设备性能升级缺口',
  assumptions: '本地或 CI 执行者和 Git 仓库受信任；hash 防混淆与意外损坏，不是远程证明或防恶意全包伪造。',
  owners: ['KEJ-86 实施与审查者：门禁与原始证据', '发布负责人：真实外部验收与允许发布范围'],
  methods: ['git-history-analysis', 'raw-evidence-revalidation', 'negative-artifact-regression'], implementation, assets, issues: ['KEJ-86'],
  invalidatedBy: ['报告契约、源代码、模型、工具、配置、语料、阈值或环境变化', '影响域规则或依赖闭包变化'],
  acceptance: [requirement], gaps: ['门禁本身不补齐真实质量、物理设备、性能或升级恢复证据。'], evidenceStatus: 'not_run'
}));
