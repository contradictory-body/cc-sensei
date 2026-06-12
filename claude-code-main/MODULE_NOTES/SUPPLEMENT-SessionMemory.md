# SUPPLEMENT — SessionMemory 子系统深读

> 补充 M06(Context Engineering) 和 M14(Subagent/Tasks)。覆盖 `src/services/SessionMemory/` 全部三文件 + 紧密关联的 `src/services/compact/sessionMemoryCompact.ts`。总行数: sessionMemory.ts(496) + sessionMemoryUtils.ts(208) + prompts.ts(325) + sessionMemoryCompact.ts(631) = ~1660 行。

---

## 一、系统职责

SessionMemory 是 Claude Code 的**会话级短期记忆系统** — 它在用户对话过程中自动、周期性地将会话要点提炼到一个 markdown 文件里，用于:

1. **Auto-compact 时替代传统 LLM 摘要** — 避免了一次昂贵的 summarization API call，直接裁剪旧 messages + 注入已有 session notes 即可
2. **Resumed session 上下文恢复** — 用户重新打开会话时，session memory 文件即为"之前做了什么"的快照
3. **Away summary** — 用户切回窗口时的简短"你离开期间…"摘要利用 session memory 作为上下文
4. **Skillify** — `/skillify` 把当前 session memory 作为分析材料，提取可复用 skill

**与 memdir 持久记忆的核心区别:**

| 维度 | Session Memory | Memdir (persistent memory) |
|------|---------------|----------------------------|
| 生命周期 | 单次 session，文件在 session dir 内 | 跨 session，存放 ~/.claude/memory/ |
| 触发方式 | 自动(post-sampling hook) | 用户 /memory 命令或显式提及 |
| 写入者 | 后台 forked subagent | 主对话 agent |
| 注入位置 | compact 时替代摘要 / awaySummary prompt | system prompt 固定段 |
| 大小约束 | 12,000 tokens hard cap | 无硬上限，但有去重 |

---

## 二、架构（数据流向图）

```
                                      ┌─────────────────────────────┐
                                      │   GrowthBook Feature Gate   │
                                      │  tengu_session_memory       │
                                      │  tengu_sm_compact           │
                                      └──────────────┬──────────────┘
                                                     │ cached flag
                                                     ▼
┌──────────────┐   post-sampling    ┌──────────────────────────────────┐
│  Main REPL   │───────────────────▶│   extractSessionMemory()         │
│  Query Loop  │   hook fires       │   (sequential wrapper)           │
└──────────────┘   after each turn  │                                  │
                                    │  1. Gate check (cached)          │
                                    │  2. shouldExtractMemory()        │
                                    │     ├─ init threshold: 10k tok   │
                                    │     ├─ update threshold: 5k tok  │
                                    │     └─ tool call threshold: 3    │
                                    │  3. setupSessionMemoryFile()     │
                                    │  4. buildSessionMemoryUpdatePrompt│
                                    │  5. runForkedAgent()             │
                                    │     └─ canUseTool: Edit only     │
                                    │        on memory file            │
                                    └──────────────┬───────────────────┘
                                                   │ writes
                                                   ▼
                                    ┌──────────────────────────────────┐
                                    │  ~/.claude/session-memory/       │
                                    │  <session-id>/notes.md           │
                                    │                                  │
                                    │  (structured markdown template)  │
                                    └──────────────┬───────────────────┘
                                                   │ reads
                          ┌────────────────────────┼─────────────────────────┐
                          │                        │                         │
                          ▼                        ▼                         ▼
              ┌───────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
              │  autoCompact /    │  │   awaySummary.ts     │  │   skillify.ts    │
              │  /compact command │  │   (while-you-were-   │  │   (session →     │
              │                   │  │    away card)        │  │    skill export) │
              │  trySessionMemory │  └──────────────────────┘  └──────────────────┘
              │  Compaction()     │
              │  ├─ wait extract  │
              │  ├─ read content  │
              │  ├─ truncate      │
              │  ├─ calculate     │
              │  │  messages      │
              │  │  to keep       │
              │  └─ emit result   │
              └───────────────────┘
```

---

## 三、关键设计决策（每个决策配代码片段）

### 3.1 双阈值触发 — token AND tool_call 联合门控

```typescript
// sessionMemory.ts:168
const shouldExtract =
  (hasMetTokenThreshold && hasMetToolCallThreshold) ||
  (hasMetTokenThreshold && !hasToolCallsInLastTurn)
```

**原因**: 单靠 token 增长会在大量阅读文件时过频触发；单靠 tool call 计数在短对话中不够。两者相与 + "自然断点"(无 tool call 的回合)作为 fallback，平衡了频率与时效。

### 3.2 Forked Subagent — 隔离执行 + 权限最小化

```typescript
// sessionMemory.ts:318-325
await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams: createCacheSafeParams(context),
  canUseTool: createMemoryFileCanUseTool(memoryPath),
  querySource: 'session_memory',
  forkLabel: 'session_memory',
  overrides: { readFileState: setupContext.readFileState },
})
```

**决策**: subagent 只允许 `FileEditTool` 且只能操作那一个 memory 文件 — 防止记忆提取时意外修改用户代码。通过 `createSubagentContext` 隔离 readFileState，不污染主 agent 的文件缓存。

### 3.3 sequential() 包装 — 防止并发提取

```typescript
// sessionMemory.ts:272
const extractSessionMemory = sequential(async function (context) { ... })
```

同一时刻只允许一次提取在进行。若上一次还没完成，新触发会排队等待。

### 3.4 非阻塞 Feature Gate — 用 CACHED_MAY_BE_STALE

```typescript
// sessionMemory.ts:81
function isSessionMemoryGateEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_session_memory', false)
}
```

GrowthBook SDK 初始化可能滞后于首次 query；用 cached 值确保 hook 注册不阻塞启动。

### 3.5 Session Memory Compact — 用记忆替代 LLM 摘要

```typescript
// sessionMemoryCompact.ts:437-503 (createCompactionResultFromSessionMemory)
const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(sessionMemory)
let summaryContent = getCompactUserSummaryMessage(truncatedContent, true, transcriptPath, true)
```

传统 compact 需要一次 API call 生成摘要；SM compact 直接将已有 session notes 作为摘要注入，节省了 30-60s 和数千 tokens 的 API 消耗。

### 3.6 Per-section 截断防溢出

```typescript
// prompts.ts:9
const MAX_SECTION_LENGTH = 2000
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000
```

每个 section 不超 2000 tokens，总量不超 12000 tokens。超限时 prompt 里加入 CRITICAL 警告要求 subagent 精简。在 compact 注入时再做一次物理截断(`truncateSessionMemoryForCompact`)防止失控的 session memory 吃掉 post-compact token 预算。

### 3.7 自定义 Template + Prompt 支持

```typescript
// prompts.ts:86-128
// Template: ~/.claude/session-memory/config/template.md
// Prompt:   ~/.claude/session-memory/config/prompt.md
```

用户可覆盖默认模板和提取 prompt。变量替换用 `{{varName}}` 语法，单 pass 替换避免 `$` 反向引用和双重替换 bug。

---

## 四、Session Memory 的生命周期（创建 → 更新 → 压缩 → 持久化 → 恢复）

### Phase 1: 初始化注册

```
setup.ts:294 → initSessionMemory()
  └── 若非 remote mode 且 autoCompact enabled
      └── registerPostSamplingHook(extractSessionMemory)
```

此时仅注册 hook，不做任何 I/O。Feature gate 在 hook 实际触发时才检查。

### Phase 2: 首次触发 (init threshold)

- 每次 API 响应后 hook 被调用
- 检查 `tokenCountWithEstimation(messages) >= 10,000`
- 首次达标后标记 `sessionMemoryInitialized = true`
- 之后切换到 update threshold 逻辑

### Phase 3: 周期性提取 (update threshold)

触发条件 (同时满足):
1. Context 增长 >= 5,000 tokens since last extraction
2. Tool calls since last update >= 3 **或** 当前最后一轮无 tool call (自然断点)

触发后:
1. `setupSessionMemoryFile()` — 确保目录和文件存在(首次写入模板)
2. `buildSessionMemoryUpdatePrompt()` — 读取当前内容 + 组装提取 prompt + 超限提醒
3. `runForkedAgent()` — 独立 agent 用 Edit tool 更新 notes.md

### Phase 4: Compact 时消费

当 auto-compact 或 `/compact` 触发时:
1. `waitForSessionMemoryExtraction()` — 等当前提取完成(15s timeout, 1min stale 阈值)
2. `getSessionMemoryContent()` — 读文件
3. `isSessionMemoryEmpty()` — 若还是空模板则 fallback 到传统 compact
4. `calculateMessagesToKeepIndex()` — 从 `lastSummarizedMessageId` 开始向前扩展，保证 >=10k tokens 且 >=5 个含文本消息
5. `createCompactionResultFromSessionMemory()` — 生成 CompactionResult，注入 summary + 保留的尾部消息

### Phase 5: 恢复 (Resumed Session)

若 `lastSummarizedMessageId` 不存在但 session memory 文件有内容(resumed session):
- `lastSummarizedIndex` 设为 `messages.length - 1`
- 效果: 不保留任何消息(因为全是"旧"的)，用 session memory 作为完整摘要

### Phase 6: 手动触发

`/summary` 命令调用 `manuallyExtractSessionMemory()`，绕过阈值检查直接执行一次提取。

---

## 五、Prompt 设计分析

### 5.1 提取 Prompt 的核心策略

```
1. 明确排除自身 — "This message is NOT part of the actual user conversation"
2. 结构保持 — 绝不允许修改 section header 和 italic description
3. 只更新实际内容 — 严格定义何为 "content" vs "template"
4. 信息密度要求 — "Write DETAILED, INFO-DENSE content ... include specifics"
5. 大小约束 — 每 section ~2000 tokens 上限
6. Current State 优先 — "IMPORTANT: Always update Current State"
7. 避免重复 — "Do not include information that's already in the CLAUDE.md"
8. 并行 Edit — "make all Edit tool calls in parallel in a single message"
```

### 5.2 模板设计 (9 个固定 section)

| Section | 用途 | 为何重要 |
|---------|------|----------|
| Session Title | 5-10 字概述 | 人类快速辨识 session |
| Current State | 当前工作进展 | compact 后恢复的第一手线索 |
| Task specification | 原始需求 | 长 session 后不忘初衷 |
| Files and Functions | 关键文件 | 减少重复 file search |
| Workflow | 常用命令 | 复现执行序列 |
| Errors & Corrections | 失败经验 | 防止重蹈覆辙 |
| Codebase and System Documentation | 系统结构 | 理解上下文 |
| Learnings | 经验法则 | 隐性知识显性化 |
| Key results | 完整输出 | 用户要的精确结果不丢失 |
| Worklog | 步骤流水 | 审计 + 恢复上下文链 |

### 5.3 超限处理 prompt 追加

当 total > 12,000 tokens 时追加:
```
CRITICAL: The session memory file is currently ~N tokens, which exceeds the maximum of 12000 tokens.
You MUST condense the file to fit within this budget. Aggressively shorten oversized sections...
Prioritize keeping "Current State" and "Errors & Corrections" accurate and detailed.
```

体现了**信息优先级排序**: 当前状态 > 错误记录 > 其他。

---

## 六、「自己写 Agent」可直接抄的设计原则

### 原则 1: 后台非阻塞提取

SessionMemory 不在主对话流里做提取 — 它注册 post-sampling hook，在 API 响应完成后异步触发。用户感知不到延迟。

**可抄**: 任何 agent 的 "反思/记忆" 环节应该是后台任务，不阻塞主交互循环。

### 原则 2: 权限最小化的 Subagent

forked agent 的 `canUseTool` 仅允许 Edit 一个文件。即使 subagent 被 prompt inject，也无法操作其他文件。

**可抄**: 所有 subagent 必须有明确的工具白名单，不继承主 agent 的全部权限。

### 原则 3: 双阈值避免过频/过稀

token 增长 + tool call 计数双门控。单一指标总有退化场景(大文件读取 vs 纯文本对话)。

**可抄**: 触发逻辑用多指标 AND，加一个 "自然断点" fallback。

### 原则 4: 结构化模板 + 约束 prompt

不让 LLM 自由发挥记忆格式 — 给定固定 section 结构，只允许填充内容区。

**可抄**: 任何 LLM 写入的"状态文件"都应有固定骨架，只让 LLM 填肉。

### 原则 5: 渐进式启用(lazy gate + memoized config)

Feature gate 在 hook 实际运行时才检查，config 用 memoize 只加载一次。启动路径零阻塞。

**可抄**: Agent 系统的可选功能应 lazy init，不拖慢冷启动。

### 原则 6: 记忆消费与生产解耦

生产(提取)和消费(compact/awaySummary/skillify)通过文件系统解耦。消费方只需 `getSessionMemoryContent()` 读文件，不依赖提取进程的内存状态。

**可抄**: agent 各组件间通过持久化中间产物(文件/DB)通信，不共享内存引用。

### 原则 7: Graceful Degradation

- Session memory 为空 → fallback 到传统 compact
- 提取超时(15s) → 放弃等待继续 compact
- 提取卡住(1min stale) → 视为无效
- Feature gate off → 静默跳过
- 远程 config 不可用 → 用本地默认值

**可抄**: 每个增强功能都必须有完整的 fallback 路径。

### 原则 8: 物理截断作为最后防线

即使 prompt 要求 LLM 精简，仍在注入 compact 时做硬截断(`truncateSessionMemoryForCompact`)。不信任 LLM 一定遵守约束。

**可抄**: 对 LLM 输出的大小约束要有程序化硬兜底，不能只靠 prompt。

---

## 七、与 MODULE_NOTES 其他章节的关联

| 关联章节 | 关联点 |
|----------|--------|
| M01 (Bootstrap) | `setup.ts:294` 在 bootstrap 尾部注册 session memory hook |
| M02 (Agent Loop) | post-sampling hook 在主循环每次 API 响应后触发 |
| M03 (Tool System) | 提取 subagent 使用 `FileEditTool` + `FileReadTool`；`canUseTool` 做白名单 |
| M06 (Context Engineering) | 核心关联 — session memory 是 context 生命周期管理的关键组件 |
| M14 (Subagent/Tasks) | `runForkedAgent` 创建隔离 subagent 执行提取 |
| M17 (Config) | 通过 GrowthBook dynamic config (`tengu_sm_config`) 远程调参 |
| M18 (Telemetry) | 大量 `logEvent('tengu_session_memory_*')` 用于追踪频率和效果 |
| SUPPLEMENT-AgentSummary-MagicDocs | 关注 compact 中 summary 的生成方式 — SM compact 是其替代方案 |

---

> **文件清单:**
> - `src/services/SessionMemory/sessionMemory.ts` — 主逻辑(hook 注册、触发判断、提取执行)
> - `src/services/SessionMemory/sessionMemoryUtils.ts` — 无依赖工具函数(状态管理、文件读取、阈值判断)
> - `src/services/SessionMemory/prompts.ts` — 模板、提取 prompt、section 分析、截断
> - `src/services/compact/sessionMemoryCompact.ts` — SM compact 策略(消费侧)
> - `src/services/compact/autoCompact.ts` — 调用 `trySessionMemoryCompaction` 的主入口
> - `src/commands/compact/compact.ts` — `/compact` 命令中的 SM compact 尝试
> - `src/services/awaySummary.ts` — away summary 消费 session memory
> - `src/skills/bundled/skillify.ts` — `/skillify` 消费 session memory
> - `src/setup.ts:294` — 注册入口
