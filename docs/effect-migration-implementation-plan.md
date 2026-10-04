# Hearwise 引入 Effect 的技术实现方案

日期：2026-10-04  
状态：设计已确认，开始按子任务实施；实际完成范围以文末实施记录为准。本文的接口、目录、阈值和子任务均为实施约定；除明确标为“已验证”的内容外，不代表已经落地。
代码基线：[dc822b7e0fe63f712e214df4455b76e9cae6191c](https://github.com/kejun/hearwise/tree/dc822b7e0fe63f712e214df4455b76e9cae6191c)，main，v1.0.5。写作前已同步 main，与前次评估相同。  
适用范围：服务端、浏览器主线程及相关测试中的异步控制流程，以及第12节可下钻执行追踪与行为对比。文档先入库，再实施经过验证的提交组；不自动升级应用版本。

## 1. 目标与已确认事实

采用 Effect 统一取消传播、资源释放、并发额度、时间策略、错误处理及观测。保持现有实时字幕、翻译、播报、知识条目与图谱的业务语义，并优先解决两个已复现的问题：

1. `knowledge-queue.mjs` 的执行器接收 `execute(job, key)`，没有 AbortSignal。删除记录并调用 `remove` 后，在途执行仍占槽；并发为 1 时，另一条记录必须等旧请求结束。
2. `public/app.js` 的 `pollCurrentSegment` 使用 `setInterval(async …, 2000)`。用实际函数模拟慢响应，连续两次 tick 产生两个在途请求。generation 只阻止旧结果展示，没有停止实际请求。

证据范围：

- 已审查 32 个生产 JS/MJS 模块及相关测试。上一轮在同一提交、Node v24.19.0 下执行 `npm test`，506 项通过、0 失败、0 跳过。
- 上述两项为隔离复现，不是线上故障率或性能基准。
- 设计阶段未执行迁移、真实付费模型调用、浏览器媒体端到端验证或迁移性能测试；实施后的结果另记于第13节。
- 其余收益为基于代码的工程判断，须通过本文验收才能宣布实现。

成功标准：

- 在指定取消事件后，所属本地网络/任务停止，额度和资源被回收。
- 相同请求能够按明确规则串行、合并或批处理。
- 既有优先级、模型调用预算、恢复状态和音频输出顺序保持兼容。
- 付费请求次数不因包装或重试增加。
- 类型检查、现有测试、迁移测试和浏览器证据形成可重复的验证入口。

本轮不改变模型、提示词、知识收录标准、图谱算法、业务 API 格式、数据库 schema 或版本；不增加登录、远端工作流引擎或多进程调度；不重写 AudioWorklet 的 PCM 热路径。不承诺模型本身更快、取消一定停止远端计费，或未经测量的性能提升比例。

## 2. 已确定的技术路线

### 2.1 保持 JavaScript ESM，新增模块逐步采用 TypeScript

现有 `server.mjs`、纯函数、存储类、浏览器视图和 worklet 可以继续使用 JavaScript。新增 Effect 服务、错误模型、运行时适配层采用 TypeScript；只有正在迁移的模块逐步转为 TS，不开展全仓库改后缀。

- 入口继续使用 Node ESM。JS 入口通过编译后的 ESM 门面调用 Effect 模块。
- 新 TS 代码启用 strict；禁止用全局 any、通配模块声明或关闭检查掩盖边界问题。
- 旧 JS 模块通过显式端口接口及适配器接入。由根目录 JS 装配入口导入旧模块，把实例和纯函数传给新服务；新服务端 TS 不直接运行时导入根目录旧模块。装配适配器用窄范围声明或已检查 JSDoc 约束，并用契约测试验证；声明本身不能证明实现正确。
- 网络和数据库外部输入从 unknown 开始验证，不以类型断言代替运行时检查。
- 不要求全量启用 checkJs。前端和后端分别配置类型环境，共享代码不依赖 DOM、Node 或文件系统。
- 保留 `node:test` 与现有 JS 测试；新服务通过构建后的测试入口进行行为测试，并由 tsc 单独检查类型。

### 2.2 依赖及构建约定

写作时 npm registry 查询到：Effect 4.0.0、TypeScript 7.0.2、esbuild 0.28.2。它们是拟采用的精确版本，不是已完成兼容验证的组合。T01 必须以安装、编译、运行验证确认；不兼容时在同一任务内选定明确版本并记录原因，不直接使用浮动 latest。Effect 核查源码为 `395f256c223fa839585971254f0a7b48a903dd1f`。

构建选择：esbuild 输出 ESM，tsc 使用 noEmit 做独立类型检查。理由是允许旧 JS 与新 TS 共存，同时明确运行产物与类型门禁。具体约定：

| 项目 | 实施约定 |
| --- | --- |
| 服务端源码门面 | `src/server/index.ts`；只导出旧入口所需门面和测试所需服务工厂 |
| 服务端产物 | `dist/server/index.js`；bundle=true，platform=node，format=esm，target=node24；npm 依赖 external |
| 浏览器源码入口 | 保留 `public/app.js`，逐步导入 `src/browser/` 的 TS 控制模块 |
| 浏览器产物 | T15 起输出 `dist/public/app.js`；bundle=true，platform=browser，format=esm，splitting=false |
| 资源路径 | `/app.js` 映射到浏览器产物；CSS、HTML、worklet 继续使用原明确白名单，不开放 dist 目录任意访问 |
| worklet | 保留独立 URL 和原生 JS；不得意外打入主线程包 |
| 类型配置 | server/browser 两份配置，shared 分别校验；strict/noEmit，环境隔离 |
| 构建输出 | dist 不入库；构建清理过期产物；失败时不得使用看似成功的新产物 |
| 开发模式 | 先构建成功再启动；监听重建，成功后再重启对应服务；构建失败明确提示，不能静默混用新旧服务端文件 |
| sourcemap | 可生成供本地/CI 调试；生产不通过通用静态目录暴露 |

服务端构建的特别边界：`knowledge.mjs` 通过 `new URL('./docs/…', import.meta.url)` 读取提示词。旧模块继续在根目录按原路径加载，再通过端口注入新服务；不能让 esbuild 把它无意内联到 `dist/server/index.js`，从而改变资源定位。T01/T03 必须检查构建依赖图和运行后的提示词内容。部署仍需携带根目录旧模块、docs 提示词和 public 资源；dist 不是独立可执行发行包。今后迁移提示词加载时另行建立显式资源路径或构建资产规则。

统一命令的目标语义：

- `npm run build`：生成当前阶段所需产物；T15 之前不切换前端路径。
- `npm run typecheck`：检查新增 TS 代码，不做构建。
- `npm test`：先 build，再运行现有和新增 Node 测试。
- `npm run test:browser`：先 build，再运行三个现有浏览器验证脚本；不得只保留 speech 脚本而漏掉 graph/relation progress。
- `npm start`：源码安装场景下先构建，再启动 server.mjs。
- `node server.mjs`：部署产物场景，调用者负责预先 build；缺少产物时明确失败。
- 生产 `npm ci --omit=dev` 必须发生在构建产物生成之后，或由独立构建阶段提供 dist。不能要求生产机器只有运行依赖却现场编译。
- CI 当前用 `npm ci --ignore-scripts`，T01 必须验证此路径下 esbuild 二进制可用。若不可用，只为锁定版本增加必要安装步骤并记录原因，不能直接放开所有依赖脚本。
- test-support 当前直接 spawn `node server.mjs`。构建应由统一测试入口完成一次，不能每个 fixture 重复构建；CI 中直接运行 verify 脚本前也必须 build。

### 2.3 迁移方式

保持对外接口和数据库格式，用模块门面逐步替换内部执行。每个子任务切换后只保留一个拥有调度权的实现。

禁止对付费模型做新旧实现双跑。对照测试只能使用固定响应、stub provider 或纯调度器。默认使用提交级回退；不增加长期全局 feature flag 或任意新旧调度器混搭。每个任务在其依赖提交上验证，不能把单个旧调度器随意塞回已经迁移的运行时。

## 3. 必须保留的业务不变量

以下是验收条件，不是一般编码建议。修改某一项需要另行明确产品变更，不能混入 Effect 重构。

| 编号 | 不变量 | 代码依据 / 主要现有测试 |
| --- | --- | --- |
| I01 | final 字幕按既有 sentence 身份去重；冲突处理、source 顺序、generation 防旧事件规则不变 | server.mjs；segments、asr-params、caption-frontier |
| I02 | final/interim/短语 MT 共用现有两槽；语音 head、最近两句窗口和后台防饥饿规则不变 | translation-queue.mjs；translation-queue、interim-translation-api |
| I03 | interim 保持单在途、1,200 ms 最小间隔和 latest pending；不能每个 token 都取消当前请求 | public/app.js；interim-translation-ui |
| I04 | 知识保持 1.5 秒 quiet、4 秒最长合批等待、3 句/1,200 字门槛、每记录串行、轮转与前台让路 | knowledge-queue.mjs；knowledge-queue、knowledge-realtime |
| I05 | 知识调用前记预算；有效结果与检查点同事务；单次修复规则、部分成功及重启恢复不变 | knowledge-workflow.mjs、storage.mjs；knowledge-workflow、knowledge-checkpoint、knowledge-v2 |
| I06 | 关系每窗口请求预算上限 3；先数据库取消栅栏后网络 abort；expectedEpoch 重试和迟到 usage 语义不变 | relation-workflow/queue/storage；relation-engine、relation-storage、relation-throughput |
| I07 | SQLite 事务同步完成；BEGIN 到 COMMIT 不允许 await/yield；内存队列不是可恢复任务的唯一来源 | storage.mjs、relation-storage.mjs；listening、knowledge-checkpoint、relation-storage |
| I08 | 同一 TTS 单元一旦向下游输出 PCM，不能自动从头重试；Qwen/Fish 错误重试矩阵保留差异 | qwen-tts.mjs、fish-tts.mjs；speech、fish-tts |
| I09 | 播报的 epoch/unit/frame/sampleCount、消费确认、4 秒/2 unit 预取、32 秒及 WS 1 MB 硬限制保留 | speech-service.mjs、speech-protocol.js；speech-integration、incremental-speech-integration |
| I10 | stop 先本地静音；pause/resume 的修订号、暂停期限和 drain 扣除暂停时间不变 | speech-controller/player/media-session；speech-media-session、浏览器 speech fixture |
| I11 | ASR 停止/断连后已提交 final 与知识工作可以继续；删除记录才终止其任务。关系暂停只影响关系 | server.mjs；knowledge-realtime、relation-engine |
| I12 | history 点击立即切换页面再加载；详情保留实时合并、metadata 版本保护；图谱保持 generation/revision 防旧响应 | app.js、knowledge-graph.js；history-metadata、knowledge-graph、graph-realtime-integration |
| I13 | Key 仅按既有内存/浏览器设置策略管理；不入 DB、不写日志；普通关闭连接不能过早释放仍被后台任务使用的 Key | server.mjs maybeReleaseKey；provider-admission、acceptance-audit |
| I14 | 图谱没有依据时允许无关系；结构 schema 不能取代现有原文引用、实体身份和语义边界校验 | relation-evidence、identity-grounding；relation-semantic-boundaries、relation-grounding-pipeline |
| I15 | getDisplayMedia 和 AudioContext.resume 保留直接用户手势调用；权限请求晚到结果必须正确清理 | app.js、speech-player.js；浏览器验证及真机检查 |
| I16 | 超时或失联的写请求先读取对账，不能通用自动重发；关系 retry 继续使用 expectedEpoch | knowledge-graph.js、server.mjs；graph-api、history-metadata |

纯函数、PCM 运算和图谱布局测试继续保留，不因为未转成 Effect 就删除。

## 4. 目标架构与运行约束

### 4.1 服务边界

拟新增目录是目标结构，不要求 T01 一次生成空壳。文件随相应任务建立。

| 目录 / 服务 | 责任 | 不承担的责任 |
| --- | --- | --- |
| src/shared/contracts、errors | 公共协议结构、领域错误、标识类型 | 不访问 DB、网络或浏览器全局 |
| src/server/runtime | Layer 装配、应用 scope、请求/连接门面、退出 | 不写业务排序或模型重试规则 |
| src/server/store | 对现有 ListeningStore 的窄端口与错误适配 | 不重写 schema、迁移或事务算法 |
| src/server/provider | 带取消的 HTTP/WS 适配器、凭据作用域与准入 | 不通用重试所有模型请求 |
| src/server/translation | dispatcher、额度、任务登记 | 纯队列 selector 继续复用 |
| src/server/knowledge | 调度器及单次状态推进 | 知识校验纯函数继续复用 |
| src/server/relations | 调度器、状态推进、迟到 usage 接收 | 关系证据算法继续复用 |
| src/server/asr、speech | ASR 连接、TTS 适配器、consumer 控制 | 不在实时音频处理器逐 sample 运行 Effect |
| src/browser/runtime、requests | 页面 scope、读取协调、证据 resolver | 不引入新的 UI 框架 |
| src/browser/capture、speech | 媒体生命周期和控制编排 | worklet/环形缓冲仍是原生 JS |

### 4.2 生命周期所有权

`ManagedRuntime` 每个服务端进程一个；浏览器主应用一个。不在每个请求重新构建 Layer。跨越 JS 边界时使用运行时门面，内部模块返回 Effect，不随处调用 runPromise 建立游离任务。

`ApplicationScope` 拥有请求、连接、后台主管及退出服务。记录级主管属于应用，不属于打开它的 HTTP 请求或 ASR socket。

| 所有者 | 持有资源 | 正常终止事件 |
| --- | --- | --- |
| HTTP request scope | 本请求独占检查/读取、监听器 | 响应完成或客户端异常断开 |
| ASR connection scope | 上游 socket、协议 Deferred、监听器、期限 | task-finished、连接失败、停止/断开 |
| Listening supervisor | 已提交 final MT、知识/关系执行实例、wake 信号 | 删除、应用退出；空闲时按 Key/任务状态回收 |
| Speech consumer scope | 私有 TTS、短语 MT、生成 worker、watchdog | stop、错误、断线、自然完成、暂停过期 |
| Page generation scope | 详情、图谱、证据、轮询 | 选择记录变化、离开页面、应用关闭 |
| Capture scope | tracks、AudioContext、nodes、worklet port、采集 WS | 结束采集、切换成功、获取过程中失败 |
| Playback scope | 播放器、媒体事件、恢复/settle 任务 | stop、切换、失败、播放结束 |

每个子任务必须有一个 owner；不得用不受监管的根 fiber 代替旧 detached Promise。注册表按实际任务标识区分 final segment、知识 job、关系 job、speech consumer；关系不能简化成“每记录只允许一个 fiber”，以免改变既有窗口并发。

运行注册应遵循：先登记 ownership/占位，再启动执行；无论成功、失败、中断都移除相同 token 的登记并归还许可。旧任务结束不能删除后来同 key 的新任务。删除时先阻止新调度，再执行既有 DB 删除/取消，随后中断并收尾；DB 删除失败则恢复本地准入，不假装删除成功。

### 4.3 取消必须贯通真实 I/O

`Effect.tryPromise` 的 AbortSignal 必须传入 fetch，并覆盖响应体读取。只包装 fetch 的 headers 阶段、之后在外部读 JSON，不能证明整个请求可取消。

回调式 WS 使用 v4 `Effect.callback` / `Stream.callback` 适配，并注册取消释放函数：移除监听、终止/关闭该操作拥有的连接、完成 Deferred。socket 共享时不能因一个等待者取消而销毁所有使用者的资源。

对不响应 AbortSignal 的第三方 Promise：

- 允许逻辑任务中断，不再等待结果，但不能声称底层资源一定关闭。
- 底层异步操作只能返回数据，不能自行提交 DB；提交只在仍有效的 owner 中执行。
- 保留 rejection handler，避免迟到 reject 变成未处理异常。
- 关系迟到 usage 交由受应用监管的有限生命周期记账接收器；结果提交仍受持久化 epoch 限制。退出收尾期限过后不再访问已关闭 DB，记账不可能保证在进程被强杀后完成。
- 不创建无限等待的后台 fiber 来“兜底”失控 Promise。

| 取消原因 | 所属任务与状态处理 |
| --- | --- |
| request_disconnected | 停止该请求独占检查/读取；已受理后台作业继续 |
| page_replaced | 停止旧页面读取/轮询，不改变服务端已提交任务 |
| listening_deleted | DB 删除成功后终止所属后台/语音任务；不得再写终态、广播已删除记录或重新排队 |
| relation_cancelled | 先持久化 epoch/取消状态，再终止关系；保留已有关系与合法迟到 usage |
| speech_stopped / superseded | 立即本地 mute/失效旧 epoch，停止该 consumer 和短语请求 |
| application_shutdown | 停止新准入，有界等待后中断；保留恢复所需 checkpoint，不记成普通模型失败或马上重试 |
| timeout | 转成具体阶段的 Timeout 错误；仅由所属业务规则决定重试 |

原始 AbortError 不能一律归为“请求超时”。生命周期原因由 owner 显式携带；Effect interruption 保持控制语义，不经通用 catch 转成可重试错误。

### 4.4 持久化与中断的原子边界

顺序固定为：纯输入检查 → 当前 owner/epoch 检查 → 同步持久化预算/调用意图 → 再次检查取消 → 发一次请求 → 验证结果 → 检查 owner/epoch → 同步提交结果与检查点 → 广播。

- 每个同步事务作为一个不可被异步切开的短步骤；只对这个步骤使用必要的中断屏蔽，不把整个网络流程设为 uninterruptible。
- 预算预留后、实际发送前被取消，可以留下保守计数；不自动返还无法证明未发送的额度，避免突破付费上限。
- HTTP 成功而存储提交失败属于 StorageFailure；不能据此再调用模型。
- shutdown 中断知识任务时保留已有 inflight checkpoint，重启沿用现有恢复规则。尤其 repair_inflight 仍按现有规则终结，不从头重放修复。
- “HTTP 已完成后不重发”约束当前执行路径的错误处理。若进程在响应与提交之间崩溃，持久化状态仍可能是 extract_inflight，重启按原规则可能在剩余预算内再请求；本方案不把它描述成 exactly-once，也不新增这类重复调用。消除此窗口需要独立的供应商幂等或响应持久化设计。
- 删除与提交在同步事务和 ownership 边界上排序；提交先发生则是已提交结果，删除随后清除；删除先发生则迟到提交必须跳过。
- 本轮不新增 DB 状态或重写恢复协议；若实现发现必须改 schema，停止该任务扩张，单独更新设计和迁移方案。

### 4.5 调度与背压

Translation 的纯 selector 继续负责 next；Semaphore 只控制总额度，不负责重新排序。interim 通过非阻塞许可检查维持“忙时跳过”，不能进入不可见等待队列。final remainder 使用 Deferred 连接队列和等待者。

知识/关系保留不同并发和前台让路策略。冷却、quiet 和持久化 ready_at 使用同一个可替换时钟来源；重启继续以持久化绝对时间为依据，进程内等待由 Effect Clock/Schedule 执行。避免 Date.now 与 TestClock 两套时间各自推进。

Queue 用于唤醒、指令或有界缓存，SQLite 仍是可恢复任务事实源。纯失效通知可以合并，final 句和 PCM 不允许 sliding/drop。对于推送型 WebSocket，bounded Queue 不会自动使远端减速，必须定义累计字节/采样数上限和关闭行为。

Consumer 内至少区分：短控制状态更新、耗时生成 worker、独立 watchdog。控制更新不能持锁等待网络。PCM 接收回调保持短路径，不能因重排到异步 consumer 而破坏 unit/frame 的顺序。保留既有样本记账，Stream 队列长度不能替代音频秒数预算。

### 4.6 错误与重试

错误携带安全的 code、阶段、provider、HTTP status、retryAfterMs 等必要字段；原始响应和凭据不直接用于用户提示。意料内故障放入明确错误通道，程序缺陷由监督边界记录 Cause 并终止所属任务，不转换成业务重试。

| 类别 | 处理规则 |
| --- | --- |
| Lifecycle interruption | 按 owner 取消；不显示普通模型失败、不自动重试 |
| ProviderTimeout / TransportFailure | 由知识、关系、翻译或 TTS 自己的现有规则判断 |
| ProviderRateLimited | 保留 Retry-After 和原有模型/凭据冷却；不得把知识冷却无条件扩展到全部翻译 |
| ProviderRejected | 鉴权/配置错误保持原来停止或等待用户修正的行为 |
| ProtocolInvalid / EvidenceRejected | 结构与语义分别处理；只允许当前领域已批准的纠正/重试 |
| StorageFailure | 保留恢复证据；已经完成 HTTP 的步骤禁止重新请求模型 |
| StaleEpoch / MissingListening | 丢弃已失效结果；不是触发重试的故障 |
| BudgetExhausted | 终结或等待现有显式操作，不能内存重置预算 |
| Unexpected defect | 记录脱敏诊断、释放资源，按现有领域状态处理，不无限重启 worker |

Effect retry/Schedule 只表达已允许的策略。尤其禁止对整个 knowledge/relation workflow、写 API 或“已经输出音频”的 synthesize 添加统一 retry。

### 4.7 前端请求协调

每个页面 generation 创建独立读取协调器：

- 单句轮询改成“请求结束后等待 2 秒再读”，单次网络期限拟为 10 秒，总墙钟期限拟为 180 秒，同时保留最多 90 次上限；到总期限立即取消在途请求。以上为新行为约定，需 T16 以虚拟时钟验证。
- processing poller 原本已经串行；只补齐取消传播和时钟统一，不能声称修复了它不存在的 interval 重叠。
- 详情读取只合并同一 listening/generation/参数的在途请求，结果仍经 live merge。读取中收到更新通知要设置 dirty，在此次完成后补一次读取；不能因 single-flight 丢掉刷新。
- 单个消费者取消只取消其等待；仅在没有等待者或页面 scope 关闭时取消共享网络。共享请求不能绑定在第一个调用者的短暂 scope 上。
- 证据 RequestResolver 按 listening、run 查询条件和 page generation 分组；每批最多 50 个 ids，微任务级合批，主动批窗上限拟为 10 ms。
- 证据结果缓存只保存终态且属于当前页面的项，拟上限 500 条/LRU；pending 只合并在途，不保留已完成缓存。segment 纠正、translation 状态变化和删除时失效；无可靠细粒度通知时使整个 listening 缓存失效。关闭页面清空缓存。
- POST/DELETE/metadata save 不进入通用读取 retry；失联按既有读回对账处理。

### 4.8 有界退出

退出机制分两步实施：T02 建立可 dispose 的运行时，T21 才连接 OS 信号并启用完整流程。

拟总退出上限 15 秒：先停止接受新 HTTP/WS 和新调度；要求现有 ASR 结束并收尾、将已有缓存按现有规则落为待处理工作；允许在途工作最多 10 秒完成。随后中断剩余任务，最多 5 秒收尾 socket/监听/worker/记账接收器，最后关闭 DB。

scheduler 的“禁止新执行”和“把已收到内容持久化”必须分开，避免为了退出把合批缓冲直接丢弃。超过期限不伪造任务成功；记录安全诊断并退出，重启沿用数据库恢复。SIGKILL、浏览器强退和供应商不理会取消不在正常 finalizer 保证范围内。

### 4.9 门面和内部服务契约

以下是拟定的接口责任，不是要求照抄的已编译代码。具体类型在对应任务中与现有 DTO 对齐；新增类型不得改变 JSON wire 格式。

| 接口 | 输入和输出 | 执行与所有权约定 |
| --- | --- | --- |
| Store 端口 | job/checkpoint/epoch 等既有 DTO；成功值或 StorageFailure | 一次方法调用只执行一个明确同步操作/事务，不在内部发网络请求 |
| Model transport | 已验证请求、凭据与执行上下文；返回响应或明确 transport/provider 错误 | 整个响应读取归调用方 scope；不得自行提交知识/关系结果或自动重试 |
| Knowledge step | 持久化 job 与凭据；continue/terminal 的既有字段 | 一次推进最多一次模型调用；取消走 interruption，不伪装成新的业务 outcome |
| Relation step | job、凭据、epoch；continue/terminal/discarded | 一次推进最多一次付费调用；usage 接收器不拥有结果提交权 |
| Scheduler 门面 | 保留 schedule/pump/remove/hasWork 等调用语义；增加明确的异步 dispose/drain | hasWork 同步反映已登记工作；schedule 先登记再唤醒，派发完成通过显式可等待事件测试；旧 close 调用点必须接入新收尾职责 |
| TTS adapter | 单元文本与 consumer 配置；有序 PCM 及完成/失败事件 | 一个实例隶属一个 consumer；明确是否已向下游输出，close 幂等 |
| Browser read coordinator | 资源键、页面 generation、等待者 signal；共享读取结果 | owner 是页面 scope；等待者取消与共享 I/O 取消分别处理 |

JS 入口只在最外层转换 Effect 为现有 Promise/回调；内部服务不来回套 runPromise/tryPromise。为了过渡而保留的 Promise 门面也必须收到 owner 的取消信号，并且不在未受监管的 continuation 中修改 DB。通知失败不能撤销已经提交的事务；按既有容错方式记录并依赖后续 revision/读取恢复。

## 5. 高级能力的采用边界

| 能力 | 本轮落点 | 验证重点 |
| --- | --- | --- |
| Context.Service / Layer / ManagedRuntime | 依赖装配、测试注入、共享运行时 | 同一运行实例只创建一次 store/provider；不重复构建连接 |
| Scope / acquireRelease / forkScoped | 请求、连接、consumer、capture、页面 | 成功/失败/取消均释放；父子 scope 正确 |
| Deferred / callback | 握手、完成、flush、progress | 多次通知只完成一次；取消无悬空等待 |
| Semaphore / Ref / SynchronizedRef | 额度、短状态变更 | 每次释放一次，不锁住长 I/O，不改业务排序 |
| Stream / Queue / PubSub | 事件适配、触发、失效通知、TTS 块传递 | 顺序、容量、关闭、不可丢弃事件和控制响应 |
| Schedule / TestClock | quiet、cooldown、deadline、退避 | 持久化时间与测试时间一致，取消能唤醒等待 |
| RequestResolver / Cache | 批证据、共享在途读取 | 分组不越权/串记录，取消和失效语义正确 |
| Schema | HTTP/WS/模型响应结构 | 错误兼容；保留专门的证据与身份校验 |
| withSpan / Metrics | 任务关联、排队/请求/首音频阶段 | 脱敏；避免高基数标签；观测不改变业务成功 |

暂不使用 Effect Workflow/Activity/Cluster 替换现有持久化执行器。核查的 v4 Workflow 仍标注 unstable，通用工作流也不能保证外部付费请求 exactly-once。暂不全局 Pool 化 TTS 连接，避免跨 consumer/key/voice/epoch 复用。需要专门业务含义的状态机继续显式表达，不能仅用一串组合子掩盖状态转换。

## 6. 子任务总览和依赖

以下为目标任务清单，实际状态见第13节。每个任务原则上对应一个可单独审查、验证和回退的提交组或 PR。依赖表示合并前置条件，实施者可以先写测试，但不能绕过依赖提交启用生产路径。下面并列分支表示技术依赖，不要求使用多代理或同时执行。

| 任务 | 交付内容 | 依赖 | 风险 |
| --- | --- | --- | --- |
| T00 | 固定基线与迁移验收夹具 | 无 | 低 |
| T01 | TS/Effect 后端构建与 CI 接入 | T00 | 中 |
| T02 | 运行时、owner 注册和取消原语 | T01 | 中 |
| T03 | Store/Provider 端口与额度观测 | T02 | 中 |
| T04 | 知识 HTTP 取消贯通 | T02；兼容路径复用现有 Store/Provider | 中 |
| T05 | 知识队列迁移 | T03、T04 | 中高 |
| T06 | 知识 workflow 的单次推进迁移 | T05 | 高 |
| T07 | HTTP 请求 scope 与连接检查 | T03 | 中 |
| T08 | 翻译 dispatcher 与 interim 门面 | T03、T07 | 高 |
| T09 | ASR 连接与协议期限 | T08 | 高 |
| T10 | 关系 scheduler 迁移 | T03、T06、T08 | 高 |
| T11 | 关系单次推进与迟到 usage | T10 | 高 |
| T12 | Qwen TTS 适配器 | T02、T03 | 高 |
| T13 | Fish TTS 适配器 | T02、T03 | 高 |
| T14 | Speech consumer 编排 | T08、T12、T13 | 高 |
| T15 | 前端 bundle 与页面运行时 | T01、T02 | 中高 |
| T16 | 单句/处理状态/详情读取 | T15 | 中 |
| T17 | 图谱刷新与证据批处理 | T16 | 中高 |
| T18 | 历史分页和其他 HTTP 操作 | T16 | 中 |
| T19 | 浏览器采集和切换 scope | T09、T15 | 高 |
| T20 | 浏览器播放 scope 与 Media Session | T14、T15 | 高 |
| T21 | 完整应用退出与重启恢复 | T06、T07、T09、T11、T14 | 高 |
| T22 | 综合负载、性能与资源验收 | T17、T18、T19、T20、T21 | 高 |
| T23 | 删除过渡实现、更新交付文档 | T22 | 中 |

建议里程碑：

- M1：T00–T05，首先交付知识取消与后端基础。T06 紧随完成持久化编排的统一。
- M2：T07–T11，HTTP、翻译、ASR、关系执行归入统一运行时。
- M3：T12–T14，语音服务端迁移完成。
- M4：T15–T20，前端全部主要异步控制路径完成。T15/T16 可在后端 M1 后提前安排，以尽早消除已复现轮询问题。
- M5：T21–T23，完成退出、整体实证与过渡代码清理。

## 7. 子任务执行说明

### T00 固定基线与验证夹具

**范围：** test、test-support、测试记录；不改运行逻辑。记录 main SHA、Node/浏览器版本、现有测试数量和指标定义。

**实施：** 把前次两项隔离复现转为可重复的基线探针；增加慢响应、忽略 abort、迟到 reject、存储提交失败、付费请求计数的可控 fixture。已有 provider stub 继续复用，不连接真实模型。基线探针记录旧行为，不把已知旧问题写成必须永久满足的回归断言。

**验收：** 原 506 项继续通过；两项探针稳定重现；fixture 清理后资源归零。收集当前构建前端大小、固定 stub 下延迟和请求数；没测到的指标明确空缺。

**回退：** 只回退新增夹具/记录。交付物包括不变量到测试的映射，不增加生产依赖。

### T01 加入后端构建与类型检查

**范围：** package/lock、构建/开发脚本、TS 配置、CI、src/server 最小入口、gitignore、README 启动说明。

**实施：** 锁定并验证第 2 节版本；完成后端产物和类型检查，暂不改变业务路径或前端静态路由。区分构建依赖和运行依赖；修改两个 CI job，使直接启动 fixture 前已有产物。

**验收：** 从无 dist 的干净 checkout 执行 npm ci --ignore-scripts、typecheck、build、npm test、browser fixture 成功；产物可由 Node 24 ESM 导入；源码安装和预构建生产安装均能启动；构建失败不落入旧产物假成功。

**回退：** 回退本任务即可回到原启动方式，无数据库变化。未经该门禁，不允许下游模块 import dist。

### T02 建立运行时与任务所有权

**范围：** src/server/runtime、src/shared/errors 及门面测试。

**实施：** 建立单实例 ManagedRuntime、服务 Layer、短同步 owner 注册、任务 token、幂等 dispose；定义取消原因。实现 fetch 完整响应适配、Deferred/callback 的最小通用基础。此任务只提供生命周期基础，不一并迁移所有网络调用。

**验收：** 成功/异常/中断各归还一次资源；父 scope 关闭终止子任务；旧 token 不能移除新任务；忽略取消的 Promise 晚到不产生未处理 rejection；runtime 不重复构建服务。

**回退：** 在业务未接入前可独立删除；业务接入后必须按依赖回退，不能留下无 owner 的 runFork。

### T03 接入 Store 和 Provider 端口

**范围：** storage/provider-admission 适配、Layer 装配、测试注入；DB 内部实现保留。

**实施：** 显式列出被迁移模块需要的 Store 方法；每个事务一个同步 effect；typed error 映射保留 status、code、retryAfterMs。统一 provider 活跃计数、冷却读取、短状态转换与指标，不改变调度策略。

**验收：** 原 provider-admission/listening 测试通过；模拟同步事务失败不丢错误；取消前后活跃计数归零；知识 429 不无意冻结 MT；假时钟与 ready_at 一致。

**回退：** 门面退回旧依赖注入；不动数据库内容和迁移版本。不要在本任务重写整个 storage.mjs。

### T04 贯通知识请求取消

**范围：** knowledge.mjs 的网络边界、knowledge-workflow/queue 兼容门面、server 删除/关闭调用处。

**实施：** 提供兼容旧参数的可选执行上下文，携带 signal 和生命周期原因；一路传到抽取与修复 fetch/响应体读取。过渡队列可先保留原实现，但由任务 scope 登记在途执行。删除成功后取消该记录并释放槽。shutdown interruption 跳过普通失败/重试路径。

**验收：** 并发 1、阻塞 provider 时删除 A，A 请求观察到 abort，B 能启动；晚到结果不落库/广播；repair 被取消不重放；正常30秒抽取/15秒修复期限仍有效；旧接口调用方继续可用。

**回退：** 回退完整取消调用链而非只去掉某一层 signal；不改 checkpoint 格式。本任务先交付行为改进，T05 才替换队列主体。

### T05 迁移知识调度器

**范围：** knowledge-queue.mjs 的调度执行部分、新 knowledge 服务；保留纯合批/选择规则。

**实施：** 用 Effect 等待、任务登记和并发许可替代手动 timer/running；保持每记录串行、轮转、动态并发和最早唤醒计算。Queue 仅合并 wake 信号；DB 保存 job。close 区分停止准入、刷新缓冲、等待执行和中断。

**验收：** knowledge-queue/knowledge-realtime 全部通过；FakeClock 验证 quiet/maxWait/每记录间隔/前台让路；许可不泄漏、不重复 dispatch；删除取消回归保持；关调度器不启动新请求。

**回退：** 回到支持 T04 取消语义的过渡队列，不退回完全没有取消的版本；数据库无需迁移。

### T06 迁移知识单次状态推进

**范围：** knowledge-workflow 的异步编排、返回类型和错误处理；保留 prompt、解析及原事务。

**实施：** 将一次合法推进定义为 effect：最多一次模型调用，返回 continue/terminal；预留预算、HTTP、提交、广播分开。extract 和 repair 都从服务依赖获取；使用 typed error，但不改变 v1/v2 兼容和持久化规则。

**验收：** knowledge-workflow/checkpoint/v2/contract 通过；逐点中断：预留前、预留后、HTTP 中、HTTP 完成后、提交后；断言请求次数、accepted items、checkpoint 一致。HTTP 成功+commit 失败无第二次调用；进程重开恢复不突破原预算。

**回退：** 使用 T04 已支持取消的旧 workflow；保持 checkpoint 兼容。不得为简化类型删除 partial/empty 等正常结果。

### T07 统一 HTTP 请求生命周期

**范围：** server.mjs HTTP 入口、readJson、三项连接检查、错误响应适配。

**实施：** 建 request scope；只在真实异常断开或响应结束时按所有权释放，不能误把正常 request body end 当取消。三个连接检查并发，但每项先转换结果再聚合，保留现有全量结果。连接检查 WS/HTTP 可取消；其它 CRUD 保持路由与响应结构。

**验收：** 请求断开时三项检查资源释放；一项失败仍能返回其他项结果；正常读完 POST body 不取消后续业务；32 KB 限制、same-origin/参数校验和现有 API 测试不变；后台任务不因响应完成被误杀。

**回退：** 恢复原 HTTP 入口及检查门面；已完成数据库写入不回滚或重复。

### T08 迁移翻译执行器

**范围：** server 的 translate/pumpTranslations/translateSpeechPhrase、provider 交互和 interim 路由；translation-queue 纯 selector 保留。

**实施：** 两槽统一由许可管理，optional interim 用 try-acquire；队列任务完成用 Deferred，取消移除等待者与所属任务；final 在途加入 listening owner。保持15秒普通 MT期限、既有错误状态和语音 head 规则。

**验收：** translation-queue、interim-translation-api/ui、incremental-speech-integration 通过；交错负载证明总在途≤2、无饥饿、同句不重复；删除终止在途 final；取消等待 remainder 不泄漏监听或许可；持续 token 输入仍能产生预览结果。

**回退：** 回退完整 dispatcher 和门面组合，不同时运行两个额度计数系统。

### T09 迁移 ASR 连接

**范围：** server 的 /ws 升级后连接逻辑、新 ASR 服务。

**实施：** callback/Deferred 描述 started/finished；scope 管上游 socket 和监听；保留开始前最多一次参数降级。新增 task-started 等待期限拟为12秒，和连接握手分别计时。新增上游发送积压控制拟以1 MB为初始硬上限，超限明确中止并标记 interrupted，不悄悄丢 PCM；阈值须通过本任务媒体回归确认。

**验收：** 握手成功不发 started 能按期结束；重复 final 不重复入库；stop/close 后后台任务继续；降级只发生在开始前且一次；慢上游不会无限积压；已有 ASR/segments/字幕测试通过。

**回退：** 恢复旧连接适配器及期限策略；不改变 run/segment 数据格式。新增期限和积压行为必须在 PR 中明确列为预期差异。

### T10 迁移关系调度器

**范围：** relation-queue、新关系任务管理。

**实施：** 保留并发2、6秒 quiet、前台让路、轮转、失败落库补偿；替换 timers/controller ownership。取消仍先调用 DB fence；记录级注册表允许既有合法窗口并发。暂时调用旧 relation workflow。

**验收：** relation-throughput/engine/realtime 测试通过；所有前台忙状态一致，包括暂停 speech consumer 仍存在时；cancel/close 无新 dispatch；存储更新失败不遗留孤儿 running 任务。

**回退：** 调度器整体恢复，不丢 failedUpdates 的职责；持久化状态无需转换。

### T11 迁移关系请求推进和 usage 收尾

**范围：** relation-workflow、relations 的传输边界、有限生命周期 usage 接收器。

**实施：** 把一次付费调用前后的持久化边界显式化；保留请求计数、epoch、expectedEpoch 和错误退避。迟到 usage 与结果提交分开，按 job/attempt 原有去重口径记录；忽略 abort 的 provider 不能持有执行槽。

**验收：** relation-engine/storage/evidence/semantic 全部通过；第三方忽略取消时本地结束；晚到结果不得写回，usage 不重复计数；HTTP 成功后存储失败不重发；重启/反复手动操作不重置原预算。

**回退：** 整体恢复旧 workflow 与 race/usage 适配器，不只删除 race。不得把 canceled 误改 failed。

### T12 迁移 Qwen TTS

**范围：** qwen-tts.mjs 门面、新 Qwen adapter。

**实施：** Deferred 管共享连接完成，Scope 清监听/计时器/WS，Stream 或 callback 交付 PCM；建立逐单元 first-output 状态。保持15秒连接、45秒单元、关闭握手和原错误矩阵。

**验收：** 首音频前网络失败仅按原规则一次重试；首 PCM 后断线零重试；并发 connect 不新建多条连接；close 与迟到 session/audio 事件无串音、无悬空 promise；原 speech/provider fixture 通过。

**回退：** 门面切回原 QwenTts；不能共用新旧实例或池化跨 consumer 连接。

### T13 迁移 Fish TTS

**范围：** fish-tts.mjs 门面、新 Fish adapter。

**实施：** Scope 持有 fetch、reader、controller；分别保留15秒 headers和45秒总期限；Stream按块传递并正确拼接半个16-bit sample。重试决定使用 Fish 自己的错误矩阵。

**验收：** 奇数字节分块与原输出完全一致；close 终止 HTTP reader；HTTP429/503、超时不新增重试；首音频前特定网络失败最多一次、输出后零重试；fish-tts 与浏览器 fixture 通过。

**回退：** 完整 adapter 回退；不更改 provider 配置/模型选择/音色参数。

### T14 迁移 Speech consumer 编排

**范围：** speech-service 的控制、生成、watchdog；speech-scheduler、incremental-speech、协议和 PCM 算法保留。

**实施：** 先用相同事件轨迹测试固定状态转换，再拆成独立控制路径、生成 worker、watchdog。将所有资源挂在 consumer scope；短状态更新使用 Ref，进度等待使用 Deferred，保留采样额度和暂停时间计算。

**验收：** 所有 speech/incremental-speech 测试通过；阻塞 synthesize 时 stop/pause/progress 仍立即受理；暂停超过12秒再恢复、5分钟过期、drain20秒/翻译等待30秒均按原语义；慢播放器/伪造进度不越额度；自然结束正确收尾。

**回退：** 恢复整体 consumer，但可继续使用已验证的 T12/T13 兼容门面。不能只迁移状态标记而保留两个同时工作的 pump。

### T15 接入前端 bundle 和页面运行时

**范围：** 浏览器构建、server静态路由、src/browser/runtime、public/app.js 最小接入。

**实施：** 按2.2切换 /app.js 产物，保持 worklet URL 和其相对依赖；建立单个浏览器运行时及 page generation scope，业务暂继续原实现。明确页面启动失败提示及开发重建流程。

**验收：** 干净构建后实际浏览器启动；没有裸 npm 导入或 node 内置模块进入包；audio/speech worklet 能加载；静态目录遍历和未授权路径仍404；现有三类浏览器脚本通过；记录 gzip大小和启动解析耗时。

**回退：** 同时回退源码进口和 /app.js 映射，避免浏览器加载未打包 TS。此任务之后的前端迁移依赖它。

### T16 迁移轮询与详情读取

**范围：** pollCurrentSegment、processing-state、fetchDetail 和调用方。

**实施：** 应用4.7的串行轮询、10秒单请求/180秒总期限和共享在途策略；保留 processingView 纯规则、live merge。详情失效发生于读取中时补读一次；stop 传递到实际 fetch。

**验收：** 慢响应下单句轮询最大在途1；切换后 abort；404/终态/缺Key停止规则正确；A→B→A无旧覆盖；两个调用方共用读取时一个取消不误杀另一个；dirty事件不丢；现有 processing-state/history-metadata/graph实时测试通过。

**回退：** 恢复旧读取协调器和轮询调用点，不清除用户数据；已修复重叠问题若回退须明确记为功能回退，不能隐藏。

### T17 迁移图谱通知和证据批读取

**范围：** knowledge-graph 的数据加载部分、app证据读取、新resolver/cache；布局和渲染保留。

**实施：** 用Stream/PubSub整合失效通知，保留图谱原有single-flight、revision和退避。RequestResolver按4.7分组、50个一批；缓存生命周期、dirty及失效规则明确实现。写操作仍走原对账语义。

**验收：** 同组50个并发缺失证据最多一批、51个拆批；跨记录/run条件不混合；取消一个等待者不取消其余；pending后变final可见；单卡取消与页面关闭不泄漏；图谱三类核心回归和browser graph通过。

**回退：** 回到旧图谱loader/单id取证；失效缓存直接丢弃，不迁移缓存数据。

### T18 迁移历史及其余页面 HTTP 操作

**范围：** 历史分页、元数据保存、删除、下载、重试、连接测试UI。

**实施：** 分页按页号single-flight；读取请求统一scope和期限；metadata保留版本防护；下载Blob URL显式释放。写请求只报告结果或读回对账，不通用retry；保留历史立即打开。

**验收：** 双击加载更多不重复同页/跳页；离开页面中断读；保存旧响应不覆盖新编辑；导出文件名/备注不变；失联写操作不自动重复调用；相关history/graph-api/API测试通过。

**回退：** 分入口回退，但共享协调器在依赖完整时才移除；不得还原用户已经成功保存的编辑。

### T19 迁移采集、切换和停止

**范围：** app的getDisplayMedia/getUserMedia、AudioContext、worklet加载、flush和采集WS。

**实施：** 手势内立即调用受限浏览器API，获得Promise后纳入scope；对无法取消的权限请求注册晚到资源释放。保持取消音源选择时旧采集继续、成功切换后才结束旧流；保留400ms flush与5秒close fallback。

**验收：** 选择取消不丢旧流；切换后只有一组有效采集；addModule/resume/WS连接各点失败无tracks泄漏；权限结果晚到且owner已关闭时立即stop；停止尾帧和run结束正确；浏览器fixture加真机采集检查。

**回退：** 恢复整个采集控制门面；worklet与采样算法不变，便于逐字节比较。

### T20 迁移播放与系统媒体控制

**范围：** speech-controller/player/media-session的异步控制；播放热路径保留。

**实施：** 立即mute与gesture内resume留在直接调用路径；Scope接管后续socket、模块加载、settle、visibility/系统事件；维持epoch/playbackRevision。媒体session元数据继续避免转写内容和Key。

**验收：** stop调用返回前本地已静音；快速start/stop/start不复活旧播放器；用户暂停不因visibility自动恢复；系统中断恢复和初始化前pause正确；现有speech浏览器验证通过，锁屏能力另做真机验证并如实记录。

**回退：** 控制层整体恢复；不替换worklet或借重构改变后台播放策略。

### T21 实现应用有界退出与恢复

**范围：** 运行时dispose、HTTP/WS停止准入、所有调度器drain、OS信号及进程fixture。

**实施：** 落实4.8总15秒预算；先停止新接入/执行，合法缓冲落为待处理任务；在途10秒后中断，余下5秒清理，最后关DB。重复信号幂等，强制结束不伪造成功。

**验收：** 独立子进程注入SIGTERM；无在途、各模型阻塞、存储异常、重复信号场景均能退出；重开同DB按既有知识/关系恢复，预算不增加；无已关闭DB被迟到usage访问；15秒预算在虚拟和真实进程层均核对。

**回退：** 回退信号入口与协调流程，保留各模块dispose能力；不得重置pending/checkpoint来“修复”退出失败。

### T22 综合验收与性能证据

**范围：** 完整测试、故障注入、浏览器/负载脚本与指标报告。

**实施：** 在同Node/浏览器/机器/固定stub延迟下比较基线；同时开启ASR、final/interim、知识、关系、TTS及图谱。测量第8节指标。真实模型评估仍只在显式live开关与提供凭据时运行，不列为每次CI默认。

**验收：** 所有兼容不变量满足；没有额外付费调用；新取消、串行、批处理目标满足；资源长期不单调增长；性能异常已定位或阻止发布。没有真实设备验证的锁屏行为必须列为未验证。

**回退：** 性能/正确性回归定位到最小任务回退，不以调高超时、删除断言或降低校验绕过。

### T23 清理与交付文档

**范围：** 已替代controller/timer/计数器、临时门面、README、实现与测试文档。

**实施：** 删除没有生产调用的旧异步实现，保留仍使用的纯逻辑；更新命令、部署产物、依赖图、取消与预算规则。扫描遗留detached Promise和计时器，逐项记录“已迁移/有意保留及原因”。

**验收：** 从干净checkout完成全部门禁；每个主要异步入口有owner，保留项可解释；没有两个调度器同时消费同一工作；文件/类型声明与实际接口一致。版本升级如果另行安排，按AGENTS同步三处并核查tag，不在文档任务自动升版。

**回退：** 保留前一已验收提交；清理失败不得倒退数据库。交付最终测试、性能、未验证事项记录。

## 8. 验证矩阵与测量口径

### 8.1 必测故障位置

| 场景 | 注入方式 | 断言 |
| --- | --- | --- |
| 请求还未发出时取消 | 阻塞准入/Deferred后关闭scope | provider调用0，owner/许可归零 |
| headers后body阻塞 | stub分开发headers与body | 取消能中断body读取，不只停等待者 |
| provider忽略abort | 延迟resolve/reject | 本地任务结束，晚到不提交/无unhandled rejection |
| HTTP完成后DB失败 | store端口在commit抛错 | 不再调用模型，预算/checkpoint可解释 |
| 持久化意图后进程退出 | 子进程注入退出 | 重启遵守既有预算与repair恢复 |
| cancel与结果同tick | 固定事件排列分别测试 | 先提交或先取消均符合事务/epoch排序 |
| 控制消息遇长合成 | synth阻塞，同时pause/stop/progress | 控制立即处理、不锁网络 |
| 页面共享请求部分取消 | 两个等待者取消一个 | 另一个正常完成；全取消后网络结束 |
| 图谱失效发生在读取中 | 首次read阻塞再发revision | 完成后补读最新状态 |
| 权限Promise晚到 | 关闭capture后再resolve stream | 立即停止全部tracks |
| 奇数字节音频块 | fixture固定chunk切分 | 输出sample序列与旧实现一致 |
| model错误/超时矩阵 | 每provider每阶段枚举 | 重试次数与旧规则一致 |

### 8.2 测试组织

- 原有node:test保持；新增 `test/effect-runtime.test.mjs`、`test/effect-cancellation.test.mjs`、`test/request-coordinator.test.mjs`、`test/shutdown.test.mjs` 等按行为组织，名称可细化。
- 新Effect时间逻辑用TestClock；旧测试的node mock timer只覆盖旧模块。同一场景通过统一Clock端口控制时间，不让两套时钟各自承担半个流程。
- 不修改业务断言来迎合异步调度；原来同步可见的公共方法若改异步，必须显式更新契约和所有调用点，不能靠反复flush微任务掩盖。
- 纯输出对照必须逐项检查关键字段，不能只看测试数量或snapshot整体变化。
- CI两个job都构建。三个浏览器脚本仍分别留证，固定tested SHA；新的性能报告与资源数据作为该提交产物。
- 浏览器自动化不能证明所有移动系统锁屏行为。真机未测则记录，不推断。

### 8.3 性能和收益指标

T00记录基线，T22同条件复测。下列阈值是计划中的验收标准，不是已经获得的结果。

| 指标 | 口径 / 目标 |
| --- | --- |
| 单句轮询在途数 | 慢网络任何时刻≤1 |
| 删除取消收尾 | 本地stub下观察到signal/连接结束、登记清理和下一合法任务启动；集成测试给予1秒真实时间上限防挂起，核心时序用虚拟时钟精确验证 |
| 请求次数 | 固定事件轨迹下MT/knowledge/relation/TTS逐类对比；无新增自动付费请求 |
| 证据批处理 | 同组同批窗口50项→1请求；51项→2；已有本地数据不请求 |
| 字幕final/首音频延迟 | 从相同事件点计时，报告p50/p95并分离排队与provider耗时；预热后至少30次测量，固定stub延迟 |
| 性能回归复查线 | p95比基线增加超过max(10%, 20ms)触发定位与同条件复测；仍超标则阻止该迁移发布，不能静默放宽 |
| 资源释放 | 固定50次启动/停止/切换后，应用自行登记的timer/socket/consumer/fiber回到基线；不使用Node所有内部handle总数作为唯一判断 |
| 音频正确性 | stub PCM样本/帧顺序一致，零重放、零越epoch输出；真实听感与设备underrun另测 |
| 前端包 | 记录实际传输总量与新app gzip大小；相对基线新增超过100 KiB进入必要性与加载策略复查，未通过不得上线；该预算是本方案拟定值 |
| 长时间运行 | 至少30分钟固定混合负载，队列有界、后台无饥饿、资源数量无持续增长；不以RSS单次波动判泄漏 |
| 类型与构建 | strict检查通过；干净安装构建成功；无用any绕过服务契约 |

请求取消不等于远端退款；逻辑任务数量下降不等于实际provider停止；没有真实网络测量时仅报告本地stub条件结果。

## 9. 发布与回退规则

1. 每个PR说明所影响的不变量、预期行为差异、测试命令、结果和未验证项。引用本文任务编号及tested SHA。
2. 不变更接口、DB schema与预算定义，保证已迁移提交之间数据兼容；使用提交级回退，不执行清库、重置预算或批量重跑模型。
3. 同一进程同一子系统只有一个执行所有者。切换实现必须先停止旧准入并收尾，不能热切换时重复消费。
4. 模型请求成功但本地状态未知时，保留已知持久化证据，执行现有恢复/对账；不可借回退重发整批。
5. 性能门槛、期限或背压策略的变更必须有单独证据和明确记录，不能为了让Effect迁移“通过”而悄悄改变用户体验。
6. 首个可交付节点是M1的取消闭环；整体重构完成以T23验收为准。中间里程碑不能声称所有异步代码已经迁移。
7. 实施按提交组交付，实际改动见第13节；本轮不创建发布tag、不升级版本、不部署。

## 10. 覆盖核对与有意保留项

| 异步/相关区域 | 任务归属 |
| --- | --- |
| server启动、依赖、退出 | T01–T03、T21 |
| readJson、API检查、CRUD、静态readFile | T07；简单静态readFile可留Promise，但由请求入口统一错误/生命周期 |
| final/interim/短语MT、provider准入 | T03、T08 |
| 知识合批、调度、抽取、修复、恢复 | T04–T06、T21 |
| 关系quiet/准入、请求、取消、迟到usage、恢复 | T10、T11、T21 |
| ASR、广播、WS关闭/降级 | T09；广播仍按现有协议，坏socket不阻断已提交数据 |
| Qwen/Fish、speech consumer、deadline、progress | T12–T14 |
| 单句/processing轮询、详情、graph刷新 | T16、T17 |
| 证据卡、HTTP批读取和缓存 | T17 |
| 历史分页、编辑、删除、下载、重试、连接测试UI | T18 |
| getDisplayMedia/getUserMedia、AudioContext、worklet加载、flush、采集切换 | T19 |
| 播放、Media Session、visibility、settle | T20 |
| 页面timer、RAF、ResizeObserver | T15/T17/T20只统一注册清理，绘制循环无需Effect化 |
| PCM采样/重采样、环形缓冲、协议解码、纯布局与纯selector | 有意保留原生同步实现；现有测试继续运行 |
| DatabaseSync及其事务 | T03窄封装，内部有意保留；不声称非阻塞 |
| evaluate-knowledge-news、Playwright子进程/服务器夹具 | T00/T22补资源验证；T23记录有意保留的Promise/finally。live脚本无需为覆盖率强行重写 |
| 同步diagnose-relations、版本检查、CI平台本身 | 不属于Effect业务运行时迁移范围 |

覆盖的含义是每条异步路径都有明确的采用或保留决定，不以“所有Promise消失”作为目标。

## 11. 设计依据与审查记录

代码依据以第1节固定提交为准，实施前再次同步main并检查差异。优先阅读现有契约：

- [字幕与提前播报](./incremental-captions-and-speech.md)
- [语音与翻译实现](./translation-speech-implementation.md)
- [知识结果可靠性](./knowledge-result-reliability-implementation.md)
- [关系证据契约](./relation-evidence-contract.md)
- [验收说明](./acceptance-audit.md)
- [项目约定](../AGENTS.md)

官方技术依据：

- [Effect v4 Scope](https://effect.website/docs/v4/resource-management/scope/)
- [Effect v4资源管理](https://effect.website/docs/v4/resource-management/introduction/)
- [核查的Effect源码](https://github.com/Effect-TS/effect/tree/395f256c223fa839585971254f0a7b48a903dd1f/packages/effect/src)：Effect、ManagedRuntime、Context、Semaphore、Stream、RequestResolver、Cache、workflow。
- [esbuild构建与平台配置](https://esbuild.github.io/api/)
- [TypeScript noEmit](https://www.typescriptlang.org/tsconfig/noEmit.html)

已进行的文档审查：

- 逐项区分已复现事实、设计选择和待验收收益。
- 覆盖JS/TS混用、构建部署、CI直接启动fixture、浏览器静态路径与worklet。
- 检查24个任务的依赖、边界、行为验收和回退；依赖不得形成环。
- 检查后台任务不误挂HTTP/ASR scope、取消不被当重试、晚到提交与usage分离。
- 检查既有模型预算、持久化恢复、音频重试与手势限制被明确保留。
- 所有新期限、容量、体积和性能阈值均标为方案值；实施后必须提供证据。
- 未验证Effect与拟选工具链的实际构建兼容，留作T01门禁；未声称24项任务已经完成。

## 12. 执行追踪、逐层下钻与版本对比

本节为2026-10-04补充的已确认需求，纳入实施范围。目标是：指定完整业务任务结束后，以可层层下钻的执行图和时间线复盘状态、等待、错误、恢复及结果；再与相同场景的已验收基准比较，帮助识别AI Coding引入的行为回归。不是仅打印更多文本日志。

### 12.1 可视化及下钻契约

| 层级 | 内容 | 聚合/展开规则 |
| --- | --- | --- |
| 任务总览 | 本次操作的翻译、知识、关系、播报分支 | 默认折叠；显示异常、等待、部分成功和采集完整性 |
| 业务流程 | 合批、排队、抽取、校验、修复、提交等步骤 | 原图展开优先；大型子图用面包屑返回 |
| 执行实例 | 每句、知识批次、关系窗口、语音单元 | 按业务标识分页，不一次载入全部事件 |
| 调用与尝试 | HTTP、事务、每次重试和取消收尾 | 失败后恢复的尝试不得被最终成功覆盖 |
| 证据详情 | 事件、错误码、结果摘要、源码版本 | 点击查看，禁止默认泄露Key、原始音频、完整转写或模型正文 |

节点包含独立的“层级归属”和“因果依赖”关系。展开/折叠只改变展示，不改变执行事实。跨分支依赖可导航到来源；同一页面允许不同分支停留在不同深度。返回保留筛选、缩放与展开状态。

上层状态由明确规则汇总：failed优先于partial，存在未结束工作时不显示全部完成；已恢复错误显示“成功，曾重试”，用户取消单列；证据缺失显示unknown/incomplete，不能推断skipped。上层墙钟耗时取执行区间，不能把并行子节点耗时直接相加；等待、实际执行和关键路径分开显示。

默认视图包括执行图、按浏览器/服务端/存储/provider分泳道的时间线，以及双版本对比。图谱不是静态函数调用图；只陈述已观测到的执行，未执行分支若作为预期模板显示，必须用独立样式明确标注。

### 12.2 数据和事件契约

使用Effect spans表达操作，保留兼容OpenTelemetry的trace/span标识、父关系和links。业务事件补齐queued、waiting、retry_wait、running、succeeded、partial、failed、cancelled、skipped、unknown。标准Span状态不能替代这些业务状态。

最小记录包括：schema_version、event_id、进程实例与单调序号、wall timestamp、duration、trace_id、span_id、parent_span_id、step_key、task_id、listening/run/job/segment/consumer/unit标识、attempt、owner/cancel_reason、允许列表中的安全属性、git_sha/build_dirty/config与埋点版本。没有值的字段省略，禁止凭空生成业务关系。step_key稳定且独立于函数名；每次调用/重试有独立实例ID。

关键事件：排队、准入、请求意图持久化、请求开始、headers/body完成、结构/语义校验结果、结果提交、通知、首PCM输出、浏览器首次消费、取消请求、底层终止和许可归还。只记录有意义的音频里程碑和汇总，不逐sample/frame写记录。

收听可以聚合多个trace。后台执行、合批和重启续跑通过业务ID与links关联，不强行长期保持根span开放。HTTP、WS和队列跨边界显式传播上下文；不把浏览器与服务端的绝对时钟当成完全同步。新进程不能伪造旧进程的连续时间。

### 12.3 采集、存储与完整性

依据2026-10-04追加确认，应用启动后默认启用追踪，每次任务均采集，不要求设置环境变量；此要求替代首期的显式开关方案。正常路径不依赖诊断可用性。使用有界内存缓冲和本地 stdout 诊断输出，不能把大量事件同步写入业务SQLite。采集异常不得触发模型重试、改变事务结果或阻塞音频。

完整任务诊断须从任务开始前保留输出。保留事件数量上限、丢弃计数、截断标记和正常结束标记；容量不足优先保留已发生终态并标识缺失，不能承诺无界完整性。导出含版本/配置/完整性清单的脱敏诊断包；不记录Authorization、原文、音频、模型原始响应或任意error.message。

诊断查看/导出默认本地或测试入口，不在当前无登录应用中直接公开所有任务日志。额外入口必须有清晰的可见范围和容量限制，不新增自动外发到第三方的行为。采集关闭、写盘失败、缓冲区满也必须有回归测试。

### 12.4 版本比较和行为规则

保存固定场景的已验收执行作为baseline，绑定代码、模型/提示词/配置、fixture与埋点版本。以业务步骤、输入来源和尝试序号对齐，不能按随机span ID对齐。并行操作比较必要先后关系，不比较全事件的绝对顺序。

差异视图可逐层下钻，显示步骤/边新增或缺失、并行转串行、次数变化、状态变化、额外重试、关键路径和结果摘要差异。埋点版本不同或采集不完整时禁止输出确定性的“步骤未执行”结论。

自动规则首先覆盖I01–I16：预算不增加、首PCM后不重试、删除取消确实释放槽、DB提交不得重放模型、旧epoch不提交、队列无饥饿、正常无关系不报错。日志完整不等于答案正确；内容准确性仍由现有语义/输出测试验证。

基准只由人工认可的变更更新，不允许实现代码失败时自动覆盖baseline。规则失败返回非零CI状态并生成差异证据；先提供提示模式，规则经固定fixture验证后逐步启用阻断。

### 12.5 新增子任务和原任务依赖

| 任务 | 交付物 | 依赖 | 验收/回退 |
| --- | --- | --- | --- |
| O00 | 事件schema、稳定step命名、层级与因果模型 | T00 | 脱敏、完整性、状态聚合测试；schema版本化 |
| O01 | Effect tracing桥、有界诊断缓冲、版本清单 | T02、O00 | 应用默认采集；成功/失败/取消/丢事件可区分，记录失败不影响业务；内部测试保留关闭能力 |
| O02 | 首条知识取消及翻译到播放贯通链路 | O01；各段依T04/T08/T14/T20 | 跨层业务ID可对齐，取消与提交顺序可解释；分模块切换，不双跑付费调用 |
| O03 | 独立诊断存储、查询、脱敏导出 | O01 | 有界容量、分页、重启/截断识别、入口限制；诊断数据可单独删除 |
| O04 | 层层下钻执行图和节点详情 | O02、O03、T15 | 五层下钻/收起、面包屑、跨分支跳转、混合深度、折叠异常汇总和按需加载 |
| O05 | 时间线、关键路径及错误影响范围 | O04 | 并行不重复计时、等待理由可查、时钟不确定性明确 |
| O06 | 固定fixture基准、结构/行为差异、CI规则 | O00、O02、T22 | 同场景稳定比对；注入多请求/漏提交/PCM后重试能失败；不自动更新baseline |
| O07 | 对比图逐层下钻与完整性体验 | O04、O05、O06 | 上层变化可定位到底层证据；采集不完整不误判；性能/导出可用 |

新增能力随迁移埋点，不等全部迁移后才补。首个实施提交组完成O00/O01和O02的知识取消部分；翻译到浏览器消费、可视化和版本对比必须在后续任务完成并验证后才能宣称交付。T23最终清理及整体完成门禁增加O07前置条件，T22为O06提供稳定场景基线，避免依赖环。


## 13. 实施记录

### 首批提交组 2026-10-04

文档先以独立提交入本地分支，随后实施第一个可验证的知识取消闭环。当前不是整份方案完成，也尚未提供下钻可视化界面。

| 范围 | 实际完成 | 后续边界 |
| --- | --- | --- |
| T00 | 保留原506项，新增15项运行时、取消、真实HTTP删除、追踪关联及诊断失败隔离测试 | 性能长测和跨版本完整基准待T22/O06 |
| T01 | 精确依赖、ESM构建、strict类型检查、开发重建、启动/测试前构建、CI构建门禁；干净npm ci --ignore-scripts验证成功 | Chromium下载失败，浏览器门禁本地未完成；前端bundle待T15 |
| T02 | ManagedRuntime/Layer、scoped资源、显式owner与任务token、幂等dispose、嵌套span上下文及取消 | 尚未接管应用的所有子系统，也未增加OS信号退出流程 |
| T04 | 现有知识调度器通过Effect执行句柄运行；抽取/修复HTTP及响应体可取消；删除释放槽；迟到结果不可提交；shutdown取消保留inflight checkpoint | 旧JS workflow与纯规则保留；T03完整Store端口、T05定时调度迁移、T06状态推进迁移尚未完成 |
| O00/O01/O02部分 | 知识execute/extract/repair/http嵌套span，安全业务属性/错误码/构建版本，检查点事件，有界内存缓冲和可选本地stdout诊断；缺失事件标识 | 全业务schema、持久诊断存储、完整跨端链路、下钻图和版本比较待后续任务 |

实施细化：T04取消兼容层只需要T02运行时及现有Store/Provider接口，提前到完整T03之前，以避免为修复取消而改写同步存储；T05完整队列迁移仍以T03为前置。此顺序已更新第6节依赖，不改变任何预算或DB协议。

类型环境：Effect4的Channel声明使用全局TextDecoderOptions。使用Node util.TextDecoder构造参数推导的局部声明补齐该类型，不开启skipLibCheck，也不为后端引入整套DOM全局。提示词仍由根目录knowledge.mjs读取；构建脚本拒绝TS直接打包旧.mjs模块，避免import.meta.url资源路径漂移。

行为验证：

- 完整Node回归521项通过、0失败、0跳过；其中15项为本轮新增。
- 真实HTTP fixture验证：并发1时删除阻塞中的A，B无需等A返回即可发起请求；A晚到结果不提交；诊断span可以对应被删除job。
- headers未到、body阻塞、repair取消均能中止本地请求；忽略AbortSignal的执行器不再占本地任务槽，迟到reject被接住。
- 429/Retry-After、知识公平调度、恢复检查点、字幕/翻译/关系/语音既有Node回归保持通过。
- strict类型检查、构建、版本一致性通过；npm ci --ignore-scripts后工具链可用。开发模式实测首次启动、源码变化后重建/重启及HTTP页面响应正常。
- Playwright Chromium安装返回无效/截断ZIP，浏览器三项验证未能运行。没有修改前端、worklet、DB schema或版本号，仍须在具备浏览器的环境完成门禁后再合并/发布。
- 未执行真实付费调用、30分钟资源测试或性能收益测量；不宣称已达到整体迁移或O07验收。

首批历史行为（已由第三批替代）：HEARWISE_TRACE=1开启execution_trace JSON行，仅覆盖上述知识路径，默认不采集。环形缓冲最多2000条（内部API可配置、硬上限10000），输出背压时丢诊断而不阻塞业务，事件序号缺口表示外部输出不完整。snapshot.complete只代表已启用的当前缓冲未截断且没有活跃span，不证明Hearwise全部流程已埋点。采集失败测试确认不改变业务结果。

仓库交付更新：用户确认发布后，首批实现通过 GitHub 接口创建 [PR #47](https://github.com/kejun/hearwise/pull/47)，并已合入 main（c5e08b4）。该 PR 的 Node 和 Chromium CI 均成功，补齐了本地因浏览器下载失败而未完成的浏览器门禁；这不代表真实模型或所有设备验收已完成。

### 第二批：本地可下钻报告 2026-10-04

本批从既有知识追踪数据交付一个可直接使用的离线诊断闭环。详细用法见 [执行追踪报告](execution-trace-report.md)。不新增公开诊断接口，不更改生产业务调度或持久化协议。

| 范围 | 本批交付 | 尚未完成 |
| --- | --- | --- |
| O00 | 事件导入校验、允许列表重建、丢失/重复/父关系异常识别，业务 partial/invalid/continue 状态不被调用成功掩盖 | 全业务 schema、显式依赖 links 与等待原因 |
| O03 部分 | 本地日志/快照导入、单文件 HTML 与脱敏 JSON 导出；20 MiB 输入和10,000事件上限；拒绝覆盖已有基准 | 自动轮转、持久化查询服务、完整任务结束清单 |
| O04 知识链路部分 | 收听→知识流程→批次→嵌套调用→事件证据；独立展开、折叠、路径导航、筛选恢复，每页50项、子树按需显示 | 跨翻译/关系/播报分支、因果链接导航、应用内入口 |
| O05 部分 | 按进程分组的时间线，保留失败子调用，显示安全错误码及证据 | 可靠的等待区间、关键路径和跨分支影响范围 |
| O06/O07 预览 | 按稳定步骤路径对比观测次数与状态，差异继续下钻到两边的实例和事件 | 同输入/模型/配置基准、业务规则阻断、边/并行度/结果差异 |

依赖细化：离线报告读取已经存在的 O01/O02 知识事件，不需要先迁移应用前端 T15，也不需要先部署 O03 查询服务。因此提前交付 O04 的知识链路查看能力；完整 O04/O07 的跨端验收仍保留第12节依赖。

完整性边界：JSONL 缺少结束清单时只能显示 unknown；序号缺口、父节点缺失、起止异常和截断均显示 incomplete。只有自洽且声明完整的快照可以显示当前进程缓冲 complete，不能据此宣称整次收听的所有业务链路完整。

验证场景使用真实 Effect 运行时、SQLite 知识 workflow 和 HTTP 适配器，模型端点在本地替代，覆盖正常完成、失败历史保留和取消。新增 Node 测试覆盖导入、脱敏、截断、循环、随机ID变化、业务结果映射和文件保护；浏览器脚本检查五层下钻、错误筛选、展开状态保留、双版本证据、导出、移动端和无网络请求，已接入 CI。最终执行结果随本批 PR 记录。

本地验证结果：完整 Node 回归532项通过、0失败、0跳过（新增11项）；strict类型检查、构建、版本一致性和diff检查通过；`trace:demo` 已实际生成33条事件、11个步骤的报告。专用浏览器脚本的5组交互检查通过。Playwright指定的Chromium153下载包仍不可用，改用官方稳定版Chrome Headless Shell154.0.8037.92验证；仓库依赖和CI安装配置未因此改动。

### 第三批：默认追踪与翻译、关系、播报接入 2026-10-04

本批落实追加需求：应用启动即采集，每次执行均记录；不再读取 `HEARWISE_TRACE`。翻译、关系提取及所有既有播报入口接入共享 Effect 运行时与离线报告。仍保留 JavaScript ESM 业务模块，未要求全仓库改写 TypeScript。

| 子任务 | 实际实现 | 验证方式 |
| --- | --- | --- |
| O01 默认采集 | 应用共享 taskRuntime 默认开启；保留 2,000 条环形缓冲、stdout 背压隔离、脱敏允许列表 | 无启用变量启动真实服务，直接捕获执行事件；原采集失败隔离测试继续通过 |
| O02 翻译 | 定稿/后台/恢复队列、预览、短句/尾句、模型检查、同语言直通；HTTP 包含响应体；传递取消和真实 run/segment/consumer ID | 本地 HTTP/WS 端到端；提前播报与定稿竞态、停止取消及尾句翻译旧行为回归 |
| O02 关系 | relation.execute/extract/http/validate/commit；请求预留、提交、通知、重试安排、丢弃状态 | 真实 SQLite 窗口与适配器；既有预算、暂停、迟到 usage 和提交规则回归 |
| O02 播报 | 所有入口共用 speech.session/unit/synthesize；千问 attempt/connect/stream，Fish 每次 HTTP；每次尝试保留终态 | 两 provider 端到端；首 PCM 前恢复保留失败尝试，首 PCM 后禁止重试 |
| O02 播放证据 | 单元生成完成后继续等待现有浏览器进度；记录首次消费/播放完成、暂停/恢复/停止 | 校验 epoch、消费计数和已完成单元后记录；标记 client_report；实际 AudioWorklet 浏览器回归 |
| O04 多流程下钻 | 按识别/翻译/知识/关系/播报分组；新增业务标识详情；同 segment 跨流程证据跳转 | 浏览器检查所有分组、播放事件、关联跳转和未关联预览；保留五层下钻/导出/移动端检查 |
| O00/O06 兼容性 | schema v1 保持兼容；埋点版本变为 v2；failed/discarded/continue 业务终态不被 Promise 成功掩盖 | 旧埋点 v1 导入及版本不兼容提示；业务状态、脱敏和采集完整性测试 |

实现约束：没有增加付费请求或双跑流程，未改变原有调度优先级、重试预算、持久化协议和 PCM 协议。外部 AbortError 原样保留，避免破坏提前播报的取消判断。删除记录按 listening owner 取消任务；迟到翻译和关系结果提交前重新检查有效性。

追踪关联：识别在实际 run 创建后记录来源；播报会话和单元采用独立根任务，通过 consumer/run/segment ID 关联，避免将长会话硬设为所有业务的父 span。预览/模型测试无收听 ID 时单独显示，不虚构归属。浏览器进度是客户端上报证据，不代表扬声器实际发声。

本地 Node 回归535项全部通过；另补充的旧日志兼容和业务终态断言通过。类型检查、构建、版本一致性及 diff 检查通过。`trace:demo` 已生成知识示例（33条事件、11个步骤）及多流程示例（90条事件、26个步骤）。示例使用真实应用/运行时/存储/适配器，模型端点与播放反馈由本地 fixture 提供，并非生产日志或真实模型延迟测量。

四组浏览器脚本均获得通过结果，新报告6组交互检查通过。使用 Chrome Headless Shell154.0.8037.92；首次完整运行中的图谱缩放等待超时，单独执行关系进度脚本时移动端按钮尺寸断言曾失败，两者在启用截图的独立复测中通过，保留为本地布局时序不稳定记录。本批没有修改这两个页面或放宽断言；远端 CI 结果随 PR 记录。

后续边界：自动轮转/持久诊断存储、结束清单、显式因果 links、关键路径、固定同输入回归门禁仍未交付。识别握手、识别模型检查、浏览器采集/worklet 内部没有独立 span。各业务接入追踪不等于 T03–T23 的队列、端口和前端 Effect 迁移全部完成。此次保持应用版本 1.0.5。

### 第四批：业务总览与规则洞察 2026-10-04

根据真实日志报告的使用反馈，新增独立的[业务追踪报告实施方案](business-trace-report-implementation-plan.md)，先提交方案，再实施 B01–B06。报告首页以五个业务域展示已观测工作量、状态分布与最近活动；支持用途/句子筛选、业务对象归并、逐层下钻和证据关联。调用次数与累计调用耗时使用明确口径，避免父子重复计算和长会话误计。

规则洞察覆盖失败、异常历史、待继续处理、慢调用、未被子步骤覆盖的耗时、候选拒绝及缺少播放完成反馈。业务终态和证据缺口分别展示，离线快照不声明实时状态。分析不调用模型。新埋点补充真实句子序号、输入关联、请求开始和音频时长，版本为 v3；旧 schema v1 日志可重新生成新版报告。

本地542项 Node 回归通过，报告7组浏览器交互检查通过；细节和范围边界见独立方案，CI 结果随 PR 记录。自动存储、实时状态、全队列积压、时间回放、成本估算和同输入回归门禁仍是后续任务。应用版本保持 1.0.5。
