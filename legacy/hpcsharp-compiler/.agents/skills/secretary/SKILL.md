---
name: secretary
version: 1.1.0
description: >
  WF-002 长期工作流的 Secretary 前台协议：主 session 同时承担 Secretary（唯一
  人机前台）与 Router（调度位）时的启动、status、reconnect 与用户报告格式。
  触发词：Secretary、workflow up、workflow status、workflow reconnect、前台
  接管、Watchdog 重连、孤儿 Watchdog、新 session 恢复调度、恢复工作流。Backlog
  操作唯一真相是 `.agents/skills/backlog-workflow/SKILL.md`，编排/TDD 真相是
  tdd-workflow；本 skill 只定义前台协议，不复制状态机或字段生命周期。
---

## When to Use

- 主 session 以 Secretary + Router 身份接管/继续 WF-002 长期工作流：启动后首查、
  例行状态检查、断线后重连/换 session 接管、Watchdog 异常处置。
- 用户提出"现在工作流什么状态"、"接上之前的活"、"Watchdog 还在吗"这类前台请求。
- Backlog 初始化、task 创建、Spec/Plan、子任务、Notes、父任务里程碑和收口以
  `.agents/skills/backlog-workflow/SKILL.md` 为准；Router/TDD 编排、单写者、
  observe-only 和证据等级以 `.agents/skills/tdd-workflow/SKILL.md` 为准；本 skill
  与二者冲突时，分别以对应来源为准。

## 定位：Secretary = 主 session Router

- 同一主 session 承担两个身份：**Secretary**（唯一人机前台，用户只跟它说话）与
  **Router**（流程裁判/调度/翻译层，四职能见 tdd-workflow Roles）。
- 不存在独立的 `router.md` 角色、不做 Router adoption、不建持久 registry。
- 本 skill 只定义前台协议（up/status/reconnect/用户报告）；状态机由
  tdd-workflow 定义，Backlog 字段生命周期由 backlog-workflow 定义，禁止在此复制
  状态机或字段生命周期。

## workflow up（启动）

- 进程拉起由启动器 `tools/workflow-secretary`（WF-002 P0.2 交付）完成：以两个
  `pi --append-system-prompt` 依序注入——先 `.pi/APPEND_SYSTEM.md`（身份无关的
  公共硬规则层，同样注入本 session），后 Secretary prompt（身份层）。必须从
  Herdr pane / 受信项目目录启动。
- 运行中的普通 `pi` 会话也可用项目扩展命令 `/secretary`（`.pi/extensions/
  secretary.ts`，THU-106 交付）就地开启同一份身份：无参或 `on` 幂等开启、
  `off` 关闭、`status` 查看；命令不触发模型请求、不自动派工，身份随下一条
  普通消息生效。已由启动器注入的会话再 `on` 不会双份；`off` 只控制扩展
  自身，不撤销启动器已注入内容或会话历史。
- Secretary 侧职责：身份生效后（启动器注入冷启动，或 `/secretary` 开启后
  的下一条消息）立即执行一次 **workflow status**（冷启动状态检查），
  向用户报告当前工作流状态与待办。

## Runtime 工具与生命周期

- 启动器显式追加但不替换默认工具：
  `--tools +secretary_schedule,+secretary_cancel,+secretary_subscribe,+secretary_runtime_status,+secretary_deadline`。
  扩展中的五个工具保持 `defaultActive: false`，分别用于 bounded job 的
  schedule/cancel、结构化 source subscribe、runtime status，以及 deadline 登记。
- `secretary_runtime_status` 只报告 runtime 的 jobs、subscriptions、queue、wake
  与 busy/runtime 状态；工具入口必须做手工参数校验，并同时检查 enabled 与
  generation。runtime 自身继续负责 job generation/cancel/closed 守卫。
- `session_start` 销毁旧 runtime 并建立新 generation；`session_tree` 不清理；
  `session_shutdown` 清理。`agent_start` 与 `agent_settled` 驱动 busy、flush 和
  deadline poll；派工不再来自工具层——Herdr / intercom 派工由 Router 在调用处记录，
  `tool_execution_end` 已不参与 dispatch；`message_end` 仅接收 catalog 认可的
  structured custom message 并按层发布。
- 不做常驻 `interval` 或 `enqueue_secretary` 轮询；status 按需计算，deadline 只在
  lifecycle settled 时 poll，事件驱动 runtime queue/wake。

## workflow status（状态检查）

按需即时执行（不周期轮询、不发模型心跳），汇总以下来源并在每行结论后标注证据
等级（终态/过程/连接，定义见 tdd-workflow"证据等级与存活判定"）：

1. Backlog：先按 `.agents/skills/backlog-workflow/SKILL.md` 完成版本/初始化门禁，
   再读取父任务与在飞子任务的 Notes（软租约、里程碑）——经全局 `backlog`
   （`-thu.` 版）读写；
2. git：`git status`（树净与否）与 `git log`（最近 commit）；
3. handoff：`/tmp/handoff-*.md` 交接文件指针；
4. intercom presence（连接级）与 Herdr 状态标签（过程级）。

产出：用户语言状态表（在飞子项 × 状态 × 证据等级 × 可直查指针）；**不把
presence 或 pane 状态单独当作"已结束"**。

## workflow reconnect（重连/接管）

新 Secretary（新 session）接管时：

1. 读父任务 Notes + 在飞子任务 Notes + `git log` + handoff 文件，重建调度状态；
   只认 Backlog/handoff/git 链，**不依赖旧 session 的压缩块**。
2. Watchdog 处置按 tdd-workflow"重启恢复/孤儿 Watchdog"条款：先观测取证
   （presence/Herdr），要求旧 Watchdog 经 intercom 确认退出或由用户人工退役
   pane，拿到终态证据后才重建 Watchdog，重建后 canary 确认；**严禁双 Watchdog**。
3. 单写者纪律不变：接管 ≠ 派工；树不净或前 Writer 未确认退出，不派下一项。
4. 完成后按"用户报告格式"向用户报告接管结果与未决事项。

## 用户报告格式

沿用 tdd-workflow 的 **Router 六段报告模板**（发生什么/已确认/不确定/方案取舍/
推荐/需要决定），不另造第二模板；status/reconnect 报告中的每条结论带证据等级与
可直查指针（任务 ID、commit、文件:行、消息 ID）。

## Pitfalls

- 在本 skill 里复制/改写状态机、Backlog 字段生命周期或单写者细则 → 制造第二
  真相；分别引用 tdd-workflow 与 backlog-workflow 即可
- 把 presence（连接级）或 Herdr pane 标签（过程级）当终态证据；未取得终态证据
  就重建 Watchdog → 双 Watchdog 并存
- 周期轮询/定时心跳：status 是按需即时计算，不是后台循环
- 绕过 backlog-workflow 的版本/初始化门禁，或使用非 `-thu.` 的 `backlog` 读写
  Backlog

## Verification

1. 冷启动后 status 产出带证据等级的状态表，每行有可直查指针；
2. reconnect 后的调度决策能引用 Backlog Notes / git / handoff 证据，不引用旧
   session 压缩块；
3. 本文件不含状态机或 Backlog 字段生命周期复制品：与 tdd-workflow、
   backlog-workflow 的流程条款做 diff 审查，无重复正文。
