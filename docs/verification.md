# 增强验证：性质与证据

本入口交付 KEJ-62（父工单 KEJ-61）的首条证据闭环。需求基线为《Hearwise 增强验证需求规格 v1.0》：
https://linear.app/kejunz/document/hearwise-增强验证需求规格-v10-5e0275a3dac3

> 本文保留 KEJ-62 初始试点的历史范围；下文“后续”不代表最新主分支尚未实现。当前全业务索引、责任缺口与三态复现见 [KEJ-87 维护交接](verification-handoff.md)，18 类技术门禁及真实验收缺口见 [发布证据门禁](release-evidence-gate.md)。

## 运行与判断

按 `docs/development-workflow.md` 准备 Node 24 和锁定依赖后运行：

```bash
npm run verify
npm run verify -- --release
npm run verify:report -- verification-evidence/run-实际目录名 --release
npm run verify:report -- verification-evidence/run-实际目录名 --release --full
```

每次运行打印唯一目录。开发模式允许未提交修改；`--release` 要求目标 SHA 的工作区干净且已提交。最后一个命令要求所有登记性质，目前必然指出尚未运行的缺口，不能用于宣称 KEJ-61 已完成。普通试点退出 0 只说明 HW-04-01 在声明场景通过。CI 在现有 Node 必需 job 中执行发布模式，并始终尝试保存产物；浏览器必需 job 保持原有要求。

成功场景复用关系工作流、真实文件 SQLite、现有请求构建及响应解析。供应商是内存桩；合成的两条知识节点从关系入口前置状态建立，知识提取和 HTTP 接线不在本场景范围。报告包含发送前持久预算、请求账本、工作流业务结果、最终图谱和终态。它不是预算全协议证明、模型检查、知识质量评测或真实服务验收。

## 性质登记与责任

`verification/properties.mjs` 为 HW-01 至 HW-15 各提供一张初始性质卡：要求、业务后果、前提、状态、输入域、假设、责任角色、方法、实现边界、现有资产、失效条件、验收和后续工单。后续单独判定的性质应拆成新的子编号，不能扩张已有通过结果的适用范围。文件内 `evidenceStatus: not_run` 是静态登记，不从测试文件存在与否推断通过。

模块维护者维护映射；验证维护者维护驱动；发布负责人冻结环境与阈值。个人责任分配以 Linear 为准，本提交不冒指具体负责人。当前只执行 HW-04-01；其他卡仍显示缺证据，各卡 `gaps` 也不会因试点通过消失。HW-15 的证据汇总负例由 Node 测试执行；完整 Trace 与发布门禁仍依赖后续工单。

## 证据格式与边界

每个 `result.json` 记录：

- schemaVersion、性质 ID/版本、规范版本和性质登记内容摘要。
- 源码 SHA、工作区 dirty、Node/SQLite 版本、依赖锁摘要、操作系统和架构。
- 执行模式 `implementation-scenario`、具体场景、输入范围、样本数；本确定性场景 seed 为 null，不伪称随机或穷尽检查。
- 开始/结束时间、完整性、passed/failed/not_run/incomplete/not_applicable 状态及附加 stale 判定。
- 原始观测和进程日志的相对路径及 SHA-256 摘要。摘要用于关联与完整性检查，不是对抗恶意伪造的签名。

`report.json` 另记录进程退出码、信号、超时/中断和清理后的完整状态。汇总器使用当前代码内固定的必需性质列表，重新读取结果与原始文件，不能信任缓存 `ok`。缺失结果为 `not_run + missing`；缺失字段/文件、超时、中断为 `incomplete`；源码/性质/规范不匹配附加 `stale`；业务失败为 `failed`。当前没有允许排除的性质，`not_applicable` 不放行。`--release` 拒绝 dirty 证据和 dirty 目标。

进程开始先写不完整报告，结束后原子替换文件。每次使用独立目录，防止复用上一轮通过文件。父运行器给子进程 15 秒外层期限，复用既有进程组清理；子进程关闭 SQLite，父进程在子进程结束后删除临时数据库。强制结束整个运行器可能留下不完整目录；报告器仍拒绝它，维护者可在确认进程结束后删除该目录。取消后上传是否成功受 CI 平台限制，缺少产物不能算通过。

扩展字段 `extensions` 的 quality/performance/device 在试点中均为 null。后续执行器接入前必须升级校验契约，至少提供：

| 类型 | 必须添加并冻结的上下文 |
| --- | --- |
| 质量 | corpusVersion、split、provider/model/promptVersion、指标方向/阈值、重复次数、严重错误、reviewer、授权预算 |
| 性能 | loadVersion、设备/运行时、数据规模、时长、预热、重复次数、分位数、资源预算与允许波动 |
| 设备 | matrixVersion、平台/架构、系统/浏览器、实体设备、输入输出路径、评审者 |

模型/Lean 执行器在后续工单接入，必须分别扩展有限状态数、深度、种子、证明前提和传递公理等字段；不能用本试点格式冒充这些证据。历史质量/设备证据是否仍适用由 KEJ-86 实现影响分析，本汇总器暂不自动继承。

## 可复现负例

```bash
npm run verify -- --scenario=business-failure
npm run verify -- --scenario=timeout
npm run verify -- --scenario=interrupt
npm test -- test/verification-evidence.test.mjs
```

前三条应退出 1，并保存独立报告。business-failure 用真实工作流处理合成 HTTP 401，持久终态 failed；不把这条“需要成功”的性质记为通过。timeout 在请求已预留且供应商不回应时触发外层 watchdog；interrupt 实际发送 SIGTERM 给运行器，由其终止工作进程；二者保留发送前观测并标不完整。这些故障演示是报告检错验证，不是崩溃恢复或断电验证。

Node 回归还删除必需结果、篡改观测文件、替换源码和规范版本、删除必需字段、复制重复结果、使用未知状态，并检查每个负例都阻止误通过。若需人工重现，可以复制一次成功目录后修改 `result.json`，再运行 `verify:report`；不要覆盖原始证据。

后续先推进 KEJ-63 的关系协议模型与轨迹重放，再按依赖开展知识预算、故障恢复、Lean 差分及全业务实测。真实服务付费调用、设备支持和性能/质量阈值仍需要独立授权与实测证据。
