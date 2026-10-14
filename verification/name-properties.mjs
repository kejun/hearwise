import { properties as protocolProperties } from './name-protocol/properties.mjs';
export const nameProperties = [...protocolProperties.map(property => ({ ...property, group: 'HW-07',
  state: [...property.persistentState, ...property.memoryState].join(', '), owners: [property.owner], issues: ['KEJ-71'],
  assets: ['test/name-transaction.test.mjs', 'test/name-protocol-http.test.mjs', 'test/name-protocol-replay.test.mjs', 'test-support/name-protocol-browser.mjs'],
  acceptance: [property.requirement], gaps: ['Finite protocol and concrete synthetic SQLite/browser fixtures; no general SQL, real semantic quality or power-loss proof.'] })),
  { id: 'HW-11-05', group: 'HW-11', version: 1, title: '名称纠正结果与恢复操作一致',
    requirement: '双击不重复提交；失败保留输入；真实提交后丢响应可查回执或明确不确定；关闭重开、列表详情和图谱反映持久结果。',
    consequence: '用户重复改写、误判保存结果或看到不一致名称。', preconditions: '归档合成收听，真实HTTP/SQLite，本地无付费供应商。',
    state: '编辑草稿、busy/unknown、冻结修订、回执、列表和图谱', domain: '1280/390px、六场景、一次真实编辑器去busy保护负例。',
    assumptions: '同步数据库事务；浏览器证据独立于有限模型报告。', owners: ['KEJ-71 实施与审查者'],
    methods: ['real-http-sqlite', 'automated-chromium', 'production-copy-negative'], implementation: ['public/knowledge-editor.js', 'public/app.js', 'public/knowledge-graph.js'],
    assets: ['test-support/name-protocol-browser.mjs'], issues: ['KEJ-71'], invalidatedBy: ['编辑器、HTTP回执、名称事务、列表/图谱或验证环境变化'],
    acceptance: ['六场景桌面/窄屏实际通过，所有附件和原始HTTP/全表结果可核'], gaps: ['实体设备、无障碍专项和真实语义质量未覆盖。'], evidenceStatus: 'not_run' }
];
export const nameProfile = nameProperties.map(property => property.id);
