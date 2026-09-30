# 实时字幕稳定性与提前播报：研究、设计及验收计划

2026-09-30。研究基线：`37384eb3696c21a1fc3317b30adaec28c02b956f`。本文先于实现保存；文末记录实现及验证范围。**这里的现状由代码及公开技术文档得出，不是现场测速。** 不承诺消除所有延迟或语义错误。

## 1. 问题不是一个定时器

当前链路：20 ms / 320 sample / 16 kHz PCM → Qwen ASR partial → 整句临时 MT → ASR `sentence_end` → SQLite canonical segment → 整句最终 MT → 句内切分 → TTS PCM → 播放。

- `public/audio-processor.js` 每 20 ms 发送音频。`app.js` WebSocket 缓冲超过 512000 bytes 时丢弃发送（约 16 秒 PCM），目前缺少可用丢帧观测；这不是正常目标缓冲量。
- `server.mjs` 实际 ASR 是 `qwen-audio-3.0-asr-flash-streaming`、`run-task` / `result-generated` / `output.sentence.text/sentence_id/sentence_end`。不能把另一套 Qwen Realtime 的 `text/stash` 当成本接口承诺。partial 不带可信稳定度/置信度。
- realtime 模式参数：`semantic_punctuation_enabled=false`、`max_sentence_silence=2500`（配置限定 200–6000）、`multi_threshold_mode_enabled=true`；失败可降级无参数。2500 ms 是识别端静音断句设置，不是 UI 人为睡眠；机械缩小可能碎句、丢上下文。参数实际支持还须用真实服务验证。
- `app.js` 源文整体替换；临时译文源文至少 5 字、相隔至少 1200 ms、每次整句重译，整体替换旧译文；3000 字以上不做临时 MT。浏览器 abort 与版本守卫可以拒绝旧结果，但原服务端 fetch 仍占槽到响应/15 秒超时。
- 最终 MT 与临时 MT 共享两个槽；最终排队时拒绝新的临时请求，但已有两个临时请求可能拖住最终。`translation-queue.mjs` 已有最终实时窗口、历史 FIFO、后台防饿死和 audible head 公平性，必须保留。
- `speech-service.mjs` 只读取持久化最终句且等整句译文完成。长句等待主要在这里，不是 TTS 本身不流式。Qwen commit WebSocket / Fish HTTP 已连续输出 PCM。
- 播放启动缓冲 200 ms；服务端 4 秒 / 2 个未播放 unit 是软背压门槛，不是固定启动等待，一个 unit 可超过软限；另有 32 秒硬限。保留既有 epoch、样本进度验证、取消、暂停、断线保护。
- 开启播报快照当前 sequence，不能意外补读开启前的旧句。历史完整原文/译文、单句回放和整篇回放继续使用 canonical final。

## 2. 已有产品决策与不能回退的约束

[Issue #1](https://github.com/kejun/hearwise/issues/1) 曾讨论最终句与 speculative 路径。复杂 FOLLOW/REVIEW 在 [994fa04](https://github.com/kejun/hearwise/commit/994fa0420a500566458c98d0a885ac0457fe5682) 实现，后在 [f9f29fe](https://github.com/kejun/hearwise/commit/f9f29fe045c1454e4be8c0d9cca296b41283a21e) 有意移除。保持简单单句字幕；不恢复这套界面。[35e5c79](https://github.com/kejun/hearwise/commit/35e5c79d5c4eb32f46870c98f864318fcf7d4cc7) 的 badge/layout 不提供语义稳定性。[PR #11](https://github.com/kejun/hearwise/pull/11) 旧响应保护、[#26](https://github.com/kejun/hearwise/pull/26) 长记录回放、[#29](https://github.com/kejun/hearwise/pull/29) 历史元数据、[#30](https://github.com/kejun/hearwise/pull/30) Node 24 / browser CI 都是回归范围。

默认播报关闭；不变更 provider、voice、免费/付费模型选择；不用真实 key、付费推理；不升版本、不合并、不部署。最终完整 transcript 始终权威。稳定不等于正确，不能静默冻结错误。

## 3. 研究结论及可用性边界

| 方法 | 可借鉴之处 | 本项目边界 |
| --- | --- | --- |
| [LocalAgreement / Whisper Streaming](https://github.com/ufal/whisper_streaming), [论文](https://aclanthology.org/2023.ijcnlp-demo.3.pdf) | 新音频上下文的相邻假设同意 contiguous prefix，再保留尾部可变 | 论文约 3.3 s 是特定 European Parliament ASR 结果，不是 Qwen/中文/本产品指标；重复事件不能算新证据 |
| [Prefix age](https://sls.csail.mit.edu/publications/2012/McGraw2-Interspeech12.pdf) | 前缀存活/擦除观测 | 年龄预测存活而非语义正确，不创造未经校准的 confidence |
| [Retranslation](https://aclanthology.org/2020.iwslt-1.27/), [Dynamic mask](https://aclanthology.org/2021.iwslt-1.4.pdf) | 源上下文增长后目标 LCP，测 normalized erasure | 当前 API 无 forced-prefix / decoder bias；不拼接不相容的目标 suffix、不盲加 UNK |
| [Meaning units](https://aclanthology.org/2020.emnlp-main.178/), [wait-k](https://arxiv.org/abs/1810.08398) | 语义单位、质量与等待的权衡 | 都有训练/模型假设；定时切字符串不等价于 trained prefix-to-prefix |
| [RALCP](https://aclanthology.org/2024.alta-1.7/) | 多候选同意 | 当前不能假设 N-best，额外候选增加调用与成本 |
| [AlignAtt](https://arxiv.org/abs/2305.11408), [SimulStreaming](https://github.com/ufal/SimulStreaming), [AlignAtt4LLM](https://aclanthology.org/2026.iwslt-1.32/), [代码](https://github.com/QuentinFuxa/AlignAtt4LLM) | attention 边界、instrumented MT | 需要内部 attention，不能直接套用远程 qwen-mt-flash API；中英混合结果要另测 |
| [LAAL](https://aclanthology.org/2022.autosimtrans-1.2/) | 等待质量度量 | 配合 wall-clock、擦除率和语义审核，不能代替它们 |
| [Prosody boundary](https://arxiv.org/abs/2603.06444) | 韵律边界值得后续研究 | 是训练研究，不是已支持 API 功能 |

### 实际 provider 合同

- [Fun-ASR realtime](https://www.alibabacloud.com/help/en/model-studio/fun-asr-realtime-python-sdk)：字词时间戳、标点选项，不承诺本项目稳定度字段；本项目 maas endpoint 仍需实测。
- [Qwen ASR realtime events](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events)：`text/stash` 属于不同协议，可作为未来迁移研究，不冒充当前协议。
- [Qwen MT](https://www.alibabacloud.com/help/en/model-studio/machine-translation)、[API](https://help.aliyun.com/en/model-studio/qwen-mt-api)：单 user / 单轮，不支持 system、多轮或强制前缀；flash SSE 单个固定输入 append-only，不保证未来源假设不修订；plus/turbo 流式语义不同。
- [Qwen TTS commit](https://help.aliyun.com/en/model-studio/interactive-process-of-qwen-tts-realtime-synthesis)：append 后 commit 才开始；server commit 也不能解决上游等整句的问题。
- [Fish duplex](https://docs.fish.audio/api-reference/endpoint/websocket/tts-live)：start/text/flush/stop；[另一个 timestamps live API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-live-with-timestamps) 有 chunk_seq/offset/alignment。不能假设当前 s2.1-pro-free 兼容，首阶段保留 HTTP PCM。
- [Qwen LiveTranslate](https://help.aliyun.com/en/model-studio/qwen3-5-livetranslate-flash-realtime) 可研究 VAD 连续生成与 manual commit 差别，属于未来 provider 迁移。

## 4. 三条边界，而不是“一个定稿”

1. Source frontier：新上下文下同意的连续原文前缀；标点和语义边界单独处理。只锁有限前缀，尾部持续显示变化。不以固定时间强制正确。
2. Target frontier：相容的完整 MT 假设在不同源上下文下同意的连续前缀。不得把旧句前半截与新句后半截强拼。源文修订穿过边界时只将第一次冲突延后一份不同源上下文，标识复核；下一份新上下文仍有冲突则显式重置受影响后缀并继续增长，不冻结整段直到 final。
3. Played frontier：不可撤销已播放的语义单元。每个 unit 持有 epoch、run/sentence、source span、revision、hash、sequence。TTS 只接受已通过门槛的不可变语义短句，永不播放 speculative 文本。

最终 canonical 与视觉锁定冲突必须显式提示/记录纠正；不能为了“不闪动”永远显示错字。早播音频无法撤回；冲突时停止该路径、展示完整修正文并允许人工完整回放，不能偷偷补读整句造成重复，也不能静默跳过未覆盖内容。

## 5. 分阶段实现

### P0：取消、调度及可观测性

HTTP preview 的断开/取消传播至该请求自己的 upstream fetch，合并 timeout；不 abort 其他 consumer/final。preview 至多占一个共享槽，为 final 留通道；最终仍可用全部两个槽。浏览器保留版本与 AbortController，合并最新输入，不启动同输入重复请求。保持最终公平性。

同一进程单调时钟计 queue wait / model / first PCM；browser 自己计音频与播放时间。不能相减未同步浏览器/服务端/供应商 clocks。记录音频收到/丢弃帧和样本数，区分 ASR final 等待、MT queue、MT model、TTS first byte、播放器 startup/underrun/backpressure。

### P1：稳定 partial 字幕

共享纯函数 frontier，source 与 target 各自维护 source revision 的新上下文证据。相邻不同并增长的上下文同意前缀、保留 mutable suffix，在安全文字边界提交。重复网络包不推进；缩短/修订不伪造新增长。视觉 committed 与 active tail 分开表示，简单字幕布局不变。冲突只做一次不同源上下文的显示去抖；随后显式 rebase 受影响后缀，恢复新上下文同意。重复相同包不计新证据；这不是语义置信承诺。final 强制使用 canonical 并标注纠正。

### P2：保守的 pre-final 语义句播报（实验开关，默认关闭）

首版选择 **独立翻译源语义句**，不是强迫 qwen-mt 接续既有译文。只在已开启 live speech、支持的语言结构、强句末边界、新上下文重复同意且危险模式不命中时进入。初始仅 English→Chinese，其他方向包括自动识别默认 final-only。无标点长尾、未闭合括号/引用、否定/数值、句中新增专名、后置修饰/重排不确定均保守等待 final。逗号/分号仅在前后都满足独立主语＋限定动词＋完整谓语的结构筛选、并有 and/then 连接和至少 12 个已同意后续字符时提前；不是见逗号就切。限定动词集合约束句法而非主题词汇，因此可用于公司发布 AI 模型、团队改善工具、访谈描述已完成工作等。未知动词、引用和复杂从句仍降级。可设置 `HEARWISE_INCREMENTAL_BOUNDARY=sentence` 禁用弱边界。规则只是筛选器，不能证明任意句语义安全。

消费者独立 coverage ledger：只有本 epoch 实际接收的 units 才占 coverage。先前未开启播报的内容不算已播。ASR final 原文前缀仍匹配时，只将尚未覆盖的源文残余独立翻译播出；完整 final MT 另存档，不用目标 substring 猜测覆盖。前缀冲突则显式停止并提示人工复听。无 early coverage 完全走旧 final-only 路径。录音停止后取消未提交预测，保留既有有界 drain。切源、静音、replay、重连、设置修改沿用 epoch 清队列和 late-chunk 拒绝。

明确分离 source committed / queued / generated / played；发送中失败不能无条件推进覆盖；防重复与 final race 要有确定性测试。软队列限制不能变成每段固定等候。纯 text speculative 合成以后再议，本次不做。

### 初始上线开关与实际范围

- `HEARWISE_INCREMENTAL_SPEECH=1` 才启用实验路径，默认关闭；UI 仍须用户主动开启播报，`speech.ready` 明示实验状态
- 只适用显式 `en`→`Chinese` 的 live speech，不适用 auto、其他语言、试听或历史回放
- `HEARWISE_INCREMENTAL_BOUNDARY=sentence` 只允许强句末标点；省略时允许上述保守独立并列分句
- 用结构启发式而非完整依存句法模型，有限动词集合覆盖部分新闻/访谈；不能保证正确性，不满足筛选的正常长句仍须等 final
- 已覆盖 prefix 后再做 final 残余 MT 会增加一次请求，并损失全句翻译上下文；完整 canonical MT 不受影响。未覆盖的后续句不能超车
- early unit 已发出但尚未播放也计入不可重播覆盖，因为客户端可能已播放但尚未回报；TTS/播放失败时停止并提示完整人工回放，不以 guessed played offset 恢复
- 每个 consumer 独立 ledger；4096 final IDs 上限到达即停止实验播报并提示，避免无界状态或遗忘后重播。关闭清除所有 ledger / queued request；其他消费者不受影响

### 后续而非本次成果

qwen-mt-flash SSE首 token、Fish duplex、原生 Qwen text/stash ASR、LiveTranslate 或 attention 模型都另做 adapter/成本/权限评估。不能把这些写成已落地延迟改善。

## 6. 验收与回滚

- 用原始时间序列的 ASR/MT 事件回放真实 production modules，对照旧门槛与候选；报告 first stable caption、first eligible/played unit、擦除字数、final correction、coverage 重复/遗漏、queue wait、underrun。
- 合成 trace 是 simulation，不是现场 latency benchmark；不报告伪造的节省毫秒。不用 keys，不调用真实 ASR/MT/TTS；provider accuracy/naturalness/实际成本和真实端到端延迟未测试。
- 场景：长 utterance final 前强边界可早播、重复/迟到 final、partial 回改；否定、数字单位、人名扩展、中英/日中重排；延迟/取消 MT、两槽饱和、最终公平；backpressure、underrun、设置 epoch、mute/replay/reconnect/source switch；关 flag 基线；历史原译文完整回放。
- 运行 Node 24 tests、check:version、syntax、实际 Chromium stub browser，并查看真实截图；检查最终精确 SHA 的远端与 CI，失败修复再测。只 draft PR，不 merge/deploy。
- 真实小流量开启前：母语审核正确性和自然度、记录 tail edits/前缀存活统计，再校准门槛。开关一关回到 final-only speech，保留完整 transcript。

## 7. 实施记录

- `0cd191e` 先提交本文；P0 请求局部取消、预留最终翻译容量、queue/model/capture 观测；P1 source/target frontier 与独立 spans、慢 MT 合并、最多一份修订上下文去抖；P2 实验性结构分句、不可变 source units、消费者 coverage、final 残余、冲突停止
- 本地 Node 24.19：初次完整回归 221/221；后续精确提交的完整测试、CI 和 Chromium 结果见 PR 的验证记录
- 新的 production-server/stub-provider 测试确实收到 final 前 PCM，覆盖天气样例、AI 新闻及访谈独立分句；天气/新闻 fixture 文本和时间均为合成输入，绝非供应商延迟测量
- 可见字符串擦除对照只证明合成 transient rewrite trace 上的改善。正常 mutable tail 仍会变化；持续真实修订会显式 rebase；尚未做真实录音质量/自然度/延迟评价
- 本地 Playwright Chromium 下载返回损坏/截断文件，不能声称本地真实浏览器通过；使用 CI Chromium fixture 与上传截图进行验证，若 CI 尚未完成必须标明
- 保留 Qwen commit PCM 和 Fish HTTP PCM，不引入 MT SSE/Fish duplex/provider 迁移/真实 key/付费调用；完整 transcript 和手动原文/译文 replay 仍 canonical

