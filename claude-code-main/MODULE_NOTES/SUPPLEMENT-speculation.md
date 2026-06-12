# SUPPLEMENT — 投机执行子系统深读（speculation.ts + promptSuggestion.ts）

> 补充 M02 中仅提及名字但未分析的投机执行系统。
> 范围：
> - `src/services/PromptSuggestion/speculation.ts`（991 行）— 投机执行核心
> - `src/services/PromptSuggestion/promptSuggestion.ts`（523 行）— 建议生成 + 投机触发入口
> - `src/state/AppStateStore.ts` 中 `SpeculationState` / `CompletionBoundary` 类型定义
>
> 总计 1,514 行源码逐行通读。

---

## 一、系统概述：Prompt Suggestion + Speculation 二级流水线

投机执行是 Claude Code 最独特的性能优化之一，核心设计哲学是**「用户的犹豫时间是免费的计算预算」**。

### 完整流水线

```
用户 idle（等待输入）
  ↓
promptSuggestion: fork agent 预测用户下一句话 → 灰色建议文本
  ↓ (如果 speculation enabled)
speculation: 用预测的建议当真实输入，fork agent 预执行 → 积累结果
  ↓ (如果 speculation 完成)
pipelined suggestion: 在投机结果基础上再预测下下一句话
  ↓
用户 Tab 接受建议 → 直接注入投机结果，跳过执行等待
```

**三级预测**：
1. **Suggestion**：预测用户会输入什么（2-12 个词）
2. **Speculation**：假装用户已输入预测文本，预执行工具调用
3. **Pipelined Suggestion**：在投机结果基础上预测下下一步

---

## 二、`promptSuggestion.ts` — 建议生成层（523 行）

### 2.1 启用门禁：6 层过滤

```
环境变量覆盖 → GrowthBook feature flag → 非交互模式排除
→ swarm teammate 排除 → 用户设置 → 运行时状态检查
```

运行时状态检查（`getSuggestionSuppressReason`）额外排除：
- `!promptSuggestionEnabled`
- 有 pending 权限请求（worker/sandbox）
- 有 elicitation 队列
- Plan Mode 激活
- 外部用户限流中

### 2.2 建议生成：复用 prompt cache 的关键约束

```ts
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: prompt })],
  cacheSafeParams,  // 不覆盖 tools/thinking 设置 — 会打穿缓存
  canUseTool,       // 通过回调 deny，不通过 tools:[] — 会打穿缓存
  skipTranscript: true,
  skipCacheWrite: true,
})
```

**核心约束（PR #18143 教训）**：
- **不设 `maxOutputTokens`**：会导致 thinking config 不一致，打穿 prompt cache
- **不设 `effortValue`**：PR #18143 尝试 `effort:'low'` 导致缓存命中率从 92.7% 暴跌到 61%（45x cache write 暴增）
- **不传 `tools:[]`**：通过 `canUseTool` 回调 deny，而非清空工具列表——后者改变了 cache key
- **唯一安全的覆盖**：`abortController`（不发 API）、`skipTranscript`（客户端）、`skipCacheWrite`（控制 `cache_control` marker）、`canUseTool`（客户端权限检查）

**工程意义**：**任何派生/分叉调用，必须让 system prompt + tools + model + thinking 等 cache key 构成要素位级一致**。一个看似无害的 `Math.min` 防御性夹紧就能毁掉缓存。

### 2.3 父请求缓存冷检测

```ts
const MAX_PARENT_UNCACHED_TOKENS = 10_000

function getParentCacheSuppressReason(lastAssistantMessage) {
  const usage = lastAssistantMessage.message.usage
  const inputTokens = usage.input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  return inputTokens + cacheWriteTokens + outputTokens > MAX_PARENT_UNCACHED_TOKENS
    ? 'cache_cold' : null
}
```

**逻辑**：fork 会重新处理父请求的 output（永远不缓存）+ 自己的 prompt。如果父请求的 uncached 部分 > 10K tokens，说明缓存是冷的，fork 的边际成本太高，抑制建议生成。

### 2.4 Suggestion Prompt 设计

```
[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]
FIRST: Look at the user's recent messages and original request.
Your job is to predict what THEY would type - not what you think they should do.
THE TEST: Would they think "I was just about to type that"?
Format: 2-12 words, match the user's style. Or nothing.
Reply with ONLY the suggestion, no quotes or explanation.
```

**关键设计决策**：
- 预测用户意图，不是建议最佳行动——「用户会打什么」vs「应该做什么」
- 严格 2-12 词限制
- 允许沉默（无建议）
- 明确禁止评价性语言、提问、Claude 口吻

### 2.5 建议过滤器：12 条规则

| ID | 过滤条件 | 示例 |
|---|---|---|
| `done` | 裸 "done" | "done" |
| `meta_text` | 模型输出元指令 | "nothing to suggest", "stay silent" |
| `meta_wrapped` | 括号包裹的元文本 | "(silence — no obvious next step)" |
| `error_message` | API 错误泄露 | "API Error: ..." |
| `prefixed_label` | 标签前缀 | "Suggestion: run tests" |
| `too_few_words` | < 2 词（特殊白名单除外） | "hmm"（但 "yes"/"commit" 放行） |
| `too_many_words` | > 12 词 | — |
| `too_long` | ≥ 100 字符 | — |
| `multiple_sentences` | 多句 | "Fix the bug. Then run tests." |
| `has_formatting` | 含换行/Markdown | — |
| `evaluative` | 评价性语言 | "looks good", "thanks" |
| `claude_voice` | Claude 口吻 | "Let me...", "I'll...", "Here's..." |

单词白名单包含：yes/yeah/yep/sure/ok/push/commit/deploy/stop/continue/no 等常见单词输入。

### 2.6 触发投机执行

```ts
// executePromptSuggestion 尾部
if (isSpeculationEnabled() && result.suggestion) {
  void startSpeculation(
    result.suggestion, context,
    context.toolUseContext.setAppState,
    false, cacheSafeParams,
  )
}
```

建议生成成功后，`void` fire-and-forget 启动投机执行——不等待结果。

---

## 三、`speculation.ts` — 投机执行核心（991 行）

### 3.1 安全边界：工具白名单 + 写隔离

```ts
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const SAFE_READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'ToolSearch', 'LSP', 'TaskGet', 'TaskList',
])
```

**三类工具处理**：

| 类别 | 工具 | 投机中行为 |
|------|------|-----------|
| 写工具 | Edit/Write/NotebookEdit | **权限模式检查** → 允许时重定向到 overlay |
| 安全只读 | Read/Glob/Grep/LSP/... | **直接允许**（读 overlay 已修改文件） |
| Bash | Bash | **只读命令允许**，非只读 → boundary 停止 |
| 其他所有 | WebFetch/WebSearch/Agent/... | **拒绝** → boundary 停止 |

### 3.2 Copy-on-Write Overlay 文件系统

```
~/.claude/tmp/speculation/{pid}/{uuid}/
  └── (写入的文件的相对路径镜像)
```

**实现**：
1. 写工具触发时，先 `copyFile(原始文件 → overlay)`（原文件不存在则跳过——新建场景）
2. 写入重定向到 overlay 路径：`input = { ...input, [pathKey]: join(overlayPath, rel) }`
3. 读工具触发时，检查文件是否在 `writtenPathsRef` 中——已写则读 overlay，否则读原始
4. 接受投机时，`copyOverlayToMain` 把 overlay 文件复制回项目目录
5. 放弃/错误时，`safeRemoveOverlay` 递归删除 overlay

**路径安全**：
- 写入路径必须在 cwd 内（`relative(cwd, filePath)` 不能是绝对路径或 `..` 开头）
- cwd 外的读取放行，cwd 外的写入拒绝

**工程意义**：这是一个轻量级 COW 文件系统——不需要 unionfs/overlayfs 内核支持，纯用户态 `copyFile` + 路径重写实现。对自建 Agent 直接可用。

### 3.3 写工具的权限模式检查

```ts
if (isWriteTool) {
  const { mode, isBypassPermissionsModeAvailable } = appState.toolPermissionContext
  const canAutoAcceptEdits =
    mode === 'acceptEdits' ||
    mode === 'bypassPermissions' ||
    (mode === 'plan' && isBypassPermissionsModeAvailable)
  if (!canAutoAcceptEdits) {
    // → edit boundary, abort speculation
  }
}
```

**只有三种权限模式允许投机写入**：
- `acceptEdits`（自动接受编辑模式）
- `bypassPermissions`（完全绕过权限模式）
- `plan` + `isBypassPermissionsModeAvailable`（Plan 模式但底层可绕过）

默认交互模式（每次 ask 用户）→ 遇到写工具直接停止投机，标记 boundary。

### 3.4 CompletionBoundary 四种状态

```ts
type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | { type: 'denied_tool'; toolName: string; detail: string; completedAt: number }
```

- **complete**：投机正常跑完所有轮次（≤ 20 轮 / 100 条消息），带 output token 数
- **bash**：遇到非只读 bash 命令停止
- **edit**：遇到写工具但权限模式不允许自动接受
- **denied_tool**：遇到不在白名单的工具

### 3.5 SpeculationState 状态机

```ts
type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string                           // UUID 前 8 位
      abort: () => void                    // 中止回调
      startTime: number
      messagesRef: { current: Message[] }  // 可变引用，避免每条消息都 spread 数组
      writtenPathsRef: { current: Set<string> }  // overlay 中已写的相对路径
      boundary: CompletionBoundary | null  // 停止原因
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean                 // 是否是流水线投机（建议之上的建议）
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: { text, promptId, generationRequestId } | null
    }
```

**设计亮点**：`messagesRef` 和 `writtenPathsRef` 用**可变引用**而非 React 不可变状态——避免每条投机消息都触发 `setAppState` 的 O(n) 数组复制。只在有意义的时刻（toolUseCount 变化）做 `setAppState`。

### 3.6 投机执行主流程

```ts
async function startSpeculation(suggestionText, context, setAppState, isPipelined, cacheSafeParams) {
  // 1. 中止已有投机
  abortSpeculation(setAppState)

  // 2. 创建 overlay 目录
  await mkdir(overlayPath, { recursive: true })

  // 3. 设置 active state
  setAppState(prev => ({ ...prev, speculation: { status: 'active', ... } }))

  // 4. 运行 forked agent
  const result = await runForkedAgent({
    promptMessages: [createUserMessage({ content: suggestionText })],
    cacheSafeParams,
    skipTranscript: true,
    canUseTool: async (tool, input) => { /* 安全边界逻辑 */ },
    querySource: 'speculation',
    maxTurns: MAX_SPECULATION_TURNS,  // 20
    overrides: { abortController, requireCanUseTool: true },
    onMessage: msg => { /* 累积消息 + 计数工具使用 */ },
  })

  // 5. 标记完成
  updateActiveSpeculationState(setAppState, () => ({
    boundary: { type: 'complete', completedAt: Date.now(), outputTokens: ... }
  }))

  // 6. 流水线：在等待用户接受期间预生成下一条建议
  void generatePipelinedSuggestion(...)
}
```

**关键参数**：
- `MAX_SPECULATION_TURNS = 20`
- `MAX_SPECULATION_MESSAGES = 100`
- `requireCanUseTool: true` — 强制每个工具调用都走 `canUseTool` 回调

### 3.7 投机接受：消息注入 + 文件合并 + 缓存同步

```ts
async function acceptSpeculation(state, setAppState, cleanMessageCount) {
  // 1. abort 投机（如仍在跑）
  state.abort()

  // 2. 如果有 clean messages，把 overlay 文件复制回主目录
  if (cleanMessageCount > 0) {
    await copyOverlayToMain(overlayPath, writtenPathsRef.current, getCwdState())
  }

  // 3. 清理 overlay
  safeRemoveOverlay(overlayPath)

  // 4. 重置状态 + 累计会话节省时间
  setAppState(prev => ({
    ...prev,
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: prev.speculationSessionTimeSavedMs + timeSavedMs,
  }))

  return { messages, boundary, timeSavedMs }
}
```

### 3.8 消息注入清洗：`prepareMessagesForInjection`

投机产生的消息不能直接注入主对话——需要清洗：

1. **剥离 thinking/redacted_thinking block**：投机的思考过程不应污染主上下文
2. **剥离失败的 tool_use/tool_result 对**：只保留有成功结果的工具调用
3. **剥离中断消息**：`INTERRUPT_MESSAGE` / `INTERRUPT_MESSAGE_FOR_TOOL_USE`
4. **空白消息丢弃**：API 拒绝纯空白 text block（400 错误）
5. **尾部 assistant 消息裁剪**（投机未完成时）：不支持 prefill 的模型拒绝以 assistant 消息结尾的对话

**工程意义**：投机结果注入不是简单的 `messages.push(...speculationMessages)`——需要考虑 API 契约、thinking 隐私、失败工具配对、空白内容等多个维度。

### 3.9 handleSpeculationAccept：用户按 Tab 后的完整流程

```ts
async function handleSpeculationAccept(speculationState, ..., deps) {
  // 1. 清除 promptSuggestion 状态
  setAppState(prev => ({ ...prev, promptSuggestion: { text: null, ... } }))

  // 2. 捕获投机消息快照 + 清洗
  let cleanMessages = prepareMessagesForInjection(speculationMessages)

  // 3. 注入用户消息（即时视觉反馈）
  setMessages(prev => [...prev, userMessage])

  // 4. 接受投机（overlay → 主目录，清理）
  const result = await acceptSpeculation(...)

  // 5. 投机未完成时裁剪尾部 assistant 消息
  if (!isComplete) {
    cleanMessages = cleanMessages.slice(0, lastNonAssistant + 1)
  }

  // 6. 注入清洗后的投机消息
  setMessages(prev => [...prev, ...cleanMessages])

  // 7. 同步文件读取缓存
  readFileState.current = mergeFileStateCaches(readFileState.current, extracted)

  // 8. ANT-only 反馈消息（节省了多少时间）
  if (feedbackMessage) setMessages(prev => [...prev, feedbackMessage])

  // 9. 流水线建议提升
  if (isComplete && speculationState.pipelinedSuggestion) {
    // 把流水线建议提升为当前建议
    // 启动下一轮投机
    void startSpeculation(text, augmentedContext, setAppState, true)
  }

  // 10. 返回是否还需要跑 query
  return { queryRequired: !isComplete }
}
```

**关键返回值**：`queryRequired`
- `true`：投机没跑完（boundary 不是 `complete`），需要主线程继续执行剩余工作
- `false`：投机完整执行完毕，不需要额外 query

### 3.10 流水线投机（Pipelined Speculation）

当第一轮投机完成（boundary = complete）后：

```ts
// 投机完成后立即启动
void generatePipelinedSuggestion(
  contextRef.current,
  suggestionText,
  speculatedMessages,
  setAppState,
  abortController,
)
```

在等待用户按 Tab 的时间里，**预生成下一条建议**并存入 `pipelinedSuggestion`。

用户接受第一轮投机时，`handleSpeculationAccept` 检查是否有 pipelined suggestion：
- 有 → 提升为当前建议 + 启动第二轮投机（`isPipelined: true`）
- 无 → 正常结束

**理论上可以无限链式投机**——每轮完成后预测下一步、预执行下一步。

### 3.11 中止逻辑

三种中止场景：
1. **用户开始打字** → `abortSpeculation()`，清理 overlay，重置状态
2. **投机遇到 boundary** → `canUseTool` 返回 deny + `abortController.abort()`
3. **消息数达到上限** → `onMessage` 中检查 `>= MAX_SPECULATION_MESSAGES` 触发 abort

### 3.12 ANT-only 反馈消息

```ts
function createSpeculationFeedbackMessage(...) {
  if (process.env.USER_TYPE !== 'ant') return null  // 仅内部用户可见
  // "Speculated 3 tool uses · 1,234 tokens · +2.1s saved (5.3s this session)"
}
```

### 3.13 遥测

每次投机结束记录 `tengu_speculation` 事件：
- `speculation_id`
- `outcome`：accepted / aborted / error
- `duration_ms`
- `suggestion_length`
- `tools_executed`
- `completed`：boolean
- `boundary_type` / `boundary_tool` / `boundary_detail`
- `is_pipelined`

接受时还写入 transcript 文件（`speculation-accept` 类型）。

---

## 四、Speculation 启用条件

```ts
export function isSpeculationEnabled(): boolean {
  return process.env.USER_TYPE === 'ant' &&
    (getGlobalConfig().speculationEnabled ?? true)
}
```

当前只对 Anthropic 内部用户开放（`USER_TYPE === 'ant'`），默认启用。

---

## 五、状态更新优化

```ts
function updateActiveSpeculationState(setAppState, updater) {
  setAppState(prev => {
    if (prev.speculation.status !== 'active') return prev  // 守卫
    const current = prev.speculation
    const updates = updater(current)
    // 浅比较检测是否真正变化——避免不必要的 re-render
    const hasChanges = Object.entries(updates).some(
      ([key, value]) => current[key] !== value,
    )
    if (!hasChanges) return prev
    return { ...prev, speculation: { ...current, ...updates } }
  })
}
```

**工程意义**：投机期间高频更新（每条消息都可能触发），必须做变更检测避免无意义 re-render。

---

## 六、错误处理：Fail-Open 设计

```ts
// handleSpeculationAccept 的 catch 块
catch (error) {
  // ... log error
  safeRemoveOverlay(getOverlayPath(speculationState.id))
  resetSpeculationState(setAppState)
  return { queryRequired: true }  // 回退到正常 query 流程
}
```

**投机是性能优化，不是功能依赖**。任何投机错误都 fail-open：
- 清理 overlay
- 重置状态
- 返回 `queryRequired: true`（让主线程正常执行）
- 用户完全不感知投机失败

---

## 七、跨文件汇总：「自己写 Agent」可直接抄的设计原则

### 7.1 用户犹豫期三级利用

| 级别 | 做什么 | 延迟 | 价值 |
|------|--------|------|------|
| L1 | 预测用户输入 | ~1s | 提供建议文本 |
| L2 | 预执行预测输入 | 1-10s | 跳过执行等待 |
| L3 | 预测并预执行下一步 | 10-30s | 链式加速 |

### 7.2 COW Overlay 文件系统

不需要操作系统级支持，纯用户态实现：
1. 创建 `$TMPDIR/speculation/{pid}/{id}/` 目录
2. 写入时先 `copyFile` 原文件到 overlay，再写 overlay
3. 读取时检查是否已写过——已写读 overlay，否则读原文件
4. 接受时 `copyFile` overlay → 原位置
5. 放弃时 `rm -rf` overlay

### 7.3 fork 调用的缓存保真

**绝对不能改的参数**：system prompt、tools 列表、model、thinking config、effort、maxOutputTokens
**可以安全改的参数**：abortController、skipTranscript、skipCacheWrite、canUseTool（客户端回调）

经验教训：PR #18143 加了 `effort:'low'` 一个参数，cache write 暴增 45x。

### 7.4 投机结果注入的清洗维度

1. 剥离 thinking block（隐私 + token 浪费）
2. 配对检查——只保留成功的 tool_use + tool_result 对
3. 剥离合成中断消息
4. 丢弃全空白消息（API 400 防御）
5. 尾部 assistant 消息裁剪（非 prefill 模型兼容）

### 7.5 写操作的权限门禁

投机中的写操作需要双重检查：
1. **路径安全**：必须在 cwd 内
2. **权限模式**：必须是 acceptEdits/bypassPermissions/plan+bypass

### 7.6 Fail-Open 原则

投机是加速层，不是功能层。任何错误 → 清理 → 回退到正常流程。用户永远不会因为投机失败而看到错误。

### 7.7 状态管理：可变引用 vs 不可变状态

高频更新路径（每条消息）用 `{ current: T }` 可变引用，避免 React 不可变状态的 O(n) 复制开销。只在需要触发 re-render 的时刻（工具计数变化）才 `setAppState`。

---

## 八、与 MODULE_NOTES 其他章节的关联

| 关联模块 | 关联点 |
|---------|--------|
| M02 agent-loop | `runForkedAgent` 是 `query()` 的 fork 调用封装 |
| M04 permission-safety | `checkReadOnlyConstraints` 判断 bash 命令是否只读 |
| M05 api-streaming | `CacheSafeParams` 确保 fork 调用的 cache key 一致 |
| M06 context-engineering | `mergeFileStateCaches` 将投机读取的文件缓存合并回主线程 |
| M07 fs-shell-git | `commandHasAnyCd` 检查 bash 命令是否含 cd |
| M19 state | `SpeculationState` / `CompletionBoundary` 类型定义在 AppStateStore |
| SUPPLEMENT-large-files | compact.ts 的 `runForkedAgent` 有相同的"不改 cache key"约束 |

---

> 文件清单：
> - `src/services/PromptSuggestion/speculation.ts`（991 行）
> - `src/services/PromptSuggestion/promptSuggestion.ts`（523 行）
> - `src/state/AppStateStore.ts`（SpeculationState 类型定义，41-79 行）
