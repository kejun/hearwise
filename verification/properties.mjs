import { upgradeProperties } from './upgrade-properties.mjs';
import { nameProperties } from './name-properties.mjs';
import { playbackProperties } from './playback-properties.mjs';
import { traceBusinessProperties } from './trace-business-properties.mjs';
import { securityProperties } from './security-properties.mjs';
import { editConsistencyProperties } from './edit-consistency-properties.mjs';
import { relationResultProperties } from './relation-result-properties.mjs';
import { sessionProperties } from './session-properties.mjs';
// Assets are inventory, never evidence. Split these seed cards as later issues add
// independently judged properties; do not expand a passing property's claim.
export const specification = { id: 'hearwise-enhanced-verification', version: '1.0', registryVersion: 1 };
export const pilot = ['HW-04-01'];
const cards = [
  ['HW-01', '音频与 ASR', '旧收听的迟到片段不能写入新收听；权限与断连错误可见。',
    '会话身份与片段', '权限拒绝、重连、重复 final、切换后晚到',
    ['server.mjs', 'storage.mjs'], ['test/asr-params.test.mjs', 'test/listening.test.mjs'], ['KEJ-74', 'KEJ-77', 'KEJ-79'],
    '真实 ASR 质量、采集设备与跨会话故障证据'],
  ['HW-02', '翻译与字幕', '只接受有效来源版本；重复上下文不虚增确认，最终文本允许缩短或重写。',
    '片段版本与字幕前沿', '旧请求晚到、相同上下文、深度改写、更短 final',
    ['server.mjs', 'public/caption-frontier.js'], ['test/caption-frontier.test.mjs', 'test/interim-translation-api.test.mjs'], ['KEJ-74', 'KEJ-77', 'KEJ-81'],
    '来源版本接线、真实翻译质量与端到端延迟'],
  ['HW-03', '调度', '按准入时条件启动并释放槽；只淘汰允许的后台任务；公平性须声明环境假设。',
    '等待队列、在途额度与任务所有权', '500/501、实时/后台竞争、限额下降、取消与异常',
    ['translation-queue.mjs', 'knowledge-queue.mjs', 'provider-admission.mjs'], ['test/translation-queue.test.mjs', 'test/knowledge-queue.test.mjs'], ['KEJ-67'],
    '服务共享额度、Quint 模型及条件公平性证据'],
  ['HW-04', '关系任务正常提交试点', '单窗口成功响应前已持久预留一次请求；一条关系落库，终态成功且无待执行任务。',
    'SQLite 关系任务、请求账本与图谱', '一个收听、一个窗口、两个节点、一条合成关系、一次成功响应',
    ['relation-workflow.mjs', 'relation-storage.mjs', 'relations.mjs'], ['test/relation-engine.test.mjs', 'test/relation-storage.test.mjs'], ['KEJ-62', 'KEJ-63', 'KEJ-64', 'KEJ-65', 'KEJ-66'],
    '试点之外的重试、知识预算、取消、代次与崩溃恢复仍需模型和实现桥接'],
  ['HW-05', '知识与关系结果', '有效空结果可完成；非法来源拒绝；已有关系保留；结构与语义质量分别判断。',
    '知识条目、关系与来源证据', '空数组、全部过滤、候选不足、否定、歧义、旧来源',
    ['knowledge.mjs', 'relations.mjs', 'relation-evidence.mjs'], ['test/relation-evidence-e2e.test.mjs', 'test/relation-semantic-boundaries.test.mjs'], ['KEJ-63', 'KEJ-76', 'KEJ-78'],
    '语义标注语料及冻结质量门槛，正常空结果跨层证据'],
  ['HW-06', '编辑与修订', '旧修订提交被拒绝；保存不确定时保留输入；兼容仅按冻结规则判断。',
    '规范化投影、修订与编辑草稿', '并发保存、后台更新、旧版指纹、502',
    ['knowledge-revision.mjs', 'knowledge-edit.mjs', 'public/knowledge-editor.js'], ['test/knowledge-revision.test.mjs', 'test/knowledge-edit.test.mjs'], ['KEJ-68', 'KEJ-69'],
    'Lean 规范化证明、公理审计、JavaScript 差分与并发 UI 证据'],
  ['HW-07', '名称纠正', '合法 UTF-16 区间映射保持文本对应；相关写入和回执原子提交；重复指纹幂等。',
    '锚点、原文、条目、操作回执', '长短替换、Unicode、旧锚点、重复操作、事务失败',
    ['knowledge-name-replacement.mjs', 'knowledge-name.mjs'], ['test/knowledge-name-replacement.test.mjs', 'test/knowledge-name.test.mjs'], ['KEJ-70', 'KEJ-71'],
    'Lean 区间证明、差分、事务与页面同步证据'],
  ['HW-08', '语音与播放', '失效代次帧不恢复播放；暂停跳转保持暂停；规范化可播报区间不重播漏播。',
    '播放代次、文本区间与缓冲帧', '停止、跳转、切换、尾段、重写、代次复用',
    ['speech-service.mjs', 'public/speech-controller.js', 'public/speech-player.js'], ['test/speech-integration.test.mjs', 'test/speech-media-session.test.mjs'], ['KEJ-75', 'KEJ-79'],
    '播放协议模型、代次边界和真实输出听测'],
  ['HW-09', '数据迁移', '备份成功后原子写入；append 保留完整本地同 ID 会话；旧预览令牌拒绝；不自动付费。',
    '备份、预览令牌、数据库版本与会话', 'restore/append、锁竞争、令牌过期复用、另一连接写入、进程终止',
    ['data-transfer.mjs', 'storage.mjs'], ['test/data-transfer.test.mjs', 'scripts/verify-data-transfer-browser.mjs'], ['KEJ-72', 'KEJ-73'],
    '预览提交模型、故障原子性与备份恢复证据'],
  ['HW-10', '隔离删除重启', '无跨收听写入、删除复活或旧任务清理新任务；恢复仅按持久阶段规则。',
    '收听身份、任务代次与持久检查点', '在途删除、旧回调、新代次、重启',
    ['relation-workflow.mjs', 'knowledge-workflow.mjs', 'storage.mjs'], ['test/effect-knowledge-cancellation.test.mjs', 'test/relation-engine.test.mjs'], ['KEJ-65', 'KEJ-66'],
    '实际进程终止、代次交错、模型反例重放'],
  ['HW-11', '完整交互', '主流程可完成；错误后可继续；草稿、焦点、窄屏与键盘操作符合交互契约。',
    '页面状态、草稿与焦点', '聆听到图谱、编辑、播放、历史和迁移，中途失败',
    ['public/index.html', 'public/knowledge-editor.js'], ['scripts/verify-knowledge-edit-browser.mjs', 'scripts/verify-speech-browser.mjs'], ['KEJ-69', 'KEJ-71', 'KEJ-85'],
    '完整用户旅程和无障碍/窄屏故障恢复证据'],
  ['HW-12', '安全隐私', '凭据不进入禁止位置；外部文本不执行脚本；输入和来源边界符合部署契约。',
    '密钥、日志、Trace、导出与外部文本', '密钥哨兵、恶意文本、非法请求',
    ['server.mjs', 'data-transfer.mjs', 'src/server/diagnostics/report.ts'], ['test/acceptance-audit.test.mjs', 'test/business-trace.test.mjs'], ['KEJ-82'],
    '凭据全出口检查与部署边界验收'],
  ['HW-13', '性能持续运行', '冻结负载下延迟与资源达标，停止后资源回收，无未解释持续增长。',
    '延迟、CPU、内存、连接与数据规模', '分级历史/图谱、连续流、反复启停、切换与导入',
    ['server.mjs', 'storage.mjs', 'public/knowledge-graph-renderer.js'], ['test/relation-throughput.test.mjs', 'test/graph-realtime-integration.test.mjs'], ['KEJ-80', 'KEJ-81'],
    '真实基线、预先冻结阈值、分位数与持续运行证据'],
  ['HW-14', '构建升级兼容', '支持环境安装可用；升级数据不丢失；失败恢复可执行；版本一致。',
    '构建产物、旧数据库、备份与版本', '干净安装、缺配置、旧库升级、迁移失败、恢复',
    ['scripts/build.mjs', 'scripts/preflight.mjs', 'storage.mjs'], ['test/development-workflow.test.mjs', 'scripts/check-version.mjs'], ['KEJ-79', 'KEJ-83'],
    '旧库升级恢复与明确平台/设备支持矩阵'],
  ['HW-15', '可观测与证据', '业务归属与终态可信；缺失、不完整、失败和过期证据不能汇总为通过。',
    'Trace、运行元数据与证据文件', '成功/失败/取消/等待、中断、旧源码、缺失结果',
    ['src/server/diagnostics/business.ts', 'scripts/lib/verification-evidence.mjs'], ['test/business-trace.test.mjs', 'test/verification-evidence.test.mjs'], ['KEJ-62', 'KEJ-84', 'KEJ-86', 'KEJ-87'],
    '全业务 Trace 映射、变更影响选择及完整发布证据门禁']
];
export const properties = cards.map(([group, title, requirement, state, domain, implementation, assets, issues, gap]) => ({
  id: `${group}-01`, group, version: 1, title, requirement,
  consequence: `违反“${title}”契约会影响用户结果或发布判断。`,
  preconditions: group === 'HW-04' ? '有效关系窗口、有效来源与可用预算，供应商返回合成成功响应。' : '对应业务操作合法，采用当前实现和声明的环境配置。',
  state, domain, assumptions: '确定性桩只证明声明场景；真实服务、设备和有限模型范围必须另附证据。',
  owners: ['模块维护者：实现映射', '验证维护者：驱动与证据', '发布负责人：环境与门槛'],
  methods: group === 'HW-04' ? ['real-sqlite-workflow', 'stub-provider'] : ['待对应子工单冻结配置；既有测试仅登记资产'],
  implementation, assets, issues,
  invalidatedBy: ['业务契约、实现、依赖、供应商、提示词或环境变化', '性质或规范版本变化'],
  acceptance: group === 'HW-04' ? ['AC-P01 的单窗口正常提交部分；不代表 M1 完成'] : [domain],
  gaps: [gap], evidenceStatus: 'not_run'
})).concat(upgradeProperties, sessionProperties, relationResultProperties, editConsistencyProperties, traceBusinessProperties, securityProperties, playbackProperties, nameProperties);
