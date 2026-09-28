# 仓库工作约定

- 每轮修改开始前拉取最新代码，提交前再检查一次。若主分支更新，先同步改动、解决冲突，再执行相关验证。

## 版本升级

每次修改版本号都必须同步完成：

1. 将 `package.json` 的 `version` 设置为目标版本，例如 `1.0.0`。
2. 同步 `package-lock.json` 顶层及 `packages[""].version`。
3. 将 `public/index.html` 页脚版本设为 `HearWise v<version>`。
4. 运行 `npm run check:version`，确认上述版本一致。
5. 将版本提交合入 `main`，确认 GitHub 的「Version tag」工作流成功创建对应 `v<version>` tag。

版本以 `X.Y.Z` 格式填写，tag 带 `v` 前缀。已有 tag 不得移动或覆盖。PR 尚未合并或工作流尚未成功时，不得声称 GitHub tag 已创建；如自动打 tag 失败，排查并重新运行工作流。
