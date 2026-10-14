# 关系来源与正常空结果验证（KEJ-76）

## 可复现入口

```bash
npm ci --ignore-scripts
npm run preflight
npm run setup:browser
npm run build
npm run test:browser -- relation-result
# 仅运行 Node / 文件 SQLite；浏览器性质必须显示 not_run，整体退出 1：
node scripts/verify-relation-result-browser.mjs --node-only
```

完整入口纳入默认浏览器 CI。两个 Node 项各最多 40 秒、浏览器最多 100 秒，但顺序检查共同受 150 秒总预算限制；父运行器为 180 秒，保留 30 秒用于进程组终止、清理、哈希与最终报告。任一超时/中断/未执行完整的 TAP 立即停止后续检查，finally 清理临时运行目录。独立性质仅按其适用检查判定；浏览器失败不会把已经通过的来源性质改为失败，但整体门禁仍失败。输出到独立 `browser-evidence/run-*/relation-result-*`，包含目标 SHA、dirty、环境/版本、逐项完整退出结果、TAP 测试数、日志、浏览器结果、桌面/窄屏截图及 SHA-256。必须 `complete=true` 且 `ok=true`，发布检查还要求干净且当前源码。缺浏览器不能用 Node 通过代替。受限环境若 Chromium 无法启动，保留失败/未运行，依赖远端真实 Chromium CI。

## 性质和执行资产

- HW-05-02：实际运行 `relations.test`、`relation-storage.test`、`relation-evidence-e2e.test`。覆盖短线协议 ID 回译、跨收听候选、未知来源/候选、来源和译文 hash、错误 UTF-16 offset/quote、重复原文、同名歧义、上下文不当补边、来源变更及失效组、文件 SQLite 重开后状态。原有错误来源反例保持，不重新实现语义判定。
- HW-05-03：新增 `relation-result.test` 使用真实 Node 服务、HTTP 请求、真实 V2 知识解析及 mentions、文件 SQLite、现有关系调度/解析/保存。六场景分别是候选不足（零请求）、有效空数组、全行来源过滤、带否定与条件计划的两条表述、输入覆盖受限、已有图谱后的协议错误。空结果不补边，显式继续和超过通常重试间隔均不增加请求。
- HW-11-03：`relation-result-browser` 在 1280×950 / 390×950 的真实页面用键盘启动关系整理，核对独立节点、完整/空/部分/失败提示、来源原文、限定字段和服务器数量诊断；全部场景保存截图并检查横向溢出。图谱 API 不被拦截或伪造。

## 判定边界

`relations-v3` 的供应商请求使用请求局部 `n* / s* / e*` ID，持久数据使用真实收听/知识/片段 ID；来源版本按当前内容 SHA-256，区间使用 JavaScript UTF-16。来源错误的行被过滤，与整个 JSON / envelope 协议失败不同。全部过滤仍正常完成，统计保留被忽略的行。

失败保留场景先通过真实 parser/commit 保存一条关系、两条限定表述，再给同窗口增加输入并返回非法 JSON。既有成功已用一次窗口请求；后续协议失败在当前累计两次的协议上限终止，因此新增 HTTP 请求一次。此场景只核保留与提示，不重定义预算或重置 epoch。

部分完成来自超过现行来源长度上限，既有输入覆盖限制必须可见，不能把零边当完整覆盖。HTTP 返回数据与先前 SQLite 图谱按完整字段比较；JSON 序列化仅规范 SQLite 行的 null prototype，不删除字段。

否定、条件、计划、专名和歧义语义输出由独立手工 corpus 给出。这里证明结构/来源契约及结果展示，不证明真实模型能作出这些判断。结构合法但语义错误的结果仍需真实质量评测；不声称真实服务、实体设备或整个 KEJ-61 验收通过。此次未发现需要改变生产关系逻辑的问题，新增的是跨层证据及保留既有反例的入口。
