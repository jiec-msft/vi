# Contribution communication

团队日常沟通、PR 正文与 review 优先使用简洁自然的中文，可混用 English technical terms。
源码、identifiers、branch names、commit messages 和 PR titles 使用 English。

本机仅做源码读取、编辑、Git 和 GitHub 运维；test/build/lint/typecheck、依赖安装、
GUI 与媒体转换全部在 GitHub Actions 的隔离 runner 上完成。
公开证据只用 CI-owned fake provider、synthetic credentials/audio；保持公开数据边界。
修改 CI 或发布 PR 证据时，先读 README 的 Checks 与 PR visual evidence。
