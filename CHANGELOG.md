# Changelog

## [0.2.0] 2026-11-15

Backlog 内 TDD 门禁（THU-119.3 / S3）+ 派工可指定目标 worktree。

- **TDD 门禁**：`lib/tdd.ts` 实现 red / green / verify 三个动作，自己跑命令、自己写目标 task 的
  Implementation Notes、自己按三条口径拒绝（`green_before_red` / `selection_mismatch` /
  `production_changed_after_green`），另有 `red_passed` / `green_failed` / `no_green` 前置拒绝。
  - 双入口：Pi 工具 `tdd_red` / `tdd_green` / `tdd_verify`；外部 worker 走
    `lib/cli.ts`（`pi-secretary-tdd`，退出码 0 通过 / 1 拒绝 / 2 用法或环境错）。
  - 证据只落 Notes 单行条目 + `.handoff/<task>-tdd-*.log` 指针；不建 `.tdd` 目录、不写父任务、不勾 AC。
  - 第三口径用 `git stash create` 的工作树快照做基线（含未提交修复），快照失效时明说 `skipped`。
  - 生产代码判定排除台账/证据/脚手架与测试路径——否则门禁写 Notes 会让下一条 verify 自拒。
  - 写入前校验 `backlog --version` 含 `-thu.`。
- **`dispatch_role` 支持 `cwd`**：写角色闸门改为判**目标**目录，主工作树上的会话可把 worker 派进
  隔离 worktree；台账仍写调用方仓库根（归属不随目标漂移）。
- `roles/prompts/worker.md` 新增「TDD 门禁（机器闸门，不是建议）」一节（CLI 用法 + 三条拒绝 + 证据落点）。
- 测试：83 → 118 pass（新增 `test/secretary-tdd.test.ts` 33 例 + 派工 cwd 用例 2 例）。

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
