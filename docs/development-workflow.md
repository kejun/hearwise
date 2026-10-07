# 开发与交付流程

先读根目录 `AGENTS.md`，确认任务范围和最新主分支，再在独立分支实现。下列命令与 CI 使用相同入口；包版本和验收脚本列表以 `package.json`、锁文件及运行器为准。

## 环境准备

使用 Node 24，在当前 checkout 执行：

```bash
npm ci --ignore-scripts
npm run preflight
npm run setup:browser
```

预检拒绝借用其他 checkout 的 `node_modules`，检查锁定版本、Git 获取范围，以及浏览器实际启动和中文字体渲染。Linux 首次配置会安装 Playwright Chromium、系统依赖和中文字体，需要相应的系统安装权限。受限环境可通过 `CHROMIUM_EXECUTABLE` 指定已有浏览器，再运行 `npm run preflight:browser`；记录实际版本，不把替代版本当作 CI 的锁定版本。

预检不读取或输出凭据，也不把远程读取成功当成可推送证明。发布前选择已有授权的 Git CLI 或连接的 GitHub；不要反复尝试没有认证的推送。选择结果可通过 `PUBLICATION_CHANNEL` 记录。

## 改动与验证

仓库使用 UTF-8、LF 和文件末尾换行。不要在功能修改时顺便重写整文件格式；必要的历史规范化应独立提交，并用忽略行尾差异的 diff 确认业务内容未变。

```bash
npm run check:format
npm run check:version
npm run typecheck
npm test
npm run test:browser
```

格式检查只扫描 Git 跟踪的文件；新文件暂存后再检查。测试运行器只选择测试文件，分别设置单项和外层进程超时，并清理进程组。夹具关闭必须有期限；不能靠无限等待或无限微任务循环等待状态变化。

`test-evidence/results.json` 和 `browser-evidence/results.json` 保存源码 SHA、工作区是否有未提交变化、完成状态和逐项结果。报告中的日志路径保留失败前输出；浏览器每次使用独立子目录，避免重复验收时与既有报告冲突。只有运行器正常退出、`complete` 与 `ok` 都为真才算该组通过；单条日志中出现“通过”不代表整组完成。最终证据应来自已提交且干净的源码，CI 会在成功、失败或取消后尝试上传证据。

## 发布与工单收尾

发布前确认远程基线未变化。Git 获取配置若只覆盖主分支，应显式获取需要的功能分支，不把缺少远程跟踪引用误判为分支不存在。通过连接器发布时，逐个复制已提交的变更，保留模式、删除操作和提交边界，并核对远端 tree SHA 与本地一致；随后创建全新的功能分支。响应不确定时先读取远端，不能盲目重试写入。

交付时重新读取 PR 的当前 head、合并状态、CI workflow 及两个必需 job：`Node 24 deterministic tests` 和 `Chromium speech fixture (stub providers)`。只有同一 head 的必需 job 和 workflow 全部终态成功才算 CI 通过。取消、超时或失败应明确报告；缺失或仍在执行的检查保持待验证。发现 head 变化就废弃旧快照。

Linear 描述的自动更新集中在一个唯一二级标题下。每次先读取服务端当前文本，再精确替换该段；首次才追加，保留其他段落。保存后重读，核对内容、提交和实际验证状态。超时或响应丢失后先读取，避免重复追加；不得将尚未完成的 CI 写成已通过。

可复用的连接器发现、GitHub 发布和 Linear 更新辅助工具在个人 `coding-workflow` 技能中。该技能按服务和操作限定发现范围，先列少量名称，再读取选中的参数；不枚举整个工具注册表。
