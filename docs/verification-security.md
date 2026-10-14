# 凭据与外部输入安全验证（KEJ-82）

规格：Hearwise 增强验证需求规格 1.0，HW-12、用户故事27/28。
性质卡位于 `verification/security-properties.mjs`；现有 HW-12-01 保留为全域资产/缺口登记，不能由这些固定场景变成全项目安全认证。

## 运行与证据

Node24，当前 checkout `npm ci --ignore-scripts` 与 `npm run preflight` 后：

```sh
npm run verify:security -- --node-only --release
npm run test:browser -- security
```

第一条只验收 HW-12-02（服务凭据）和 HW-12-04（请求边界）；03/05明确为 `not_run`，`fullSecurityProfile:false`。第二条在现有 Chromium CI 中运行完整四性质；本地沙箱不能启动 Chromium时不能代签浏览器通过。发布证据来自准确已提交、干净源码及同树 CI，不以开发结果替代。

每次独立目录保存 report.json、observations.json、worker.log、逐检查日志及浏览器截图。继承 NODE_TEST_CONTEXT 会显式清除；使用共享 canonical TAP footer parser，跳过/取消/歧义/零测试均不通过。Node最小数量冻结为credentials10、boundaries13、negative12；fetch观察包含请求发出至clone完成的全周期，并按navigation epoch保留未完工作；reload/close先有界drain，旧epoch不被当前pending0覆盖。增加测试可以扩大数量，删除场景不能隐式保留原验收范围。

源码开始/结束快照重新读取全部 Git tracked及非忽略untracked文件，另含实际 dist/server/index.js 与 vendor/cytoscape.js。记录 SHA/dirty、逐文件SHA256、锁文件/Node/SQLite/系统、性质版本、命令、预算与开始结束时间；dirty→dirty内容改变、缺源码、缺/改附件、过期结果、超时或清理失败均不能通过。这是首尾一致性检查，不宣称消除运行中任意文件系统 TOCTOU。

整个profile预算150秒；credentials/boundaries各30秒、negative20秒、browser100秒，但每项还受剩余总预算约束。浏览器父入口180秒，预留30秒给进程组终止、清理与证据落盘。各Node test另有10–20秒界限；进程组、WebSocket、临时数据库/文件与浏览器都有限清理。原Node/浏览器CI总预算不扩大。

性质独立判断：浏览器失败不擦掉已经完整完成的Node结果；危险渲染检错失败不把已完成的浏览器凭据检查伪写成成功或随意覆写。共同源码变更或清理失败使共同结果失效。全profile任何必需检查失败仍非零退出。截图哈希在主observations里嵌套检查；两主附件由现有证据契约校验。

## 冻结的凭据流向矩阵

仅使用 `HW_TEST_ONLY_...` 两个公开合成哨兵，绝不读取环境中的真实 Key。测试供应商都是loopback，音频是合成数据，绝不触发外部收费。

允许：
- 明确的Key输入框（默认password遮罩）、本应用origin的约定localStorage键
- 浏览器→本地服务的Key请求输入与服务内存授权映射
- 所选目标本地供应商的 Authorization header。千问与Fish分别核对，不混用
- 测试进程内用于比对的合成输入与provider ledger。证据只序列化计数/哨兵编号，不序列化授权值

禁止：
- 返回浏览器的错误/HTTP/WS业务响应、正文/状态/非Key输入/属性、console/pageerror
- 服务普通日志与结构化Trace、离线Trace HTML报告
- SQLite各业务表、实际SQLite/WAL文件、下载的SQLite备份、导入前安全备份、原文/译文导出

服务用例包括正常ASR→MT→知识工作、连接测试、401/429/503、ASR错误/一次参数回退、Qwen/Fish错误、失败知识任务落库与显式恢复、导入安全备份及真实服务重启。HTTP状态与知识retryAfter被单独断言，安全诊断不能破坏重试预算/冷却分类。

扫描明确为UTF-8和UTF-16LE中的完整哨兵；不是任意编码/变形/隐写的DLP，也不承诺识别用户刻意放入原文、业务ID或模型成功内容的秘密。实际用户备份包含原文等业务数据，本验证不会把备份称为公开脱敏数据。fixture之外的数据不能直接上传公开CI。

## 外部文本与真实展示

固定恶意语料覆盖img事件属性、script结束标签、script与SVG事件，名称/别名/背景/原文/模型译文/模型卡片/标题/备注分别有来源：
- 标题备注经真实UI PATCH，名称经公共name-replacements POST
- 卡片摘要/事实经真实manual regeneration HTTP与本地模型响应
- 无公开编辑入口的别名/背景经既有业务store.applyKnowledge写入，不伪造DOM
- 原文经本地ASR WebSocket，译文经实际MT HTTP，均进入真实SQLite

重载、真实服务器停止/重启后核对history、transcript、cards、Cytoscape canvas/accessible节点及graph details。检测器累计script执行计数、曾插入的危险节点、探测请求/外部请求、凭据露出和观测错误，而不只检查“页面含有字符串”。只捕获已通过隔离检查且关闭凭据设置框的截图。

API响应通过只读fetch observer的原Response.clone异步扫描，原Promise/Response、receiver和参数不变，应用不等待clone。单元测试验证identity、deferred clone、错误和UTF-8/UTF-16扫描。静态app.js响应哈希证明加载实际源码。浏览器中的路由只允许当前本地fixture origin；恶意探测请求记录并abort，不发送外网。

两项定向检错：
1. 临时复制实际server.mjs、业务模块/构建资源和当前锁定依赖，只把MT安全HTTP错误改回供应商message转发；同一真实HTTP哨兵判定失败。复制物无.git/.env/用户数据，清理后原源码未变。
2. 实际应用只替换一处record-title的textContent为innerHTML；加载变异资源的哈希与唯一anchor明确，同一已保存恶意title使同一浏览器判定器检测到节点及执行/请求。其余HTTP、SQLite与资源不变。

## 请求与部署契约

保持当前规则：默认监听127.0.0.1，没有账号鉴权；无Origin允许，GET读取不加Origin鉴权。POST/PATCH/DELETE与两WS upgrade比较Origin host和协议；协议采用现有X-Forwarded-Proto第一值或socket协议。HTTP写入和WS异Origin/错误协议/端口/null拒绝，拒绝后全表快照及provider计数不变。

该规则不是远程身份认证。远程部署须独立配置HTTPS和访问控制，并由可信代理控制Host/X-Forwarded-Proto；不把测试通过称为可直接暴露公网。本票不改Origin判断，不放宽载荷限制，也不增加认证产品语义。

实际入口另测非法JSON/非object/长度/语言、metadata字段、segment查询、跨收听item/run/segment/receipt组合、ASR64KiB及TTS16KiB上限+1。超大ASR帧在启动前无上游/业务写入；已启动后保留合法原文并按既有close流程将run标为interrupted，不误称全库不变。供应商非object JSON沿ASR忽略畸形消息或Qwen安全错误/原重试语义处理。

## 固定真实反例与最小修复

实现前的真实本地供应商回显合成Key，MT错误响应、连接检查（ASR/MT/知识）、ASR客户端错误和参数回退普通日志泄露；结构化Trace已安全。独立审重现后，独立修复只保留MT/知识HTTP状态诊断，保留status/retryAfter，并让ASR错误/回退使用固定文案。

另两个客户端输入反例：ASR超大帧的未处理error事件、两WS的JSON null字段解引用使服务退出。分别保留red测试后，添加ASR error监听接入既有close清理，以及parse后object形状检查。供应商ASR/Qwen null也有独立真实red→guard→恢复测试。未删断言、放宽预算/来源限制或修改成功路径来取得通过。

这些是可复现固定安全场景及反例检测能力，不是任意攻击输入、所有浏览器/OS/供应商的完备证明。远程部署、TLS、浏览器扩展、供应商内部凭据处理、真实录音/Key、真实设备及全域模糊测试仍无本票证据。
