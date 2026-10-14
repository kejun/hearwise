# KEJ-75 播放代次与可播报文本验证

## 验收边界

本项分开保存有限协议模型、实际实现重放、真实本地供应商传输及 Chromium 页面证据。某一组通过不能替代其他组；真实 ASR/MT/TTS 质量、扬声器听感、设备兼容、长期资源曲线不在这些确定性夹具的结论中。浏览器尚未执行时必须保持 `not_run`，不能用合成截图字节或 Node 平台替身冒充页面通过。

实现 profile 为 `playback`，登记 HW-08-02 至 HW-08-05。原有 HW-08-01 种子范围卡保持原义。独立形式化配置及最终精确工具/源码/轨迹统计以 `verification/playback-protocol` 和其报告为准；这份文档不预先声称模型或远端浏览器已通过。

| 性质 | 实际实现边界 | 关键资产 |
| --- | --- | --- |
| HW-08-02 对象代次隔离 | 解锁、原生恢复、player 回调、旧 socket、供应商忽略取消、设备尾缓冲收尾 | `speech-generation-boundary.test.mjs`、`playback-protocol-adapter.test.mjs`、`playback-browser.mjs` |
| HW-08-03 规范化文本 | 独立 golden 的 UTF-16 区间账本、精确原文覆盖、Qwen/Fish 请求、最终消费回执 | `playback-text-contract.test.mjs`、`playback-websocket.test.mjs` |
| HW-08-04 暂停与跳转 | 在途合成可完成；下一句暂停；seek 仍暂停；显式恢复以及迟到原生 Promise | 实际 service/player/worklet 桥接与 1280/390px 键盘页面 |
| HW-08-05 帧与响应身份 | unit/frame/sample 序列、旧 epoch、重复/跨单元/坏长度、已知 response ID 历史 | `qwen-response-ownership.test.mjs`、真实服务器 WS/Fish HTTP |

## 修复前反例与生产修复

1. 旧 controller 使用无界 Number 递增作为回调身份和 uint32 wire epoch。实际 `0xffffffff` 边界后产生非法 wire 值，超过 `Number.MAX_SAFE_INTEGER` 后还可能复用数值身份。回归只在真实源码副本中设置初始计数，不改业务逻辑。现 wire 始终在 1…0xffffffff 内，局部 callback owner 和 resume revision 使用永不复用的对象身份。另有明确的模2测试加速器固定三代 1/2/1 ABA，不把小模数当生产值。
2. 旧 Qwen `response.created` 可将当前任务重新绑定到旧响应。仅保护第一次 created 仍不够：已完成旧 ID 先到时也会错误认领。真实 WS 回归固定当前 created 前/后到达、不是紧邻上一条的历史重复。每个实际连接记录已绑定的 ID；当前任务不重绑，历史 ID 不重新认领。
3. 历史阈值为4096个 ID 或累计1MiB UTF-8 ID字节。单个合法ID可以越过字节阈值一次，仍受既有4MiB消息上限限制；不截断或拒绝ID。只在无 pending 的下一任务先失效旧 ws 身份再关闭它，实际新连接创建时才换 ID 集合。真实4097次本地 WS 请求断言恰好两连接、4097次 commit、每次 attempts=1；旧连接 queued close/error/created/PCM 不影响新任务，新连接可以合法复用 `response-1`。另以三个512KiB多字节ID的真实WS请求验证第三请求才换连接、正好三次commit和三次PCM，证明字节数不是JavaScript字符串长度。没有对活跃任务清缓存或新增合成重试。

已有 reconnect 夹具曾为两次不同 commit 共用 `response.id='r'`，与新固定的历史身份约束冲突。保留该完整失败日志后，将夹具 ID 改为每 commit 不同；原 `commits=3`、`pcm=2`、部分音频后不重试断言未放松。

Qwen 协议按 response ID 关联 created/delta/done，参考[官方服务端事件](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-realtime-server-events)。当前单在途 API 没有给客户端一个能独立关联任意未知迟到 created 的提交 token。**首次未见 created 属于当前提交仍是明确环境假设**；已由本连接绑定过的历史 ID 不属于这个假设，必须被拒绝。连接重建和 provider ID 历史不是用户文本版本。

## 实现桥接不是模型重写

`test-support/playback-protocol-adapter.mjs` 实际运行 controller、SpeechPlayer、AudioWorklet processor、SpeechBuffer、speech service 和文件 SQLite。仅原生平台调度和 TTS 边界受控，供应商可在 close 后回调。PCM 进入真实帧校验、实际环形缓冲和实际 worklet render，progress 来自 worklet。`settled()` 等待实际设备 drain Promise，有明确 deadline，不靠80ms/100ms固定睡眠假定完成。

观测区分累计 `receivedSamples`、尚未消费的 `bufferedSamples` 和真实 `consumedSamples`。初始化故障和关闭均恢复平台全局、关闭 SQLite、删除临时目录；回归包含初始化中途失败后重新建立夹具。

真实语义保持：服务器 `speech.stop` 是该 socket 的取消，不检查其 epoch；pause 不撤销已有 synthesize，但阻止下一次；seek 建立新 player/socket，保留暂停；原生 resume 正在等待时，controller 仍 paused，而 player 内部已经尝试恢复，这两个状态不能合并。完成合成不等于完成消费，消费完不等于设备尾缓冲已 settle。

## 有限协议模型与实际重放

正式入口为 `npm run setup:playback-protocol`、`npm run verify:playback-protocol -- --release`，独立报告复核为 `npm run verify:playback-protocol:report -- DIRECTORY --release`。CI 为它单独设置15分钟 job；运行器 fast 总 deadline 为480秒，保留工具准备与报告上传余量。源码、工具版本、模型配置、原始 ITF、每步真实观测和负例都绑定当前干净提交。完整命令、冻结范围与成本日志见 [模型说明](../verification/playback-protocol/README.md)。

TLC 完整检查三个明确有限域：单 owner、两个 PCM 单元；双 owner、每 owner 最多一个 PCM；三个 owner 的同记录/固定起点/无 PCM 控制 ABA 补充。双 owner 域仍包含 seek、切换记录和相同 wire 值的旧/新代次交错。三个域分别做深度6的 Apalache 检查，这不是无限归纳证明。更宽三代音频交错的超时探针完整保留，不能由窄域通过替代。TLC 只去掉不进入 guard、业务更新或 Safety 的纯追踪标签，结构回归核对与带标签版本的对应。

19条命名 witness 使用固定 seed；另按三个域各100次、最多24步抽样，实际重放每域选定的5条轨迹。更宽的三代/两 PCM witness 只证明那些固定轨迹可达并符合实现，不是穷尽。模型中四类错误变体及真实 controller 源码副本删除 owner guard 的负例必须被检出。每步附实际 SQLite 身份、请求文本、消息、原生状态、缓冲/消费计数和原始二进制 header/payload；门禁重建投影、跨步固定身份、检查历史只追加以及错误终态矛盾，不只信任缓存的 actual 或空 violations。

## 文本 oracle

预先手写的 normalized golden 是期望值来源，不能调用生产 splitter 来生成它自己的期望。每个 unit 必须是下一个精确有序子串，任何间隙和尾部仅允许空白，全部 accepted/omitted 区间拼回 golden。可选 grapheme 边界检查覆盖 emoji family、组合字符及补充平面字符。

规范化保留内部词间空白，允许 splitter 在单元边界丢弃空白。测试包含成对/未成对 Markdown 标记、空白-only、很长空白、缩写/小数、长中文/英文、无标点、超长单 grapheme、最终尾段和合法/非法 rate。实时600 code-point边界显式通过/拒绝，不静默截断。来源区间 ledger 固定旧 run/epoch、重复 commit、final 抢先、覆盖前缀改写以及剩余源区间；不通过译文字符串减法推断已读覆盖。

## 浏览器与负例

`test-support/playback-browser.mjs` 使用实际页面按钮/键盘、真实 AudioContext/AudioWorklet、应用 WS、SQLite 和本地 Qwen 供应商。两种宽度各保存 normalized全文、paused seek、旧socket事件和旧 native unlock 竞争截图。旧 socket 队列注入可以携带当前 wire epoch，仍不得跨越对象 owner；该注入被明确标为迟到 DOM callback，而不是 TCP 包乱序。

原生 unlock 竞争只延迟真实 `AudioContext.resume()` 返回 Promise，实际 native resume 已完成后用户停止、切换记录、重新开始，再释放旧 Promise。负例只在页面 route 的真实 controller 副本删除 post-unlock owner guard；相同操作应观察到本不该出现的第二个 socket。正常路径必须保持一个 socket。它不替换页面业务函数，也不声称测得可听声音。

## 证据与门禁

`node scripts/verify-playback-browser.mjs --node-only` 真跑 identity16、text4、transports10 项，但四个性质均保持 `not_run`，整体退出1。完整入口为 `npm run test:browser -- playback`，必须由可启动锁定 Chromium 的环境运行。

共用严格 canonical TAP footer 解析器；本 profile 另绑定每阶段精确项数。整体检查共享150s deadline，父180s保留30s清理/报告余量；超时立即停止后续步骤。按性质应用的 execution 独立汇总，单项失败不污染不相关性质，但整体仍失败。

每个 result 严格只有 `observations.json` 与 `worker.log`。observations 内引用 browser JSON 与9张截图，所有10件附件都验证路径存在和 SHA256；browser JSON 与内嵌观测必须相等。门禁逐单元绑定 unit/PCM/end 的 epoch、编号、帧序列、样本和最终消费，独立重算 golden 区间；暂停前后保留供应商调用快照，旧事件前后资源数量/身份不变，完成后 sockets 和 contexts 必须实际关闭。原始阶段日志必须与完整 worker.log 绑定。首尾保存全部源码文件和实际 server build 的内容 hash，拒绝 dirty→dirty 内容变化；app/controller/player 保留 Chromium page response 的实际响应字节，正常/固定 controller 变体分别与源码计算结果绑定。Chromium 的 AudioWorklet 请求不触发页面 response 事件，因此仅浏览器播放夹具给真实 server 子进程启用 test-only Node preload：只观察两个精确 worklet/buffer GET 路径的 ServerResponse write/end 字节，在 finish 后同步写入独立临时日志，不额外请求源码副本、不修改生产服务。每场独立 fixture UUID 与真实服务 origin、观测来源、method/path/status、字节数及 SHA256 全部核对；错误、提前 close、空 body、缺任一模块都不能通过。observer 本身纳入首尾源码 hash；原始记录合并入 browser JSON 后仍维持两个顶层资产约定。真实 HTTP 回归覆盖编码、分块、背压、回调、返回值及启动失败清理；这些回归不替代 Chromium 执行。合成结构回归覆盖所有附件删除/篡改、计数减少/增加、skip/todo/缺footer、重复/缺失性质、错text/PCM/状态，以及超时清理。合成结构回归不是浏览器通过证据。
