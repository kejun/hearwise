# 十分钟真机采集与播报检查（KEJ-79）

这个入口把一次真机检查需要的版本、环境、固定文本和操作记录放在一起。它不操作麦克风、不调用供应商，也不会凭界面播放状态推断实际出声。每台客户端、浏览器和 TTS 配置分别运行一次；Intel、Apple Silicon 和手机不能互相代替。

## 开始前

在运行 Hearwise 服务的机器使用 Node 24、当前锁文件和干净的已提交源码：

```sh
npm ci --ignore-scripts
npm run preflight
npm run build
npm run verify:device -- plan
```

编辑打印的 `plan.json`：填实际操作者、浏览器客户端的机型/芯片/系统/浏览器版本、输入与输出设备，以及实际 ASR、翻译、TTS 模型、音色和设置。`settings` 记录地域、速度、prompt、实验开关等影响输出的设置，默认值也写清；不要填 API Key。

自动保存的 `host` 是运行 Node 的机器，`processArch` 是 Node 进程架构，不能据此认定客户端芯片。例如 Mac mini 运行服务、旧 Intel MacBook 使用浏览器时，client 填 MacBook 的真实信息。旧系统不能运行当前 Node 时，不需要为了浏览器验收在旧机器安装服务；服务端与客户端支持范围分开记录。此工具不预先声称任何 macOS 版本已受支持。

服务初始化、权限配置和填写计划在开始检查计时前完成。真实采集/播报由操作者使用已配置且获授权的服务；本工具不会读取密钥或自动执行付费请求。

## 准备独立数据

```sh
npm run verify:device -- prepare --plan verification-evidence/device/plan.json
```

输出一个新的 `run-*` 目录：

| 文件 | 用途 |
| --- | --- |
| `context.json` | 准备时固定的计划、版本、源码/构建摘要、主机信息和判据 |
| `seed.sqlite` | 两条固定中文听测记录；保持原样 |
| `device.sqlite` | 真机使用的独立数据库副本，可以产生新的测试聆听 |
| `checklist.md` | 九项具体操作、判据和固定文本 |
| `observations.json` | 初始全部未测，供实际操作者填写 |

停止原先的本地开发服务，在当前同一 checkout 中把下列路径替换为刚输出的绝对 `database` 路径，再启动。不要省略 `LISTENING_DB`，也不要将测试库覆盖到真实数据库：

```sh
LISTENING_DB='/absolute/path/run-XXXX/device.sqlite' npm start
```

用计划中的浏览器打开该服务，确认“设备验收 A/B”和页脚版本。若浏览器在另一台设备，使用已有可访问的 HTTPS 入口；普通局域网 HTTP 的麦克风限制应如实记录，不通过脚本绕过浏览器权限。改变版本、客户端或服务配置后重新 prepare，不能编辑旧 context 让报告变绿。

## 九项操作，最多十分钟

准备好后启动十分钟计时器，按 `checklist.md` 执行。建议操作时间合计 8 分 30 秒，剩余时间用于切换。到时停止采集和播报，未完成的项目保留未测，不自动重试。

| 操作 | 建议时间 |
| --- | ---: |
| 麦克风权限拒绝及恢复 | 60 秒 |
| 切换真实输入设备 | 45 秒 |
| 固定文本听测：数字、否定、条件、专名、漏播/重播/尾句 | 90 秒 |
| 暂停、暂停中跳转、恢复、停止 | 75 秒 |
| 切换记录，核对旧声音停止 | 45 秒 |
| 前后台切换 | 45 秒 |
| 锁屏及解锁 | 45 秒 |
| 休眠及唤醒后恢复 | 45 秒 |
| 断网及恢复后的新请求 | 60 秒 |

在 `observations.json` 写实际开始和结束的 ISO 时间，例如 `2026-10-15T16:00:00+08:00`。每条 criterion 填 `true`（亲自确认）、`false`（观察到失败）或保留 `null`（未测）；写 `observedAt` 和具体 `notes`。没有第二只麦克风、锁屏不适用或不能测试时保留 null 并写原因，不自动算通过。实际操作者填写 `operatorAttested=true`；确认测试服务版本后填写 `applicationVersionConfirmed=true`。

时间限制按操作者报告的实际操作区间检查，填写报告可以稍后完成。此离线工具不会计时关闭用户的浏览器或供应商会话；计时器到时由操作者停止。

## 汇总与后续处理

```sh
npm run verify:device -- report --run verification-evidence/device/run-XXXX
```

报告写入同目录 `summary.json`，重新核对源码、构建、固定输入摘要、计划/观察绑定、完整项目名单及十分钟区间。缺字段、环境/版本改变、只填“播放中”却未实际听到声音、超时和未测都不能得到完整人工通过。已知失败不会被其他项目的通过平均掉。

| 退出码 | 含义 |
| --- | --- |
| 0 | 所有判据均由该操作者报告通过：`reported_passed` |
| 1 | 有实际报告的失败 |
| 3 | 未测、不完整、过时、超时或输入无效 |

这些是人工报告的校验结果；摘要和哈希提供记录绑定，不认证操作者身份或证明现场操作发生。即使退出 0，`qualityEvaluated`、`fullProjectAcceptance` 和 `releaseEligible` 仍为 false。正式验收还需支持矩阵、独立人工听测/复核、必要的失败复现和发布负责人确认；现有 release gate 的外部义务保持未运行。本短测不替代多小时稳定性、正式语料的 TTS 评分或所有设备/音色的质量验收。

发生失败后保留该 run，记录最短复现步骤，再为修复候选创建新 run；不要覆盖失败观察或反复执行直到偶然通过。报告和测试数据库默认留在 ignored 的 `verification-evidence/`，不提交个人录音、密钥或真实数据库。
