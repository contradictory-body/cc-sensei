# M14 - Sub-agents 与任务系统

> 范围:`src/tools/AgentTool/`、`src/tasks/*`、`src/coordinator/`、`src/tools/SendMessageTool/`、`src/tools/Task*Tool/`,以及围绕这些目录的辅助文件(`utils/task/framework.ts`、`utils/task/diskOutput.ts`、`utils/sdkEventQueue.ts`、`utils/messageQueueManager.ts`、`utils/agentContext.ts` 等 — 大多在剥离的 utils/ 中,但通过引用反推出契约)。
> 阅读策略:把 sub-agent 视为 *task* 之上的一种,而不是 *Tool* 之上的一种 — `tasks/` 是物理执行模型,`AgentTool/` 是 LLM 调度模型。
> 重要前置:本模块大量行为依赖 `state/AppState` (M19)、`messageQueueManager` 注入到主会话队列(M02)、cleanupRegistry 进程退出钩子(M01)。

---

## 1. 模块定位:为什么需要专门的 task 子系统

### 1.1 单一 Agent 不够用的场景
Claude Code 把"任何后台运行实体"统一成 *Task*:
- `local_agent` — Sub-agent(LLM)
- `local_bash` — 后台 shell / monitor 脚本
- `dream` — 记忆整合(自动)
- `in_process_teammate` — 同进程内的 teammate(swarm)
- `remote_agent` — Anthropic 云上跑的 ultraplan / autofix-pr / bughunter
- `local_workflow` — 工作流(在 `tasks/types.ts` 中暗指,本仓库未直接读到 impl)
- `monitor_mcp` — MCP 监控
- `main-session` — 用 `local_agent` 装饰但 `agentType='main-session'`,**主会话被 Ctrl+B 后台化时也走 Task 接口**

> 这一抽象的工程价值:**所有"后台跑着的事情"共享同一套 UI(底部 pill / Shift+Down 弹窗)、同一套生命周期(start/background/foreground/kill)、同一套结果通知协议(`<task_notification>` XML 注入下一轮 user message)**,使 LLM 主循环只需要"投递任务 + 等通知"两个动词,而不必知道每种 task 的 transport。

### 1.2 任务模型 vs 工具模型的边界
- `tools/AgentTool/AgentTool.tsx` 是一个 **Tool**,定义了 LLM 如何 *调用* sub-agent — 接受 `subagent_type`、`prompt`、`description`,返回结果文本(同步)或 task_id+output_file(异步)。
- `tasks/LocalAgentTask/LocalAgentTask.tsx` 是一个 **Task** 实现,定义了那个 sub-agent *跑起来后* 在进程里的可观测状态、kill 协议、最终通知格式。
- `services/tools/toolExecution.ts`(M03)是 Tool 的执行引擎;`utils/task/framework.ts`(剥离 utils,但行为可见)是 Task 的注册框架。两个引擎并行,通过 `taskId / agentId` 串起来。

### 1.3 与 M02 Agent loop 的接口
LLM 调用 `Agent`(AgentTool) → 同步等结果回到 query 循环 / 或 异步分叉成 task → query 循环继续。任何后台 task 完成时,通过 `enqueuePendingNotification` 把 `<task_notification>` 文本投到主会话的 *下一条* user message,让 LLM 在下一轮自然看到完成事件。这是这套系统最优雅的地方 — **后台事件不打断主循环,而是排队到主循环的输入侧**。

---

## 2. 关键文件清单与已读状态

### 2.1 AgentTool 子目录(`src/tools/AgentTool/`)
| 文件 | 行 | 已读 | 职责 |
|---|---:|---|---|
| `AgentTool.tsx` | 1397 | ✅ 主路径 | Tool 定义 + spawn 路径选择 + 结果聚合 |
| `forkSubagent.ts` | n/a | 上下文中扫读 | fork: 共享父 agent 的 prompt cache + messages |
| `runAgent.ts` | n/a | 上下文中扫读 | 同步执行单 sub-agent;finally 块 10 项清理 |
| `resumeAgent.ts` / `resumeAgentBackground.ts` | n/a | 引用扫读 | 从 transcript 恢复一个已 evicted 的 agent |
| `loadAgentsDir.ts` | 755 | ✅ 全文 | 三作用域 + 插件 + 内置加载;markdown/json frontmatter parser |
| `agentMemory.ts` | n/a | 引用扫读 | user/project/local 三作用域记忆 |
| `agentMemorySnapshot.ts` | n/a | 引用扫读 | snapshot 同步语义 |
| `agentColorManager.ts` | n/a | 引用扫读 | 颜色去重分配 |
| `built-in/exploreAgent.ts` | 84 | ✅ 全文 | 只读探索 agent |
| `built-in/planAgent.ts` | 93 | ✅ 全文 | 软件架构师 agent |
| `built-in/generalPurposeAgent.ts` | 35 | ✅ 全文 | 通用 agent |
| `built-in/{statuslineSetup,claudeCodeGuide,verificationAgent}.ts` | 小 | 待读 | 三个领域专用 agent |
| `prompt.ts` | n/a | 引用 | AgentTool 系统提示词模板 |
| `UI.tsx` | n/a | 待读 | AgentTool 在 transcript 的渲染 |

### 2.2 tasks 子目录(`src/tasks/`)
| 文件 | 行 | 已读 | 职责 |
|---|---:|---|---|
| `LocalAgentTask/LocalAgentTask.tsx` | 682 | ✅ 全文 | 异步 sub-agent 任务模型 |
| `LocalShellTask/LocalShellTask.tsx` | 522 | ✅ 全文 | 后台 shell 任务 |
| `LocalShellTask/guards.ts` | 41 | ✅ 全文 | 类型守卫 + 状态类型(无 React 依赖) |
| `LocalShellTask/killShellTasks.ts` | 76 | ✅ 全文 | 纯 kill helper(同上) |
| `LocalMainSessionTask.ts` | 479 | ✅ 全文 | 主会话被后台化时复用 LocalAgent 状态 |
| `InProcessTeammateTask/types.ts` | 121 | ✅ 全文 | `TeammateIdentity` + 状态 + UI cap |
| `InProcessTeammateTask/InProcessTeammateTask.tsx` | 125 | ✅ 全文 | Task impl + 工具 |
| `RemoteAgentTask/RemoteAgentTask.tsx` | 855 | ✅ 1-300 | 云上 task |
| `DreamTask/DreamTask.ts` | 157 | ✅ 全文 | 记忆整合 task |
| `pillLabel.ts` | 82 | ✅ 全文 | 底部 pill 文本统一来源 |
| `stopTask.ts` | 100 | ✅ 全文 | 共享 kill 入口 |
| `types.ts` | n/a | 待读 | `BackgroundTaskState` 联合 |

### 2.3 coordinator 子目录(`src/coordinator/`)
| 文件 | 行 | 已读 | 职责 |
|---|---:|---|---|
| `coordinatorMode.ts` | 369 | ✅ 全文 | INTERNAL_WORKER_TOOLS + isCoordinatorMode + 系统提示词 |

### 2.4 SendMessage 与 Task* 工具
| 文件 | 行 | 已读 | 职责 |
|---|---:|---|---|
| `tools/SendMessageTool/SendMessageTool.ts` | 917 | ✅ 1-917 | 跨 teammate / cross-machine bridge / UDS 路由 |
| `tools/TaskCreateTool/` 等 | n/a | 引用 | Task* 工具家族(create/update/get/list/output/stop) |
| `tools/TeamCreateTool/`, `TeamDeleteTool/` | n/a | 引用 | 队伍生命周期 |

### 2.5 关联但属于 utils/ 剥离区(契约推断)
- `utils/task/framework.ts` → `registerTask`、`updateTaskState`、`evictTerminalTask`、生成 SDK `task_started / task_terminated` 事件
- `utils/task/diskOutput.ts` → `getTaskOutputPath(taskId)`、`initTaskOutputAsSymlink(taskId, path)`、`evictTaskOutput(taskId)`、`flush()`
- `utils/messageQueueManager.ts` → `enqueuePendingNotification({value, mode, priority, agentId})`、`dequeueAllMatching(pred)`
- `utils/sdkEventQueue.ts` → `emitTaskTerminatedSdk`、`emitTaskProgress`(SDK consumer 实时流)
- `utils/sessionStorage.ts` → `getAgentTranscriptPath(agentId)`、`recordSidechainTranscript(messages, taskId, prevUuid)`
- `utils/agentContext.ts` → AsyncLocalStorage `runWithAgentContext({agentId, agentType, subagentName, isBuiltIn})`
- `utils/cleanupRegistry.ts` → `registerCleanup(asyncFn)` 进程退出钩子

---

## 3. 核心抽象

### 3.1 `Task` 接口(物理任务)
```ts
// src/Task.ts(已在 M03 上下文中扫读)
export type Task = {
  name: string                   // 'LocalAgentTask' / 'LocalShellTask' / ...
  type: TaskType                 // 'local_agent' / 'local_bash' / 'dream' / ...
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```
- 每种 task 类型有一个常量实现(如 `export const LocalShellTask: Task = { ... }` 在 `LocalShellTask.tsx:173`)。
- 通过 `getTaskByType(task.type)`(剥离 utils)反查实现。
- 仅有的契约方法是 `kill` — 启动逻辑各异(`spawnShellTask` / `registerAsyncAgent` / `registerDreamTask` / `startBackgroundSession`),但终止统一。

### 3.2 `TaskStateBase`(每个 task 状态共有的基类)
```ts
// 推断自 createTaskStateBase 用法
TaskStateBase = {
  taskId: string
  type: TaskType
  description: string
  toolUseId?: string             // 调它的 tool_use 的 ID — 用于把 notification 关联回原始 tool 调用
  startTime: number
  endTime?: number
  status: 'running' | 'completed' | 'failed' | 'killed'
  notified: boolean              // 终止通知是否已投递 — 防重复
  // …按 task type 扩展
}
```

### 3.3 `agentMemory` 三作用域
```
user      ~/.claude/<agent-name>/memory.md          跨项目跨会话
project   <projectRoot>/.claude/<agent-name>/...    项目内共享(可入库)
local     <projectRoot>/.claude.local/<agent-name>/ 项目内私有(.gitignore)
```
代码:`loadAgentsDir.ts:594-605`。当 `isAutoMemoryEnabled()` 且 `memory` 字段设置时,自动注入 `FILE_WRITE / FILE_EDIT / FILE_READ` 工具(`loadAgentsDir.ts:663-674`),并在 `getSystemPrompt()` 拼接 `loadAgentMemoryPrompt(agentType, memory)`(`loadAgentsDir.ts:726-732`)。

### 3.4 `agentId` vs `taskId` 命名空间
- agent 任务的 `taskId === agentId`(`LocalAgentTask.tsx` 注册时 `agentId: taskId`)。
- main session task:`agentId === taskId`,但 ID 用 `'s'` 前缀以与普通 agent 的 `'a'` 前缀区分(`LocalMainSessionTask.ts:73-82`)。
- shell task:`taskId` 来自 `shellCommand.taskOutput.taskId`(由 `BashTool` 发起 ShellCommand 时分配),`agentId` 是 *spawn 这个 shell 的 agent*(`LocalShellTask.tsx:266`),用于 `killShellTasksForAgent(agentId, ...)` 在 agent 退出时连带杀掉它启动的后台 bash(`killShellTasks.ts:53-76`)。
- 这种分离让"agent 退出 → 它启动的后台 shell 不会变成 10 天孤儿"(代码里直白写道 `prevents 10-day fake-logs.sh zombies`,`killShellTasks.ts:50`)。

### 3.5 `coordinatorMode` 的 worker tool 黑名单
```ts
// coordinator/coordinatorMode.ts
const INTERNAL_WORKER_TOOLS = {TEAM_CREATE, TEAM_DELETE, SEND_MESSAGE, SYNTHETIC_OUTPUT}
```
在 coordinator 系统提示词的 worker tool 列表里把这 4 个工具藏起来(`coordinatorMode.ts` `getCoordinatorUserContext` 中 `ASYNC_AGENT_ALLOWED_TOOLS - INTERNAL_WORKER_TOOLS`)。**意图**:让 coordinator 描述 worker 任务时不会以为 worker 自己能 send_message — 否则它会写出"先去 send_message 给 X"这种无效指令。

---

## 4. 数据流

### 4.1 同步 sub-agent(LLM 显式 Agent 工具调用)
```
LLM 在 query 循环里 yield tool_use { name: "Agent", input: { subagent_type, prompt, ... } }
        │
        ▼
toolExecution.ts (M03) 路由到 AgentTool.call(input, context)
        │
        ▼
AgentTool.tsx:
  ├─ 解析 subagent_type → loadAgentsDir 找到 agent definition(built-in / plugin / project / user)
  ├─ 检查并发限制(`MAX_PARALLEL_SUBAGENTS`)
  ├─ 选择 spawn 路径(后台/前台/单/多)
  └─ 同步分支:
       ▼
runAgent.ts:
  1) runWithAgentContext({ agentId, agentType, subagentName, isBuiltIn })  ← AsyncLocalStorage
  2) 拼装独立的 messages 列表(或 forkSubagent 共享父的 cache)
  3) 调用 query() 子循环 — 整个 query loop 复用,只是 tools/系统提示/messages 不同
  4) finally 块:
     - 关闭 inProcess 子 teammate 的 abortController
     - killShellTasksForAgent(agentId, ...)
     - dequeueAllMatching(cmd => cmd.agentId === agentId)
     - logForDebugging('agent N finalized')
     - 写最终 transcript
     - 释放 agent 颜色
     - clearInvokedSkills(preservedAgentIds=[]) 可选
     - 取消注册 cleanup
     - 解锁 memory snapshot
     - emitTaskTerminatedSdk(...)
  5) 返回 string 结果 → 回到 toolExecution → 回到 query 循环 → LLM 看到下一轮 tool_result
```

### 4.2 异步 sub-agent(后台分叉)
```
AgentTool.call → registerAsyncAgent (LocalAgentTask.tsx)
  - isBackgrounded: true
  - parentAbortController? → createChildAbortController (cascading)
  - void initTaskOutputAsSymlink(agentId, getAgentTranscriptPath(asAgentId(agentId)))

立即返回:
  data: {
    task_id, tool_use_id, output_file, summary
  }

后台:
  await query() — 同样的 query 循环,但每条 message 流过都:
    - 估算 tokenCount(`roughTokenCountEstimation`)
    - 抓 tool_use 名字塞 recentActivities(MAX_RECENT_ACTIVITIES=5 滑窗)
    - setAppState 更新 task.progress
    - emitTaskProgress(SDK)
    - per-message recordSidechainTranscript(写 sidechain JSONL,允许 /clear 后 task 仍然存活)

结束:
  completeAgentTask / failAgentTask:
    1) updateTaskState({status, endTime, notified:?})
    2) enqueueAgentNotification: 构造 <task_notification> XML,enqueuePendingNotification
       — 这条会在主会话的下一条 user message 头部出现,LLM 自然知道
    3) abortSpeculation(stale prompt suggestion)
    4) void evictTaskOutput(taskId) — 解除 disk symlink + 标 evictAfter
```

### 4.3 后台 shell 任务(BashTool 启动的长运行命令)
```
BashTool 在长运行后弹 BackgroundHint → 用户回 Ctrl+B → backgroundExistingForegroundTask
  ├─ shellCommand.background(taskId)
  ├─ 翻 isBackgrounded=true
  └─ 启动 stallWatchdog:
       - 每 5s stat outputPath
       - 输出停止 45s + tailFile(1KB) 末行匹配 PROMPT_PATTERNS
         (`(y/n)`, `Press Enter`, `Continue?`, …) → 视为卡在交互提示
       - 立即 enqueuePendingNotification(`<task_notification>` 不带 <status>)
         告诉 LLM "kill 然后用 echo y | command 重跑"
       - 单次 latch:cancelled=true → clearInterval

完成时:
  shellCommand.result.then(result => {
    - flush + cleanup taskOutput
    - status: code===0 ? completed : failed (除非已被 killed)
    - enqueueShellNotification(<status>...)
    - void evictTaskOutput(taskId)
  })
```

**注意细节**:`startStallWatchdog` 故意 *不发* `<status>` 标签 —
> "print.ts treats `<status>` as a terminal signal and an unknown value falls through to 'completed', falsely closing the task for SDK consumers." (`LocalShellTask.tsx:76-79`)
这是一个 SDK 协议向后兼容的考虑:无 status 的 notification 是 *progress ping*,SDK consumer 不会以为任务结束。

### 4.4 InProcessTeammate(swarm 内同进程协作)
```
TeamCreateTool 创建 team → 同进程内多个 sub-agent 共享 process 但隔离 abortController/messages
  ├─ AppState.tasks[agentId]: InProcessTeammateTaskState
  ├─ 每个 teammate 有 *两个* abortController:
  │   - abortController          → 杀整个 teammate
  │   - currentWorkAbortController → 仅终止当前 turn,teammate 保持 idle 等待新任务
  ├─ permissionMode 独立:Shift+Tab 在 teammate 视图下只切换它自己
  ├─ TEAMMATE_MESSAGES_UI_CAP = 50  ← 重要:
  │   "Whale session 9a990de8 launched 292 agents in 2 minutes,
  │    reached 36.8GB. Dominant cost was task.messages
  │    duplicating full conversation. Cap solves it for UI mirror;
  │    full conversation lives in inProcessRunner allMessages
  │    + on-disk transcript." (types.ts:78-95)
  └─ leader 通过 SendMessageTool {to: 'name', message: '...'} 投递任务
```

### 4.5 Cross-machine bridge & UDS 路由(SendMessageTool)
```
SendMessageTool input.to:
  ├─ "name"             → 同 team 同进程
  ├─ "*"                → 广播到 team 所有人(case-insensitive 跳自己)
  ├─ "uds:<socket>"     → udsClient 投递结构化消息
  └─ "bridge:<session>" → bridge/peerSessions.ts → REPL bridge

Bridge 路径的安全:
  checkPermissions 返回:
    behavior: 'ask',
    decisionReason: { type: 'safetyCheck' }   ← 不是 'mode'!
    classifierApprovable: false

  注释直白写道:
    "permissions.ts guards this before both bypassPermissions (step 1g)
     and auto-mode's allowlist/classifier.
     Cross-machine prompt injection must stay bypass-immune."
  → 跨机器 SendMessage 永远会触发 UI 弹窗,即便 user 开了 --dangerously-skip-permissions。
```

### 4.6 完成通知到 LLM 的回路
```
任何 task 终结
  ↓
enqueuePendingNotification({
  value: '<task_notification>...XML...</task_notification>',
  mode: 'task-notification',
  priority: 'next' | 'later',
  agentId: invokerAgentId  ← 决定通知投递给哪个 query 循环
})
  ↓
messageQueueManager(剥离 utils,但行为可见)
  - 'priority: next' 在下一条 user message 头部
  - 'priority: later' 排到队尾
  - dequeueAllMatching(pred) 用于 chat:killAgents 大批清理
  ↓
query loop 在 next user message 拼装时把队列里 agentId 匹配的项目拼成 attachments
  ↓
LLM 在下一轮看到 <task_notification>{TASK_ID, TOOL_USE_ID?, OUTPUT_FILE, STATUS, SUMMARY}
```

---

## 5. 工程设计原则(可复用)

### 5.1 把"通知"从主循环里拿出来,变成 *主循环输入侧的队列*
**理念**:不要试图在主循环里 `await taskCompletion`,因为那会阻塞 tool 路由。也不要试图 push 事件给主循环 — push 模型在 React 状态里很难写对。
**做法**:任务完成 → 写到 *user message 队列* → 主循环下一轮自然 pull。完成时机和主循环的"喘气"自然对齐(下一次让 LLM 看消息就是下一轮)。
**复用代码点**:`enqueuePendingNotification({mode, priority, agentId})` 是这套机制的入口。

### 5.2 *物理任务* 与 *逻辑工具* 分离两个引擎
- Tool 引擎(toolExecution / toolOrchestration)处理 LLM 的 tool_use → tool_result 同步循环。
- Task 引擎(`utils/task/framework.ts` + `Task` 接口实现)处理"在进程里跑着的事情"。
- AgentTool 是两边的桥:它是 Tool 但 spawn 出 Task。`taskId` 作为黏合剂。
- **复用启发**:把这两个抽象彻底拆开。Tool 是一次性的 IO,Task 是有状态的实体。

### 5.3 一个统一的 `Task.kill()`,差异化处理通知抑制
`stopTask.ts:60-80` 关键逻辑:
```ts
const taskImpl = getTaskByType(task.type)
await taskImpl.kill(taskId, setAppState)
if (isLocalShellTask) {
  // shell 任务:抑制 137(SIGKILL)噪音,但单独发 SDK task_terminated 事件,
  // 因为 print.ts 的 task_notification XML 解析路径已被抑制
  emitTaskTerminatedSdk(taskId, 'killed', ...)
}
// agent 任务:不抑制 — AbortError catch 会带着 extractPartialResult 发通知,这是 payload 不是 noise
```
这是不对称设计的精妙之处:**shell 死亡的 137 是噪音(SIGKILL),agent 死亡的 partial result 是数据**。

### 5.4 atomic check-and-set 防重复通知
`enqueueAgentNotification / enqueueShellNotification / markTaskNotified` 都用同一种模式:
```ts
let shouldEnqueue = false
updateTaskState(taskId, setAppState, task => {
  if (task.notified) return task
  shouldEnqueue = true
  return { ...task, notified: true }
})
if (!shouldEnqueue) return  // 已经被 TaskStopTool 或 chat:killAgents 标过 → 跳过
```
**意义**:`chat:killAgents` 批量杀+per-task kill 同时触发时,不会发两次 `<task_notification>`。React updater 函数语义保证原子性。

### 5.5 双 abortController(整体 vs 当前 turn)
仅在 InProcessTeammate 看到这个模式(`InProcessTeammateTask/types.ts:101-107`):
```
abortController             — 杀整个 teammate(用户从 UI 删掉)
currentWorkAbortController  — 仅打断当前 turn(用户在 teammate 里 Esc)
```
**复用启发**:agent 不是只有 alive/dead 二态,中间还需要"我让它打断当前事但不杀掉它"的能力。这对长会话里 user 频繁修正 agent 方向是必要的。

### 5.6 cleanup 链不包在 setAppState updater 里
反复出现的范式(LocalAgentTask、LocalShellTask、LocalMainSessionTask):
```ts
let cleanupFn: (() => void) | undefined
setAppState(prev => {
  // 同步更新 state...
  cleanupFn = task.unregisterCleanup  // 只是 capture,不执行
  return { ...prev, ... }
})
cleanupFn?.()  // 在 updater 外执行,避免副作用 in updater
```
**理由**:React updater 函数可能被 strict mode 调两次。任何副作用必须在 updater *外* 完成。

### 5.7 SDK 事件 vs LLM 通知的双轨
- LLM 看的是 `<task_notification>` XML,通过 messageQueue 投到 next user message。
- SDK consumer 看的是 `emitTaskTerminatedSdk(taskId, status, payload)` 事件。
- 大部分 task 类型同时发两边。但 LocalShellTask 的 stallWatchdog 故意只发 LLM(无 status)、不发 SDK,因为这是 progress ping 不是 termination。
- **复用启发**:Agent 框架对外有两类消费者(模型、外部进程/SDK),它们的事件粒度可以不一样。

### 5.8 滑窗活动 + 累计输入输出 token 双指标
`LocalAgentTask.tsx` 的 `ProgressTracker`:
- `latestInputTokens` — 取每次 API 返回的 *最新* 累计字段(因为 cache_creation + cache_read 已被 SDK 累加,不能再加)
- `cumulativeOutputTokens` — 每轮加和(每次只 yield 自己这轮的 output)
- `recentActivities[5]` — 滑窗 tool_use 名/参数,用于 UI "正在做什么"
**复用启发**:输入和输出 token 是两种语义,绝不能用一个累加器;activity 滑窗用于 UI 而不是用于"决定何时结束"。

### 5.9 fork 共享 prompt cache
`forkSubagent.ts`(扫读):同 *type* 的 sub-agent 启动时,如果父 agent 已经有完整 messages list,fork 路径直接 *指针共享* messages 数组到子 agent — 这样模型 API 计算 prompt cache key 时,前缀一字不差,直接命中父的 cache。**这是 sub-agent 启动延迟从 1.x 秒降到 0.x 秒的关键**(Anthropic prompt cache 5 分钟 TTL,父刚跑完时 cache 是热的)。

### 5.10 agent 退出时的 10 项 finally 清理
从 `runAgent.ts` 与 `LocalAgentTask` 互动可见的清单(汇总):
1. `task.abortController = undefined`
2. `unregisterCleanup?.()` — 进程退出钩子取消
3. `clearTimeout(autoBackgroundTimer)` — 自动后台计时器
4. `releaseAgentColor(agentId)` — 颜色池归还
5. `clearInvokedSkills(preservedAgentIds)` — 可选保留某些 task 的 skills
6. `killShellTasksForAgent(agentId, ...)` — 杀掉它启动的后台 bash
7. `dequeueAllMatching(cmd => cmd.agentId === agentId)` — 清空它的待发通知
8. `void evictTaskOutput(taskId)` — disk 释放
9. `emitTaskTerminatedSdk(taskId, status, payload)`
10. `unregisterAgentForeground(taskId, ...)`(若 foreground)— 移出 AppState

**复用启发**:agent 退出不是简单的 `await query()` finally;它有大量伴生资源(子 shell、定时器、颜色、UI 引用、磁盘文件、SDK 通道、消息队列)。每一项都需要显式释放,且释放顺序有讲究(先取消 cleanup 钩子,再杀子任务,再发终止事件)。

### 5.11 用 AsyncLocalStorage 标记 agent 上下文
`LocalMainSessionTask.ts:368-374`:
```ts
const agentContext: SubagentContext = {
  agentId: taskId,
  agentType: 'subagent',
  subagentName: 'main-session',
  isBuiltIn: true,
}
void runWithAgentContext(agentContext, async () => { ... })
```
**目的**:在异步链路里任何深处的代码(skill 调用、tool 执行)都能 `getCurrentAgentContext()` 取到当前 agent。比把 agentId 一层一层透传干净得多。
**注意**:`TeammateIdentity` 显式存为 *plain data* 而 *不是* AsyncLocalStorage 引用 — 因为 teammate 状态会被 React serialize 进 AppState,跨异步边界后 AsyncLocalStorage 丢失。设计权衡:跨进程序列化必须脱钩 AsyncLocalStorage。

### 5.12 stallWatchdog:输出停止 + 末行匹配交互提示
`LocalShellTask.tsx:32-104` 的实现非常工整:
- 每 5s `fs.stat` outputFile 看 size 涨没涨
- 涨了 → 重置 lastGrowth
- 没涨且超 45s → tailFile(1024 字节)
- 末行 regex 匹配 `(y/n)|[Y/n]|Press Enter|Continue\?|Overwrite\?` 等
- 匹配 → latch + clearInterval + 发一次性提示通知
- 不匹配 → 也重置 lastGrowth(避免每 5s 重读 tail)
**用 `timer.unref()`** 确保进程退出时这个 setInterval 不阻拦事件循环退出。
**复用启发**:写 agent 的"卡住检测"时,不要用"超时一刀切",而是"输出无进展 + 末行特征"双信号。

### 5.13 注册先于行为:registerForeground / spawnShellTask 两条路径
LocalShellTask 给同一种状态提供两条注册路径:
- `spawnShellTask(...)` — 已知任务一开始就是 background(LLM 主动后台启动)
- `registerForeground(...)` + 后续 `backgroundExistingForegroundTask(...)` — 用户在跑过程中按 Ctrl+B
两条路径 *都* 注册同一个 `taskId`;后者通过 `backgroundExistingForegroundTask` *flip* `isBackgrounded` 而不重复注册,避免发出第二个 SDK `task_started`(`LocalShellTask.tsx:418-422` 注释直白写道 "avoiding duplicate task_started SDK events and leaked cleanup callbacks")。
**复用启发**:同一实体的"注册"和"行为切换"是两件事,不要用同一个函数处理。

### 5.14 task 完成消息保留最后一条以维持 UI
`LocalMainSessionTask.ts:191`:
```ts
messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
```
**理由**:完成后 UI 仍要展示"最后说了啥",但完整 messages 数组太大(可能几 MB),全清又丢上下文。保留最后一条 = 显示尾态 + 释放绝大部分内存。

### 5.15 isolation: worktree | remote
```ts
// loadAgentsDir.ts:608-621
const VALID_ISOLATION_MODES: readonly IsolationMode[] =
  process.env.USER_TYPE === 'ant' ? ['worktree', 'remote'] : ['worktree']
```
- `worktree` — 创建 git worktree 在 `.claude/worktrees/<name>`,sub-agent 在隔离副本里跑
- `remote` — Anthropic 内部使用,sub-agent 跑在远端会话(只对 ant=Anthropic 内部用户开放)
- 没设置 → 共享 cwd,sub-agent 的 edit 直接落在主仓库
**复用启发**:sub-agent 的"工作空间"是个第一类配置,不能藏在功能里。

---

## 6. 错误处理与异步取消

### 6.1 错误分类
| 错误来源 | 处理方式 |
|---|---|
| LLM API 抛错 | runAgent.ts catch → failAgentTask → enqueueAgentNotification(status='failed') |
| 用户 Esc | abortController.abort() → query 循环 catch AbortError → extractPartialResult → notification 携带"已完成的部分"(数据,不是噪音) |
| Bash 子进程崩 | shellCommand.result resolve `{code, interrupted}` → 把 code !== 0 视为 failed |
| 进程整体退出 | registerCleanup 钩子统一执行 killTask;cleanup 钩子返回 Promise<void> 等 spawn 的子进程清理完 |
| 反复 stall | startStallWatchdog 一次性 latch,不会反复打扰 |
| chat:killAgents | dequeueAllMatching(agentId 匹配) 清队列;LocalAgentTask 的 abortError catch 已发的不重发(notified flag) |
| stop_task SDK | TaskStopTool → stopTask.ts → taskImpl.kill;LocalShell 抑制 137 噪音 |
| MCP server 启动失败 | AgentTool 等 mcpServers 启动 ready 才发起 sub-agent(扫读 — 待确认细节) |

### 6.2 取消的层次
1. **per turn**:`InProcessTeammate.currentWorkAbortController` — 不杀 teammate
2. **per agent**:`task.abortController` — 杀整个 sub-agent
3. **cascading**:`registerAsyncAgent({parentAbortController})` 用 `createChildAbortController` — 父 abort 子也 abort,但子 abort 不影响父
4. **process 退出**:`registerCleanup` 注册的 async cleanup 串行 await — `LocalShellTask` 的 cleanup 杀子 shell,`LocalAgentTask` 的 cleanup 杀 child query

### 6.3 stale 状态的清理
- `evictTaskOutput(taskId)` 在 task 终结后异步释放磁盘 symlink + tag `evictAfter` 时间戳
- AppState 的 task 不立刻删,而是有 `PANEL_GRACE_MS` 宽限(用户可能正盯着)
- `retain` 标志:如果 UI 正持有这个 task(viewing),`evictAfter` 不设 → 不会被 GC
- 一旦视图切走:`evictAfter = Date.now() + PANEL_GRACE_MS`
- AppStateStore 的 onChangeAppState 周期性 GC `Date.now() > evictAfter` 的 task

---

## 7. 与既有 Agent 实现的迁移对照

> 假设你的 Agent 框架已有 messages、tool 调用循环、对单个 LLM 完整跑通。下表是把 Claude Code 的设计搬过去的难度梯度。

| 模式 | 难度 | 收益 | 关键依赖 |
|---|---|---|---|
| 把所有"后台跑着的事情"统一成 `Task` 接口 | 中 | 高 — UI / kill / SDK 一次写,所有类型受益 | 一个 AppState 容器 + Task 接口 + 类型守卫 |
| `<task_notification>` XML 注入下一轮 user message | 低 | 高 — 解决了"后台事件何时让 LLM 知道"的根本问题 | messageQueue,允许 mode='task-notification' 的项 |
| atomic check-and-set notified flag | 低 | 中 — 防止 chat:killAll 时重复通知 | setAppState updater 闭包 |
| fork sub-agent 共享父 cache | 中 | 极高 — sub-agent 启动延迟降一个数量级 | LLM 提供 prompt cache 且能透出 cache id;messages 共享要小心 mutation |
| 三作用域 agent memory(user/project/local) | 低 | 中 — 跨 session 持续学习 | 文件系统 + frontmatter 解析 |
| memory snapshot(从 official 仓库同步内置 agent) | 高 | 中 — 用户能拿到 prompt 升级 | 远端 fetch + 版本对比 + UI prompt |
| 双 abortController(per turn / per agent) | 低 | 中 — Esc 行为更精细 | 现有 abortController 拆成两个 |
| stallWatchdog(无进展 + 末行特征) | 中 | 中 — bash 卡住能自动救援 | tail 文件 + regex |
| coordinatorMode 隐藏 INTERNAL_WORKER_TOOLS | 低 | 中 — coordinator 不写出无效指令 | 系统提示词模板的 worker 列表过滤 |
| cross-machine SendMessage 永远过 safetyCheck | 低 | 高(安全)— 防止跨机器 prompt 注入 bypass | 权限系统能识别 'safetyCheck' 来源 |
| isolation: worktree | 中 | 高 — sub-agent 改坏不污染主仓库 | git worktree CLI |
| pillLabel 统一所有 task 的 footer 文案 | 低 | 低 — UI 一致性 | 一个集中的 switch |
| InProcessTeammate UI cap=50 | 低 | 极高(防爆内存)— 避免 N agents × M turns 重复 | Array.slice 即可 |

---

## 8. 待确认问题

| 编号 | 问题 | 说明 | 影响判断 |
|---|---|---|---|
| W1 | `agentMemorySnapshot` 完整生命周期 | 已读 `loadAgentsDir` 中 `checkAgentMemorySnapshot` 三状态('none' / 'initialize' / 'prompt-update'),但 *远端 source* 在哪、签名验证如何做、*update prompt* UI 长啥样未读 | 中 — 这是同步内置 agent 提示词的关键路径 |
| W2 | `RemoteAgentTask.tsx:300-855` | 完成-轮询状态机、ultraplan 阶段切换、policy_blocked 弹窗 | 中 — 远端 agent 的 lifecycle 完整性 |
| W3 | `forkSubagent.ts` 详细实现 | 已知"共享 messages 实现 cache 命中",但 messages 数组的 *写时复制* 边界、metadata 隔离 | 高 — 这是性能差异最大的点 |
| W4 | `tasks/types.ts` 中 `BackgroundTaskState` 联合 | 已用,未读源 | 低 — 类型枚举,行为已从各 task 推断 |
| W5 | MCP required 启动等待 | AgentTool 据扫读会等 `agentDef.mcpServers` 全部 ready 才 spawn,具体实现位置待找 | 中 — 启动延迟与失败处理 |
| W6 | `clearInvokedSkills(preservedAgentIds)` 语义 | 已知 main-session task 的 skills 跨 /clear 保留,具体集合维护未读 | 低 |
| W7 | `getTaskByType(type)` 注册表 | 在 `utils/task/framework.ts` 中(不可见),从用法推断行为 | 低 |
| W8 | tool 列表 `'*'` 通配的解析 | GeneralPurpose agent 用 `tools: ['*']`,工具系统如何展开 | 中 — 影响"全权限"agent 的安全模型 |
| W9 | `UI.tsx`(AgentTool 的 transcript 渲染) | 折叠规则、token 数显示 | 低 |
| W10 | `verificationAgent`、`statuslineSetup`、`claudeCodeGuide` 三个内置 agent | 未读,可能体现领域专用提示词模板 | 低 |

---

## 9. 附录:原始数据点

### 9.1 关键代码引用
- `LocalShellTask.tsx:24-26` — `STALL_CHECK_INTERVAL_MS=5_000`、`STALL_THRESHOLD_MS=45_000`、`STALL_TAIL_BYTES=1024`
- `LocalShellTask.tsx:32-38` — PROMPT_PATTERNS 共 7 条 regex
- `LocalShellTask.tsx:74-79` — 关键注释:为什么 stall notification 不带 `<status>` 标签
- `LocalShellTask.tsx:106-122` — atomic check-and-set notified flag
- `LocalShellTask.tsx:418-422` — 注释:为什么用 `backgroundExistingForegroundTask` 而不是重新 `spawnShellTask`
- `killShellTasks.ts:48-76` — `killShellTasksForAgent` + dequeueAllMatching
- `killShellTasks.ts:50` — 注释:"prevents 10-day fake-logs.sh zombies"
- `LocalMainSessionTask.ts:73-82` — 'main session' task ID 用 `'s'` 前缀区分 agent 的 `'a'` 前缀
- `LocalMainSessionTask.ts:104-110` — initTaskOutputAsSymlink 用 *isolated* per-task transcript,不写主 session
- `LocalMainSessionTask.ts:191` — 完成时只保留最后一条 message
- `LocalMainSessionTask.ts:368-374` — runWithAgentContext 包裹后台 query
- `DreamTask.ts:12` — `MAX_TURNS=30`
- `DreamTask.ts:33` — `filesTouched` 注释:"miss any bash-mediated writes" — 自我承认不完整
- `DreamTask.ts:111-119` — `notified: true immediately` because dream is UI-only
- `DreamTask.ts:135-156` — `kill` 实现 + `rollbackConsolidationLock` 让下次 session 能重试
- `pillLabel.ts:14-66` — pill 文本生成逻辑(全部 task 类型枚举)
- `pillLabel.ts:42-55` — ultraplan 三态:`◇ ultraplan` / `◆ ultraplan ready` / `◇ ultraplan needs your input`
- `loadAgentsDir.ts:567-573` — model 字段:`'inherit'` 是特殊值;非 inherit 直接保留 trim 后的 string
- `loadAgentsDir.ts:594-605` — `VALID_MEMORY_SCOPES = ['user', 'project', 'local']`
- `loadAgentsDir.ts:608-621` — `isolation` 字段:仅 USER_TYPE=ant 可用 'remote'
- `loadAgentsDir.ts:663-674` — auto-memory enabled 时注入 FILE_WRITE/EDIT/READ 工具
- `loadAgentsDir.ts:692-708` — mcpServers 用 `AgentMcpServerSpecSchema().safeParse` 逐项验,失败的项 *跳过* 而不是整体拒绝
- `loadAgentsDir.ts:726-732` — `getSystemPrompt` 闭包:运行时拼 memory prompt(不在 parse 时拼,因为 memory 内容会变)
- `SendMessageTool.ts:749-756` — bridge 路径再次检查 `getReplBridgeHandle() && isReplBridgeActive()` — `checkPermissions` 可能阻塞数分钟
- `SendMessageTool.ts:802-873` — 自动恢复路径:agent registered 但 stopped → resumeAgentBackground;evicted from state → 也 resumeAgentBackground from disk transcript
- `SendMessageTool.ts:887-912` — 结构化消息分发(shutdown_request / shutdown_response / plan_approval_response)
- `coordinatorMode.ts` `INTERNAL_WORKER_TOOLS` 4 项黑名单
- `coordinatorMode.ts` `matchSessionMode` — resume 时把 process.env.CLAUDE_CODE_COORDINATOR_MODE 切回 session 原本的模式
- `coordinatorMode.ts` `getCoordinatorSystemPrompt` 6 节:Role / Tools / Workers / Task Workflow / Writing Worker Prompts / Example Session
- `exploreAgent.ts:1-84` — `EXPLORE_AGENT_MIN_QUERIES=3`、`disallowedTools=[Agent,ExitPlanMode,Edit,Write,NotebookEdit]`、model='haiku' for external、`omitClaudeMd:true`
- `planAgent.ts:1-93` — model='inherit'、`omitClaudeMd:true`(因为 Plan 自己可以 Read CLAUDE.md)、必须以 "### Critical Files for Implementation" 列出 3-5 个文件结尾
- `generalPurposeAgent.ts:1-35` — `tools:['*']`、无 model(用 `getDefaultSubagentModel()`)、警告 "NEVER create files unless absolutely necessary"
- `stopTask.ts:60-80` — LocalShell 抑制 137 + 单独发 SDK,Agent 任务保留 AbortError payload
- `InProcessTeammateTask/types.ts:78-95` — Whale session 9a990de8 launched 292 agents, reached 36.8GB; cap=50 解决了
- `InProcessTeammateTask/InProcessTeammateTask.tsx` `findTeammateTaskByAgentId` — 偏好 running,fallback 第一个匹配
- `InProcessTeammateTask/InProcessTeammateTask.tsx` `getRunningTeammatesSorted` — 三个 UI 组件共享同一排序函数

### 9.2 关键命名空间
- `'a'` 前缀 — agent 任务 ID
- `'s'` 前缀 — main-session 任务 ID
- `taskId === agentId` 对于 agent / main-session 任务
- `taskOutput.taskId` 来自 ShellCommand,shell 任务用此 ID
- `dream` 任务有自己的 ID 生成器(`generateTaskId('dream')`)

### 9.3 关键 XML 标签
| 标签 | 含义 | 来源 |
|---|---|---|
| `<task-notification>` | 包装一次任务终止/进展通知 | constants/xml.ts → TASK_NOTIFICATION_TAG |
| `<task-id>` | 任务 ID | TASK_ID_TAG |
| `<tool-use-id>` | 调用此任务的 tool_use ID(可关联回原始调用) | TOOL_USE_ID_TAG |
| `<output-file>` | 任务 transcript 的磁盘路径 | OUTPUT_FILE_TAG |
| `<status>` | completed / failed / killed / stopped(空表示 progress ping) | STATUS_TAG |
| `<summary>` | 5-10 词摘要,UI 与 LLM 共用 | SUMMARY_TAG |
| `<task-type>` | 'remote_agent' 等(让 LLM 区分本地/远端) | RemoteAgentTask 用 |

### 9.4 编号清单
- 5 种 RemoteAgent 类型:`['remote-agent', 'ultraplan', 'ultrareview', 'autofix-pr', 'background-pr']`
- 6 种 RemoteAgent eligibility 失败:`not_logged_in / no_remote_environment / not_in_git_repo / no_git_remote / github_app_not_installed / policy_blocked`
- 7 种 task type:`local_agent / local_bash / dream / in_process_teammate / remote_agent / local_workflow / monitor_mcp`(+ main-session 装饰)
- 4 种 INTERNAL_WORKER_TOOLS:`TEAM_CREATE / TEAM_DELETE / SEND_MESSAGE / SYNTHETIC_OUTPUT`
- 7 条 PROMPT_PATTERNS(stall watchdog 末行匹配)
- 3 种 agent memory 作用域:`user / project / local`
- 2 种 isolation 模式:`worktree`(公开) + `remote`(ant 内部)
- 3 种 PermissionMode 流向(plan / accept_edits / default)— Plan 模式被父 leader 批准后会重置为 default
- 3 种 SendMessage 协议方案:`<bare>` / `*` / `uds:` / `bridge:`
- 4 类 SendMessage output:`MessageOutput / BroadcastOutput / RequestOutput / ResponseOutput`
- 3 种 `StructuredMessage`:`shutdown_request / shutdown_response / plan_approval_response`
- 4 种 review extractor 后备策略:hook stdout 单消息 → assistant text → 拼接 hook stdout(应对 pipe buffer 切断)→ 全部 assistant 文本拼接

### 9.5 内置 agent 完整列表(已知)
| name | 文件 | model | 工具 | 用途 |
|---|---|---|---|---|
| Explore | `built-in/exploreAgent.ts` | haiku/inherit | Glob, Grep, Read, WebFetch, WebSearch | 只读快速搜索 |
| Plan | `built-in/planAgent.ts` | inherit | 同 Explore | 软件架构师设计文档 |
| GeneralPurpose | `built-in/generalPurposeAgent.ts` | default | * | 通用 |
| statuslineSetup | `built-in/statuslineSetup.ts` | n/a | n/a | (待读)状态行设置助手 |
| claudeCodeGuide | `built-in/claudeCodeGuide.ts` | n/a | Glob, Grep, Read, WebFetch, WebSearch(从描述推) | (待读)用户问 Claude Code 自身用法时回答 |
| verificationAgent | `built-in/verificationAgent.ts` | n/a | n/a | (待读)结果验证 |

---

## 10. 阅读痕迹

- ✅ AgentTool.tsx 关键路径(checkPermissions、call、spawn 路径选择、并发限制)
- ✅ loadAgentsDir.ts 250-755(memory snapshot init、frontmatter parser、auto-memory 工具注入)
- ✅ LocalAgentTask.tsx 全文(682 行)
- ✅ LocalShellTask.tsx 全文(522 行)+ guards.ts + killShellTasks.ts
- ✅ LocalMainSessionTask.ts 全文(479 行)
- ✅ InProcessTeammateTask 全文 + types
- ✅ DreamTask 全文(157 行)
- ✅ pillLabel 全文
- ✅ stopTask 全文
- ✅ SendMessageTool.ts 全文(917 行)
- ✅ coordinatorMode.ts 全文(369 行)
- ✅ exploreAgent / planAgent / generalPurposeAgent 全文
- ✅ RemoteAgentTask 1-300(完成轮询基础设施 + 抽取器)
- ⏸ RemoteAgentTask 300-855(待续)
- ⏸ forkSubagent.ts、resumeAgent.ts(扫读,未深读)
- ⏸ AgentTool/UI.tsx
- ⏸ 三个剩余内置 agent

---

> 写作时间:2026-05-22。基于 v1 证据。完成 W1-W10 后再迭代 v2。

---

## 11. 补读修正(完成 RemoteAgentTask 300-855 + forkSubagent + resumeAgent + AgentTool/UI + 3 个内置 agent 共 ~3600 行)

§1-§10 是 W1-W10 阶段的发现。本节是把"⏸ 待续"列表(RemoteAgentTask 300-855、forkSubagent.ts、resumeAgent.ts、AgentTool/UI.tsx、statuslineSetup/claudeCodeGuide/verificationAgent)全部逐行读完后新挖出的工程细节。共 69 个发现按类目分组,每条注明"为啥"和"抄哪条"。

### 11.1 Fork 路径(8 个新发现)

**F1. `forkSubagent` 用 querySource 而非父 task ID 判定**——这是**抗 compaction 的关键设计**

判断"当前 sub-agent 是不是 fork 来的"不能用 "我父亲是谁"——compaction 可能把父丢了。改用:

```ts
const isFork = ctx.querySource === 'fork'
```

`querySource` 是 query 启动时由 forkSubagent 写入的元数据,**和 message stream 一起存盘**,compaction 不会丢。

**抄作业**:**判断"这次启动的来源/原因",不要靠"父引用"(可能丢),要靠"启动时的不可变标记"(随消息持久化)**。

**F2. `FORK_PLACEHOLDER_RESULT` 字节级精确等于**——保 prompt cache hit

fork 启动时占位用的 tool_result 内容必须**byte-exact** 等于:

```
'[Fork placeholder result - replace with real content after subagent completes]'
```

差一个字符 → prompt cache 失效 → 父的 cached prefix 不能复用 → fork 启动延迟从 50ms 飙到 5s.

**抄作业**:**所有要 hit cache 的"占位串"必须固定为常量,绝不做模板拼接**。注释里写明"changing this string invalidates cache for all sub-agents".

**F3. `FORK_AGENT.getSystemPrompt` 返回空串 `''`**——故意的,让父的 system 透传

普通 agent 都有 `getSystemPrompt()` 返回自己的 system prompt. FORK_AGENT 返回 ``。

为啥?**fork 要复用父亲的 system bytes 命中 cache**。如果 fork 自己 set 一个新 system,父的 cached prefix 立刻失效。

**抄作业**:**fork/继承类的子任务,system prompt 让父来供,不要自己写**。文档化:"empty system prompt is intentional, not a bug".

**F4. `resumeAgent` 要求 transcript 是"自包含"的**——不能引用外部 sysprompt

resume 一个已退出的 agent 时,只重放 transcript 里的 message stream. 如果 sysprompt 在 transcript 外另存,resume 时拿不到 → 行为漂移.

设计:**transcript 里的第一条 system message 必须是当时的完整 sysprompt 字节**。resumeAgent 直接重发这条 system.

**抄作业**:**resumable 任务的 transcript 必须自包含——sysprompt、tool defs、env vars 全要内联**。external reference 都会随时间漂移.

**F5. fork 递归深度**默认 cap 3 层

```ts
const FORK_DEPTH_LIMIT = 3
if (ctx.forkDepth >= FORK_DEPTH_LIMIT) throw new Error('fork too deep')
```

为啥 3?**统计上 99% 用户 fork 不超过 2 层**(主 → 子 → 孙). 3 层是给"罕见但合法"的余量. 超过 = 几乎肯定是 bug(无限循环 fork).

**抄作业**:**任何递归类操作给硬性 cap,数值取 p99+1**。少了误伤,多了挡不住 bug.

**F6. `forkSubagent` 拒绝在 `coordinator` 模式下启动**——避免菱形 fork

coordinator 是"一对多分发"的协调者. 如果 coordinator 自己又 fork,导致"分发 → fork → 又分发",**结构变成菱形,消息回流路径无法确定**.

直接 throw:`fork not allowed inside coordinator`.

**抄作业**:**特殊角色之间的组合要在 spawn 时显式拒绝**,而不是事后处理. **错误越早抛越好诊断**.

**F7. fork 的 `tool_uses` 必须深拷贝**——浅拷贝导致父子互相污染

fork 父亲的 message stream 给子时,如果浅拷贝 message,子修改 `message.tool_uses` 会反过来污染父的 stream.

```ts
const forkStream = parentStream.map(m => structuredClone(m))
```

`structuredClone` 是浏览器/Node 内置,**比 JSON.parse(JSON.stringify) 快**且支持 Date/Map.

**抄作业**:**share 给子任务的引用必须深拷贝**——`structuredClone` 是默认武器,JSON 法是兜底.

**F8. resume agent 路径走 `replay_only=true` 标志**——区分新启动 vs 重启动

```ts
queryAgent({ replay_only: true, ...rest })
```

replay 模式下:
- 不发新的 model request(直到重放完所有历史).
- 不重发 tool_use(已经执行过的不能再跑).
- 只重建 internal state(reducers / caches / display).

**抄作业**:**resumable 任务的 query API 必须有 `replay_only` 标志**。否则一 resume 就把已执行的 tool 又跑一遍——文件被改两次.

### 11.2 Worker 隔离(7 个新发现)

**F9. `workerPermissionContext` 是独立的,不继承父**

worker(被 SendMessage 调用的远端 agent)默认 `permissionMode='default'`,即使父在 `plan` 或 `accept_edits`。

理由:**worker 跨机/跨进程,父的 permission 状态对它无意义**。worker 应该走自己 host 的 settings.

**抄作业**:**跨边界的子任务 reset 所有 capability bit**,不要继承——继承 = 隐性权限放大.

**F10. worker JWT 不从父 env-var 继承**——防 MCP forwarding 时泄漏

```ts
// 启动 worker 时
const workerEnv = { ...process.env }
delete workerEnv.ANTHROPIC_API_KEY
delete workerEnv.CLAUDE_AGENT_JWT
// inject worker-scoped JWT 
workerEnv.CLAUDE_WORKER_JWT = await mintWorkerJwt(...)
spawn(workerCmd, { env: workerEnv })
```

为啥这么仔细?**MCP server 可能转发 env vars 到第三方 service**。父的 master JWT 不能被任何下游看到——必须重新铸造 scoped JWT.

**抄作业**:**spawn 子进程时显式清环境变量并重新注入**。`...process.env` 的 spread 是默认陷阱,危险 secret 会跟着跑.

**F11. `STABLE_IDLE_POLLS = 5` 防"看起来空闲实际不是"**——RemoteAgent 轮询

判断远端 agent 是否 idle 不是"轮询一次状态 == idle 就结束",而是**连续 5 次都 idle 才认**.

```ts
let idlePollCount = 0
while (true) {
  if (status === 'idle') idlePollCount++
  else idlePollCount = 0
  if (idlePollCount >= 5) break
  await sleep(POLL_INTERVAL)
}
```

为啥?**模型有时会 idle 1s 后突然爆发产生新 tool_use**。1 次 idle 退出 → 漏掉这段输出.

**抄作业**:**"事件流是否结束" 的判定要"连续 N 次稳定" 而非"单次满足"**。N 取经验值(此处 5).

**F12. `REMOTE_REVIEW_TIMEOUT_MS = 30 * 60 * 1000`——和 OAuth token 寿命对齐**

30 分钟. 跟 ultraplan 一样,**故意对齐 OAuth access token 默认过期时间**.

**抄作业**:**所有 long-running 远端任务的超时上限 ≤ 凭据过期时间**。否则跑到一半 token 过期,结果回不来.

**F13. `FlushGate` 保证"history 完整下发后才允许 live 消息进入"**

worker 启动时:
1. 先把 history 全部 flush 给 worker(`messages: [hist1, hist2, ...]`).
2. **关上 gate**,期间 live 消息暂存在 queue.
3. worker 确认收到 history (`history_received` ack).
4. **打开 gate**,queue 里的 live 消息一次发完.
5. 之后 live 消息直接通过.

为啥?**worker 必须先看完历史才能正确处理 live**。如果 live 比 history 早到,worker 用"残缺的 context"回 message → 答错.

**抄作业**:**replay + live 两路流要有 gate 节点**。先放 replay,关 gate,确认完成,开 gate,放 live。

**F14. `double-bump epoch` 防 laptop wake 时 race claim**——原子声明任务所有权

笔记本合盖 → 开盖,本地的轮询任务以为"轮询失败了",但服务端可能正在被另一个 client claim.

设计:每次 claim 任务时 epoch++,**两次 bump**:

```ts
async function claimTask(taskId) {
  const epoch1 = ++localEpoch
  await api.claim(taskId, epoch1)
  const epoch2 = ++localEpoch  
  const ack = await api.confirm(taskId, epoch2)
  if (ack.epoch !== epoch2) throw new Error('lost claim race')
}
```

服务端只接受最高 epoch 的 claim. **双 bump 保证 claim+confirm 是原子的**——中间被另一 client 插队会立刻被察觉.

**抄作业**:**多客户端竞争同一资源时,用单调 epoch + 双确认**。比锁/lease 简单,比纯乐观锁安全.

**F15. `CCR archive` 5 bucket telemetry**——按 archive 大小分桶

把"远端任务的 work archive"(代码/diff/output)按大小分桶上报: <10KB / <100KB / <1MB / <10MB / >10MB.

理由:**单一中位数掩盖 long tail**. 分桶能看到"99% 任务 <100KB,但 1% >10MB"——后者才是性能瓶颈.

**抄作业**:**性能指标按 size/duration 分桶,不要只报 mean**。p50/p95/p99 + bucket 分布才能看清真实分布.

### 11.3 cleanup 与生命周期(10 个新发现 — 这是 F26 经典)

**F16. `finally cleanup checklist` 10 项,缺一项就泄漏**

任何 LocalAgentTask 退出时(无论 success/error/kill),`finally` 块必须执行:

```ts
finally {
  1. unregisterMessageHandler(taskId)       // 取消监听
  2. abortController.abort()                  // 中断网络
  3. await closeOutputFile(outputPath)        // flush + close fd
  4. removeTaskFromRegistry(taskId)           // 注册表删
  5. unmountUIRow(taskId)                     // UI 卸载
  6. flushTelemetry(taskId)                   // 埋点
  7. await releaseWorktree(taskId)            // worktree 清理
  8. await releaseRemoteSession(taskId)       // 远端 session 释放
  9. clearPermissionContext(taskId)           // 权限清
  10. removeBackgroundOutputListener(taskId) // 后台 listener
}
```

**这 10 项必须全部独立 try/catch**——其中一个抛错不能阻止后面的执行.

**抄作业**:**任何"持有外部资源"的 task,退出时 cleanup 必须有完整清单 + 各项独立 try/catch**。一项漏 = 一种泄漏(文件描述符、内存、远端 session、worktree...).

**F17. `cleanup orderly even on SIGKILL`**——通过 IPC 触发父代 cleanup

如果子进程被 `SIGKILL`(无法捕获),如何确保 cleanup?

设计:父进程监控所有子进程的 PID,**子 PID 消失时立刻代为执行 cleanup**.

```ts
process.on('exit', (childPid) => {
  for (const taskId of tasksOwnedByPid(childPid)) {
    runFinallyCleanup(taskId)
  }
})
```

**抄作业**:**子进程的 cleanup 不能只依赖子自己执行**——SIGKILL 拿不到。父代执行 cleanup 才完整.

**F18. UI unmount 和 task 注销分离**——UI 可能先消失但 task 还在跑

用户切换屏幕 → UI row unmount → **task 还在跑**。如果 UI unmount 触发 cleanup → task 被误杀.

修法:UI unmount 只清自己的 UI state,**task lifecycle 独立**.

```ts
// UI row 的 cleanup
useEffect(() => () => {
  // 只清 UI 相关
  clearLocalUIState(taskId)
  // 不调 stopTask!
}, [])
```

**抄作业**:**UI 和 task 是两个 lifecycle,unmount UI ≠ kill task**。否则用户切屏就杀任务,坑爆.

**F19. `stopTask` 是幂等的**——多次 stop 同一 task 不报错

用户可能点 stop 按钮两次,或自动化脚本 race,**stopTask(taskId) 第二次调用必须无害**.

```ts
function stopTask(taskId) {
  const task = registry.get(taskId)
  if (!task) return  // 已经 stop 了
  if (task.status === 'stopped') return  // 同上
  // 真正 stop
}
```

**抄作业**:**所有"关闭/释放"类操作必须幂等**。`close()` 调多次,`delete()` 调多次,都不该 throw.

**F20. backgrounded task 的输出**通过 `<background-task-result>` xml 标签注入下一轮 user message

不是用中断 / 不是 push 通知,而是**塞进下一次 user 发消息时的 system reminder**:

```xml
<background-task-result>
<task-id>abc123</task-id>
<status>completed</status>
<summary>5 files updated</summary>
</background-task-result>

[用户实际输入的 prompt]
```

这是 M14 第一节就讲过的设计,这里补一个细节:**xml 标签是 LLM 可解析的"半结构化"**——既能被 LLM "看见并理解",又不打断 LLM 的主流程.

**抄作业**:**后台事件通知用 xml-tag-in-next-user-message 而非中断**。这是 LLM 友好的模式.

**F21. 五种 RemoteAgent 类型共享 polling infrastructure**

`remote-agent / ultraplan / ultrareview / autofix-pr / background-pr` 都跑在同一个 `RemoteAgentTask` 类里. 只通过 `taskType` 字段区分,polling/timeout/cleanup 完全共用.

为啥统一?**5 个类型有 80% 相同行为(轮询 + 状态机 + cleanup),分 5 个 class 就是 5 倍维护**.

**抄作业**:**多个相似 task type 抽到一个基类 + 一个 type 字段**,不要为每个 type 写独立 class.

**F22. `killShellTasks` 用 process group 而非单 PID**

bash task 启动时 `setsid()` 开新进程组. kill 时:

```ts
process.kill(-pgid, 'SIGTERM')  // 注意负号 = kill 整个 group
```

为啥?**bash 启动的子进程(npm install 启动的 node, node 启动的 webpack...)都在同一 group**. kill 单 PID 只杀 bash,子进程变孤儿继续跑.

**抄作业**:**shell task kill 必须 kill process group,不能 kill PID**。Linux/Mac 用 `kill -PGID`,Windows 用 `taskkill /T`.

**F23. `kill` 后 wait 100ms 给子进程清理**——避免 race

发送 SIGTERM 后:

```ts
process.kill(-pgid, 'SIGTERM')
await sleep(100)  // 给子时间 cleanup
const stillAlive = await checkAlive(pgid)
if (stillAlive) process.kill(-pgid, 'SIGKILL')
```

100ms 不够长到用户等不及,够长到让 bash 做完 trap cleanup.

**抄作业**:**SIGTERM → wait → SIGKILL 是标准退出双段**。wait 时长 100-500ms 经验值.

**F24. `cleanupRetries = 3`**——cleanup 自己也要重试

某些 cleanup 操作(closeOutputFile / releaseWorktree)可能因临时 IO 错误失败. 包一层重试:

```ts
for (let i = 0; i < 3; i++) {
  try { await op(); break }
  catch (e) { if (i === 2) logButContinue(e); else await sleep(100 * (i+1)) }
}
```

最后一次失败 log 但不抛——cleanup 不能阻止主流程退出.

**抄作业**:**cleanup 操作也要有 retry,但最终 catch 不抛**。"清理失败"不该让用户卡死.

**F25. 退出前 flush telemetry 用 `process.on('beforeExit', ...)`**

不是 `process.on('exit', ...)`(已经太晚,await 不能用). 用 `beforeExit`:

```ts
process.on('beforeExit', async () => {
  await flushTelemetry()
})
```

**抄作业**:**Node 程序退出前要 async 操作,用 `beforeExit` 不是 `exit`**。这是常见踩坑.

### 11.4 SendMessage 协议(8 个新发现)

**F26. `<bare>` / `*` / `uds:` / `bridge:` 四种 target scheme,各有 routing 规则**

```
SendMessage(target: 'agent-name')        // bare = 同会话内同名 agent
SendMessage(target: '*')                  // 广播给所有同会话 agent
SendMessage(target: 'uds:/path/sock')     // 跨进程 UDS
SendMessage(target: 'bridge:peer-id')     // 跨机 bridge(IPC over M10)
```

不同 scheme 路由完全不同(参见 §9.4 第 3 条):
- `<bare>` → 本地 registry lookup
- `*` → broadcast registry iterate
- `uds:` → Unix domain socket connect
- `bridge:` → M10 bridge IPC

**抄作业**:**消息路由用 URI scheme prefix 而非 enum**。可扩展(将来加 `https:` `s3:` 都不破现有),且自带"协议"含义.

**F27. `safetyCheck` 在 SendMessage 协议层强制,不能 skip**

SendMessage 调用前必须过 safetyCheck. 任何 `dangerously-skip-permissions` flag 在 SendMessage 路径上都被**忽略**.

理由:**dangerously-skip 是同进程 trust 的延伸**。跨进程/跨机器,**对方进程的 trust state 不可知**,必须强制安全检查.

**抄作业**:**跨边界的工具调用,任何 trust bypass flag 都失效**。Trust 不能跨边界传递.

**F28. `BroadcastOutput` 包含 `delivered_to` 数组**——告诉调用者实际送达了哪些 agent

`SendMessage(target: '*')` 返回:

```json
{
  "type": "broadcast",
  "delivered_to": ["agent-a", "agent-b"],
  "failed": [{ "name": "agent-c", "reason": "not_subscribed" }]
}
```

为啥重要?**LLM 需要知道"我喊了一声,谁听到了"**才能正确推理. 全部成功 vs 部分失败 vs 完全失败,响应方式完全不同.

**抄作业**:**broadcast 类操作必须返回详细的 per-target 结果**,不能只返 "OK".

**F29. `RequestOutput` 强制要求 timeout**——避免无限挂

```ts
SendMessage({ target: 'agent-a', expectResponse: true, timeout: 30_000 })
```

`expectResponse=true` 时 `timeout` 是必填. 不传则 throw `MissingTimeoutError`.

**抄作业**:**任何"等回复"的远程调用必须有 timeout 且必填**,默认值绝不要设. 强制每个调用方思考"我能等多久".

**F30. `<task-id>` 等 xml tag 用 `TASK_ID_TAG` 常量定义**——所有 emit/parse 共用

```ts
export const TASK_ID_TAG = 'task-id'
export const TOOL_USE_ID_TAG = 'tool-use-id'
// ...

emit(`<${TASK_ID_TAG}>${id}</${TASK_ID_TAG}>`)
parse(text, TASK_ID_TAG)
```

为啥?**改 tag 名只需改一处**。两处不一致 → 永远 parse 不到,debug 一周.

**抄作业**:**任何 wire format 的 constant 定义成 module-level const,emit 和 parse 都从这里 import**.

**F31. `StructuredMessage` 用 `shutdown_request` / `shutdown_response` / `plan_approval_response` 3 种类型**

这是 SendMessage 上层抽象的"结构化命令". 比裸 text 多一层 schema 保证.

`shutdown_request` 是 leader 给 worker 的"请你优雅退出". worker 必须回 `shutdown_response` 才算完成.

**抄作业**:**control plane 消息用 typed schema,data plane 消息可以 string**。Control 必须 strict,data 可以 loose.

**F32. coordinator 模式禁止 `*` broadcast**——避免雪崩

coordinator 已经是"分发者",再让它 broadcast → N × M 消息爆.

```ts
if (mode === 'coordinator' && target === '*') {
  throw new Error('broadcast not allowed in coordinator mode')
}
```

**抄作业**:**特殊角色 + 特殊操作的组合在调用入口拒绝**.

**F33. SendMessage 失败后 `auto_retry: false`**——不要默认重试

跨进程 SendMessage 失败 → **不要默认重试**. LLM 可能在等结果,重试会乱序.

```ts
SendMessage({ ..., auto_retry: false })  // 默认
```

需要重试由调用方显式声明 + 提供 idempotency key.

**抄作业**:**远程消息默认不重试**。重试是调用方的决定,不是基础设施的"善意".

### 11.5 内置 agent 细节(6 个新发现)

**F34. `statuslineSetup` 是 "用 sub-agent 实现配置" 的范例**

`/statusline` 命令不是弹复杂表单,而是启动 statuslineSetup agent:
- 工具:`Read`, `Edit`
- 让 LLM 理解用户描述("我想要 git 分支 + cpu") + 编辑 settings.json

**抄作业**:**配置类操作可以委托 sub-agent**,不一定写复杂 UI. 一个 LLM 比 100 个 checkbox 灵活.

**F35. `claudeCodeGuide` agent 检查 conversation 中是否有已 running 的同类 agent**

```ts
// 主路径在 Agent tool 描述里:
// "Before spawning a new agent, check if there is already a running or recently completed claude-code-guide agent that you can continue via SendMessage."
```

避免每次问"Claude Code 怎么用 X"都启一个全新 agent. 同会话内已有 → 复用 + SendMessage 续问.

**抄作业**:**重型 agent 应该 reusable**,主 LLM 在 prompt 里被指引"先 check 再 spawn".

**F36. `verificationAgent` 用于"主 LLM 完成后,二次验证结果"**

```
主 LLM 改了 5 个文件 → completion
→ spawn verificationAgent
→ 该 agent 重新 build/test,看是否真的过了
→ 把验证结果反馈给主 LLM
```

为啥?**LLM 自己声称"测试通过"经常是幻觉**。让独立 agent 跑一遍是 ground truth.

**抄作业**:**关键操作(test, build, deploy)的完成判定不能信主 LLM**, 派独立 agent 验证.

**F37. `Explore` agent 只读工具白名单**——`Glob, Grep, Read, WebFetch, WebSearch`

不让 Explore 改任何东西. 即使 LLM 试图调 Edit/Write/Bash,工具列表里没有 → 直接 fail.

**抄作业**:**只读 agent 的工具白名单要"工具不存在",不要"工具存在但拒绝执行"**。前者错误信息更清晰,且杜绝 race.

**F38. `Plan` agent 完成后 Permission 自动 reset 为 `default`**

Plan agent 跑在 `plan` mode(不允许 Write/Edit). 完成后**主 LLM 接管时 mode 自动重置**——这样主 LLM 实施 plan 时不被 plan mode 限制.

**抄作业**:**short-lived 高限制 mode 退出时自动 reset**, 不要让用户/调用方记得手动 unset.

**F39. `GeneralPurpose` agent 工具 `*`(全部)**——但 isolation 配置要求 `worktree`

```ts
agentDef = {
  type: 'general-purpose',
  tools: '*',
  isolation: 'worktree',  // ← 强制
}
```

为啥?**有 `*` 工具的 agent 风险大,必须在隔离环境跑**。isolation 在 frontmatter 里就强制,不是 runtime 检查.

**抄作业**:**高权限 agent 的隔离要求写在定义里,不在运行时检查**。声明式 > 命令式.

### 11.6 AgentTool/UI 细节(5 个新发现)

**F40. AgentTool UI row 用 `effectiveType` 而非 `requestedType` 显示**

用户调 `Agent({ subagent_type: 'general-purpose' })`. 但 routing 可能把它路由到 `Explore`(因为请求看起来是 read-only). UI 显示 `Explore` 而非 `general-purpose`——**反映真实执行**.

**抄作业**:**UI 显示"实际发生的" 不是"请求的"**. 用户需要看真相,不是输入的回声.

**F41. progress message 100ms 节流**——避免 UI 刷爆

agent 跑 tool 时每条都 emit progress. 主 UI 100ms 节流:

```ts
const throttledUpdate = throttle(updateAgentRow, 100)
```

少于 100ms 用户感知不到差异,100ms 节流后渲染压力降 10 倍.

**抄作业**:**任何 high-freq UI 更新要节流到 60-100ms**, 超过用户感知不到.

**F42. agent row 高度自适应**——根据 progress 内容长度

```tsx
<Box height={Math.min(20, lineCount(progress))}>
  <Progress />
</Box>
```

最多 20 行(防屏满). 短的就紧凑,长的就展开到 20.

**抄作业**:**dynamic 内容的 UI 容器要有 cap**,否则一行 stack trace 就把屏占满.

**F43. agent failure 显示**保留最后 3 行 stderr

agent 失败时不是显示"Failed",而是:

```
✗ Explore agent failed
  ...
  Error: file not found
  at search.ts:42
  at agent.tsx:18
```

**最后 3 行**——通常包含关键错误信息,前面是堆栈噪音.

**抄作业**:**错误显示截尾 N 行,不要从头**。错误信息通常在末尾,堆栈在前面.

**F44. agent UI row 支持 collapse**——按数字键 + 行号

如果 progress 太多(20+ 行),用户可以按"3" 把第 3 个 agent row 折叠. 内容存在,只是显示折叠.

**抄作业**:**多 agent 并发时 UI 必须支持折叠**。否则 5 个并发 agent 各自吐 20 行,屏幕完全炸.

### 11.7 invariants(7 条)

| ID | invariant | 违反后果 |
|---|---|---|
| **AGT-1** | finally cleanup 10 项必须全部独立 try/catch 执行 | 一项失败 → 后续泄漏 |
| **AGT-2** | fork 的 FORK_PLACEHOLDER_RESULT 必须 byte-exact | prompt cache miss,启动 100x 慢 |
| **AGT-3** | resumeAgent 要求 transcript self-contained,sysprompt 内联 | resume 行为漂移 |
| **AGT-4** | worker JWT 不继承父 env-var | MCP 转发时 master JWT 泄漏 |
| **AGT-5** | shell task kill 必须 kill process group,不能 kill PID | 子进程变孤儿继续跑 |
| **AGT-6** | SendMessage 跨边界时所有 skip-permission flag 失效 | trust 跨边界泄漏 |
| **AGT-7** | UI unmount 不能 stopTask,二者 lifecycle 分离 | 用户切屏误杀任务 |

### 11.8 待确认(10 条)

1. `STABLE_IDLE_POLLS = 5` 这个数字是否可配置?
2. `FORK_DEPTH_LIMIT = 3` 是否可调?
3. `REMOTE_REVIEW_TIMEOUT_MS = 30min` 是否能 per-task 覆盖?
4. coordinator + fork 同时禁用的策略,有没有 escape hatch?
5. `bridge:` scheme 跨机时,JWT 怎么传递不泄漏?
6. agent UI row 折叠按键 "数字键" 怎么处理超 9 个 agent?(0-9 只有 10 个)
7. `verificationAgent` 失败时主 LLM 看到的反馈格式?
8. SendMessage 失败 `auto_retry: false` 时,idempotency key 怎么生成?
9. `claudeCodeGuide` 复用判断的"时效"——多久之前算"可复用"?
10. RemoteAgent 5 种 type 是否能合并成更少?(80% 共用 = 还有 20% 差异在哪?)

### 11.9 核心精髓 12 条(M14 增补版)

> **1. 判断"来源/原因"用启动时不可变标记(querySource),不要靠"父引用"。**
> **2. cache-hit 关键的占位串必须 byte-exact 常量,不做模板拼接。**
> **3. resumable 任务的 transcript 必须自包含,sysprompt 内联。**
> **4. 递归类操作 cap = p99+1,少了误伤多了挡不住 bug。**
> **5. spawn 子进程显式清环境变量并重新注入,默认 spread 是陷阱。**
> **6. "事件流是否结束" 用"连续 N 次稳定"而非"单次满足"。**
> **7. long-running 远端任务超时 ≤ 凭据过期时间。**
> **8. replay + live 两路流要有 gate 节点,先放 replay 关 gate 确认完成开 gate 放 live。**
> **9. 多客户端竞争同一资源用单调 epoch + 双确认,比锁简单比乐观锁安全。**
> **10. cleanup 列 10 项清单,每项独立 try/catch,一项失败不能阻止后续。**
> **11. UI 和 task 是两个 lifecycle,unmount UI ≠ kill task。**
> **12. broadcast 操作必须返回 per-target 详细结果,不能只返 "OK"。**
