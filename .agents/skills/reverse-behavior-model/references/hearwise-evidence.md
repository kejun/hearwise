# Hearwise 证据入口

这些路径是查找入口，使用前用 `rg --files`、`rg -n` 和当前代码验证。不可把本表当成运行时事实。

| 范围 | 优先读取 |
| --- | --- |
| HTTP / WebSocket 入口、收听会话 | `server.mjs` |
| 记录、句子、知识持久化 | `storage.mjs` |
| 翻译任务与定稿 | `translation-queue.mjs`、`server.mjs` |
| 知识抽取与队列 | `knowledge-workflow.mjs`、`knowledge-queue.mjs`、`knowledge.mjs` |
| 关系任务及提交 | `relation-workflow.mjs`、`relation-queue.mjs`、`relation-storage.mjs` |
| 播报会话与供给端 | `speech-service.mjs`、`speech-scheduler.mjs`、`qwen-tts.mjs`、`fish-tts.mjs` |
| 浏览器消费反馈 | `public/speech-controller.js`、`public/speech-player.js`、`public/speech-output-processor.js` |
| Effect 运行时、schema 和脱敏 | `src/` 下搜索 `step_key`、`instrumentation_version`、`process_id`、`sequence` |
| 日志解析与观测状态 | `scripts/trace-report.mjs`、`docs/execution-trace-report.md` |
| 本地样本与真实性边界 | `test-support/trace-report-fixture.mjs`、`test-support/full-trace-fixture.mjs`、`scripts/trace-report-demo.mjs` |

默认追踪写 stdout，不保证历史日志已持久保存。先找用户指定日志，不能把新运行生成的 fixture 当成历史生产记录。用户授权演示时可使用已有 demo 命令，明确标“本地 fixture；真实业务代码、替代模型端点”，不据此推断生产频率或性能。

按实际 schema 校验 `execution_trace` 事件。检查 build 中版本、进程序号缺口以及输入是否混合了多次进程启动。`listening_id` 是收听范围，`job_id`/`window_id` 是任务范围，`consumer_id` 是播放消费端范围，`segment_id` 是句子范围，不能互相替代；具体作用域必须核对当前代码。

特别核查：`continue`、`partial`、`discarded` 等业务结果不能被运行时 succeeded 覆盖；音频生成、PCM 发送、浏览器消费及播放完成是不同事实。跨流程关联 ID 不是父子依赖。没有稳定关联的预览/提前播报不能被硬塞进持久化句子。
