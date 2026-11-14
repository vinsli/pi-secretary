# WF-002 压缩 keep-list 模板（Router/Secretary 用）

> 适用对象：Secretary（主 session Router）与 Watchdog 在 bili ACP（billion-context
> ≥ 0.1.213，四工具 compress/decompress/search_context/acp_status）下做会话内压缩时。
> 状态机唯一真相仍是 `.agents/skills/tdd-workflow/SKILL.md`（v2.1+）；本文件只是
> 压缩摘要的内容模板，不是第二真相。

## 定位与边界（先读）

- **Backlog 字段（Notes 软租约/里程碑）+ `/tmp/handoff-*.md` + git 链是任务事实源**；
  压缩块只是**同一 session 内的工作记忆**，可随时 decompress 恢复，但**跨 session
  恢复一律不依赖旧 session 的压缩块**（secretary skill reconnect 条款）。
- 因此 keep-list 的目标不是"把真相存进摘要"，而是**最小化同 session 内的重读成本**：
  保留"接下来还会用到的调度状态 + 可直查指针"，丢过程噪声。
- 指针（任务 ID、commit、文件:行、消息 ID、dump 路径）必须逐字保留——它们是
  回查 Backlog/git/handoff 的钥匙。

## KEEP（六类，缺一即视为摘要不合格）

1. **Open objectives + refs**：仍未完成/未被取代的目标，逐条带消息 ref。
   格式：`Open objectives: <目标一句话> (<mNNNNN>)`。已完成或被取代的移出。
2. **任务状态/冻结决定**：状态机当前位置一句话 + 冻结的 Spec/Plan 的**指针**
   （任务 ID + 冻结时间），不复制正文；用户拍板记录保留"决定 + 为什么"各一句。
   细节回查 Backlog——摘要里复制 Spec/Plan 全文 = 制造第二真相。
3. **告警四段**（Watchdog 异常报告，事实/证据/风险/建议）：**未处置**（Router 未
   裁决/未派单）的告警整段保留，四段缺一不可，证据指针逐字。已处置的可降为一行：
   `已处置告警 <主题> → <裁决> (<指针>)`。
4. **软租约/单 writer**：当前活跃租约原文（「子项 X 派给 <worker> @ <时间>」）、
   树净检查结果、前 writer 退出确认与否。只保当前 + 最近一次销记；历史租约聚合。
5. **接管指针**：handoff 文件路径、Backlog 任务 ID、关键 commit hash、Watchdog
   canary 状态、`/tmp` dump 路径。逐字。
6. **模型/API 错误**：仍在影响执行的错误（限流/5xx/超时/配额耗尽/上游报错原文、
   哪个 provider/model、已重试次数与退避状态）。已恢复的历史错误聚合为统计行：
   `glm-5.3 429×3 (已恢复)`。

## AGGREGATE（可聚合，一行 + 指针即可）

- 已验收子项的正常过程（命令输出、门禁 PASS 行）→ `子项 X 已验收 (commit, 门禁行)`。
- 重复读取与重复 status 检查（同一文件多次读、`git status`/presence 反复查询）。
- 正常 Watchdog 事件（canary 确认、无异常例行观察）。

## 调用范式

```
compress({ content: "mNNNNN–mNNNNN <topic>\nOpen objectives: … (mNNNNN)\n
任务状态: … (THU-xxx @ 冻结时间)\n告警(未处置): [事实|证据|风险|建议] …\n
租约: …\n接管指针: handoff=/tmp/handoff-x.md, commit=…, canary=OK\n
错误(在飞): …\n过程(已聚合): …" })
```

## Pitfalls

- 把压缩摘要当跨 session 交接材料用：新 Secretary 只认 Backlog/handoff/git。
- 摘要里复制冻结 Spec/Plan 全文：第二真相，重规划时会腐烂。
- 已处置告警仍整段保留：挤占六类在飞信息的预算。
- 丢掉消息 ref / commit / 路径的任何字符：摘要能被搜到但回查不了 = 半失效。
