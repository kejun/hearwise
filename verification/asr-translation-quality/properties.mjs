// M0 measured quality. The offline plumbing profile never satisfies these rows.
const common = {
  version: 1, owners: ['KEJ-77 实施与审查者', '发布负责人及指定双语评审者'],
  preconditions: '真实录音/人工文本来源和使用范围已批准；候选输出产生前冻结语料、金标、方向、重复次数、阈值、评审者和预算。',
  state: '版本化语料/金标、冻结配置、共享持久预算、原始公开接口结果、逐样本人工评审与配对报告',
  domain: '有来源记录的有限正常/困难语料；en/zh/ja/ko 的批准方向；ASR 16kHz 单声道 PCM；固定文本 MT。',
  assumptions: '官方最坏计费上界经人工核验；供应商别名不保证不可变模型修订；本机时钟可信；配置中的批准记录不自行产生用户授权。',
  methods: ['real-corpus-human-review'], issues: ['KEJ-77'],
  invalidatedBy: ['语料、金标、指标规范、阈值、方向、重复/评审者变更', '模型、供应商、请求参数/模板、ASR/MT 实现或工具链变更', '源码/附件不匹配、未完成采集、缺失人工评审或预算证据'],
  evidenceStatus: 'not_run', gaps: ['本次仅离线基础设施验证；真实调用、人工评审和质量基线尚未执行。', '有限语料不保证总体分布、实体设备或端到端延迟。']
};
export const asrTranslationQualityProperties = [
  { ...common, id: 'HW-01-05', group: 'HW-01', title: '真实语音识别质量',
    consequence: '误识别、遗漏或静音幻觉使原文失真，数字/否定/条件/归属错误影响含义。',
    requirement: '按冻结 CER/WER 与遗漏率及基线差值逐语言判断；静音幻觉和严重语义错误单独否决。',
    implementation: ['server.mjs: /ws and persisted segments query', 'storage.mjs', 'scripts/lib/quality-collector.mjs'],
    assets: ['verification/asr-translation-quality/corpus.template.json', 'scripts/lib/quality-metrics.mjs', 'scripts/lib/quality-assessment.mjs'],
    acceptance: ['正常/困难录音、同句纠错、空结果、静音、数字/否定/条件/专名/长句/口音噪声/多语言/歧义', '真实 baseline/candidate 配对重复、独立严重错误审查、失败/取消仍保留已发预算'] },
  { ...common, id: 'HW-02-05', group: 'HW-02', title: '真实文本翻译质量',
    consequence: '形式合法的译文仍可能反转含义、丢失条件或改变数字与归属。',
    requirement: '人工依据合理多解金标评定含义保留率；候选达到绝对和基线差值阈值；任一严重错误否决。',
    implementation: ['server.mjs: /api/translate and translation.http', 'scripts/lib/quality-collector.mjs'],
    assets: ['verification/asr-translation-quality/corpus.template.json', 'scripts/lib/quality-assessment.mjs'],
    acceptance: ['人工固定文本与真实 ASR 评测分开，避免将 ASR 错误混入 MT 分数', '冻结方向/模板/参数、所有配对重复均有具名人工评审；漏结果/漏评审不能通过'] }
];
