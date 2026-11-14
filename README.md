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
闸门判的是**目标**目录：`dispatch_role({ role: "worker", taskId, cwd: "<worktree>" })`
让主工作树上的会话把 worker 派进隔离 worktree（不传 `cwd` 就在调用方仓库根，写角色会被拒）。
派工台账仍写调用方的 `.handoff/worker-roster.jsonl`——归属不随目标目录漂移。

### dispatcher 轴

`dispatch_role({ dispatcher: "user" | "secretary" | "teamlead" | { kind, id? } })` 只是
**可追溯的自称**，写入 `.handoff/worker-roster.jsonl` 的 `dispatchedBy` / `dispatchedById`。
它不是权限闸门：同一份扩展加载在哪个 pi 里，代码无法分辨。`id` 缺省取当前 session id。

## TDD 门禁（Backlog 内 red/green/verify）

把 superpowers 的铁律「NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST」从提示词挪到机器闸门：
门禁自己跑命令、自己写**目标 task** 的 Implementation Notes、自己拒绝顺序错误的调用方。

```bash
pi-secretary-tdd red    --task THU-119.3 --role worker --cmd "bun test tests/a.test.ts"
pi-secretary-tdd green  --task THU-119.3 --role worker --cmd "bun test tests/a.test.ts"
pi-secretary-tdd verify --task THU-119.3
```

同一套判定有两个入口：Pi 侧工具 `tdd_red` / `tdd_green` / `tdd_verify`，外部 worker（codely/codex
只有 shell）走 `lib/cli.ts`。CLI 退出码：`0` 通过 · `1` 门禁拒绝 · `2` 用法或环境错。

- **选择集 `sel`** = 规范化命令（只折空白）的 sha256 前 12 位。red 与 green 用同一条命令即同一个 sel。
- **三条拒绝**（Spec 点名要指名是哪一种）：`green_before_red`（绿早于红，后来补的红不能追认）、
  `selection_mismatch`（green 的 sel 没在任何更早 red 里出现过）、
  `production_changed_after_green`（绿之后生产代码又有未记录改动，用 git 路径差集判定，不看 mtime）。
  另有前置拒绝：`red_passed`（命令通过就不能记为红）、`green_failed`（green 时命令仍失败）、`no_green`。
- **证据只落两处**：目标 task 的 Notes 单行条目 + `.handoff/<task>-tdd-*.log`。不建 `.tdd` 目录、
  不写父任务、不勾 AC。
- **第三口径的基线**：green 记 `head`（HEAD）+ `snap`（`git stash create` 的工作树快照，含未提交改动）。
  两者都失效时 verify **明说 `productionCheck: "skipped"` 并给出原因**，绝不假装查过。
- **什么算生产代码**：`backlog/`、`.handoff/`、`.backlog-workflow/`、`.superpowers/`、`node_modules/`
  与测试路径全部排除。不排除台账的话，门禁自己写 Notes 会让下一次 verify 自拒。

Notes 条目格式（单行，可 grep）：

```
- <ISO ts> tdd-red|tdd-green|tdd-verify | task=<id> role=<role> cmd=<命令> exit=<码> sel=<前12> head=<sha> snap=<sha> | fail=<失败签名> | log=<相对路径>
```

## 开发

```bash
bun test test/     # 118 tests / 0 fail，不依赖宿主仓库
```

- `test/secretary.test.ts` —— 命令/事件 mock（注入、去重、生命周期、正文优先级）
- `test/secretary-runtime.test.ts` —— runtime job/订阅/cooldown/deadline
- `test/secretary-roles.test.ts` —— 注册表、覆盖、解析、三个派工工具与 roster（含 cwd 目标闸门）
- `test/secretary-tdd.test.ts` —— TDD 门禁：条目往返、选择集指纹、三条口径、全部拒绝路径、路径分类
- `test/secretary.sdk.test.ts` —— 真实 Pi SDK + faux provider，捕获实际 system prompt

`legacy/` 存放已退役的旧 Secretary 资产（启动器、身份正文旧版、前台协议 skill、
子项制派工 skill），只作重做参考，不参与运行、不被任何测试引用；逐份说明见
[`legacy/README.md`](./legacy/README.md)。

## 布局

```
index.ts              扩展入口（factory）
body/identity.md      包内身份正文
lib/                  runtime（job 队列/catalog/cooldown/deadline）+ tdd.ts（门禁判定）+ cli.ts（外部入口）
roles/                角色注册表 / 项目覆盖 / 解析 / roster / worktree 闸门 / 角色提示词
test/                 单元 + mock + 真实 SDK
legacy/               已退役资产存档（只读参考）
```
