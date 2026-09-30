# HearWise（同声）

<img src="https://mdn.alipayobjects.com/huamei_ytl0i7/afts/img/A*dNRZTZ1uLlAAAAAAUCAAAAgAejCYAQ/original" alt="HearWise 同声界面" style="max-width:100%;">

用于收听知识型演讲、播客和视频的个人应用：实时转写与翻译，整理有原文依据的对话知识，保存全文，并按需播报译文或整篇原文。

**应用在本地运行，识别、翻译、知识整理和语音合成调用云端模型 API。** 当前版本：[v1.0.3](https://github.com/kejun/hearwise/releases/tag/v1.0.3)。

## 功能总览

| 功能 | 当前支持 |
| --- | --- |
| 音频采集 | 麦克风、浏览器标签页音频；收听中可更换标签页 |
| 实时字幕 | 单句大字幕、临时译文到最终译文平滑更新、同语言原文直通、可收起的吸顶字幕 |
| 对话知识 | 精选具体对象、原文引用、同一收听内去重与增量补充、失败项定向补全 |
| 收听历史 | SQLite 本地保存、多次继续收听、分片段查看、任务恢复、编辑标题与备注、删除记录 |
| 全文导出 | 原文或已完成译文下载为 TXT，不受页面分页限制 |
| 语音播报 | 阿里云千问 / Fish Audio；实时中文译文播报、整篇原文或译文分段播报 |
| 播放控制 | 试听、音量、暂停/继续、停止、积压跳转、中断句重播；支持时接入锁屏和耳机媒体控制 |

## 快速开始

需要 **Node.js 24 或更新版本**，以及千问AI平台的[按量计费通用 API Key](https://platform.qianwenai.com/docs/api-reference/preparation/api-key)。项目使用内置 `node:sqlite`，无需另外安装数据库服务。

```bash
git clone https://github.com/kejun/hearwise.git
cd hearwise
npm install
npm start
```

开发时可用 `npm run dev` 启动文件变更监听。打开 <http://127.0.0.1:3000>：

1. 在「设置 → 连接设置」填写 Key。「测试连接」分别检查识别、翻译和知识抽取，显示三项结果；测试不会保存尚未提交的 Key，可能产生少量模型费用。
2. 在「语言设置」选择识别语言、译文语言和识别模式。默认英语 → 简体中文；识别可选自动、中、英、日、韩，译文可选中、英、日、韩。收听期间语言设置锁定。
3. 选择声音来源，点击「开始聆听」。使用标签页时，在浏览器共享窗口中选择目标标签页，并勾选共享音频。
4. 实时字幕、对话知识和全文记录会持续更新。需要朗读时，切到「语音播报」并手动开启；停止收听后可以导出或播报全文。

标签页音频采集需要浏览器支持；Chrome、Edge 等支持该能力的浏览器可使用，每次采集仍需用户授权。麦克风收听并开启播报时建议佩戴耳机。

## 实时字幕与音源

- **焦点跟随说话人**：原文实时上屏，当前句的临时译文约每 1.2 秒更新一次；最终译文完成后替换同句临时结果，等待期间不清空字幕。翻译优先处理实时内容，同时保留历史任务的调度机会。
- **同语言直通**：明确选择相同源语言和目标语言时，例如中文 → 简体中文，原文直接作为译文显示与保存，不调用翻译模型；「自动识别」仍走翻译。
- **长句与错误恢复**：临时文本超过本应用的长度限制（3000，按 JavaScript 字符串长度计）时，保留已有译文并等待完整句，不截断原文。最终原文照常入库，最终翻译独立处理；旧请求的迟到响应不会覆盖新句。
- **阅读交互**：译文默认 44px，可在 30–70px 间调整并保留设置。长字幕在限高区域内滚动，上滚回看时不被强制拉到底；向下浏览时出现吸顶字幕，可收起为小条。
- **面板切换**：「实时字幕」和「语音播报」共用一个面板。切换 Tab 不会启停播报；播报开启时，Tab 显示状态圆点。
- **更换音源**：收听中「更换标签页」会在成功选择新来源后创建新收听片段，保留旧片段记录；新片段的语音播报保持关闭。停止采集时会尽量发送剩余尾部音频。

「低延迟断句 / 标准断句」影响服务端 ASR 参数，下次开始聆听生效；若平台拒绝附加断句参数，会明确提示回退。它不改变单句大字幕的展示方式。

## 对话知识

### 收录与更新

知识来自**最终原文**，不从临时字幕抽取。新记录使用精选收录规则：优先整理对当前内容重要、值得解释的具体人物、组织、产品、作品、方法、事件和地点；泛词不会仅因反复出现就成为卡片。

卡片折叠时显示名称、类别与一句说明，展开后显示对话中的信息和原文引用。同一收听内，重复提及补充引用，有新事实才增量更新；身份不足的对象先留作内部候选，不仅凭同名强行合并。已有历史卡片中的「背景补充（模型生成）」与对话内容分开展示，「待确认」保留不确定性。

「追踪新增」默认关闭；手动开启后，新建或实质更新的条目会自动定位并短暂高亮。支持全部展开/收起，实时更新保留用户已展开的卡片。「收听片段」和「原文与译文」也可折叠，长页面提供返回顶部按钮。

### 及时处理与失败恢复

最终句入库后短暂合批：安静约 1.5 秒、累计 3 句或 1200 字符可触发，合批最多等待 4 秒。翻译繁忙时知识任务默认最多让路 1.5 秒；同一收听串行处理，不同收听可并发。**这些是调度等待参数，不是知识卡片的出结果时延保证**，实际耗时还包括排队和模型响应。

有效条目先保存并展示；有可纠正字段错误的条目进入一次定向补全，不整批丢弃成功结果。页面区分「知识整理中」「正在补全部分条目」「部分知识未能整理」和「知识整理失败」；合法空结果、待观察或排除决策不会仅因没有新卡片而报错。

网络或限流错误按预算退避，并遵守 `Retry-After`。新知识流程将分片检查点、请求预算和未解决项保存到数据库；人工「继续处理」仅重开未解决工作，不重复写入已成功内容。历史记录保留原有抽取策略，旧任务不自动套用新协议重跑。停止收听后，已排队的翻译和知识任务仍可继续补齐。

## 收听历史与全文

「新建收听」在识别任务成功启动后创建记录；「继续收听」在原记录下追加片段，不覆盖过去内容。同一记录同时只允许一个活动收听片段。历史页可查看各片段、最终原文、译文、知识与处理状态。

打开历史记录后，点击「编辑标题与备注」修改标题并添加多行备注，保存后刷新仍保留；取消不保存改动。标题不能为空，最多 200 字；备注选填，最多 10000 字，清空后保存即可删除备注。正在收听的记录需先停止后再编辑。

在「原文与译文」右上角选择下载原文或译文，可将**整条记录**导出为 TXT，包括尚未在页面加载的句子；译文导出包含已完成部分。文件名使用保存后的标题（不适合文件名的字符会被替换），有备注时会放在正文之前，空备注不添加额外内容；尚无正文时不会只导出备注。删除记录需要确认，并同步删除其关联内容；正在收听的记录需先停止。

服务重启后不会从磁盘读取 API Key 自动调用模型。存在可恢复任务时，在历史记录中点击「继续处理」，使用当前浏览器保存的 Key 恢复；已保存的文字和成功知识保留。

## 语音播报

### 选择服务商

| 设置 | 阿里云千问（默认） | Fish Audio |
| --- | --- | --- |
| 模型 | 默认 `qwen3-tts-flash-realtime`；填写 Prompt 后使用 `qwen3-tts-instruct-flash-realtime` | `s2.1-pro-free`、`s2.1-pro`，默认前者 |
| API Key | 共用「连接设置」中的 Key | 单独填写 Fish Audio API Key |
| 音色 | Cherry（默认）、Serena、Ethan、Chelsie | `reference_id`，可从音色页面复制 |
| 语速 | 1.0×、1.1×、1.2× | 0.5–2.0× |
| 风格 | 可选语音 Prompt，最多 500 字符，作为指令发送，不混入正文 | 可选表达风格，最多 120 字符，例如 `calm`，按 `[描述]` 前缀应用 |
| 其他 | 北京 / 新加坡服务地域，Key 需具有对应地域和模型权限 | 延迟模式：实时优先（默认 `balanced`）、音质优先、最低延迟 |

Fish Audio 默认音色 ID 为 `bbfff76fd7c74f35a04a33366574f2d6`；已有自定义音色会保留。两家的偏好分别保存，切换服务商或保存设置会停止当前播报，不自动开始，也不会从 free 模型自动切换到付费模型。千问使用 WebSocket 语音流，Fish 使用 HTTP 流式 PCM，均边生成边播放。

### 实时译文与全文播报

**播报默认关闭，必须手动开启。** 开始中文译文收听后，点击「开启译文播报」，只按原句顺序朗读之后产生的最终译文；临时字幕和历史补齐不会发声。首次需等待完整译文和首段语音生成，页面会提示当前等待状态。刷新、继续收听、更换音源后均需重新开启。

可调节音量、暂停/继续或立即停止。积压较多时，「跳到最新内容」会跳过未读内容，改从之后的新句子开始；发生可恢复的实时中断时，可从头「重播中断句」。停止收听后，实时播报最多等待 20 秒收尾，暂停时间不计入；手动关闭播报立即停止声音。

停止收听后，在「原文与译文」点击「播报全部原文」或「播报全部译文」，从第一句开始，覆盖整条记录的所有片段和未加载句子。长句、长引号、无标点文本会自动分段；优先在段落、标点和英文词界切分，按语速控制段长，完整保留正文。页面显示总句数及「第 i / k 段」。全文播报不受实时收尾的 20 秒限制，播完自动结束。

译文尚未完成时会等待；翻译失败或等待超时会提示先「继续处理」，不默默跳过。整篇原文播报不依赖翻译结果。试听、实时和全文均使用当前所选服务商，调用可能产生费用。

### 锁屏与后台播放

支持时接入 [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API)，注册播放、暂停和停止控制；锁屏、通知栏或耳机上实际可用的控件由浏览器和系统决定。锁屏元数据只显示播报模式和 HearWise 名称，不显示原文、译文或 Key。

页面切到后台不会主动停止播报。系统中断声音后保留播放器和待播队列，返回前台尝试恢复；用户主动暂停需手动继续。暂停最多保留 5 分钟，其间不生成后续新段，正在生成的一段可完成；停止或播完后释放媒体控制。

浏览器支持 Audio Session 时，纯播放使用 `playback`，麦克风收听使用 `play-and-record`，标签页采集使用自动模式，结束后恢复原设置。**这不等于取得后台常驻权限**：锁屏持续播放和持续采集仍受系统、省电及浏览器策略限制，设备休眠或页面被终止时无法保证继续。

## 模型、数据与运行配置

### 模型与接口

| 用途 | 当前模型 / 接口 |
| --- | --- |
| 实时识别 | `qwen-audio-3.0-asr-flash-streaming`；`wss://maas.qianwenaiapi.com/api-ws/v1/inference` |
| 翻译 | `qwen-mt-flash`；OpenAI 兼容 HTTP 接口 |
| 知识整理 | `qwen3.8-flash`，关闭思考模式；同一 HTTP 接口 |
| HTTP Base URL | `https://maas.qianwenaiapi.com/compatible-mode/v1` |
| 语音合成 | 上述千问 / Fish Audio 模型，经本地 `/ws/tts` 转发给浏览器 |

识别的 WebSocket 地址与翻译/知识整理的 HTTP 地址不能混用。连接设置使用通用 Key；Token Plan 专属 Key 不能直接与本应用的上述地址混用。千问语音的具体地址随设置中的服务地域选择，与识别地址分开配置。

### 本地数据与 Key

历史文本、收听片段、知识和任务检查点保存在 `data/listenings.sqlite`。当前数据库**结构版本为 4**，启动时自动迁移；这与应用版本 v1.0.3 是不同编号。数据库不保存音频和 API Key，`data/` 不纳入版本控制。

连接 Key 和 Fish Key 保存在当前浏览器的 `localStorage`；服务端仅在处理请求和后台任务期间使用内存中的 Key。清除浏览器数据会清除本地 Key 与偏好，不会删除服务端历史记录。收听音频、待翻译/整理文本和待播报正文会分别发送到对应云端服务。

默认仅监听本机。应用没有账号和访问鉴权，**Key 保存在浏览器不等于历史记录受访问保护**；远程使用需自行配置 HTTPS 和访问控制。浏览器音频采集需要安全上下文，本机 localhost 可直接使用。

### 常用环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `3000` | HTTP / WebSocket 服务端口 |
| `LISTENING_DB` | 项目内 `data/listenings.sqlite` | SQLite 文件路径 |
| `ASR_SENTENCE_SILENCE_MS` | `2500` | 低延迟识别模式的句末静音阈值，范围 200–6000 毫秒 |
| `EXTRACTION_CONCURRENCY` | `2` | 不同收听的知识任务并发，范围 1–4；翻译繁忙时按 1 个派发 |
| `EXTRACTION_WAIT_MS` | `1500` | 知识任务对繁忙翻译队列的最长让路时间，范围 0–15000 毫秒 |

同一收听的知识模型请求间隔至少 2 秒。缩短合批或让路时间可能增加调用频率，不保证模型本身更快。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 标签页没有声音可采集 | 确认选择的是带声音的标签页，并勾选共享音频；仅共享画面不会得到音轨 |
| 临时译文提示长句或暂不可用 | 查看最终句是否继续完成；临时翻译有独立长度限制和恢复逻辑，原文不会因此被截断 |
| 知识显示「部分知识未能整理」 | 已成功条目仍保留；点击「继续处理」重试未解决项，服务端 `knowledge_rejected` / `knowledge_job` 可查看原因和阶段 |
| `/ws/tts` 返回 `101`，但没有声音 | `101` 表示浏览器到本地服务的 WebSocket 已升级，不能证明上游已生成音频；查看页面播报状态与 `speech_event` 日志 |
| Fish 报 `UND_ERR_CONNECT_TIMEOUT` | 检查运行 Node 服务的电脑能否访问 Fish API，以及该进程的网络、代理、证书设置；浏览器能访问不代表服务进程能访问 |
| 锁屏后停播 | 检查系统是否中断或冻结页面；可返回页面继续播放，Media Session 不保证所有设备后台常驻 |

如果 Fish 需要经本机代理访问，可在较新的 Node.js 24（建议 24.5+）中按 [Node.js 官方代理说明](https://nodejs.org/learn/http/enterprise-network-configuration)启用环境代理。以下为 macOS / Linux 示例，将 `7890` 替换为实际 **HTTP / Mixed** 代理端口：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1,::1,.aliyuncs.com,.qianwenaiapi.com \
NODE_USE_ENV_PROXY=1 npm start
```

示例让本地连接和所列阿里云域名直连，其余支持环境代理的请求经代理访问。若环境已有小写 `http_proxy`、`https_proxy`、`no_proxy`，也需检查它们是否与预期一致。

## 主要功能迭代

按已合入主分支、进入正式 tag 的功能整理；实现细节以当前代码为准。

| 首次包含的版本 | 主要迭代 | 对应记录 |
| --- | --- | --- |
| v1.0.0 | 基础收听与本地历史：麦克风 / 标签页、实时识别翻译、SQLite 持久化、继续收听、失败任务恢复、TXT 全文导出 | [历史与存储实现](docs/listening-history-implementation.md)、[全文导出](https://github.com/kejun/hearwise/commit/e8c42bf) |
| v1.0.0 | 字幕与阅读体验：实时优先调度、ASR 断句设置、单句大字幕、临时/最终结果衔接、同语言直通、字号、吸顶与长页面浏览 | [实时调度](https://github.com/kejun/hearwise/commit/6192fe3)、[同语言直通](https://github.com/kejun/hearwise/commit/c7ae55b)、[PR #8](https://github.com/kejun/hearwise/pull/8)、[PR #11](https://github.com/kejun/hearwise/pull/11) |
| v1.0.0 | 知识精选与及时更新：模型更新为 `qwen3.8-flash`、具体对象收录、去重与证据增量、追踪新增、短时合批、翻译让路、自动重试与状态补齐 | [模型更新](https://github.com/kejun/hearwise/commit/4e09a64)、[PR #7](https://github.com/kejun/hearwise/pull/7)、[追踪新增](https://github.com/kejun/hearwise/commit/9602c9c)、[PR #10](https://github.com/kejun/hearwise/pull/10) |
| v1.0.1 | 知识结果可靠性：逐项校验、有效项先展示、失败项定向补全、持久化检查点、区分部分成功与失败 | [PR #13](https://github.com/kejun/hearwise/pull/13) |
| v1.0.1 | 语音播报首版：千问实时中文播报、共用连接 Key、停止后全文原文/译文播报、字幕/播报 Tab、可收起吸顶字幕 | [PR #14](https://github.com/kejun/hearwise/pull/14)、[PR #15](https://github.com/kejun/hearwise/pull/15)、[PR #16](https://github.com/kejun/hearwise/pull/16) |
| v1.0.2 | 语音服务扩展：千问 Prompt、Fish 双模型与独立 Key、默认音色、错误诊断、试听和重播不再误触发实时收尾超时 | [PR #19](https://github.com/kejun/hearwise/pull/19)、[PR #20](https://github.com/kejun/hearwise/pull/20)、[PR #21](https://github.com/kejun/hearwise/pull/21)、[PR #22](https://github.com/kejun/hearwise/pull/22)、[PR #23](https://github.com/kejun/hearwise/pull/23) |
| v1.0.3 | Media Session 与可恢复播放：锁屏媒体控制、系统中断恢复、暂停保留进度、后台播放适配 | [PR #25](https://github.com/kejun/hearwise/pull/25) |
| v1.0.3 | 全文长内容分段：按段连续合成、语速相关长度预算、完整保留长原文/译文、分段进度 | [PR #26](https://github.com/kejun/hearwise/pull/26) |

## 开发与文档

```bash
npm test
npm run check:version
```

自动化覆盖数据库迁移、字幕与翻译、知识调度与纠正、语音协议、长文分段和播放控制。测试使用模拟模型服务；通过测试不代表真实模型的抽取质量、延迟或所有设备锁屏表现均已验证。浏览器回归脚本见 [scripts/verify-speech-browser.mjs](scripts/verify-speech-browser.mjs)，需要另外准备 Playwright 与 Chromium。

| 文档 | 内容 |
| --- | --- |
| [收听历史实现](docs/listening-history-implementation.md) | 历史、片段、存储与恢复流程 |
| [知识条目阶段 1](docs/knowledge-items-phase1-implementation.md) | 精选收录、身份约束、去重与增量证据 |
| [知识及时更新](docs/knowledge-update-latency-implementation.md) | 合批、调度、公平性与延迟验证 |
| [知识结果可靠性](docs/knowledge-result-reliability-implementation.md) | 定向纠正、预算、检查点和质量状态 |
| [临时译文错误恢复](docs/interim-translation-error-fix.md) | 长句限制、错误分类与迟到响应保护 |
| [语音播报实现](docs/translation-speech-implementation.md) | 千问/Fish、流式播放、分段、暂停和 Media Session |
| [知识条目优化规划](docs/knowledge-items-optimization-plan.md) | 分阶段设计与后续方向，未实现部分不属于当前功能 |

部分设计文档保留了编写当时的基线和规划；当前行为以本 README 和代码为准。云服务接口参考：[千问AI平台兼容接口](https://platform.qianwenai.com/docs/api-reference/toolkitframework/openai-compatible/overview)、[实时语音识别](https://platform.qianwenai.com/docs/developer-guides/speech/asr-realtime)、[Fish 流式语音](https://docs.fish.audio/features/realtime-streaming)。

## 自动化验证与验收证据

PR 的 Node 24 确定性测试与 Chromium 语音 fixture 会自动运行，不需要模型密钥。
浏览器测试使用本地桩服务和模拟麦克风，截图仅作为人工视觉验收材料，不代表真实设备或付费服务验证。
另有仅手动触发、只生成预览的 gh-aw 验收证据审查试点；尚未配置/授权模型计费或执行模型。
配置、验证范围与启用步骤见 [CI 与验收证据试点](docs/acceptance-audit.md)。


### 实验性提前播报

字幕稳定与延迟的研究和边界见 [设计文档](docs/incremental-captions-and-speech.md)。默认仍等待最终译文。
显式设置 `HEARWISE_INCREMENTAL_SPEECH=1` 可在用户开启播报后，为英语→中文启用保守的独立短句提前播报。
可加 `HEARWISE_INCREMENTAL_BOUNDARY=sentence` 禁用逗号/分号分句。其他语言、自动识别、复杂或不确定句子仍等待定稿。
这是结构启发式实验，不能保证提前播出的内容不被后续识别修订；冲突会停止播报并提示查看完整定稿后回放。
关闭开关即可回到 final-only 播报；历史原文/译文和完整回放不变，不改变 TTS provider 或收费模型。
