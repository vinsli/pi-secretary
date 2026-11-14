# legacy/ —— 待重做的旧 Secretary 能力存档

> 建立：2026-11-14。目的：把散在三个位置、彼此重复且已过时的「Secretary / Router / 派工」
> 旧实现**集中冻结在这里**，供重做时对照；原位置已经清空，不要在别处再新建副本。
>
> 这里的文件**不是可运行的代码**，`pi` 不会加载它们，也没有任何测试引用。
> 唯一用途：读历史口径、抄走仍然有价值的细节、避开已经踩过的坑。

## 为什么集中到这里

这四份文件原先分散在三个互不相干的位置，各自演进、互相引用、版本漂移：

| 原位置 | 载体 | 谁在管 | 问题 |
|---|---|---|---|
| `<repo>/tools/workflow-secretary` + `.prompt.md` | 宿主仓 git | 项目 | shell 启动器 + 身份正文，和 `.pi/APPEND_SYSTEM.md`、扩展 `/secretary` 三处都在做「注入身份」 |
| `<repo>/.agents/skills/secretary/SKILL.md` + `compression-keep-list.md` | 宿主仓 git | 项目 skill | 前台协议（up/status/reconnect）第三份副本 + 压缩摘要模板 |
| `~/.pi/agent/projects-memory/<repo>/skills/worker-item-dispatch/SKILL.md` | 用户机器，**不在任何 git 里** | pi-hermes-memory | 只存在于一台机器上，无历史、无 diff、无法回滚 |

三处都叫「Secretary」，但一个管进程启动、一个管身份正文、一个管前台对话协议，
真正的实现却在一处都不在这四份文件里（在 `.pi/extensions/secretary.ts`）。
重做时如果继续沿用这个布局，同一件事会被写第四遍。

## 文件清单（5 份）

### 1. `hpcsharp-compiler/tools/workflow-secretary`（114 行，sh）

**作用**：WF-002 的主会话启动器。它是「怎么把 pi 拉起来并让它是 Secretary」的答案。

```sh
# 实际执行（dry-run 实测）
cd <project-root>
pi -n wf002-secretary \
   --tools +secretary_schedule,+secretary_cancel,+secretary_subscribe,+secretary_runtime_status,+secretary_deadline \
   --append-system-prompt "<project>/.pi/APPEND_SYSTEM.md" \
   --append-system-prompt "<project>/tools/workflow-secretary.prompt.md"
```

它做了四件事，逐条都有更合适的现代替代：

| 它做的 | 现在的问题 | 重做时的替代 |
|---|---|---|
| 用两个 `--append-system-prompt` 按序注入「公共规则 + 身份」 | 显式传参会**顶替** `.pi/APPEND_SYSTEM.md` 的自动发现，所以必须把公共规则文件也手工列一遍——一旦加了第三个来源就又要改脚本 | `.pi/APPEND_SYSTEM.md` 由 pi 自动发现（`resource-loader.js:971`，需项目信任）；身份层交给扩展的 `before_agent_start` section |
| `--tools +secretary_*` 激活 5 个 opt-in runtime 工具 | 只有 `--tools` 和 `defaultTools` 设置能激活；扩展自己从不调 `setActiveTools()` | 扩展在 `/secretary on` 里调 `pi.setActiveTools()`，或写 `.pi/settings.json` 的 `defaultTools` |
| `-n wf002-secretary` 给会话起名 | 纯显示层，Herdr tab 标题也能区分 | Herdr tab 标题 / `--name` 按需 |
| 预检 `pi` / `.git` / `backlog --version 含 -thu.` | **这条有真实价值**：非 `-thu.` 版 backlog 会静默写坏任务文件 | 保留这个预检，但作为独立 doctor 命令，而不是塞在启动器里 |

**重做时值得抄走的**：`backlog --version` 的 `*-thu.*` 校验（唯一一道防「写错 backlog 版本」的机器闸门）。

### 2. `hpcsharp-compiler/tools/workflow-secretary.prompt.md`（53 行）

**作用**：WF-002 的**身份正文**。H1 是 `WF-002 Secretary / Router 注入提示`——这个字符串同时是
去重标记（`IDENTITY_MARKER`）：扩展看到 system prompt 里已有它就跳过注入，避免启动器 + `/secretary on`
双份身份。

内容结构：

1. 双身份定义（Secretary = 人机前台，Router = 流程裁判/调度/翻译层，同一 session）
2. 两个消费入口的说明（启动器 / 扩展 `/secretary`）
3. **启动后第一件事**：立即做一次只读 `workflow status`（Backlog + git + handoff + presence 四源）
4. 硬约束：不自动派 Watchdog、不自动派子代理、`backlog` 只走 `-thu.` 版
5. Secretary runtime 5 个工具的说明

**问题和教训**：

- 它是「身份」，但内容里 80% 是流程约束——这些在 `.agents/skills/tdd-workflow/SKILL.md` 里已有一份，
  两份必然分叉。第 3 条的「先做 workflow status」在 `secretary/SKILL.md` 里也写过一遍。
- 它把「不要自动派子代理」写成了硬约束，但当时扩展里已经有一组 `dispatch_role` 工具——**约束和工具面矛盾**。
- 它引用了 `.pi/extensions/secretary.ts` 的具体路径，导致扩展一旦打包成 pi 包，正文就得改；
  反过来扩展又硬编码 `tools/workflow-secretary.prompt.md` 这个宿主仓路径（`BODY_RELATIVE_PATH`），
  形成**双向路径耦合**。

**重做时值得抄走的**：`IDENTITY_MARKER` 去重思路（幂等注入）、冷启动首查 `workflow status` 的四源清单。

### 3. `hpcsharp-compiler/.agents/skills/secretary/SKILL.md`（113 行，v1.1.0）

**作用**：Secretary 的**前台对话协议**（不是实现，是行为规范）。被 pi 当项目 skill 自动发现
（`.agents/skills/` 是 pi 支持的 Agent Skills 位置），也被 `tdd-workflow` 引用两处。

章节：`When to Use` / `定位：Secretary = 主 session Router` / `workflow up` / `Runtime 工具与生命周期` /
`workflow status` / `workflow reconnect` / `用户报告格式` / `Pitfalls` / `Verification`。

**它真正的独有内容**（其余都能在 tdd-workflow 找到）：

- `workflow status` 的**四源取证 + 每行标证据等级**（终态/过程/连接），并明确「不许把 presence
  或 pane 状态当已结束」
- `workflow reconnect` 的接管序列：读 Backlog Notes + `git log` + handoff → **不依赖旧 session 的
  压缩块** → Watchdog 必须拿到退出确认才重建（严禁双 Watchdog）
- 「接管 ≠ 派工」：树不净或前 Writer 未确认退出，不派下一项

**问题和教训**：

- 「Runtime 工具与生命周期」一节描述的是扩展内部实现（`session_start` 销毁 runtime、
  `agent_start`/`agent_settled` 驱动 busy、deadline 只在 settled 时 poll），且已经过时：
  它写「派工不再来自工具层」，而后来扩展里恰恰塞进了 `dispatch_role`。
- skill 里抄了扩展的实现细节 → 扩展一改 skill 就假。**skill 只该写模型怎么用工具，不该写工具内部怎么实现。**

**重做时值得抄走的**：三态证据等级、reconnect 的「只认 Backlog/handoff/git，不认压缩块」、
双 Watchdog 禁令。

### 4. `pi-hermes-memory/hpcsharp-compiler/skills/worker-item-dispatch/SKILL.md`（45 行，v5）

**作用**：本仓的**子项制派工纪律**——一个子项 = 一次派工，粒度 = 一拍或一步。

**独有内容**（tdd-workflow 里没有的）：

- 粒度的量化定义：「预期 tool calls ≤ 40、时长 ≤ 2h、产出 = commit(s) + 凭证」
- 「单 worker 连跑多批 = 上下文滚雪球」的历史教训（2026-10-05 夜，M2→M4a→M3→M4c→M4b 五批连跑被迫换岗）
- 项间传递只走两条通道：commit 链（事实）+ handoff 文件（叙事），**禁止 worker 之间直接对话**
- 验收三件：commit 内容、实测凭证、树净

**问题和教训**：

- 它存放在 `~/.pi/agent/projects-memory/`，**不在 git 里**，无 diff、无历史、只有一台机器上有。
  这是本次集中归档的直接原因之一。
- 与 `tdd-workflow` 大面积重叠（子项 8 次、`external_worker` 5 次、handoff 5 次都各写一遍）。
- 本次归档前它还留着「`secretary_dispatch` 作为 deferred 别名」的说法，而别名已被删除——典型漂移。

**重做时值得抄走的**：粒度的量化阈值、滚雪球教训、双通道传递、验收三件。

### 5. `hpcsharp-compiler/.agents/skills/secretary/compression-keep-list.md`（56 行）

**作用**：Secretary / Watchdog 在 billion-context 压缩下写摘要时的内容模板（KEEP 六类：
open objectives、任务状态/冻结决定、未处置告警四段、软租约/单 writer、接管指针……）。

**独有内容**：两条可复用的判断——「指针（任务 ID、commit、文件:行、消息 ID）必须逐字保留」、
「跨 session 恢复一律不依赖旧 session 的压缩块」；其余是 billion-context 四工具的用法。

**归宿**：这不是扩展代码，属于「压缩摘要策略」——重做时更像 billion-context 的配置/提示，
而不是 secretary 扩展的资产。

## 这几份文件共同暴露的结构问题（重做时要正解）

1. **同一件事写四遍**。「身份」同时存在于：`.pi/APPEND_SYSTEM.md`（公共规则）、
   `workflow-secretary.prompt.md`（身份正文）、`secretary/SKILL.md`（前台协议）、
   `tdd-workflow/SKILL.md`（编排状态机）。任何一处改动都要人工同步四处 —— 实际从来没同步过。
2. **仓库路径双向硬编码**。扩展硬编码宿主仓的 `tools/workflow-secretary.prompt.md`；
   正文又硬编码扩展的 `.pi/extensions/secretary.ts`。谁打包成 pi 包，另一边就断。
3. **实现细节写进 prose**。`secretary/SKILL.md` 抄了 runtime 生命周期，`worker-item-dispatch` 抄了
   `external_worker` 的参数面 —— 每次实现变动 prose 就变成假话。
4. **启动器在补 pi 没有的东西**（会话名、`--tools` 激活、`-thu.` 预检），其中只有 `-thu.` 预检
   真正不可替代，其余都能用 settings 或扩展 API 表达。
5. **一份文件选了不落 git 的存储**（projects-memory），直接导致无法审计。

## 一个重要事实：pi-secretary 包里没有任何替代品

这几份文件之所以要归档而不是直接删，是因为 `pi-secretary` 目前只有**代码**
（`index.ts` + `roles/`：注册表、resolve、roster、worktree、dispatcher、5 份角色正文），
**没有**下面任何一份 prose 的等价物：

| 旧资产 | 包里有没有替代 | 现状 |
|---|---|---|
| `workflow-secretary.prompt.md`（身份正文） | ❌ | 包内 `index.ts` 的 `BODY_RELATIVE_PATH` **仍然读宿主仓** `tools/workflow-secretary.prompt.md`——这是那条「包依赖宿主仓布局」的反向依赖，重做时要优先修 |
| `workflow-secretary`（启动器） | ❌ | 无 `--tools` 激活、无 `-thu.` 预检 |
| `.agents/skills/secretary/SKILL.md`（前台协议） | ❌ | status/reconnect 协议无处承接 |
| `worker-item-dispatch`（子项制派工纪律） | ❌ | 粒度阈值/滚雪球教训/验收三件无处承接 |

所以「重做」的净工作量 = 上表的 ❌ 行，而不是把代码再写一遍。

## 现状：现在谁在承担这些能力

| 旧文件想做的事 | 今天由谁做 | 是否够用 |
|---|---|---|
| 身份注入 | `.pi/extensions/secretary.ts` 的 `/secretary on` → `before_agent_start` 写 `sections.secretary` | 够用。但正文文件路径仍指向 `tools/workflow-secretary.prompt.md`（已随本次归档移除），`/secretary on` 现在会**诚实降级为 off** 并报「无法读取身份正文」—— 这是设计好的失败路径，不是 bug |
| 5 个 runtime 工具激活 | 无（启动器已移除）；可用 `.pi/settings.json` 的 `defaultTools` 或扩展内 `setActiveTools()` | **待重做** |
| `-thu.` backlog 预检 | 无 | **待重做**（建议做成 `/secretary doctor`） |
| 前台协议（status / reconnect） | `tdd-workflow` 里保留了一部分；专属条款随本归档下线 | **待重做** |
| 子项制派工纪律 | `tdd-workflow` 的「派工通道」+ `dispatch_role` 工具面 | 部分够用 |

重做的主线在 `pi-secretary` 包的 `index.ts` + `roles/`（角色注册表、`dispatch_role`、`dispatcher` 轴），
那份是**代码**，只有这几份是**已退役的历史 prose / shell**。
