# 同声翻译

极简的本地 Web 应用：麦克风或浏览器标签页的音频通过本地服务转发给千问AI平台 `qwen-audio-3.0-asr-flash-streaming`，识别结果持续显示；译文由 `qwen-mt-flash` 生成，人物、术语等知识由 `qwen3.8-flash` 从最终原文中整理。默认识别英语，翻译为简体中文；也可以手动切换成自动识别。

## 运行

需要 Node.js 24 或更新版本。收听历史保存在本机 `data/listenings.sqlite`，服务启动时自动迁移；数据库不保存音频和 API Key。Node.js 24 的内置 `node:sqlite` 仍为实验性模块。

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:3000>，选择“麦克风”或“浏览器标签页”，点击“开始聆听”。首次使用按提示输入[千问AI平台通用 API Key](https://platform.qianwenai.com/docs/api-reference/preparation/api-key)。使用标签页声音时，请在浏览器的共享窗口中选择要收听的标签页，并勾选“共享标签页音频”；收听期间可点“更换标签页”重新选择。浏览器若提供原生的标签页切换控件，也可直接使用。标签页采集在 Chrome、Edge 等支持标签页音频共享的浏览器中可用，采集权限每次都需由用户确认。API Key 保存在当前浏览器的 localStorage；本地服务只在请求时使用，不写入磁盘。公共场所或共用电脑使用后，请在浏览器中清除本站数据。Token Plan 专属 Key 不能与此按量计费 Base URL 混用。

设置中的“测试连接”会分别检查识别、翻译与知识抽取模型，并显示三项结果。模型测试可能产生少量费用；测试不会保存输入的 Key。

服务默认仅监听 `127.0.0.1`。可以通过 `PORT` 设置端口。浏览器音频采集要求安全上下文，因此远程使用时需要自行配置 HTTPS。

## 接口说明

- 实时识别使用阿里云 WebSocket 的 `run-task → 音频流 → finish-task` 流程。浏览器经 AudioWorklet 采集单声道 PCM，并转为 16 kHz / 16 bit。停止聆听时前端会向 Worklet 发送 `flush` 指令，把不满一包的尾样本发出并等待 `flushed` 回执（最多 400ms），尽量不丢句尾音频。标签页模式使用浏览器的 `getDisplayMedia` 获取音轨；浏览器授权时会同时提供画面轨道，但应用只处理并发送音频。若浏览器只返回画面而没有音轨，页面会提示重新选择带音频的标签页。
- 翻译使用 Qwen-MT 的 OpenAI 兼容接口。识别中的句子约每 1.2 秒更新一次临时译文（浅色 + 「临时译文」角标）；句子结束后立即发起最终翻译，final 到达时无缝替换临时译文，中间不清空、不闪烁。
- 翻译 HTTP Base URL 是 `https://maas.qianwenaiapi.com/compatible-mode/v1`；实时识别需使用对应的 WebSocket 地址 `wss://maas.qianwenaiapi.com/api-ws/v1/inference`。两者不能使用同一个协议 URL。
- 阿里云会按模型用量计费；停止聆听后会结束识别任务。

相关文档：[千问AI平台 OpenAI 兼容接口](https://platform.qianwenai.com/docs/api-reference/toolkitframework/openai-compatible/overview)、[实时语音识别](https://platform.qianwenai.com/docs/developer-guides/speech/asr-realtime)、[客户端事件](https://platform.qianwenai.com/docs/api-reference/speech-recognition/fun-asr-realtime/client-events)。

## 字幕交互

单句大字幕，焦点始终跟随说话人：

- **焦点跟随**：译文区始终显示当前最新一句。说话时原文实时上屏，约每 1.2 秒更新一次临时译文（浅色 + 「临时译文」角标）。
- **无缝升级**：句子结束立即发起最终翻译；final 到达前保留同句临时译文（角标转「翻译中」），到达后原地替换为最终译文（角标「已完成」），全程不清空、不闪烁、不被后续句子打断。
- **停止后补齐**：停止聆听时若当前句译文仍在处理，按 ID 定点轮询自动补齐，无需手动刷新。

设置 → 语言设置中的「识别模式」（低延迟断句 / 标准断句）只影响服务端 ASR 断句参数，下次开始聆听生效，不改变上述字幕交互。完整句子历史见下方「收听历史」。

## 收听历史

“新建收听”会在识别任务成功启动后创建记录；“历史收听”可查看最终原文、译文与知识，并继续在原记录下收听。历史列表中的“删除”会在确认后永久移除整条记录及其关联内容，正在收听的记录需先停止。知识的“对话中提到”和“背景补充（模型生成）”分开展示；“待确认”表示证据不足。停止后仍在处理的模型任务会继续运行；如果服务重启或处理失败，在历史记录中点击“继续处理”即可用当前浏览器的 Key 重试。“原文与译文”区域提供下载下拉，可把全部句子的原文或已完成译文分别下载为合并的 txt 文件，不受页面分页限制。
