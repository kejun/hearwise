# 译文语音播报：第一版实现

模型为 `qwen3-tts-flash-realtime`。页面初始、刷新、继续收听、切换音源形成新片段时均关闭播报；只有点击开启或试听才创建播放 AudioContext 与 `/ws/tts` 连接。普通收听、历史补齐、保存设置和原有连接测试不调用 TTS。

## 使用

1. 打开「播报设置」，填写所选地域的阿里云百炼 Key；识别/翻译使用的千问 AI 平台 Key 与它独立。
2. 选择北京或新加坡、音色和基础语速，可以点击「试听语音」。保存设置不自动开启播报。
3. 开始中文译文收听，再点击「开启译文播报」。从服务端确认开启之后的新最终句开始，之前已识别但稍后才译完的句子不会补读。
4. 音量实时生效。更改音色、语速或 Key 后保存，会关闭当前播报，手动重新开启后生效。
5. 「关闭播报」先在本机停止输出，再通知服务器；「停止聆听」则允许读完尾句，最长 20 秒，期间仍可关闭播报。
6. 积压时可明确选择「跳到最新内容」。中断后可选择「重播中断句」：从头读出该最终句，读完关闭，随后可手动重新开启实时播报。

Key 默认只保存在当前标签页的 sessionStorage；仅勾选记住才使用 localStorage。服务端不写入数据库或日志。TTS 为云端按量计费功能，不是离线小模型。麦克风收听建议戴耳机；标签页输入排除 Hearwise 自己，输出不接入录音图。

## 实现边界

| 部分 | 实现 |
| --- | --- |
| 播报源 | SQLite 中同一 listening/run 的最终译文，临时字幕永不进入 TTS |
| 起点 | 校验 active run 后，同步读取最大 sequence 并注册 consumer，避免分页水位和注册间隙 |
| 顺序 | 从水位后读取第一行，包含 pending/failed；前句未完成时不越过、不静默丢句 |
| 分段 | 在完整译文的句末或长分句标点处分段，保留引号、括号、数字，不补写或概括正文 |
| Qwen | commit 模式，24 kHz PCM16 单声道；单会话同一时刻一个 response，复用连接 |
| 播放 | 独立 AudioContext + AudioWorklet 环形队列，跨包连续重采样到设备实际采样率 |
| 取消 | epoch 使旧事件失效；本机先静音和释放播放器，再关闭上下游 |
| 确认 | Worklet 消费样本回执，与生成完成分开；自然结束额外等待声卡缓冲排空 |
| 收尾 | run 完结时冻结最大 sequence；保留停止前音频产生的最终句，不等待知识整理 |
| 翻译调度 | 阻塞播报的句子每隔一个派发槽可获优先；临时/最终翻译共享两槽，保留后台防饥饿 |
| 音源切换 | 选择取消保留旧流；成功选择后 flush/结束旧 ASR，建立新 run，播报关闭 |

二进制音频包头为 4 个小端 uint32：`epoch / unit / frame / sampleCount`，随后为 PCM16 LE。文本控制事件使用 JSON。服务端验证消费数与已完成单元的样本上界，客户端验证 epoch、单元、帧号和长度。

首音预缓冲 200ms；完整短音频不足阈值也能播放。最多有 2 个尚未播完的单元，待播 PCM 达 4 秒即暂停新合成；允许单个单元突破软水位，硬上限为 32 秒。客户端无进度回执 12 秒或 WebSocket 下行过载时关闭播报。单次合成最多 45 秒，连接最多 15 秒；drain 的 20 秒总期限始终优先。超过 600 字且无安全切点的单元明确报错，不截断正文。

尚无音频输出时可自动重连一次；一旦输出过 PCM，不自动从头重读。已完整生成的音频在上游正常断开后仍可本地播放；下一单元会重新建连。正常完成使用 `session.finish`，主动取消直接关闭上游。浏览器挂起时回到关闭，需手动开启恢复。

## 观测与验证

`speech_event` 日志包含 consumer/run、segment/unit、首包耗时、样本数、response 状态/重试次数、token usage（上游提供时）、缓冲时长、缺样次数和退出原因。日志不含 Key、完整译文和 PCM。待播时长是「未消费 PCM + 未生成文字按 5 字/秒估算」，不是与原声的精确延迟，也不是词级字幕对齐。

```bash
npm test
npm run check:version
```

`test/speech.test.mjs` 验证起点、乱序、去重、背压、收尾边界/超时、重播、回执校验、分段和 44.1/48 kHz 重采样。`test/speech-integration.test.mjs` 使用真实本地 WebSocket 接通 ASR、翻译和模拟 Qwen，覆盖 odd-byte PCM、session 配置、部分音频不重试及取消。`test/interim-translation-api.test.mjs` 验证临时/最终翻译不突破共享额度。

可选浏览器回归（自行安装 Playwright/Chromium；不修改应用生产依赖）：

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROMIUM_EXECUTABLE=/absolute/path/to/chrome \
node scripts/verify-speech-browser.mjs
```

该脚本使用假麦克风与本地模拟服务，不产生云端费用；验证真实页面操作、最终译文到 Worklet 消费、手动开关、停止收尾、新 run/刷新保持关闭、试听和手机宽度。

本次实现已通过模拟端到端与 Chromium 页面回归。尚未配置真实百炼 Key，因此不承诺真实首包延迟、音色听感、30 分钟稳定性或麦克风外放回声效果。发布前用目标 Key/地域完成试听及真实材料长时测试。后续再调优相邻短句合批、动态预取窗口与音色切换时的句边界衔接；本版不做自适应变速、不朗读历史、不播临时译文。

协议依据：[阿里云客户端事件](https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-server-events)。
