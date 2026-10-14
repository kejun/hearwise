# ASR / 翻译真实质量评测准备（KEJ-77）

## 当前交付边界

本轮交付采集器、冻结模板、费用预留和报告检错。真实质量仍为 `not_run`：没有调用真实供应商，没有使用真实密钥，没有下载或上传用户录音，没有人工质量评分，也没有生成可发布的真实质量基线。离线桩返回固定文字，即使管线通过也不表示 ASR 或翻译质量通过。

性质为 `HW-01-05`（真实 ASR 质量）和 `HW-02-05`（真实 MT 质量），完整登记见 `verification/asr-translation-quality/properties.mjs`。方法是 `real-corpus-human-review`，独立报告不伪装为 Lean、模型检查或 `implementation-scenario`。普通 PR CI 只运行离线合成输入；`CI` 环境拒绝 live 入口。

## 一个入口，明确阶段

需要 Node 24、此 checkout 自己的锁定依赖和生产 build：

```sh
npm ci --ignore-scripts
npm run preflight
npm run quality:asr-mt -- plan
npm run quality:asr-mt -- offline --release
npm run quality:asr-mt -- check-offline --out verification-evidence/asr-translation-quality/offline-EXAMPLE --release
```

`plan` 只列缺项，默认模板应显示不满足冻结条件。`offline` 使用真实应用子进程、公开 HTTP/WS、临时真实 SQLite、本地合成供应商；两次 ASR、两次固定文本 MT，保留原始请求计数、每次采集/日志和 SHA-256。`check-offline` 从附件重新核对源码、四次采集、实际 loopback 计数和预算，仍只输出基础设施状态。`--release` 要求干净源码。离线输出永远含 `qualityEvaluated:false`、两个性质 `not_run`、`fullQualityAcceptance:false`。

真实阶段的命令仅供获得单独批准后的操作者使用，本轮不执行：

```sh
npm run quality:asr-mt -- freeze --config /approved/plan.json --out /approved/frozen.json
npm run quality:asr-mt -- collect --freeze /approved/frozen.json --role baseline --out /evidence/baseline --live --approve-budget APPROVED_ID
npm run quality:asr-mt -- collect --freeze /approved/frozen.json --role candidate --out /evidence/candidate --live --approve-budget APPROVED_ID
npm run quality:asr-mt -- prepare-review --freeze /approved/frozen.json --baseline /evidence/baseline --candidate /evidence/candidate --out /evidence/review.json
npm run quality:asr-mt -- assess --freeze /approved/frozen.json --baseline /evidence/baseline --candidate /evidence/candidate --reviews /evidence/review.json --out /evidence/assessment.json
```

每个 role 在其批准的干净 SHA 上构建并运行；两个 Git 对象须本地可读取。两个版本都须包含此采集工具。冻结计划、真实音频、计费文档及输出放在 checkout 外，两个 role 读取同一份冻结文件和同一预算数据库。输出目录/冻结文件只新建，不覆盖。基线必须先完成；候选接续同一持久预算快照。失败/取消后不自动重跑全部采集，不删除预算账本以“恢复额度”。

未来操作者通过自己的受控环境提供 `HEARWISE_QUALITY_API_KEY`；不要将密钥写入计划、命令参数、仓库、聊天或报告。创建/配置凭据和真实付费执行需要独立授权，配置里的 `approvedBy` 或 `--approve-budget` 本身不会产生授权。当前实现从未运行该 live 路径。

## 语料、来源和可复现性

`corpus.template.json` 是 22 个原创新写的占位脚本：21 个验收槽、1 个开发槽。包含日常/技术、数字时间金额、否定条件、专名、长句、口音噪声、多语言、静音/空结果和歧义的正常/困难槽。它们不是录音，不是审核后的金标；`draft-script-only`、空音频、未审核字段故意不能冻结。静音槽只评测 ASR。英语默认 WER，中文/日语/韩语用 CER；模板方向为 en→Chinese、zh→English、ja/ko→Chinese，正式范围由负责人冻结。

每个真实样本必须记录原始来源、不可变样本 ID、版本/选择规则、许可与链接、归属、允许使用/再分发确认、人工评审、转换流程，以及实际 PCM 字节哈希、字节数和时长。输入是 16kHz、单声道、有符号 16-bit little-endian PCM，时长由 `bytes / 32` 毫秒计算，最长 90 秒；须在连接上限内保留 15 秒启动/结束余量。采集前重新核对实际文件。禁止用供应商/候选输出反向挑选验收集或修改金标。

开发与验收分离；跨集合相同规范化文本或相同音频哈希被拒绝。ID 不能重复。该检查不识别所有语义近重复，选样者仍须隔离同源段落、改写、说话人/录制会话等泄漏风险，并写入选择规则。当前只有开发槽模板，不声称已完成代表性抽样。

仓库已有材料不能直接成为本票真实基线：

- speech fixture 的 ASR/MT 固定文字与输入 PCM 无语义关系，TTS 为合成音；浏览器假麦克风仅验证协议。
- `anthropic-akamai-news.txt` 过去用于知识提取。已有记录说它是用户提供的三段新闻，但没有完整来源日期、第三方许可证明、录音或人工翻译金标；仓库 MIT 许可不能替代材料自己的使用权。
- 本轮未下载第三方语料。可优先审查 [Google FLEURS 官方数据卡](https://huggingface.co/datasets/google/fleurs)：卡片标注 CC-BY-4.0、提供上述语言与录音转写，也明确读稿语音与实际噪声场景有差距。它不能单独填满真实口音/噪声/对话覆盖。
- 翻译可审查 [FLORES-200 官方说明](https://github.com/facebookresearch/flores/blob/main/flores200/README.md) 和 [许可清单](https://github.com/facebookresearch/flores#licenses)，其标注 CC-BY-SA 4.0。需固定版本/样本、保留归属并审核衍生材料的许可要求。不能仅因名称相近就假定 FLEURS 与 FLORES 样本可直接配对。

以上来源于 2026-10-14 只读核对，是候选来源，不是已批准/导入的数据集。真实录音可以来自最终批准的公开语料，不必要求用户提供私人素材。

## 冻结的指标与人工评审

`plan.template.json` 保留未知阈值、重复次数、评审者、源码和价格为空。`freeze` 只有在所有权利、文件、覆盖、金标、指标、方向、阈值、重复次数、预算和来源上界齐备时才创建不可覆盖文件；变更任意输入或文件、过期计费/批准、复制到不同账本位置均拒绝原冻结结果。

指标 v1：NFC、Unicode 默认小写、首尾/连续空白规范化；保留标点、数字和符号。CER 使用去空白后的 Unicode 码点，不是 UTF-16 单元；WER 使用空白分词，只允许英语，不能把中文 WER 当跨语言可比指标。编辑距离保留替换/删除/插入；同距离对齐依次优先对角、删除、插入，因此遗漏归属也被冻结。合理多解参考在候选生成前列出；选最低错误率，平局取首项。

ASR 汇总为选定参考的总编辑数 / 总参考单位数，遗漏率为总删除数 / 总参考单位数，不平均各句百分比。保留逐样本、逐重复、逐语言和指标的最小/最大值。空转写输出不是自动丢弃的困难样本：非空参考会计为遗漏；全空静音参考单列 hallucination 布尔值，分母为零时没有 CER/WER 分数。静音与非空参考不能混合。

MT 由具名双语评审者对每条输出打 0–4 分，平均 `score/4` 为含义保留率：

- 4：关键含义完整，允许合理措辞变化。
- 3：主要含义完整，仅有非关键细节或表达问题。
- 2：部分含义丢失/扭曲，仍可识别主要意思。
- 1：主要含义错误或大幅遗漏。
- 0：无关、无法理解或没有有效含义。

每条 ASR/MT 输出均必须独立标记 number、negation、condition、attribution、omission 五类严重错误；有错误须附具体说明。数字/单位/否定反转/条件变化/人物归属改变等不能被平均分掩盖。候选任一严重错误直接否决；MT 0/1 分必须标出至少一项严重错误。参考译文不是唯一合法字符串，合理多解由人工按固定规则判断，不能用精确字符串匹配代替语义评价。

候选须同时满足 ASR 绝对错误/遗漏上限和对基线的最大退化、MT 最低含义保留率和最大退化；静音幻觉与严重错误上限固定为零。每个 role 使用相同样本和 2–10 次已冻结重复，报告 distinct output 数及范围。固定顺序、无随机抽样，不声称统计置信区间或总体代表性。若要校准阈值，先用隔离开发集做试点，再在任何候选验收输出产生前确认，不能看结果后降低阈值。

人工评审模板绑定每条输出哈希、原文、参考、关键事实、评审身份和时间；漏一条或未知评审者就不完整。基线同样评审，不只评审候选。报告不把 baseline 本身存在错误当作 candidate 可忽略严重错误的理由。

## 真实入口与费用隔离

采集走现有 `/ws` 与 `/api/translate`，不添加生产调试端点或更改生产预算。ASR 以 640-byte/20ms 实时节奏发送实际音频，收到结束后通过公开 segments 查询取 SQLite canonical 原文并核对 WS 定稿；合法 `caption-correction` 保留，不排除出现修订的样本。当前首次 final 的身份规则保持，报告包含后续修订事件，评分对象是用户实际保存的 canonical 文本。

ASR 的 source/target 设置为同一语言以使用现有直通，避免每个分句自动产生 MT 费用。MT 独立使用人工固定原文，测现有公开预览翻译请求路径，不宣称测了 ASR→自动翻译完整级联。可能启动的知识请求由 gateway 在发送上游前拒绝；无 TTS。没有使用会同时调用多类模型的 `/api/test-connection`。

公开应用子进程只拿本地能力标记；真实 key 仅留在 gateway 内存并只用于计划声明的 TLS 上游 Authorization。gateway 精确限制模型、ASR 参数、MT 文本和方向；拒绝额外知识、意外 MT、重定向、超长请求/响应、超量音频和凭据回显。offline 上游必须为字面 loopback，不能通过仅改 `mode` 将实际 loopback 调用升级为真实质量证据。

生产 ASR 启动前的既有一次 fallback 可以形成第二次尝试，逐次重新预留；MT 每样本每重复至多一次，不添加 repair 或自动重试。备用连接和失败/取消/超时均算在发起次数内。单次、整次运行、子进程启动和清理有界；响应未完成或日志截断保留不完整证据，不变成通过。

## 费用上限如何成立

预算是同一批准 ID 的独立 SQLite 账本，非生产数据库表。baseline/candidate/restart 共享冻结的绝对路径、批准配置与冻结摘要。`BEGIN IMMEDIATE`、`synchronous=FULL` 将最坏费用和尝试占用提交后，gateway 才连接上游。两连接也不能各自重置额度。余额不足/过期/绑定改变/每试次次数耗尽时零新增上游调用；取消、超时、错误和未确认结果不退款。

费用使用同一币种的整数 micro-unit（1/1,000,000 币种单位），单价须向上取整，不靠折扣或缓存保证上限。每次预留为输入上界×输入单价 + 输出上界×输出单价 + 固定费用；总计划包含两角色、全部重复及每个 ASR 的两次最坏尝试。必须以官方文档快照/哈希、有效期、审核者、具体模型/endpoint/币种和推导说明证明所有收费项目都被覆盖：

- ASR 输入按连接 wall-clock 上限，加已审定结束尾差、最小计费和向上计费粒度计量；不能将 90 秒音频写成 1 秒预算。若服务按其他方式计费，本适配器不支持该未证明的界限。
- MT 按该供应商实际强制的最大输入/输出 token 数预留，并核实际完整请求字节不超过已审的请求界限。响应 byte cap 和关闭 HTTP 连接都不等于供应商停止生成或计费；隐藏推理/附加费用不明就拒启动。
- 模型/地区/端点不同必须明确覆盖各配置；一个文档 URL 或 `reviewed:true` 不是自动价格认证，负责人须核实官方硬界限及单价。当前没有填写任何真实计费值，因此 live 默认被拒。

不普遍强制用户另建账户或更改账户限额。如果明确可验证的专用账户硬封顶可作为额外保护，应另行确认；余额提醒/soft quota 不能代替未知最坏费用上界。账本保护本评测工具发出的请求，不保证其他客户端/账户并发消费或供应商账单的全局总额；不删除/复制账本，也不在未新批准的情况下重新开始新预算 ID。

## 报告检错与限制

真实报告绑定冻结语料/配置、批准的两角色 Git SHA/tree、所有 Git tracked blob SHA-256、实际 build hash、Node/SQLite/系统、起止时间、公开事件/持久查询、provider 模型/端点/实际返回 ID/修订（未返回则 null）、输出哈希、逐尝试时间链及预算。评估器独立重读完整附件，核 sourceStart/sourceEnd、原日志中的 Trace build、实际请求与预算预留、基线→候选快照连续性、每个样本/方向/重复和人工审查。缺文件、摘要改变、非法 schema、倒序时间、未知模型、缺评审、少一次重复或不完整输出均不得质量通过。

原始证据来自操作者信任的本地采集进程；哈希防止意外替换/错配，不是供应商签名或反恶意伪造证明。生成的 build hash 和 Trace build 标识被保存，不能据此宣称供应商内部实现或别名不可变。报告保留已发送失败；空 MT 响应违反现有公开翻译成功契约，采集记为失败/不完整，不伪造 0 分后当完整样本通过。账本恢复和采集器取消测试也不代替其他票的全套 SIGKILL 崩溃原子性。

`test/quality-assessment.test.mjs` 的 test-only 合成 bundle 只检验报告拒绝能力与算术；从不保存真实质量通过报告。关键负例包括数字/否定独立否决、阈值方向、空参考、漏评审/计数/预算、离线换标签、原日志/源文件篡改和时间倒置。普通测试与离线 profile 通过只说明这些工具可用。

## 执行真实验收前最少需要的决定

1. 批准有限语料来源/使用范围与方向，选定负责金标及结果审查的人；可使用审定公开材料，不必提交私人录音。
2. 在候选输出前确认金标、多解/严重错误规则、重复次数与五个数值阈值。模板不给未知阈值默认“通过”。
3. 明确一次评测的预算金额/币种、批准有效期和具体模型/端点；核实官方最坏收费上界后，再由获授权操作者安全配置凭据并执行。

在这三项齐备且真实采集与人工审查完成前，KEJ-77 的真实质量验收保持未运行，不能关闭整票或整个增强验证需求。
