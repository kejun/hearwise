# 实时与全文语音播报

默认服务商为「阿里云千问」，模型为 `qwen3-tts-flash-realtime`；填写语音 Prompt 时使用支持指令的 `qwen3-tts-instruct-flash-realtime`。也可选择 Fish Audio 的 `s2.1-pro-free` 或 `s2.1-pro`。页面初始、刷新、继续收听、切换音源形成新片段时均关闭播报；只有点击开启、全文播报或试听才创建播放 AudioContext 与 `/ws/tts` 连接。普通收听、历史补齐、保存设置和原有连接测试不调用 TTS。

## 使用

1. 在「连接设置」填写 API Key。千问播报与识别、翻译共用这一份已保存的 Key；切换到 Fish Audio 后，需要独立 Fish API Key 和音色 ID。
2. 选择千问时，设置北京或新加坡、音色和基础语速，可选填语音 Prompt，再点击「试听语音」。Prompt 用中文或英文描述声音表达方式，应用上限为 500 个字符，去除首尾空白后保存；留空恢复默认风格。Fish 的独立设置见下文。保存设置不自动开启播报。
3. 开始中文译文收听，切换到主面板的「语音播报」Tab，再点击「开启译文播报」。从服务端确认开启之后的新最终句开始，之前已识别但稍后才译完的句子不会补读。切回「实时字幕」不会中断声音，Tab 上的圆点表示播报已开启。
4. 音量实时生效。更改音色、语速、Prompt 或 Key 后保存，会关闭当前播报，手动重新开启后生效。
5. 「关闭播报」先在本机停止输出，再通知服务器；「停止聆听」则允许读完尾句，最长 20 秒，期间仍可关闭播报。
6. 积压时可明确选择「跳到最新内容」。中断后可选择「重播中断句」：从头读出该最终句，读完关闭，随后可手动重新开启实时播报。
7. 停止收听后，在「原文与译文」点击「播报全部原文」或「播报全部译文」，从第一句开始读出当前记录的全部内容，包含未加载到页面的句子和多个收听片段；可随时停止，选择另一种内容会先停止当前声音。

千问 Key 沿用连接设置的 localStorage 保存方式；升级时清理旧的千问语音 Key 存储。Fish Key 单独保存在当前浏览器的 `hearwise:fish-key`，不混入普通播报偏好，也不会回退使用连接设置的 Key。服务端不将 Key 写入数据库或日志。切换服务商立即停止声音；两家的偏好分别保留，隐藏的设置不参与当前服务商的校验。TTS 为云端功能，可能产生费用，不是离线小模型。麦克风收听建议戴耳机；标签页输入排除 Hearwise 自己，输出不接入录音图。

首次开启显示「等说话人说完一句并完成翻译后就会开始」；取得最终文本后显示「正在准备第一句语音，首次播放可能稍慢」。实际开始消费音频后再显示「正在播报」，缓冲统计不会覆盖等待说明。

千问 Prompt 使用 `session.update.session.instructions` 下发，设置 `optimize_instructions=false`，不额外改写用户指令、不混入朗读正文。仅服务端按校验后的 Prompt 是否为空选择固定模型，客户端不能指定任意模型；旧配置没有 Prompt 时保持兼容。前后端共享长度与类型校验，过长或类型错误在连接上游前拒绝。试听、实时、全文和中断句重播复用这套配置，错误不会静默降级到不支持指令的模型。指令模型支持北京和新加坡，仍需所选地域的 Key 具备模型权限。官方参数限制为 1600 Token，本应用使用更短的字符上限。

## Fish Audio

模型可选 `s2.1-pro-free`（默认）和 `s2.1-pro`。free 适合试用，响应延迟无保证；pro 为付费模型。前后端都校验固定模型列表，不依赖上游的模型默认值，不自动转为付费模型。需填写 API Key 和 `reference_id` 音色 ID，可从 Fish 音色库或自己的音色页面获取。本版使用已有音色，不上传或克隆声音；加载设置不会调用云端接口。

Fish 独立设置语速（0.5–2.0）、延迟模式（balanced / normal / low，默认 balanced）和表达风格。风格是一条最多 120 字符的简短描述，例如 `calm` 或 `whispers softly`；发送上游时按 Fish 的 `[描述]` 方式加到每个合成单元前，不修改数据库正文和页面显示。不复用千问的地域、音色名或 `instructions` 参数。切回千问时仍保留原来的语音 Prompt。

现有队列已经得到完整最终句，因此按照官方文档采用 HTTP 流式音频，而非面向逐 Token 文本输入的 WebSocket。服务端请求 `POST https://api.fish.audio/v1/tts`，通过 `Authorization: Bearer …` 和 `model` 请求头传入凭据及所选模型；JSON 包含 `text`、`reference_id`、`format=pcm`、`sample_rate=24000`、`latency` 和 `prosody.speed`。上游地址仅能由服务端配置，`FISH_TTS_ENDPOINT` 用于本地模拟测试；浏览器不能指定地址。

`fish-tts.mjs` 随响应到达转发 PCM16 单声道音频，处理跨包的半个采样，不等待完整响应。复用原有 AudioWorklet、有限预取和消费回执。连接上限 15 秒、单次生成上限 45 秒；主动关闭或切换服务商使用 AbortController 取消 HTTP 流。网络在首个音频样本前断开可重试一次，输出 PCM 后不重试；鉴权、配额、限流和其他 HTTP 错误不自动重试。错误提示不回显上游响应正文，避免泄露凭据。

## 实现边界

| 部分 | 实现 |
| --- | --- |
| 播报源 | 实时模式读取同一 listening/run 的最终译文；全文模式读取所选 listening 的全部原文或最终译文，临时字幕永不进入 TTS |
| 起点 | 校验 active run 后，同步读取最大 sequence 并注册 consumer，避免分页水位和注册间隙 |
| 顺序 | 从水位后读取第一行，包含 pending/failed；前句未完成时不越过、不静默丢句 |
| 分段 | 在原文/译文的句末或长分句标点处分段，保留引号、括号、数字和常见英文缩写，不补写或概括正文 |
| Qwen | commit 模式，24 kHz PCM16 单声道；单会话同一时刻一个 response，复用连接 |
| Fish | 完整句子请求 HTTP 流式接口，24 kHz PCM16 单声道；每个单元一个请求，随生成转发音频 |
| 播放 | 独立 AudioContext + AudioWorklet 环形队列，跨包连续重采样到设备实际采样率 |
| 取消 | epoch 使旧事件失效；本机先静音和释放播放器，再关闭上下游 |
| 确认 | Worklet 消费样本回执，与生成完成分开；自然结束额外等待声卡缓冲排空 |
| 收尾 | run 完结时冻结最大 sequence；保留停止前音频产生的最终句，不等待知识整理 |
| 翻译调度 | 阻塞播报的句子每隔一个派发槽可获优先；临时/最终翻译共享两槽，保留后台防饥饿 |
| 音源切换 | 选择取消保留旧流；成功选择后 flush/结束旧 ASR，建立新 run，播报关闭 |

二进制音频包头为 4 个小端 uint32：`epoch / unit / frame / sampleCount`，随后为 PCM16 LE。文本控制事件使用 JSON。服务端验证消费数与已完成单元的样本上界，客户端验证 epoch、单元、帧号和长度。

首音预缓冲 200ms；完整短音频不足阈值也能播放。最多有 2 个尚未播完的单元，待播 PCM 达 4 秒即暂停新合成；允许单个单元突破软水位，硬上限为 32 秒。客户端无进度回执 12 秒或 WebSocket 下行过载时关闭播报。单次合成最多 45 秒，连接最多 15 秒；drain 的 20 秒总期限始终优先。超过 600 字且无安全切点的单元明确报错，不截断正文。

千问尚无音频输出时可自动重连一次；一旦输出过 PCM，不自动从头重读。已完整生成的音频在上游正常断开后仍可本地播放；下一单元会重新建连。正常完成使用 `session.finish`，主动取消直接关闭上游。浏览器挂起时回到关闭，需手动开启恢复。

## 全文模式

客户端显式发送 `speech.transcript`，指定 listeningId 和 `original` / `translation`；服务端确认该记录没有活跃收听，再冻结最后 sequence，从第一句有界读取。不接受任意待念文本，不使用页面分页数据。复用原播放器、有限预取和样本回执，只保留至多两个尚未播完的单元，长篇不会整体加载为 PCM。

全文模式不受实时收尾的 20 秒限制；按句显示「第 N / 总句数」。译文 pending 时最多等待该句 30 秒，failed 时明确停止并提示先继续处理，不静默略过。原文不依赖翻译结果。全部句子播完后自动关闭；新建、继续收听、切换记录和手动停止均会立即终止当前声音，其他页面继续同一记录时也停止全文播报。

千问全文使用 `language_type=Auto`，适配英语原文以及跨片段不同语言；实时中文译文保持 `Chinese`。Fish 根据文本识别语言，不发送千问的语言参数。服务端按各自服务商校验设置，Key 的模型/音色权限由云服务验证。

## 观测与验证

`speech_event` 日志包含 consumer/run、segment/unit、首包耗时、样本数、response 状态/重试次数、token usage（上游提供时）、缓冲时长、缺样次数和退出原因。日志不含 Key、完整译文和 PCM。待播时长是「未消费 PCM + 未生成文字按 5 字/秒估算」，不是与原声的精确延迟，也不是词级字幕对齐。

```bash
npm test
npm run check:version
```

`test/speech.test.mjs` 验证起点、乱序、去重、背压、收尾边界/超时、重播、回执校验、分段和 44.1/48 kHz 重采样。`test/speech-integration.test.mjs` 使用真实本地 WebSocket 接通 ASR、翻译和模拟 Qwen / Fish，覆盖 odd-byte PCM、session 配置、Fish 两个模型和请求头、部分音频不重试及取消。`test/fish-tts.test.mjs` 另行验证渐进输出、重试边界、取消、超时、HTTP 错误和异常音频；UI 测试覆盖两套设置与 Key 隔离。`test/interim-translation-api.test.mjs` 验证临时/最终翻译不突破共享额度。

可选浏览器回归（自行安装 Playwright/Chromium；不修改应用生产依赖）：

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROMIUM_EXECUTABLE=/absolute/path/to/chrome \
node scripts/verify-speech-browser.mjs
```

该脚本使用假麦克风与本地模拟服务，不产生云端费用；验证真实页面操作、最终译文到 Worklet 消费、手动开关、停止收尾、新 run/刷新保持关闭、试听、共用 Key、小号按钮、首次等待提示、全文原文/译文、停止全文播报和手机宽度；同时验证 Prompt 的保存/刷新恢复、实时/全文/试听指令下发，以及清空后恢复默认模型。Fish 回归覆盖独立 Key、free / pro 切换、保存与刷新、流式实时播报、全文原文/译文、切换服务商中断 HTTP 流，以及切回千问后继续使用连接 Key。

本次实现已通过模拟端到端与 Chromium 页面回归。尚未配置真实百炼或 Fish Key，因此未验证真实首包延迟、音色听感、30 分钟稳定性或麦克风外放回声效果。发布前用目标服务商的 Key/音色完成试听及真实材料长时测试。后续再调优相邻短句合批、动态预取窗口与音色切换时的句边界衔接；本版不做自适应变速、不播临时译文；历史内容仅在用户明确点击全文播报时读取。

协议依据：[阿里云客户端事件](https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-server-events)、[Fish 实时流式说明](https://docs.fish.audio/features/realtime-streaming)、[Fish HTTP TTS](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)、[Fish 模型说明](https://docs.fish.audio/developer-guide/models-pricing/models-overview)。
