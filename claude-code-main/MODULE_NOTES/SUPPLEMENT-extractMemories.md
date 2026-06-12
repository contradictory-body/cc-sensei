# SUPPLEMENT — extractMemories 子系统深读

> 补充 M06(Context Engineering) / M14(Subagent Tasks) 中未展开的「自动记忆提取」后台子系统。
> 范围：
> - `src/services/extractMemories/extractMemories.ts`（616 行）— 提取逻辑 + 闭包状态 + 工具权限
> - `src/services/extractMemories/prompts.ts`（155 行）— 提取 Prompt 模板
> - `src/memdir/memoryTypes.ts`（272 行）— 记忆分类体系 + 保存/不保存规则
> - `src/memdir/memoryScan.ts`（95 行）— 目录扫描 + manifest 格式化
> - `src/memdir/paths.ts`（278 行）— 路径解析 + 启用判断
>
> 总计约 1416 行源码逐行通读。

---

## 一、系统职责

extractMemories 是一个**后台记忆提取子系统**：在用户每次对话 turn 结束时（model 产出最终回复、无 tool call），自动从对话上下文中提取"持久记忆"并写入 memdir 目录（`~/.claude/projects/<sanitized-path>/memory/`）。

核心目标：**让 Claude 在跨 session 场景下"记住"用户偏好、项目背景、纠正反馈等不可从代码推导的信息，无需用户手动 `/remember`。**

它与主 Agent 的记忆写入互斥——当主 Agent 自己写了 memory 文件时，后台提取 skip 当轮；当主 Agent 没写时，后台捕获遗漏。

---

## 二、架构（触发时机 → 提取流程 → 写入 memdir）

```
用户消息 → 主 Agent 推理 → 最终响应(无 tool_use)
                                     ↓
                              stopHooks.ts: handleStopHooks()
                                     ↓
                    ┌─ feature('EXTRACT_MEMORIES') gate ─┐
                    │ isExtractModeActive()              │
                    │ !toolUseContext.agentId (仅主线程) │
                    │ !isBareMode()                     │
                    └───────────────────────────────────┘
                                     ↓ fire-and-forget
                    executeExtractMemories(context, appendSystemMessage)
                                     ↓
                    executeExtractMemoriesImpl() [闭包内]
                                     ↓
                    ┌─ 前置 guard ──────────────────────┐
                    │ 1. agentId 非空 → return           │
                    │ 2. tengu_passport_quail=false → return │
                    │ 3. !isAutoMemoryEnabled() → return │
                    │ 4. getIsRemoteMode() → return     │
                    │ 5. inProgress → stash → return    │
                    └───────────────────────────────────┘
                                     ↓
                    runExtraction({ context, appendSystemMessage })
                                     ↓
                    ┌─ 互斥检查 ────────────────────────┐
                    │ hasMemoryWritesSince() → skip     │
                    │ (主 Agent 已写 memory → 前进游标) │
                    └───────────────────────────────────┘
                                     ↓
                    ┌─ 节流门控 ────────────────────────┐
                    │ turnsSinceLastExtraction < N      │
                    │ (tengu_bramble_lintel, 默认 1)    │
                    │ → return (每 N 个 eligible turn)  │
                    └───────────────────────────────────┘
                                     ↓
                    scanMemoryFiles(memoryDir) → existingMemories manifest
                                     ↓
                    buildExtractAutoOnlyPrompt / buildExtractCombinedPrompt
                                     ↓
                    runForkedAgent({
                      promptMessages: [用户指令 prompt],
                      cacheSafeParams,      ← 共享主对话 prompt cache
                      canUseTool,           ← 沙箱权限函数
                      querySource: 'extract_memories',
                      skipTranscript: true,
                      maxTurns: 5
                    })
                                     ↓
                    提取写入路径 → extractWrittenPaths()
                    过滤 MEMORY.md → memoryPaths
                    appendSystemMessage(createMemorySavedMessage)
                    → 主对话显示 "Saved N memories" 提示
```

### 关键时序

1. **fire-and-forget**：`executeExtractMemories` 在 stopHooks 中以 `void` 调用，不阻塞主对话循环
2. **drain 机制**：`print.ts` 在 flush 响应后、`gracefulShutdownSync` 前调用 `drainPendingExtraction()`，给 forked agent 最多 60s 完成
3. **trailing run**：如果提取过程中又有新 turn 进入，stash 最新 context，当前 run 结束后自动执行一次 trailing extraction

---

## 三、关键设计决策（每个决策配代码片段）

### 3.1 闭包隔离状态（Closure-scoped State）

所有可变状态封装在 `initExtractMemories()` 闭包内，避免模块级全局变量：

```ts
export function initExtractMemories(): void {
  const inFlightExtractions = new Set<Promise<void>>()
  let lastMemoryMessageUuid: string | undefined
  let inProgress = false
  let turnsSinceLastExtraction = 0
  let pendingContext: { context; appendSystemMessage } | undefined
  // ...
}
```

好处：测试中 `beforeEach` 调用 `initExtractMemories()` 即可获得干净状态，无需 mock 模块级变量。

### 3.2 主 Agent / 后台 Agent 互斥（Mutual Exclusion）

```ts
if (hasMemoryWritesSince(messages, lastMemoryMessageUuid)) {
  // 主 Agent 已写 memory → 前进游标、skip forked agent
  lastMemoryMessageUuid = lastMessage.uuid
  return
}
```

设计逻辑：主 Agent 的 system prompt 已有完整保存指令。当主 Agent 主动写了 memory 时，后台重复提取是冗余的。通过检查 assistant 消息中是否有 `FileEdit/FileWrite` 工具调用且目标路径在 `autoMemPath` 下来判断。

### 3.3 prompt cache 共享（Perfect Fork）

```ts
const cacheSafeParams = createCacheSafeParams(context)
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams,  // ← 复用主对话的 system prompt + 消息前缀的 cache
  // ...
})
```

`runForkedAgent` 不改变 tool list（因为 tools 是 cache key 的一部分），而是通过 `canUseTool` callback 限制权限。这保证了 prompt cache 命中率（实际日志显示 cache hit 率通常 >90%）。

### 3.4 沙箱化工具权限（`createAutoMemCanUseTool`）

```ts
export function createAutoMemCanUseTool(memoryDir: string): CanUseToolFn {
  return async (tool, input) => {
    if (tool.name === REPL_TOOL_NAME) return allow  // REPL 壳允许（内部再检查）
    if (tool.name === FILE_READ/GREP/GLOB) return allow  // 只读工具不限
    if (tool.name === BASH_TOOL_NAME) {
      if (tool.isReadOnly(input)) return allow     // 只允许只读 shell
      return deny
    }
    if ((EDIT/WRITE) && isAutoMemPath(filePath)) return allow  // 写操作仅限 memory 目录
    return deny
  }
}
```

这确保 forked agent 只能：读任意文件/grep/glob + 只读 bash + 在 memory 目录内写文件。

### 3.5 游标机制（Cursor-based Incremental Processing）

```ts
let lastMemoryMessageUuid: string | undefined
const newMessageCount = countModelVisibleMessagesSince(messages, lastMemoryMessageUuid)
```

每次成功提取后前进游标到最后一条消息的 UUID。下次只处理新增消息。如果游标对应的消息被 context compaction 删除，fallback 到计数全部可见消息（防止永久禁用提取）。

### 3.6 重叠防护 + Trailing Run（Coalescing）

```ts
if (inProgress) {
  pendingContext = { context, appendSystemMessage }  // 仅保留最新一次
  return
}
// ...
finally {
  inProgress = false
  if (pendingContext) {
    await runExtraction({ ...pendingContext, isTrailingRun: true })
  }
}
```

并发调用不会叠加，只保留最新 context。当前 run 结束后自动执行 trailing run——保证不丢消息、不浪费 API 调用。

### 3.7 maxTurns 硬上限

```ts
maxTurns: 5
```

防止提取 agent 陷入"验证兔子洞"（去读源码确认 pattern 是否存在）。典型提取只需 2-4 turn（read existing → write new）。

---

## 四、提取 Prompt 分析（提取什么/不提取什么的规则）

### 4.1 Prompt 结构

`buildExtractAutoOnlyPrompt` 由三段组成：

1. **opener** — 角色声明 + 工具清单 + 效率策略 + 范围约束
2. **TYPES_SECTION_INDIVIDUAL** — 四类记忆分类法
3. **WHAT_NOT_TO_SAVE_SECTION** — 禁止保存列表
4. **How to save memories** — 操作步骤（skipIndex 模式跳过 MEMORY.md 索引）

### 4.2 四类记忆分类法

| 类型 | 用途 | 示例 |
|------|------|------|
| `user` | 用户角色/目标/知识/偏好 | "用户是数据科学家，首次接触 React" |
| `feedback` | 用户纠正 + 确认的工作方式 | "不要 mock 数据库""PR 合成一个" |
| `project` | 项目动态（时间敏感、不可从代码推导） | "周四开始合并冻结" |
| `reference` | 外部系统指针 | "pipeline bug 在 Linear INGEST 项目" |

### 4.3 禁止保存的内容（WHAT_NOT_TO_SAVE_SECTION）

- 代码模式/架构/文件路径/项目结构（可从代码推导）
- Git history / who-changed-what（`git log` 可查）
- Debug 解决方案/修复配方（commit message 有）
- CLAUDE.md 已有内容
- 临时任务状态 / 当前对话上下文
- **即使用户明确要求保存 PR 列表/活动摘要也不保存**——要求追问"什么是 surprising/non-obvious 的"

### 4.4 效率指令

```
You have a limited turn budget. FileEdit requires a prior FileRead...
the efficient strategy is: turn 1 — all FileRead in parallel;
turn 2 — all FileWrite/FileEdit in parallel.
```

同时：
```
You MUST only use content from the last ~N messages to update your persistent memories.
Do not waste any turns attempting to investigate or verify that content further —
no grepping source files, no reading code to confirm a pattern exists, no git commands.
```

### 4.5 去重机制

两层去重：
1. **Prompt 注入 existing manifest**：`scanMemoryFiles()` 扫描现有文件 → `formatMemoryManifest()` 格式化为文本列表注入 prompt，指令明确说 "Check this list before writing — update an existing file rather than creating a duplicate"
2. **Frontmatter description**：每个 memory 文件有 `description:` 字段，manifest 展示 type + filename + timestamp + description，帮助 agent 判断是否重复

### 4.6 Team Memory 模式

当 `feature('TEAMMEM')` 启用时，使用 `buildExtractCombinedPrompt`：
- 每个 type 增加 `<scope>` 标签（private/team）
- user 类型始终 private
- feedback 默认 private，项目级公约才 team
- project/reference 偏向 team
- 额外约束："MUST avoid saving sensitive data within shared team memories"

---

## 五、与 memdir / SessionMemory / MagicDocs 的关系

### 5.1 与 memdir 的关系

```
memdir（基础设施层）
├── paths.ts          — 提供 getAutoMemPath / isAutoMemPath / isAutoMemoryEnabled
├── memoryScan.ts     — 提供 scanMemoryFiles / formatMemoryManifest
├── memoryTypes.ts    — 提供分类体系 + prompt 片段
├── memdir.ts         — 提供 buildMemoryPrompt（注入 system prompt 的 recall-side）
└── findRelevantMemories.ts — query-time 检索（recall side）

extractMemories（写入层）
└── 唯一职责：将对话中的隐式知识 → 写入 memdir 中的 .md 文件
```

extractMemories 是 memdir 的"写入端"，而 `findRelevantMemories` + `buildMemoryPrompt` 是"读取端"。

### 5.2 与 SessionMemory 的区别

| 维度 | extractMemories | SessionMemory |
|------|----------------|---------------|
| 持久性 | 跨 session 永久存储 | 当前 session 内临时笔记 |
| 存储位置 | `~/.claude/projects/<path>/memory/` | session-scoped 文件 |
| 触发方式 | 每 turn 结束 | 周期性（满足 token 阈值） |
| 内容 | 用户偏好/反馈/项目动态 | 当前任务进展/中间结论 |
| 用途 | 未来 session recall | 当前 session context 压缩替代 |

### 5.3 与 autoDream 的关系

- `autoDream` 是记忆**整合/蒸馏**层（类似睡眠中的记忆巩固）
- 触发条件不同：time-gate + session 数量阈值
- 复用 `createAutoMemCanUseTool` 共享沙箱权限逻辑
- extractMemories 是"碎片写入"，autoDream 是"周期性清理/合并/精简"

### 5.4 与 MagicDocs 的关系

MagicDocs 是另一个后台 fork 系统，但面向 CLAUDE.md 的自动更新（code pattern、架构 doc），属于"可从代码推导"的内容。extractMemories 明确禁止保存这类内容——两者互补不重叠。

---

## 六、「自己写 Agent」可直接抄的设计原则

### 6.1 Forked Agent 模式（共享 prompt cache 的后台子任务）

```ts
runForkedAgent({
  promptMessages: [单一用户消息指令],
  cacheSafeParams,        // 主对话 system prompt + messages 前缀的 cache 快照
  canUseTool,             // 沙箱化权限 callback（不改 tool list → 不破坏 cache key）
  skipTranscript: true,   // 不写入主 transcript → 避免竞态
  maxTurns: N,            // 防止失控
})
```

**核心优势**：子任务复用主对话 90%+ 的 cache，避免为后台任务重新填充 context window。

### 6.2 闭包隔离 + 单例初始化

```ts
let extractor: Function | null = null
export function init(): void {
  // 所有可变状态在闭包内
  let cursor, inProgress, pending
  extractor = async (ctx) => { ... }
}
export async function execute(ctx): Promise<void> {
  await extractor?.(ctx)
}
```

### 6.3 Coalescing Pattern（合并并发请求）

当后台任务可能被频繁触发但每次执行成本高时：
- 第一个请求执行
- 后续请求 stash（仅保留最新）
- 执行完毕后 run trailing
- 保证：不丢最新状态、不并发竞争、不浪费 API 调用

### 6.4 Mutual Exclusion with Primary Agent

后台 agent 和主 agent 做同一件事（写 memory）时，需要互斥：
- 检测主 agent 是否已完成该操作
- 如果已完成 → skip + advance cursor
- 如果未完成 → 后台补位

### 6.5 工具权限沙箱（不改 tool list，用 callback 限制）

保持 tool list 不变（维持 cache key 一致），通过 `canUseTool` 动态限制：
- 只读工具无限制
- 写工具仅限特定目录
- bash 仅限 `isReadOnly` 命令

### 6.6 Pre-inject Context to Save Turns

```ts
const existingMemories = formatMemoryManifest(await scanMemoryFiles(...))
// 注入 prompt → agent 不需要花一个 turn 做 `ls`
```

在 forked agent 有 maxTurns 限制时，预注入可节省 1-2 turn。

### 6.7 Drain Pattern for Graceful Shutdown

```ts
export async function drainPendingExtraction(timeoutMs = 60_000): Promise<void> {
  await Promise.race([
    Promise.all(inFlightExtractions),
    new Promise(r => setTimeout(r, timeoutMs).unref())  // .unref() 不阻塞进程退出
  ])
}
```

在 response 已 flush 给用户后、进程退出前，给后台任务一个完成窗口。

---

## 七、与 MODULE_NOTES 其他章节的关联

| 章节 | 关联点 |
|------|--------|
| M02(Agent Loop) | `runForkedAgent` 是 queryLoop 的轻量 fork，共享 message handling 逻辑 |
| M06(Context Engineering) | extractMemories 是 context 的"写入侧"，与 `findRelevantMemories`(读取侧) 对偶 |
| M14(Subagent Tasks) | 同属 forked agent 模式，但 extractMemories 不注册为 Task、不显示 UI |
| M04(Permission Safety) | `createAutoMemCanUseTool` 是权限系统的消费者，sandbox 化 fork 的写能力 |
| M18(Telemetry) | `logEvent('tengu_extract_memories_*')` 系列埋点 |
| SUPPLEMENT-AgentSummary | 同为 `runForkedAgent` 消费者，但 AgentSummary 面向 UI 摘要而非持久存储 |
| SUPPLEMENT-teamMemorySync | Team memory 的 scope routing 逻辑在 extractMemories 的 combined prompt 中体现 |

---

> **文件清单**
> - `src/services/extractMemories/extractMemories.ts` — 主逻辑（616 行）
> - `src/services/extractMemories/prompts.ts` — 提取 prompt 构建（155 行）
> - `src/memdir/memoryTypes.ts` — 四类记忆分类 + 保存/不保存规则（272 行）
> - `src/memdir/memoryScan.ts` — 目录扫描 + manifest（95 行）
> - `src/memdir/paths.ts` — 路径 / 启用判断（278 行）
> - `src/memdir/memdir.ts` — ENTRYPOINT_NAME 定义 + buildMemoryPrompt
> - `src/query/stopHooks.ts` — 触发入口（handleStopHooks L142-153）
> - `src/cli/print.ts` — drain 入口（L967-968）
> - `src/services/autoDream/autoDream.ts` — 复用 createAutoMemCanUseTool
> - `src/services/SessionMemory/sessionMemory.ts` — 对比：session-scoped 记忆
