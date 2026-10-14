// These IDs also identify the separately gated Quint/HTTP replay evidence.
// A browser-profile pass is scoped to its recorded scenarios, not every method.
export const editConsistencyProperties = [
  ['HW-06-06', '并发修订与事务冲突', '同版客户端后到写入拒绝；冻结兼容规则保持；事务失败无部分写入；冲突只读刷新不自动重发。',
    'current、v11/v12、override、后台译文完成、全表回滚；真实双浏览器客户端及真实编辑器自动重发变体',
    ['knowledge-revision.mjs', 'knowledge-name-replacement.mjs', 'public/knowledge-editor.js']],
  ['HW-06-07', '保存不确定与迟到成功', '已提交的结果不被通知失败改成未保存；丢失/502且回执不可用时保留不确定；迟到成功后读取实际最新状态。',
    '真实COMMIT后通知错误、响应丢失/代理502、一次失败回执查询、迟到成功跨另一客户端提交',
    ['server.mjs', 'knowledge-name-replacement.mjs', 'public/knowledge-editor.js']],
  ['HW-11-04', '编辑失败后草稿与恢复操作', '失败/不确定时保留输入；关闭重开显示持久结果；显式继续保存、键盘和窄屏可用。',
    '1280/390px，五个真实页面场景；不确定时禁用重复写操作，关闭重开不写入，明确再次保存可成功',
    ['public/knowledge-editor.js', 'public/app.js', 'public/index.html']]
].map(([id, title, requirement, domain, implementation]) => ({
  id, group: id.slice(0, 5), version: 1, title, requirement, domain, implementation,
  consequence: '并发内容被静默覆盖，已提交被误报未保存，草稿丢失或错误后无法继续。',
  preconditions: '归档收听、隔离文件SQLite、本地HTTP代理、合成名称与来源；无供应商或真实凭据。',
  state: '当前/冻结revision、草稿、请求、事务与回执、通知、可见编辑器状态',
  assumptions: 'SQLite同步事务及通知栈不允许虚构HTTP交错；网络递送独立。关闭仅在非busy或既有后台polling状态允许。',
  owners: ['KEJ-69 实施与审查者'], methods: ['real-http-sqlite', 'automated-chromium', 'mutation-detection'],
  assets: ['test/edit-commit-notification.test.mjs', 'test/edit-protocol-http.test.mjs', 'test-support/edit-consistency-browser.mjs'],
  issues: ['KEJ-69'], invalidatedBy: ['编辑/修订/事务/回执/通知/页面行为变化', '性质、模型、夹具或环境变化'],
  acceptance: [requirement], gaps: ['浏览器profile不替代独立Quint检查；无无限重试、断电恢复、持久草稿或真实模型质量主张。'], evidenceStatus: 'not_run'
}));
export const editConsistencyProfile = editConsistencyProperties.map(property => property.id);
