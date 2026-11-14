# pi-secretary

Pi 扩展：把 **Secretary / Router 身份注入** 与 **按角色派工外部 agent** 内聚成一个可分发包。

单一 `index.ts` 注册三组能力，互不隐式依赖：

| 能力 | 入口 | 说明 |
|---|---|---|
| 身份注入 | `/secretary` `/secretary on` `off` `status` `reload` | 把 `body/identity.md` 作为自有 system-prompt section 注入当前会话；只翻转开关，不发起模型请求 |
| 运行时工具 | `secretary_schedule` `secretary_cancel` `secretary_subscribe` `secretary_runtime_status` `secretary_deadline` | 全部 `defaultActive: false`，需显式开启（`--tools +secretary_schedule,...` 或 `.pi/settings.json` 的 `defaultTools`） |
| 角色派工 | `role_list` `role_resolve` `dispatch_role` | 角色注册表在本包 `roles/registry.ts`；`dispatch_role` 经 `external_worker` 启 pane |

## 安装

```bash
pi install git:github.com/vinsli/pi-secretary@main
```

`dispatch_role` 需要 `herdr-external-agents` 提供 `external_worker` 工具：

```bash
pi install git:github.com/vinsli/herdr-external-agents@main
```

缺失时 `dispatch_role` 返回 `isError`，不静默降级。

## 身份正文的优先级

1. **项目级覆盖** `<repo>/.pi/secretary-identity.md` —— 从 cwd 向上搜索，最近的 `.git`（目录或文件）是边界，独立嵌套仓库不继承外层仓库的覆盖。
2. **包内** `body/identity.md` —— 随包分发，任何目录下都能开启。

两者都缺失或为空时 `/secretary on` 报错并降级为 `off`，不沿用旧缓存。

身份 H1 `WF-002 Secretary / Router 注入提示` 同时是去重标记：CLI 已用
`--append-system-prompt` 注入同一身份时不再重复注入。

## 角色注册表

`roles/registry.ts` 定义 5 个封闭角色（`researcher` / `reviewer` / `oracle` / `planner` / `worker`），
每个角色 **有序候选列表**（candidate 1 = 一等，candidate 2 = fallback），候选键为
`kind | model | effort | sandbox | wireApi`。模块加载即自校验，非法值直接抛错。

项目可用 `<repo>/.pi/secretary-roles.json` 覆盖候选（严格键校验，未知名报错）：

```json
{
  "reviewer": [
    { "kind": "codely", "model": "neo/eco/claude-opus-5-5", "effort": "xhigh", "wireApi": "messages" }
  ]
}
```

权限（`write` / `worktree`）不可通过覆盖放宽或收窄——`guardOverridePermissions` 会拒绝。

写角色（`worker`）必须在**隔离 git worktree** 中启动，主工作树直接拒（`roles/worktree.ts`）。

### dispatcher 轴

`dispatch_role({ dispatcher: "user" | "secretary" | "teamlead" | { kind, id? } })` 只是
**可追溯的自称**，写入 `.handoff/worker-roster.jsonl` 的 `dispatchedBy` / `dispatchedById`。
它不是权限闸门：同一份扩展加载在哪个 pi 里，代码无法分辨。`id` 缺省取当前 session id。

## 开发

```bash
bun test test/     # 83 tests / 0 fail，不依赖宿主仓库
```

- `test/secretary.test.ts` —— 命令/事件 mock（注入、去重、生命周期、正文优先级）
- `test/secretary-runtime.test.ts` —— runtime job/订阅/cooldown/deadline
- `test/secretary-roles.test.ts` —— 注册表、覆盖、解析、三个工具的派工与 roster
- `test/secretary.sdk.test.ts` —— 真实 Pi SDK + faux provider，捕获实际 system prompt

`legacy/` 存放已退役的旧 Secretary 资产（启动器、身份正文旧版、前台协议 skill、
子项制派工 skill），只作重做参考，不参与运行、不被任何测试引用；逐份说明见
[`legacy/README.md`](./legacy/README.md)。

## 布局

```
index.ts              扩展入口（factory）
body/identity.md      包内身份正文
lib/                  runtime：job 队列、事件 catalog、cooldown、deadline
roles/                角色注册表 / 项目覆盖 / 解析 / roster / worktree 闸门 / 角色提示词
test/                 单元 + mock + 真实 SDK
legacy/               已退役资产存档（只读参考）
```
