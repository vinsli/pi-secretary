# Changelog

## [0.1.0] 2026-11-14

首个可分发包版本。

- 身份注入：`/secretary` / `on` / `off` / `status` / `reload`，正文默认取包内
  `body/identity.md`，仓库根可用 `.pi/secretary-identity.md` 覆盖（不跨 `.git` 边界）。
  移除对宿主仓库 `tools/workflow-secretary.prompt.md` 的硬编码路径。
- 角色派工：`role_list` / `role_resolve` / `dispatch_role`，5 角色 × 有序候选注册表，
  `.pi/secretary-roles.json` 项目覆盖，写角色必须隔离 worktree，roster 记录 dispatcher 自称。
  角色提示词固定在包内 `roles/`（不再按 cwd 搜索宿主仓库副本）。
- 运行时工具：5 个 opt-in 工具（schedule / cancel / subscribe / runtime_status / deadline）。
- `legacy/` 归档已退役资产（启动器、身份正文旧版、前台协议 skill、子项制派工 skill），
  附逐份说明与重做要点。
