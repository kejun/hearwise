// Finite structural/identity scenarios, never a real-model quality acceptance.
const definitions = [
  ['HW-05-02', '关系来源身份与持久完整性', '候选、收听、版本、UTF-16 区间与 quote 必须绑定合法来源；无效结果不破坏已有关系。',
    '真实解析/文件 SQLite/重开；错误来源、跨收听、陈旧修订、重复字句、同名歧义、Unicode、非法候选',
    ['relations.mjs', 'relation-evidence.mjs', 'relation-storage.mjs'],
    ['test/relations.test.mjs', 'test/relation-storage.test.mjs', 'test/relation-evidence-e2e.test.mjs'], false],
  ['HW-05-03', '关系终态与正常空结果', '候选不足、有效空数组和全过滤均正常完成且不补边或自动重试；否定/条件/计划结构保留；部分与失败仍保留已有图谱。',
    '六个真实 HTTP 场景及独立手工语义 corpus；源数据到业务查询、诊断统计和页面逐层核对',
    ['server.mjs', 'relation-workflow.mjs', 'relation-storage.mjs', 'public/knowledge-graph.js'],
    ['test/relation-result.test.mjs', 'test/fixtures/relation-evidence-corpus.mjs', 'test-support/relation-result-browser.mjs'], true],
  ['HW-11-03', '图谱空结果与问题提示可用', '桌面与窄屏保留独立节点；空关系不误报失败；部分完成和请求错误可辨认；页面来源及统计与持久查询一致。',
    '1280/390px Chromium，键盘启动，节点/关系列表、精确来源、数量诊断、部分/失败提示和无横向溢出',
    ['public/knowledge-graph.js', 'public/app.js'], ['test-support/relation-result-browser.mjs'], true]
];
export const relationResultProperties = definitions.map(([id, title, requirement, domain, implementation, assets, browser]) => ({
  id, group: id.slice(0, 5), version: 1, title, requirement,
  consequence: '错误来源支持关系、空结果重复付费或误报失败、已有图谱损坏。',
  preconditions: '合法归档收听、真实知识解析和持久 mentions；本地合成供应商与隔离 SQLite；无真实密钥。',
  state: '候选/来源/支持身份、关系及限定字段、窗口终态、诊断统计、可见独立节点', domain,
  assumptions: '关系契约 v3；来源内容 hash 与 JavaScript UTF-16；语义由手工夹具预先给出，不推断真实模型能力。',
  owners: ['KEJ-76 实施与审查者：场景及实现映射', '发布负责人：真实质量独立验收'],
  methods: ['real-sqlite-workflow', 'stub-provider', ...(browser ? ['automated-chromium'] : [])], implementation, assets, issues: ['KEJ-76'],
  invalidatedBy: ['关系契约、解析、来源、存储、页面、供应商或环境变化', '性质或规范版本变化'],
  acceptance: [requirement], gaps: ['结构合法但语义错误的真实模型输出、真实设备与质量评测未由该夹具验收。'], evidenceStatus: 'not_run'
}));
export const relationResultProfile = relationResultProperties.map(property => property.id);
