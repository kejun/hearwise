# 历史与图谱性能采集（KEJ-80）

对应 HW-13-02..04、用户故事 26/37。这个入口采集真实 SQLite、HTTP 和 Chromium 页面原始数据，另由冻结 policy 产生比较结论。**采集完成不等于性能通过**。当前数值目标和支持设备/规模尚未冻结，`performanceEvaluated=false`、`thresholds_not_frozen` 是准确结论。smoke 用于验证采集器，不能替代 baseline 或 M4 验收。

## 日常只做必要检查

**普通提交不跑完整基线。** PR 和 main push 的 `performance-smoke` job 现在运行 `bounded` 两轮比较：small 数据、loopback、无预热、每轮每阶段 3 次采样。同一份冻结 SQLite 先采基线，再冻结 policy，再采候选，独立读回原始证据。CI 默认同源校准，明确 `sameSourceCalibration=true`；未批准目标不会产生性能通过。

性能 job **总上限仍为 10 分钟**，包括依赖/浏览器准备、构建、两轮采集、报告检查及上传。pair 内部总期限为 450 秒，各步骤共享剩余期限；超时保留不完整结果，不自动延长或补跑完整基线。该上限针对性能 job，不代表整个 CI 的其他验证也已压到 10 分钟。详细范围、跨版本命令和批准目标格式见下方“日常有界比较”。

低层 `performance:prepare` 和 `performance:collect` 省略 profile 仍默认旧 `smoke`（2 次采样），仅用于单轮采集器诊断，**不再等同于日常 CI 必需检查**。完整 baseline 仅显式手动运行，本轮中大数据及慢网矩阵延后，不需要为日常改动补齐。

## 负载与可复现性

`verification/performance/profile.mjs` 的暂定采集规模如下。这些是探测域，不是已承诺的产品上限。

| 档位 | 收听 | 总片段 | 每张图节点/边 | 总节点/边 | 每图独立节点 |
| --- | ---: | ---: | ---: | ---: | ---: |
| small | 20 | 472 | 20/36 | 40/72 | 2 |
| medium | 100 | 10,360 | 100/180 | 200/360 | 10 |
| large | 500 | 102,400 | 500/900 | 1,000/1,800 | 50 |

每档两个图谱记录，其余记录为已归档的译文片段。关系结构是固定有向环加 offset-two 弦和独立节点；`seed=20261014` 决定合成内容命名，**不是随机拓扑种子**。报告另存连通分量、最大分量、度数分布、各类型数、事实/断言/支持数、原文/译文/名称/摘要/备注的 Unicode 字符与 UTF-8 字节量。原文每段 240 字符，译文加 5 字符前缀。

夹具通过真实 `ListeningStore` 的片段、译文、知识和关系预留/提交入口构造。关系请求账本是存储夹具生成的合成记录，不代表真实供应商外呼；准备期间没有网络供应商调用。全部数据合成，不使用真实凭据、音频或个人数据。准备与测量计时分开。

UUID 和布局顺序有关系。`semanticDigest` 只检查规范化业务内容相同，不把重新生成的另一个 UUID 数据库视为完全相同的性能负载。比较必须重用同一已保存的数据库字节、SHA256、ID 映射和导入备份。采集器对每个后端/浏览器网络组合复制冻结库，不修改原件。导入在每个隔离浏览器库中只做一次，之后只读采样；候选从原冻结库再次开始。

最初开发探针中 small/medium 准备约 1.1/11.4 秒，包含 large 的总 180 秒探针未完成，记录保留。独立 large 准备探针在明确的 600 秒准备预算内耗时约 347 秒，生成约 139 MiB SQLite。它们是未冻结开发源的准备成本，**不是页面性能基线**。正式准备单库 600 秒、整体 1800 秒；超时会保留失败及原始文件，不能继续当作有效输入。

## 日常运行（bounded 两轮校准）

使用仓库 Node 24、锁文件、真实构建与已预检的 Playwright Chromium。浏览器不可启动时会写 `not_run`、零样本、原始错误并退出 3，不使用其他数据代填。

```sh
npm ci --ignore-scripts
npm run preflight
npm run setup:browser
npm run preflight:browser
npm run performance:bounded -- . . verification-evidence/performance
# 上一步打印唯一 pair-*/pair.json；保留整个目录。
npm run performance:bounded:report -- verification-evidence/performance/pair-XXXX
node scripts/check-performance-bounded-negative.mjs verification-evidence/performance/pair-XXXX
```

这是与日常 CI 相同的入口。两次测量各自保留全部原始附件，用实际最大观测值比较，不将三次采样推广为总体 p95。无批准目标时退出 0 仅表示证据完整且可读回。

若只调试单轮采集器，可显式执行 `performance:prepare -- DIRECTORY smoke`、`performance:collect -- PREPARED.json smoke` 及 `performance:report -- RUN --clean`。旧 smoke 的准备/采集预算为 60/300 秒，仍不是性能验收。`--skip-browser` 仅提供后端开发证据，整体 `collectionComplete=false`、退出 3。

## 手动完整基线（长任务，日常不运行）

完整 baseline 是每阶段 2 次预热 + 20 次计入分位数的重复、三个档位和两个网络组合。每个 browser 组合最多 600 秒、后端 180 秒，采集整体 2400 秒；另有最多 1800 秒的数据库准备。手动 CI job 上限 80 分钟。40 分钟采集看门狗只属于这个显式完整模式，不能因没采齐而在日常验证中继续补跑。

```sh
npm run performance:prepare -- verification-evidence/performance baseline
npm run performance:collect -- verification-evidence/performance/fixtures-XXXX/prepared.json baseline
npm run performance:report -- verification-evidence/performance/run-XXXX --release-collection
```

## 测量范围

后端七阶段：历史第一页/第二页、A/B 记录详情、图谱 A、导入后历史及导入图谱。每次读取真实服务器及 SQLite，并核对响应状态、字节哈希、实体 ID、片段数、节点和关系数。完整响应内容按实际 SHA256 去重保存，每条样本保留对应哈希、字节数及全部原始计数，不删除慢样本。存储构造、服务器启动及导入准备不混入这些读取耗时。应用没有历史全文搜索，不能将分页查询称为全文搜索；图谱搜索单独实测。

浏览器 21 阶段：历史首屏/下一页、详情/下一页、图谱首次端到端、已预取图谱激活、A→B→A、全屏、放大/缩小/适配/重新布局、搜索/类型筛选/节点详情、真实指针平移/拖点/滚轮、恢复总览、导入后历史/图谱。每个样本新建非持久 context、禁用 HTTP cache；同一 browser 进程复用。页面初始化作为设置步骤，不计入历史点击的首屏时间，也不声称冷 OS 文件缓存。滚轮输入先只读等待锁定 Cytoscape renderer 的 `scrollingPage` 抑制状态结束，再发送一次真实 mouse wheel；不靠固定休眠、重复滚轮或修改 renderer。该输入准备仍计入该阶段 wall 时间。导入 POST 的 DevTools 正文缓存即使提前读取仍可能不可用，因此仅在导入专用 context 复用已验证的 `observeImportFetch`：只读 clone 应用实际收到的 Response，不等待 clone、不替换原 Response、不重发请求。真实 Playwright POST 事件的完整 URL/status 与唯一、完成的 clone 观测绑定，缺正文/读取失败/重复或错配均拒绝。报告保留 validate/commit 两条真实 wire+clone 原始观测，reader重新核对匹配关系并从正文重算导入摘要；这一直接测量依赖纳入 measurementDigest。导入动作处于重复性能样本之外。

图谱在详情加载后会预取。首次图谱从没有该记录数据的 context 中的历史选择开始，核对真实 detail+graph 响应及节点、边和两次渲染帧；已预取 tab 激活是另一阶段。small 恰好只有 20 条历史、主记录 56 段，对两个不存在的下一页控件按精确域报告 `not_applicable`；medium/large 实际执行分页。

慢网络为 CDP 真实模拟 100ms latency、下载 1,250,000 B/s、上传 625,000 B/s，正常网络为本地 loopback、无额外限速。它不是用户公网实测；服务器进程不进行网络模拟。导入通过真实设置页面、validate/commit API 和重载，核对备份新增数及导入后的目的库历史。

## 原始指标与环境

- `wallMs`：HTTP 读为请求发起到完整 body 收到；浏览器为真实动作派发到功能就绪及两帧，包含自动化往返。不是响应头时间，也不是单独布局耗时。
- 服务器 CPU：实际子进程 `cpuUsage` 差值。`serverRssAfterBytes`、`serverHeapUsedAfterBytes` 是结束时快照；`serverLifetimeMaxRssAfterKiB` 是包含启动的进程生命周期高水位，不冒充本阶段峰值。
- 浏览器物理 CPU：同一完整 PID/type 集合的 `SystemInfo` 累积 CPU 秒差值。进程集合变化或不可用会记 incomplete。CDP renderer Task/Script/Layout duration 单独命名，不叫物理 CPU。
- 浏览器内存：renderer JS heap 与 DOM 快照。没有声称全浏览器 RSS 或峰值。
- 阻塞：保存原始 Long Task 条目，`phaseBlockingExcessMs=sum(max(0,duration-50))`。它不是 Lighthouse TBT。Event Timing 为可选原始诊断；没有观察到时为 null，不能叫现场 INP。
- 分位数：计入样本使用 nearest-rank，保存 p50/p90/p95/p99、最小/最大、均值和总体标准差。所有预热及计入的原始样本保留；禁止补零、静默丢弃慢样本或只提交摘要。
- 环境：实际 Node/SQLite/Playwright/Chromium、OS/arch/CPU型号/并行数/内存/cgroup、真实浏览器参数、viewport/DPR/locale/TZ/reduced-motion、实际中文 glyph 字体、缓存和网络设置。记录采集前后的主机 load average/空闲内存及其时段。主机负载不是容器独占 CPU 百分比。

云 runner 结果不外推为用户 Mac、手机、Intel/ARM 或有 GPU 的桌面体验。设备支持范围必须在 policy 中明确。环境比较保留所有真实参数，只规范化新建空 browser user-data 临时目录；不能因为主机不同而假设可比。

## 负例与门禁

后端固定 200ms 受控 loopback 转发延迟仍读取真实 graph 路由；浏览器固定 150ms 主线程成本绑定真实 fit 点击并由 Long Task 观察。它们与正式样本分开，验证测量路径能看到受控成本，不是假装产品回归，也不修改 summary 数字。

门禁重算原始 CPU/内存/时间/响应/就绪字段和分位数，校验具体冻结 SQLite 的规模、内容、ID、拓扑、每阶段 roster、重复数、完整退出、前后源码及构建 SHA、附件 SHA256。功能和门禁回归由同源码的 Node CI 单独执行。缺浏览器、丢结果、环境或负载观测来自旧时段、timeout/interrupt、dirty/stale build 均不得得出发布通过。`--inspect-incomplete` 允许检查真实部分报告结构：已处理 SIGINT/SIGTERM 或 watchdog 的终态必须有互斥的停止原因、`complete=false`、code 3，且只允许配置顺序的 dataset/result 前缀。已保存附件、数据库、命令、时间和源身份仍逐项验证；被停止且没有输出的子进程必须保留输入、日志、非成功 execution 与 `missing_observations`。返回的 `collectionComplete` 和 `performanceEvaluated` 仍为 false；同时指定 `--release-collection` 仍强制完整验收。测试用 preload 在真实子进程启动点触发实际 SIGINT 或调用已注册 watchdog（继而实际 SIGTERM），不更改正式时限或伪造报告字段。

## 完整基线的冻结目标与候选比较（延后范围）

只有完整、干净源码 baseline 的 gate 通过后，发布负责人才能冻结 policy。需要明确批准：基线报告 canonical SHA256 和源码、测量代码 digest、环境、精确数据/导入库 SHA256、配置及采样、nearest-rank、支持 case 范围；每个指标的 p95 绝对上限、相对基线 p95 上限、允许的 max/p50 波动；主机 load 上限和空闲内存下限。不得在看见候选数据后更改目标。

policy 字段见 `scripts/lib/performance-policy.mjs`。草稿不得使用 `status=frozen`；`frozenAt` 必须在 baseline 完成之后、candidate 开始之前。采集器在 candidate 启动前保存 policy 文件和 digest，比较器拒绝事后修改、旧观测、换库/换环境/换采样/换测量代码、缺 CPU 或内存指标。绝对目标和相对退化两者都必须满足。

```sh
npm run performance:collect -- SAME_FROZEN_FIXTURES/prepared.json baseline --policy frozen-policy.json
npm run performance:compare -- BASELINE_RUN CANDIDATE_RUN frozen-policy.json comparison.json
```

对比 CLI 先验证两个完整数据包。历史 baseline 由预冻结 policy 的精确报告 hash 绑定，candidate 必须匹配当前干净 checkout。纯 collection report 从不写性能通过；只有比较报告 `performanceEvaluated=true && passed=true` 才表示声明环境/规模内达标。没有批准的目标文件时，不得宣称该范围的性能验收通过；人工目标和支持范围统一在 KEJ-87 验收。

## 日常有界比较（KEJ-80，2026-10-16 收敛范围）

日常 CI 的性能 job 仍以 10 分钟为硬上限。使用 `bounded`：small 合成库、loopback、无预热、每个适用阶段 3 次独立观测；复用原有全部 7 个后端阶段及 21 个浏览器阶段，含历史、详情、图谱操作和实际导入后的读取。阶段不适用仍由原 reader 验证，不静默删项。报告保留所有原始样本、浏览器就绪/HTTP 响应及数据库证据。

短测比较的是 **3 个观测的最大值**，不是可靠的总体 p95/p99，也不是支持设备或产品性能承诺。原采集文件为向后兼容仍保存描述性 nearest-rank 分位数；短测决策完全不使用它们。中大数据、慢网、长尾可靠性和真实设备全部未覆盖；旧完整基线 `38687211421` 仍为 attempted/incomplete，不能被本入口改写为通过。

### 同源 CI 校准与跨版本运行

安装各 checkout 自己的锁文件依赖并完成浏览器预检后，在候选 checkout 执行：

```bash
npm run performance:bounded -- /absolute/baseline-checkout /absolute/candidate-checkout verification-evidence/performance
npm run performance:bounded:report -- verification-evidence/performance/pair-XXXXXX
```

两个 checkout 都必须干净，包含完全相同的性能测量工具代码、运行器和配置。需要把本次测量工具提交先合入或回移到基线，保留真实提交身份；禁止把旧报告的源码 SHA 或数字改成候选结果。产品源码可以不同。分别构建两个版本后只准备一次真实 SQLite 与导入库；先采基线、独立读回、冻结 policy，再采候选。数据库、环境、Node/浏览器/字体、配置、采样及测量代码身份任何变化都会拒绝比较。运行期间源码改变也拒绝。

内部端到端上限为 450 秒，含构建、准备、两轮测量、独立读回；各步骤使用剩余总预算，超时保存已有日志和不完整状态，绝不自动延长或转跑完整基线。依赖/浏览器安装在此期限之外；CI 整个 job（含安装上传）仍由 10 分钟约束。输出必须放在 Git 忽略的证据目录，避免污染被测源码。

CI 默认参数是 `. .`，故明确报告 `sameSourceCalibration=true`。这是同一源码两次实际运行，用于证明管线/证据可重复读取，**不声称已经比较过两个产品版本**。跨版本必须检查 `baselineSourceSha` 和 `candidateSourceSha`。在两个 checkout 不具备相同测量工具时，应先准备它们，不能忽略测量摘要不一致。

### 目标批准与结果语义

默认没有体验目标：生成 `status=draft` 的 policy，提供逐指标观测最大值及比值，`performanceEvaluated=false`、`passed=false`、`thresholds_not_frozen`。执行退出 0 仅代表完整采集及独立证据检查成功，不能解释为性能达标。人工目标批准集中在 KEJ-87。

只有负责人在候选采集前批准目标，才追加第四个参数 `APPROVED_TARGETS.json`。目标文件格式如下（省略的完整 case/metric roster 必须全部填写；本例不是可用预算）：

```json
{
  "status": "approved",
  "releaseLead": "实际审批人",
  "approvedAt": "候选采集前的 ISO 时间",
  "conditionLimits": { "maxHostLoadAverage1m": 0, "minHostFreeMemoryBytes": 0 },
  "budgets": {
    "完整 case ID": {
      "指标名": { "maxObserved": 0, "maxRatioMax": 1, "maxToP50Ratio": 1 }
    }
  }
}
```

数值由负责人确认，程序不根据候选数据推导目标。policy 绑定基线原文摘要、批准目标原文摘要、冻结时间、源码、环境、测量代码和输入库；候选在启动时记录该 policy 摘要。绝对最大值、相对基线最大值和离散度三项同时满足才可在这个有限范围内通过；主机负载或可用内存越过批准条件则不可比较。候选开始后的目标修改、缺样本、超时、改库、改环境、改摘要均拒绝。

`pair.json` 给出阶段退出情况、完整性、源码及比较结果。默认独立 reader 重新检查阶段顺序和全套底层附件，并重算比较，不相信 pair 的 passed 字段。内部 `--collecting` 只供编排器在最终写出 pair 前使用，不提供整个 pair 完成的证明。已批准的性能退化退出 1，不完整/无效证据退出 3。

CI 在原始真实采集之后执行 `check-performance-bounded-negative.mjs`：先验证正例，再复制真实候选证据，分别注入超时、缺项、环境改变、导入库改变、policy 改写、仅摘要改数、伪造通过，要求全部被独立 reader 拒绝，保存 `negative-controls.json`。绝对/相对退化判据另有确定性测试；这些故障注入用于验证检查器，不冒充真实产品退化或人工验收。
