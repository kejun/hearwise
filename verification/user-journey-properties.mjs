// Inventory only. A card is passed only by independently re-reading the complete
// continuous browser profile; synthetic reader unit fixtures are not acceptance.
const definitions = [
  ['HW-11-06', '连续收听身份与内容闭环', '从空库经实际开始、ASR、翻译、知识、图谱、改名、播放到历史重开，身份与完整内容连续一致。',
    '每宽度一个真实 SQLite，两个 UI 创建的收听，原文与译文独立预期、图谱锚点与完整无关记录保留'],
  ['HW-11-07', '冲突与不确定保存恢复', '真实竞争页面的旧修订被拒绝且不隐式重试；提交后丢响应查回执或保留禁用草稿，重开反映持久结果。',
    '双页面 409、提交成功后 502、回执可用与不可用、显式重存和关闭重开、漏刷新生产副本负例'],
  ['HW-11-08', '取消迟到与删除后继续', '取消正在等待的真实供应商请求后新任务可完成；旧请求物理完成不改新状态；删除记录仅经显式备份导入恢复。',
    '旧关系请求保持等待、新公开生成任务完成、旧请求释放和已关闭传输、UI 删除确认与显式恢复'],
  ['HW-11-09', '备份导入迁移连续性', '实际下载的 SQLite 字节经实际文件输入导入；旧预览与过期令牌不写入；明确再次确认追加保留完整本地同 ID 记录。',
    '两次真实导出、完整库投影、竞争备注修改、409、生产过期回调与 410、重新上传、辅助及主记录原身份恢复'],
  ['HW-11-10', '旅程键盘与窄屏恢复', '桌面与窄屏的开始、保存、暂停跳转与恢复可键盘操作，错误后草稿、焦点和可见控件可用。',
    '1280/390px、Enter 开始与保存、暂停状态跳转和继续、编辑器尺寸、逐阶段截图与 DOM 状态']
];
export const userJourneyProperties = definitions.map(([id, title, requirement, domain]) => ({
  id, group: 'HW-11', version: 1, title, requirement, domain,
  consequence: '跨功能状态断裂、误判保存或备份成功、丢失内容或错误归属。',
  preconditions: '本地合成供应商，无付费服务；真实 Chromium、服务和临时 SQLite；主路径只用公开 UI 操作。',
  state: '收听/run/条目身份、全库检查点、DOM、HTTP/WebSocket、供应商物理状态、备份字节、显式用户操作',
  assumptions: '合成供应商只证明声明的跨层操作；HTTP 取消后的物理完成不等同于应用收到旧回调。',
  owners: ['KEJ-85 实施与审查者：连续旅程与原始证据', '发布负责人：同源码依赖及外部验收'],
  methods: ['real-http-websocket-sqlite', 'automated-chromium', 'stub-provider', 'production-copy-negative'],
  implementation: ['public/app.js', 'public/knowledge-editor.js', 'public/knowledge-graph.js', 'public/speech-controller.js', 'server.mjs', 'storage.mjs', 'data-transfer.mjs'],
  assets: ['test-support/user-journey-browser.mjs', 'scripts/lib/user-journey-evidence.mjs', 'test/user-journey-evidence.test.mjs'],
  issues: ['KEJ-85'], invalidatedBy: ['UI、身份、编辑、供应商取消、播放、持久化、迁移或源码环境变化'],
  acceptance: [requirement, '原始字段和导出字节由独立读取器重建，不能由布尔汇总或准备测试代替'],
  gaps: ['真实供应商质量、实体设备和性能仍为独立 not_run 项。', 'KEJ-66 同源码有限模型及真实旧代次回调证据、KEJ-75 播放代次证据须独立附于完整发布验收。'],
  evidenceStatus: 'not_run'
}));
export const userJourneyProfile = userJourneyProperties.map(property => property.id);
