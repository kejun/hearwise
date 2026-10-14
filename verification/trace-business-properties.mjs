const definitions = [
  ['HW-15-02', '业务查询与 Trace 身份终态', '翻译、知识、关系、播报的身份、终态与实际 SQLite/API/WS 查询一致；重试、继续、取消、旧代次和重复迟到使用量不被当作新成功。',
    '11 个工作流场景、4 个完整 HTTP/WS 场景；正常空/过滤/部分/失败恢复/旧代次/重复反馈与迟到账本',
    ['src/server/diagnostics/business.ts', 'src/server/diagnostics/report.ts', 'knowledge-workflow.mjs', 'relation-workflow.mjs', 'server.mjs', 'speech-service.mjs']],
  ['HW-15-03', '通知及诊断故障隔离', '同步通知与诊断回调异常不改变已提交结果、不泄漏逻辑槽、不触发重复供应商请求；sent 只证明同步回调完成。',
    '实际关系/知识回调抛错与内存sink失败；真实server翻译WebSocket发送抛错和speech metric抛错；service onDispose抛错后head/连接释放及新owner工作',
    ['relation-workflow.mjs', 'knowledge-workflow.mjs', 'src/server/runtime/diagnostics.ts', 'server.mjs', 'speech-service.mjs']],
  ['HW-15-04', '实际任务报告下钻', '离线浏览器从业务域、活动及任务到对应底层事件；缺失与未知采集明确可见，未关联请求不伪造归属。',
    '桌面/390px Chromium；五业务域、6种状态、任务/事件身份、输入缺口、导出、零网络请求',
    ['scripts/trace-report.mjs', 'scripts/trace-report-view.mjs', 'src/server/diagnostics/business.ts']],
  ['HW-15-05', 'Trace 证据及检错能力', '必需业务快照、源码和附件必须齐全且一致；中断、旧源码、旧埋点和伪造计数不可通过；两种真实源码变异必须被实际查询对照检出。',
    '固定2个编译生产源码变异；来源/缺失/中断/版本/计数/附件负例与Node-only未运行边界',
    ['test-support/trace-business-evidence.mjs', 'test-support/trace-business-negative.mjs', 'scripts/verify-trace-business-browser.mjs']]
];
export const traceBusinessProperties = definitions.map(([id, title, requirement, domain, implementation]) => ({
  id, group: 'HW-15', version: 1, title, requirement, domain, implementation,
  consequence: '误报业务成功、错误归属或过期证据会误导用户恢复和发布决策。',
  preconditions: '当前默认追踪开启；临时真实SQLite和本地供应商；合成数据，无真实密钥或付费调用。',
  state: '持久业务查询、独立调用账本、Trace事件、运行资源、报告DOM和源码/附件摘要',
  assumptions: '同步通知成功不是客户端收到；播放完成是客户端回执，不是实际听测；JSONL无结束清单保持完整性未知。',
  owners: ['KEJ-84 实施与独立审查者：场景和实现映射', '发布负责人：真实环境、质量与最终验收'],
  methods: ['real-sqlite-workflow', 'stub-provider', 'implementation-mutation', ...(id === 'HW-15-04' ? ['automated-chromium'] : [])],
  assets: ['test-support/trace-business-worker.mjs', 'test/trace-business-workflow.test.mjs', 'test/trace-business-boundary.test.mjs', 'test/trace-notification-boundary.test.mjs'],
  issues: ['KEJ-84'], invalidatedBy: ['源码、依赖、追踪或业务契约、性质、环境变化'], acceptance: [requirement],
  gaps: ['有限固定场景，不是任意执行可重放、真实供应商质量或设备播放完成证明；其他未合分支不得由本证据代签。'], evidenceStatus: 'not_run'
}));
export const traceBusinessProfile = traceBusinessProperties.map(property => property.id);
export const traceBusinessNodeProfile = traceBusinessProfile.filter(id => id !== 'HW-15-04');
