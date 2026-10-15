# Trace 业务归属与终态对照（KEJ-84）

本配置验证 HW-15-02～05。默认追踪保持开启；使用真实 Effect runtime、工作流、临时文件 SQLite、HTTP/WS 适配器和离线报告页面。付费供应商由本地合成响应替代。它不证明任意执行可完整重放，也不代表真实服务质量或设备播放验收。

## 运行

```sh
npm ci --ignore-scripts
npm run preflight
npm run verify:trace-business -- --node-only --release
npm run setup:browser
npm run verify:trace-business -- --release
# 或由既有浏览器总入口运行本配置
npm run test:browser -- trace-business
```

最终发布证据必须来自已提交、干净源码。开发模式可反馈失败；不能用它替代 release。当前受限执行环境无法启动 Chromium，浏览器代码及门禁单测不等于浏览器通过；必须由支持环境/CI 的真实运行补齐 HW-15-04。Node-only 明确保留该项 `not_run`。

运行目录为 `verification-evidence/trace-business/trace-business-*`；浏览器总入口通过 `TRACE_BUSINESS_EVIDENCE_DIR` 分配独立目录。开始先写 `complete:false/ok:false`；结果包含当前源码、锁文件、Node/SQLite/系统版本、性质版本、实际命令、时间与退出状态。两个主附件是 `observations.json` 和 `worker.log`，其中引用带 SHA-256 的原始业务观察、8 份实际生成的离线 HTML、3 张截图及脱敏导出。摘要只用于完整性校验，不作密码学无碰撞证明。

沿用 M0 的 `samples:1` 表示一次固定配置运行；HW-15-02 的 15 个场景另记为 `scenarioCases:15`，原始附件逐条列出 11 个工作流与 4 个公共接口场景，不修改公共证据 schema。

单项上限：业务观察 40 秒、回归 45 秒、Chromium 60 秒；整个配置 150 秒，既有 browser parent 的 180 秒留下清理、哈希与落盘余量。所有 child process 使用既有进程组运行器；临时目录、HTTP/WS、SQLite、runtime 与浏览器有清理路径。实际未运行、超时、终止、缺文件或旧源码均不能通过。CI 保留原必需检查，Node 增加 node-only release，浏览器注册表增加完整配置。

## 固定范围及实际对应

### HW-15-02：业务查询与执行记录

11 个工作流场景直接调用当前 workflow、真实 HTTP adapter 和真实 SQLite：

- 知识正常空、初步接受后未修复的部分完成、429 等待后恢复
- 知识通知及诊断 sink 抛错，结果仍已提交
- 知识取消后忽略 AbortSignal 的旧响应；持久 inflight 保留，SQLite 重开按原恢复规则变 pending
- 关系正常空、候选全过滤、真实长输入覆盖裁剪导致 partial、429 等待后恢复
- 关系提交后通知抛错，业务仍 complete，一次请求账本不变
- 关系取消旧轮并开始新轮；旧供应商晚到使用量重复报 71，新轮再报 21。总量为 92，新轮只有 21，旧请求不重算为新业务成功，也不释放新任务

每次观察保存真实业务查询、原始 runtime snapshot、独立调用次数、报告及业务总览。门禁重新由原始事件计算报告/总览，并核对任务 ID、收听归属、持久 state/outcome、检查点预算及可见数据。多次 dispatch 合并为一个业务对象，调用尝试仍逐次计数。正常空与过滤完不是部分失败；真实覆盖裁剪才是这里的关系 partial。

取消/迟到场景使用 workflow 的已有 `extract` seam，让上游实际忽略取消；它们不是网络忽略 AbortSignal 的证明。报告明确区分这些 adapter 调用与真实 HTTP ledger。迟到费用写入原 request journal，与业务提交、当前 round 总量分别核对。SQLite 重开只证明持久恢复查询，不冒充 SIGKILL/断电保障。

另有 4 个真实 server HTTP/WS 场景：

1. 实际 ASR final → MT → 知识 → 关系、Qwen 实时播报、Fish 全文播报以及未关联收听的 HTTP preview。公共详情、片段/图谱查询与只读 SQLite、WS unit/end/frame 和供应商请求账本对照。
2. 取消已生成但未播放完成的 speech consumer，再创建新 consumer。旧 epoch 的 progress 后以有效 pause 作处理屏障；新单元仍未完成。正确反馈及其重复只产生一次播放完成事件。
3. 实际 Fish 401：speech session/unit 失败，持久原文/译文不变。
4. MT 空响应失败后显式 HTTP retry：同一个持久片段恢复，报告仍是一个 recovered 对象、两次调用及两次执行。

播报没有伪造持久“播放成功”列：执行状态由真实 WS 事件和 runtime 核对，持久来源只断言不被改写。`playback_completed` 始终是 `client_report`，不证明声音已经被人听到。

### HW-15-03：故障不能反转已提交结果

真实回调故障固定了四处反例，修复单独提交：

- 关系通知回调抛错后仍发 `notification_sent`。修复只在同步回调成功时记录该事件；已有业务终态、请求预算不变。
- 真实服务端 WebSocket `translation-updated` 发送抛错：前两个译文已经 complete，Trace 却 failed，第三句因槽未释放而 pending。最小保护三个通知边界，保留原计数、清理和调度顺序；三句各调用一次并最终完成。
- 实际 `speech_event` 诊断回调抛错使 preview admission 失败。只隔离 metric 回调异常，保留原播放/关闭流程；实际两单元完成、服务仍可访问。

- 播报关闭时 `onDispose` 抛错，已删除 consumer 却遗留 translation head 与打开的 client。只隔离此通知，继续既有资源清理；验证 stop 不抛、head 释放、连接关闭、后续新 owner 可生成一个单元，两个 owner 各只关闭一次。此项使用现有 service transport interface、真实 runtime 与文件 SQLite，不冒充网络端到端。

服务端发送/诊断故障通过隔离 child preload 注入，其他回调通过已有构造参数注入，没有新增生产故障开关或调试接口。错误诊断只使用固定标识，不回显异常正文。`notification_sent` 只说明同步 callback 完成，不能声称客户端已经收到通知。

同仓库 KEJ-69 的名称纠正提交后通知问题是独立路径，本分支不依赖或重复它的未合修复；安全全出口验收由 KEJ-82 独立承担。

### HW-15-04：真实业务记录的浏览器下钻

浏览器读取本次 worker 产生的实际观察，不用手工编造运行成功事件。按当前生产报告生成器生成离线页面，验证：

- 五个业务域；未关联 preview 保持未关联
- succeeded、waiting、partial、recovered、cancelled、failed 六种业务状态的可见文字
- 翻译/知识/关系/播报任务下钻到显式父子步骤及原始 event ID，身份与实际任务查询对应
- JSONL 保持“完整性未知”；删除真实 snapshot 的起点后显示采集不完整/缺口
- 脱敏 JSON 导出、390px 无横向溢出、键盘选择业务域、无页面错误和外部网络请求

原始 DOM 观察与计数互相核对，HTML hash 必须等于本次实际业务输入及当前 renderer 生成的内容；必需截图/导出名称、数量与 hash 均检查。截图和 browser worker 完成以前不得代签此性质。

## 完整性、来源与检错

`report.complete` 是本验证配置完成标记；与 Trace 输入的 `completeness` 是两个概念。默认 server stdout 没有完整结束清单，实际全部查询完成也仍是 `unknown`。内存 buffer 完整可以与外部 sink 失败同时存在；不能用前者声称 stdout 完整。离线报告不把缺失终态解释为正在运行。

验证门禁要求实际状态快照存在。Trace 本身不是重放输入集，缺业务查询时不声称完整重放。旧 instrumentation、混合/截断记录、当前源码不符均不能作为本配置通过证据。读取所有跟踪/非忽略源码及实际构建文件的首尾内容摘要；即使工作区从 dirty 变到 dirty，内容变化也会被拒绝。

两种定向变异复制并编译真实 TypeScript 源码：

1. 删除 `continue → waiting` 映射：真实 pending 的知识任务被误报 recovered，持久查询对照检出。
2. 按 span 而非 job 合并业务对象：一次实际重试产生两个业务对象，被同一个持久任务对照检出。

每个变异固定唯一 anchor、替换内容、原/变体源 hash，保留实际原 snapshot/业务查询、变体 report/overview、原样 oracle 及具体失败比较。变异必须真的被检出，只有 `detected:true` 不足以通过。

回归清单固定为 8 个文件、50 个实际 Node 测试，读取完整 TAP 日志的唯一末尾 footer，不能依赖截断 tail、测试输出中的伪摘要或 `exit 0`。子进程移除继承的 `NODE_TEST_CONTEXT`。门禁单测包括缺业务快照/案例、错误查询状态、旧源码/埋点、未完整退出、缺文件、伪造 mutation 结果、浏览器缺项、独立性质结果及文件篡改。

执行者负责场景/实现映射，独立审查者核查反例与原始证据；发布负责人确认目标 head 的完整 CI 与真实浏览器附件。仅本地 Node 通过时，HW-15-04 保持未运行，KEJ-84 不能结为完成。

完整应用夹具按实际 SQLite job 和 listening 身份等待 knowledge.execute / relation.execute 根终态，包括后续产生的全部任务。真实关系事务 COMMIT 后受控暂停根返回的回归证明：commit 子步骤完成时根仍可未结束，不能作为完整采集屏障。等待失败在清理前保留原始 Trace、堆栈、阶段、SQLite 和业务任务快照，清理仍在 finally 中执行。模型调用、成功断言与验证超时预算保持不变。
