# SUPPLEMENT — AgentSummary + MagicDocs 子系统深读

> 补充 M14/M02 中未涉及的两个后台 fork 子系统。
> 范围：
> - `src/services/AgentSummary/agentSummary.ts`（179 行）— 子 Agent 进度摘要定时器
> - `src/services/MagicDocs/magicDocs.ts`（254 行）— Magic Doc 自动更新系统
> - `src/services/MagicDocs/prompts.ts`（127 行）— Magic Doc 更新 prompt 模板
>
> 总计 560 行源码逐行通读。

---

## 一、AgentSummary — 子 Agent 进度摘要（179 行）

### 1.1 系统职责

Coordinator 模式下，子 Agent 可能长时间运行。AgentSummary 每 **30 秒**用 `runForkedAgent()` fork 子 Agent 的对话上下文，生成 3-5 词的现在进行时摘要（如 "Reading runAgent.ts"），显示在 UI 的 AgentProgress 面板上。

### 1.2 架构

```
AgentTool.tsx / agentToolUtils.ts
  → startAgentSummarization(taskId, agentId, cacheSafeParams, setAppState)
      ↓
      30s 定时器（完成触发型，非固定间隔）
      ↓
      getAgentTranscript(agentId) → 读取子 Agent 当前消息
      ↓
      filterIncompleteToolCalls() → 清理未完成工具调用
      ↓
      runForkedAgent({
        promptMessages: [摘要 prompt],
        cacheSafeParams: { ...baseParams, forkContextMessages: cleanMessages },
        canUseTool: deny all,       // ← 不改 tools 列表，callback deny
        skipTranscript: true,
        querySource: 'agent_summary'
      })
      ↓
      updateAgentSummary(taskId, summaryText, setAppState)
```

### 1.3 关键设计决策

**1. 完成触发型定时器（非 setInterval）**

```ts
async function runSummary(): Promise<void> {
  try { /* ... fork + 提取摘要 ... */ }
  finally {
    if (!stopped) scheduleNext()  // 下一个 30s 从本次完成后开始
  }
}
```

不用 `setInterval`——避免前一次 fork 还在跑时启动下一次（fork 调用可能需要数秒）。每次 runSummary **完成后**才 schedule 下一轮。

**2. 丢弃闭包中的 forkContextMessages**

```ts
const { forkContextMessages: _drop, ...baseParams } = cacheSafeParams
```

`cacheSafeParams.forkContextMessages` 是 AgentTool.tsx 传入时子 Agent 的初始消息快照。如果把它留在闭包里，这些消息会被 pin 住整个定时器的生命周期。解法：每次 tick 从 `getAgentTranscript(agentId)` 重新读取最新消息，避免内存泄漏 + 保证摘要反映最新状态。

**3. Prompt 设计：3-5 词现在进行时**

```
Describe your most recent action in 3-5 words using present tense (-ing).
Name the file or function, not the branch. Do not use tools.
```

- 强制现在进行时 (-ing)：统一 UI 显示风格
- 指定文件/函数名：比 "Investigating the issue" 信息密度高得多
- 禁止 branch 名：避免泄露内部工作细节
- 传入 `previousSummary`：提示 "say something NEW"，避免反复生成相同摘要

**4. 缓存安全约束**

与 Speculation/PromptSuggestion 完全一致的模式：
- **不设 `maxOutputTokens`**：会 clamp `budget_tokens`，导致 thinking config 不匹配，打穿 prompt cache
- **不传 `tools:[]`**：通过 `canUseTool` callback deny，保持 cache key 一致
- **复用 `cacheSafeParams`**：与父 Agent 共享 prompt cache

**5. 消息数门禁**

```ts
if (!transcript || transcript.messages.length < 3) return
```

子 Agent 刚启动时（< 3 条消息），上下文不足以生成有意义的摘要，跳过。

### 1.4 调用方

| 调用位置 | 场景 |
|---------|------|
| `AgentTool.tsx:855` | 同步子 Agent（coordinator 模式） |
| `AgentTool.tsx:937` | 后台化的子 Agent（用户按 Esc 后 Agent 转后台） |
| `agentToolUtils.ts:545` | Workflow 中的子 Agent |

所有调用方都保存 `stop()` 句柄，在子 Agent 完成/中止时调用。

---

## 二、MagicDocs — 自动文档更新系统（381 行）

### 2.1 系统职责

Magic Docs 是一个**被动触发的后台文档维护系统**：当 Claude 读取到一个包含 `# MAGIC DOC: [title]` 头部的 Markdown 文件时，自动追踪它。在对话空闲时（Claude 没有在执行工具调用），用一个 Sonnet 子 Agent 读取最新对话上下文和文档内容，增量更新文档。

**核心价值**：用户维护一份 "活文档"，Claude 在对话过程中自动填充新学到的知识。

### 2.2 架构

```
initMagicDocs()                                     ← 仅 ant 用户
  ├→ registerFileReadListener(检测 MAGIC DOC 头部)   ← 挂载到 FileReadTool
  └→ registerPostSamplingHook(updateMagicDocs)       ← 挂载到 query 循环

FileReadTool 读文件
  → listener 检测到 # MAGIC DOC: title
  → registerMagicDoc(filePath)
  → trackedMagicDocs.set(filePath, { path })

query() 每轮结束后
  → executePostSamplingHooks()
  → updateMagicDocs(context)
      ├→ 跳过条件: querySource !== 'repl_main_thread'
      ├→ 跳过条件: 最后一轮 assistant 消息含 tool_use
      └→ 对每个 tracked doc 串行调用 updateMagicDoc()
          ├→ FileReadTool.call() 读取最新内容
          ├→ detectMagicDocHeader() 重新解析头部
          ├→ buildMagicDocsUpdatePrompt() 构建 prompt
          └→ runAgent({ agentDefinition: magic-docs, ... })
              ↓ 只允许 Edit 工具，只允许编辑该文件
```

### 2.3 Magic Doc 文件格式

```markdown
# MAGIC DOC: My Architecture Overview

_Focus on high-level patterns and entry points, not implementation details._

## Section 1
...
```

- **第一行**必须是 `# MAGIC DOC: <title>`（正则 `MAGIC_DOC_HEADER_PATTERN`）
- **第二行（可选）**：斜体指令（`_..._` 或 `*...*`），作为文档特定的更新指导
- 指令会被传入 prompt 的 `customInstructions` 部分，优先级高于通用规则

### 2.4 关键设计决策

**1. 只读触发 + 空闲执行**

| 阶段 | 条件 |
|------|------|
| 注册 | FileReadTool 读到文件 → 检测头部 → 加入追踪 |
| 更新 | postSamplingHook → 无 tool_use 在最后一轮 → 串行更新 |

不在文件读取时立即更新——等待对话空闲（最后一轮没有工具调用），说明 Claude 正在等待用户输入，此时后台更新文档对体验影响最小。

**2. 串行更新（sequential wrapper）**

```ts
const updateMagicDocs = sequential(async function (context) { ... })
```

`sequential()` 确保即使 postSamplingHook 被高频触发，updateMagicDocs 的执行也是串行的——前一次完成后才开始下一次。

**3. 最小化工具权限**

```ts
function getMagicDocsAgent(): BuiltInAgentDefinition {
  return {
    agentType: 'magic-docs',
    tools: [FILE_EDIT_TOOL_NAME],  // 只允许 Edit
    model: 'sonnet',               // 用 Sonnet 而非 Opus
    ...
  }
}
```

- 只给 `Edit` 工具（不给 Write/Read/Bash 等）
- `canUseTool` 进一步限制：只允许编辑**该 Magic Doc 文件本身**，其他文件 deny

```ts
const canUseTool = async (tool, input) => {
  if (tool.name === FILE_EDIT_TOOL_NAME && input.file_path === docInfo.path) {
    return { behavior: 'allow', updatedInput: input }
  }
  return { behavior: 'deny', ... }
}
```

**4. FileStateCache 克隆 + 删除**

```ts
const clonedReadFileState = cloneFileStateCache(toolUseContext.readFileState)
clonedReadFileState.delete(docInfo.path)
```

FileReadTool 有去重机制——如果文件已经读过且未变，返回 `file_unchanged` stub。Magic Docs 需要获取**实际内容**来重新检测头部，所以克隆 cache 并删除该文件的条目，强制完整读取。

**5. 自动取消注册**

```ts
// 文件被删除
if (isFsInaccessible(e) || e.message.startsWith('File does not exist')) {
  trackedMagicDocs.delete(docInfo.path)
  return
}

// 头部被移除
const detected = detectMagicDocHeader(currentDoc)
if (!detected) {
  trackedMagicDocs.delete(docInfo.path)
  return
}
```

两种情况自动停止追踪：文件被删除/不可读，或者文件内容不再包含 Magic Doc 头部。

**6. 自定义 Prompt**

```ts
async function loadMagicDocsPrompt(): Promise<string> {
  const promptPath = join(getClaudeConfigHomeDir(), 'magic-docs', 'prompt.md')
  try {
    return await fs.readFile(promptPath, { encoding: 'utf-8' })
  } catch {
    return getUpdatePromptTemplate()  // 回退到默认
  }
}
```

用户可在 `~/.claude/magic-docs/prompt.md` 放置自定义 prompt，用 `{{docContents}}`/`{{docPath}}`/`{{docTitle}}`/`{{customInstructions}}` 模板变量。

**7. 变量替换的安全性**

```ts
return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
  Object.prototype.hasOwnProperty.call(variables, key) ? variables[key]! : match
)
```

单 pass 替换，避免两个 bug：
- `$` 反向引用污染（replacer 函数中 `$` 被当字面量）
- 二次替换（用户内容中恰好包含 `{{varName}}`，多 pass 会错误替换）

### 2.5 更新 Prompt 的核心指导原则

默认 prompt 包含精心设计的文档哲学：

| 该写 | 不该写 |
|------|--------|
| 高层架构和系统设计 | 代码中已显而易见的细节 |
| 非显而易见的模式、惯例、坑 | 穷举文件/函数/参数列表 |
| 关键入口点（从哪里开始读代码） | 逐步实现细节 |
| 设计决策及其理由 | 底层代码机制 |
| 关键依赖和集成点 | CLAUDE.md 中已有的信息 |

**关键规则**：
- 保持文档反映**当前状态**——不是 changelog，不追加历史记录
- 就地更新过时信息——不加 "Previously..." 或 "Updated to..."
- 删除不再相关的 section
- 简洁高信号——"BE TERSE. High signal only."

### 2.6 当前部署状态

```ts
export async function initMagicDocs(): Promise<void> {
  if (process.env.USER_TYPE === 'ant') { ... }
}
```

仅对 Anthropic 内部用户启用。`initMagicDocs()` 在源码中没有被其他文件引用（可能通过动态加载或 feature flag 的 bundle 分支注入）。

---

## 三、两个子系统的共同设计模式

### 3.1 Fork 模式三原则

AgentSummary 和 MagicDocs 都是 `runForkedAgent()` / `runAgent()` 的消费者，遵循相同的三条 fork 原则：

| 原则 | AgentSummary | MagicDocs |
|------|-------------|-----------|
| 缓存安全 | 复用 cacheSafeParams，不改 tools/thinking/effort | 通过 runAgent 的 override 传递 systemPrompt |
| 工具最小化 | canUseTool deny all | tools: [Edit]，canUseTool 限制到单文件 |
| 非阻塞 | 30s 完成触发定时器 | postSamplingHook + sequential wrapper |

### 3.2 后台执行的两种触发模式

| 模式 | 实现 | 用例 |
|------|------|------|
| **定时器驱动** | `setTimeout` 完成后重调度 | AgentSummary（30s 轮询） |
| **事件驱动 + 空闲检测** | postSamplingHook + hasToolCalls 检查 | MagicDocs（对话空闲时更新） |

### 3.3 状态管理差异

| 维度 | AgentSummary | MagicDocs |
|------|-------------|-----------|
| 状态存储 | AppState.agentProgress（React 级） | 模块级 Map（trackedMagicDocs） |
| 生命周期 | 绑定到单个 Agent 任务（stop 句柄） | 绑定到会话（clear 时重置） |
| 恢复 | 无（Agent 结束即停止） | 每次更新重新读文件检测头部 |

---

## 四、「自己写 Agent」可直接抄的设计原则

### 4.1 Fork 调用的闭包内存管理

长时间运行的定时器中，fork context（消息列表）会被闭包 pin 住。AgentSummary 的做法——丢弃初始 `forkContextMessages`，每次 tick 从 transcript 重新读取——是防止内存泄漏的标准模式。

### 4.2 活文档模式（Magic Docs）

设计一个"文件头部即注册协议"的约定：
1. 文件首行包含特定头部 → 自动注册
2. 头部消失 → 自动取消注册
3. 文件删除 → 自动取消注册

无需额外配置文件，文件本身就是注册信息。

### 4.3 空闲时后台更新

`hasToolCallsInLastAssistantTurn(messages)` 是检测对话是否空闲的低成本方式：如果最后一轮 assistant 消息没有工具调用，说明 Claude 正在等待用户输入或已结束一轮工作。此时做后台更新对用户体验影响最小。

### 4.4 串行化 wrapper

```ts
const updateMagicDocs = sequential(async function (context) { ... })
```

`sequential()` 是一个通用的串行化 wrapper——确保 async 函数不被并发调用。适用于任何需要互斥执行的后台任务。

### 4.5 最小权限子 Agent

MagicDocs 的 Agent 配置是最小权限原则的教科书案例：
- 只给一个工具（Edit）
- canUseTool 进一步限制到单个文件路径
- 用 Sonnet 而非 Opus（任务简单，不需要强推理）
- 不影响主会话的 FileStateCache（克隆后操作）

---

## 五、与 MODULE_NOTES 其他章节的关联

| 关联模块 | 关联点 |
|---------|--------|
| M02 agent-loop | `runForkedAgent` 是 query() 的 fork 封装；`executePostSamplingHooks()` 在 query 循环内调用 |
| M03 tool-system | MagicDocs 通过 `FileReadTool.call()` 直接调用工具实现（不走权限链） |
| M14 subagent-tasks | `startAgentSummarization` 从 AgentTool.tsx 调用；`updateAgentSummary` 更新 LocalAgentTask 状态 |
| SUPPLEMENT-speculation | 相同的 fork 缓存安全约束（不改 tools/thinking/maxOutputTokens） |
| M19 state | AgentSummary 通过 `setAppState` 更新 `agentProgress`；MagicDocs 独立于 AppState |
| M07 fs-shell-git | MagicDocs 通过 `cloneFileStateCache` 隔离文件读取状态 |

---

> 文件清单：
> - `src/services/AgentSummary/agentSummary.ts`（179 行）
> - `src/services/MagicDocs/magicDocs.ts`（254 行）
> - `src/services/MagicDocs/prompts.ts`（127 行）
