// Fixed protocol scenarios, not exhaustive ASR/MT quality or real-device evidence.
const definitions = [
  ['HW-01-02', '最终片段身份与终态边界', 'run + sentence ID 首次定稿唯一；冲突保留首次定稿并提示；终态前尾句接受，终态后片段拒绝。',
    '同/跨 run 同 ID、重复/冲突 final、task-finished 同批晚到', ['server.mjs', 'storage.mjs'], ['test/session-consistency.test.mjs'], false],
  ['HW-01-03', '采集失败恢复与跨会话隔离', '权限拒绝不建记录；断连可恢复；停止释放麦克风；旧 transport 事件不改变新收听。',
    '1280/390px Chromium、一次拒绝后允许、断开重连、新收听、旧 socket 回调', ['public/app.js', 'server.mjs'], ['test-support/session-browser.mjs'], true],
  ['HW-02-02', '翻译提交绑定持久原文', '旧成功/失败响应不能修改已变更原文的片段；显式重试使用新原文；持久修订与页面文本一致。',
    '两个在途尝试、后发失败、合法改名、旧成功晚到、显式重试、SQLite 重开', ['server.mjs', 'storage.mjs', 'knowledge-name-replacement.mjs'], ['test/session-consistency.test.mjs', 'test-support/session-browser.mjs'], true],
  ['HW-02-03', '字幕修订与重复上下文', '重复上下文不增加确认；深度重写和更短 Unicode 最终文本可替换；停止尾句译文可补齐。',
    '固定中间上下文/重复/增长/重写/缩短轨迹与 😀 UTF-16 边界', ['public/caption-frontier.js', 'public/app.js'], ['test/caption-frontier.test.mjs', 'test/interim-translation-ui.test.mjs', 'test-support/session-browser.mjs'], true],
  ['HW-11-02', '聆听恢复操作可见可用', '桌面与窄屏权限错误、断连反馈、键盘重试及停止按钮可用，无横向溢出。',
    '1280×950/390×950、键盘开始、失败后开始、继续/新建收听与停止', ['public/app.js', 'public/index.html'], ['test-support/session-browser.mjs'], true]
];
export const sessionProperties = definitions.map(([id, title, requirement, domain, implementation, assets, browser]) => ({
  id, group: id.slice(0, 5), version: 1, title, requirement,
  consequence: '字幕错误归属、来源与译文不一致或错误后无法继续使用。',
  preconditions: '合法收听/改名/显式重试；隔离真实 SQLite、本地合成 ASR/MT，禁用付费服务。',
  state: '收听与 run 身份、持久原文及修订、译文状态、可见字幕与麦克风 track', domain,
  assumptions: '首次 final 不可覆写；较短最终文本指 interim→final；同内容原文视为同版本，无新增数据库字段。',
  owners: ['KEJ-74 实施与审查者：场景及实现映射', '发布负责人：设备与质量独立验收'],
  methods: ['real-sqlite-workflow', 'stub-provider', ...(browser ? ['automated-chromium'] : [])], implementation, assets, issues: ['KEJ-74'],
  invalidatedBy: ['ASR/MT 协议、身份、停止、持久化、字幕、页面或环境变更', '性质或规范版本变更'],
  acceptance: [requirement], gaps: ['真实 ASR/翻译质量、实体桌面与移动设备、时延和长期性能未由本协议夹具验收。'], evidenceStatus: 'not_run'
}));
export const sessionProfile = sessionProperties.map(property => property.id);
