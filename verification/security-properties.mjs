const definitions = [
  ['HW-12-02', '凭据运行与导出隔离', '合成凭据只进入声明输入/内存和目标供应商 Authorization；正常、错误、重启后的日志、Trace、SQLite、备份及导出不含哨兵。',
    ['server.mjs', 'knowledge.mjs', 'speech-service.mjs', 'qwen-tts.mjs', 'fish-tts.mjs', 'data-transfer.mjs'],
    ['test/security-credentials.test.mjs', 'test/security-persistence.test.mjs', 'test/security-speech.test.mjs', 'test/security-negative.test.mjs']],
  ['HW-12-03', '外部文本持久化展示隔离', '恶意原文、模型译文/卡片、名称、别名、背景、标题与备注保存后重新展示，不执行脚本、不插入非预期节点、不发起探测请求；真实渲染变异被检出。',
    ['public/app.js', 'public/knowledge-editor.js', 'public/knowledge-graph.js', 'public/knowledge-graph-renderer.js'], ['test-support/security-browser.mjs']],
  ['HW-12-04', '外部请求与来源边界', '非法形状/长度、跨收听子身份与跨源写入拒绝；现有同源/无Origin及代理协议规则保持；WS输入/供应商错误不终止服务。',
    ['server.mjs', 'storage.mjs', 'knowledge-edit.mjs', 'speech-service.mjs', 'qwen-tts.mjs'],
    ['test/security-http.test.mjs', 'test/security-websocket-limit.test.mjs', 'test/security-websocket-shape.test.mjs', 'test/security-provider-shape.test.mjs']],
  ['HW-12-05', '浏览器凭据与错误反馈隔离', '浏览器仅在约定masked input/localStorage持有合成Key；业务DOM、错误、控制台、HTTP/WS响应与导出不出现哨兵，失败后可恢复。',
    ['public/app.js', 'public/knowledge-editor.js', 'server.mjs'], ['test-support/security-browser.mjs']]
];
export const securityProperties = definitions.map(([id, title, requirement, implementation, assets]) => ({
  id, group: 'HW-12', version: 1, title, requirement, consequence: '凭据泄露、外部内容执行、服务崩溃或跨收听错误修改。',
  preconditions: '本机隔离服务、真实 SQLite、本地合成供应商及已锁定 Chromium；只使用显式公开测试哨兵。',
  state: '授权输入/内存、业务表、错误/日志/Trace、SQLite/文字导出、实际浏览器 DOM 与网络',
  domain: '固定合成哨兵UTF-8/UTF-16扫描；401/429/503；原始/模型/编辑文本，1个渲染和1个错误回显变异；无/同/异Origin，非法JSON形状和载荷上限+1。',
  assumptions: '应用默认loopback且无账号鉴权；远程部署须自行配置HTTPS/访问控制并可信处理Host/X-Forwarded-Proto。无Origin允许，不作为身份认证。',
  owners: ['KEJ-82 实施与审查者：边界及回归', '部署负责人：访问控制、凭据存储与实际环境'],
  methods: ['real-http-websocket', 'real-sqlite', 'synthetic-provider', 'targeted-implementation-mutation', ...(id === 'HW-12-03' || id === 'HW-12-05' ? ['automated-chromium'] : [])],
  implementation, assets, issues: ['KEJ-82'], acceptance: [requirement],
  invalidatedBy: ['凭据/供应商错误/日志/Trace/持久化/导出/渲染/请求边界变更', '依赖、工具、性质或部署前提变化'],
  gaps: ['不是任意攻击输入、浏览器/OS/网络的安全证明；不检测刻意放入业务正文/ID的秘密或任意编码隐写；远程认证/TLS、真实Key、真实音频/供应商和实体设备不在此夹具范围。'],
  evidenceStatus: 'not_run'
}));
export const securityProfile = securityProperties.map(row => row.id);
export const securityNodeProfile = ['HW-12-02', 'HW-12-04'];
