# M06 · 上下文工程(Context Engineering)

> 模块定位:在 LLM 有限上下文窗口下,**主动**(autoCompact)/**被动**(reactiveCompact 应对 PROMPT_TOO_LONG)/**轻量**(microCompact)/**外置**(sessionMemory + memdir)四条路径协同管理 messages 数组,使长会话可持续运行。同时管理 git/CWD/CLAUDE.md 等系统上下文的注入与失效。
>
> 本模块是「Agent 工程」最具复用价值的部分之一 —— 任何要长跑的 Agent 都必须解决"上下文不够用"的问题。Claude Code 给出了一整套生产级方案,本文档系统拆解。

---

## 1. 模块定位

`services/compact/` + `context.ts` + `memdir/*` + `history.ts` 共同构成 Claude Code 的**上下文管理子系统**。它要解决的问题:

1. **写入侧(messages 累积)**:每轮 tool_use → tool_result 都在膨胀 messages;Read/Bash 等工具的输出可能动辄数千 token。
2. **读取侧(API 调用)**:Anthropic / Bedrock / Foundry / Vertex 都有硬上限(typically 200K token),逼近上限将报 `prompt_too_long`。
3. **降本侧(prompt cache)**:每次调用都重新计算 cache 是浪费的;但任何 messages 修改都可能让 cache 失效。
4. **跨会话侧(persistent memory)**:用户偏好、项目事实、外部系统引用应跨 session 保留。

Claude Code 的解决思路总结为四层:

| 层 | 触发时机 | 输入 | 输出 | 是否调用 LLM | 关键文件 |
|---|---|---|---|---|---|
| **microCompact**(轻量压缩) | 每轮 user 提交前 | messages | messages(修剪后) | ❌ | `microCompact.ts` |
| **sessionMemoryCompact**(实验) | autoCompact 之前 | messages + 已抽取的 sessionMemory | summary + messagesToKeep | ❌(memory 在后台预先抽取) | `sessionMemoryCompact.ts` |
| **autoCompact / 手动 /compact**(主压缩) | tokens 接近窗口阈值 | 整段 messages | 9-section summary + messagesToKeep + attachments | ✅(独立请求) | `compact.ts`, `prompt.ts` |
| **reactiveCompact** | 主线程 API 抛 PROMPT_TOO_LONG | messages | 同上,但带 PTL retry 切片 | ✅ | `compact.ts:truncateHeadForPTLRetry` + `M05` 重试链 |

`memdir/*` 则是**外置持久存储**,文件系统作为 LLM 的"长期记忆":通过强结构化的 prompt 让模型自己写文件、自己读文件,主进程几乎不参与读写决策。

---

## 2. 关键文件

### 2.1 `services/compact/`(核心,11 文件)

| 文件 | 行数 | 职责 |
|---|---|---|
| [compact.ts](src/services/compact/compact.ts) | 1705 | 主流程:`compactConversation` / `partialCompactConversation` / `streamCompactSummary` / 后压缩附件构造 |
| [autoCompact.ts](src/services/compact/autoCompact.ts) | 351 | 阈值计算 / 递归守卫 / 熔断器 / 主入口 `autoCompactIfNeeded` |
| [microCompact.ts](src/services/compact/microCompact.ts) | 530 | 时间触发 MC + cached MC + tool_result 替换 + estimateMessageTokens |
| [apiMicrocompact.ts](src/services/compact/apiMicrocompact.ts) | 153 | Anthropic API context_management 配置生成 |
| [prompt.ts](src/services/compact/prompt.ts) | 374 | 三种压缩 prompt + scratchpad 处理 + summary 用户消息构造 |
| [sessionMemoryCompact.ts](src/services/compact/sessionMemoryCompact.ts) | 631 | 实验性的「外置 memory + 不调 LLM 直接拼装」压缩路径 |
| [grouping.ts](src/services/compact/grouping.ts) | 64 | `groupMessagesByApiRound` —— 按 assistant message.id 分组 |
| [postCompactCleanup.ts](src/services/compact/postCompactCleanup.ts) | 77 | 清理 module-level state(skill / agent / tool listing)|
| [compactWarningHook.ts](src/services/compact/compactWarningHook.ts) | 16 | React hook 抑制 warning |
| [compactWarningState.ts](src/services/compact/compactWarningState.ts) | 18 | 全局 suppress flag |
| [timeBasedMCConfig.ts](src/services/compact/timeBasedMCConfig.ts) | 44 | gapThresholdMinutes=60 配置 |

### 2.2 `memdir/`(8 文件)

| 文件 | 职责 |
|---|---|
| [memdir.ts](src/memdir/memdir.ts) | `loadMemoryPrompt()` 主入口;构造系统 prompt 中的 memory section;含 KAIROS daily-log 模式 |
| [memoryTypes.ts](src/memdir/memoryTypes.ts) | 四类 memory(user/feedback/project/reference)+ COMBINED/INDIVIDUAL 两种 prompt 变体 + frontmatter 模板 |
| [paths.ts](src/memdir/paths.ts) | `getAutoMemPath` / `isAutoMemPath` / 路径验证(SECURITY) |
| [findRelevantMemories.ts](src/memdir/findRelevantMemories.ts) | sideQuery 调 Sonnet 选 top-5 相关 memory |
| [memoryScan.ts](src/memdir/memoryScan.ts) | 扫描 memdir 下所有 .md 提取 frontmatter |
| [memoryAge.ts](src/memdir/memoryAge.ts) | mtime → "47 days ago" 字符串 |
| [teamMemPaths.ts](src/memdir/teamMemPaths.ts) | 团队共享 memory 路径 + 严密路径校验(symlink 防逃逸) |
| [teamMemPrompts.ts](src/memdir/teamMemPrompts.ts) | combined private+team prompt |

### 2.3 上下文注入与持久化

- [context.ts](src/context.ts) — `getSystemContext`(git status + ENV)/ `getUserContext`(CLAUDE.md + projectStructure)
- [history.ts](src/history.ts) — `~/.claude/history.jsonl` 输入历史(↑/Ctrl-R)
- [services/SessionMemory/*](src/services/SessionMemory/)(本次未深入,见「待确认」)

---

## 3. 核心抽象

### 3.1 四类压缩(Four Compaction Strategies)

#### 3.1.1 autoCompact(主压缩,基线)

[autoCompact.ts:241-351](src/services/compact/autoCompact.ts#L241-L351)

阈值常量([autoCompact.ts:18-30](src/services/compact/autoCompact.ts#L18-L30)):
- `AUTOCOMPACT_BUFFER_TOKENS = 13_000` —— 距离 effective context window 还剩 13K 时触发
- `WARNING_THRESHOLD_BUFFER_TOKENS = 20_000` —— UI 黄色警告阈值
- `ERROR_THRESHOLD_BUFFER_TOKENS = 20_000` —— UI 红色阈值
- `MANUAL_COMPACT_BUFFER_TOKENS = 3_000` —— blocking limit:超过此值连手动 /compact 都拒绝执行
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` —— 熔断器

熔断器逻辑([autoCompact.ts:259-265](src/services/compact/autoCompact.ts#L259-L265)):
```ts
if (tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
  return { wasCompacted: false }
}
```
> BQ 2026-03-10 注释:"1,279 sessions with 50+ failures wasting ~250K API calls/day" —— 这个熔断器**不是过度设计**,是从生产数据反推出来的必需保护。

递归守卫([autoCompact.ts:170-183](src/services/compact/autoCompact.ts#L170-L183)):
```ts
if (querySource === 'session_memory' || querySource === 'compact') return false
if (feature('CONTEXT_COLLAPSE') && querySource === 'marble_origami') return false
```
**关键**:压缩本身的 LLM 调用通过 `runForkedAgent` 走 `querySource = 'compact'`,如果不守卫,压缩内的 LLM 调用又会触发 autoCompact → 死锁。

#### 3.1.2 reactiveCompact(被动压缩)

触发点:M05 主请求收到 PROMPT_TOO_LONG。但本模块的 compactConversation 内部**也**实现了一层 PTL retry,见 [compact.ts:227-291](src/services/compact/compact.ts#L227-L291) 的 `truncateHeadForPTLRetry`:

```ts
const MAX_PTL_RETRIES = 3
const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'
```

切片策略:
1. 用 `groupMessagesByApiRound` 分组(以 assistant message.id 边界)
2. 计算 `tokenGap = getPromptTooLongTokenGap(ptlResponse)`(从错误响应中解析"还差多少 token")
3. 累加丢弃,直到 acc ≥ tokenGap;否则按 20% 兜底丢
4. 至少保留一组(否则 nothing to summarize)
5. 若结果以 assistant 开头(API 拒绝 first message != user),前置一个合成 marker user 消息

> **CC-1180 注释**:"Compact 请求自身也可能 prompt-too-long" —— 一个被生产事故反推出来的必备机制。

#### 3.1.3 microCompact(轻量压缩,不调 LLM)

[microCompact.ts](src/services/compact/microCompact.ts) —— 完全不调 LLM,只在 messages 数组上做替换。

两个子路径:
- **Time-based MC**(`maybeTimeBasedMicrocompact`):若距上次 assistant 响应 > **60 分钟**(等于 server prompt cache TTL),清理工具结果。原因([timeBasedMCConfig.ts:1-30](src/services/compact/timeBasedMCConfig.ts#L1-L30)):cache 已冷,不如压一压再发。
- **Cached MC**(`cachedMicrocompactPath`):每轮 tool 执行结束注册 tool_result;在下次发送前替换为简短 stub,通过 `cache_edits` API 字段告诉 Anthropic"这些位置在我心里替换了,但你的 cache 不用废"。

可压缩工具白名单(`COMPACTABLE_TOOLS`)只覆盖 Bash / Glob / Grep / FileRead / WebFetch / WebSearch —— 这些工具的输出可重新计算,且通常很大。Edit / Write 等不在列。

`keepRecent` 默认 5,**地板设为 1**([microCompact.ts](src/services/compact/microCompact.ts) `Math.max(1, keepRecent)`)。原因:`messages.slice(-0)` 返回**完整数组**,会让 keepRecent=0 配置直接绕过整个压缩。

#### 3.1.4 API microcompact(服务端压缩)

[apiMicrocompact.ts](src/services/compact/apiMicrocompact.ts) —— 通过 Anthropic Beta `context_management` 字段委托给服务端做。两种触发器:

```ts
// clear_tool_uses_20250919:超阈值时 server 自动清理 tool_uses
// clear_thinking_20251015:对话空闲时 server 清理 thinking 块
```

`TOOLS_CLEARABLE_RESULTS = SHELL + GLOB + GREP + FILE_READ + WEB_FETCH + WEB_SEARCH` —— 与 microCompact 客户端白名单严格对齐(单一事实源)。

`clear_thinking_20251015` 的 keep 策略:>1h idle 时只保留 1 个 thinking turn,否则 keep:'all'。

### 3.2 NO_TOOLS_PREAMBLE + scratchpad 模式

[prompt.ts](src/services/compact/prompt.ts)。这是一个**强制让 Sonnet 4.6+ 不调工具**的工程技巧:

```
NO_TOOLS_PREAMBLE = """Your task is to create a detailed summary...
You MUST NOT use tools. You MUST output a single text response.
"""
DETAILED_ANALYSIS_INSTRUCTION_BASE = "Before producing the summary, write your analysis in <analysis> tags..."
NO_TOOLS_TRAILER = "(Remember: do not use tools. Output text only.)"
```

> 注释揭示:"Sonnet 4.6+ adaptive thinking sometimes attempts tools even with weaker trailer; preamble + trailer + maxTurns:1 are all needed."

Scratchpad 处理([prompt.ts](src/services/compact/prompt.ts) `formatCompactSummary`):
- 模型先写 `<analysis>...</analysis>` 整理思路
- 再写 `<summary>...</summary>` 给最终结果
- `formatCompactSummary` 用正则**剥掉** `<analysis>`,**替换** `<summary>` 标签

工程价值:让模型有思考空间提升质量,但用户 / 后续上下文只看到精炼版。

### 3.3 9-section 摘要结构(eval-driven prompt)

`BASE_COMPACT_PROMPT` 强制模型按 9 节输出([prompt.ts](src/services/compact/prompt.ts)):

1. Primary Request and Intent(用户原始意图)
2. Key Technical Concepts
3. Files and Code Sections(file:line 引用,**含完整代码片段**)
4. Errors and fixes(错误 + 修复)
5. Problem Solving(已解决 + 进行中)
6. All user messages(逐字保留 user message)
7. Pending Tasks
8. Current Work(中断时正在做的事)
9. Optional Next Step

加上**示例**(prompt 中给出虚构的好 summary)。这是 **prompt-as-spec**:用强结构反向规范模型输出。

### 3.4 三个压缩 prompt 变体

[prompt.ts](src/services/compact/prompt.ts):

- `BASE_COMPACT_PROMPT` —— 整段会话压缩(autoCompact / 手动 /compact)
- `PARTIAL_COMPACT_PROMPT` —— 仅压缩**最近**的某段(`partialCompactConversation` direction='from')
- `PARTIAL_COMPACT_UP_TO_PROMPT` —— 仅压缩**前缀**(direction='up_to'),输出标题改为 "Context for Continuing Work"

`partialCompactConversation`([compact.ts:770-1106](src/services/compact/compact.ts#L770-L1106)):
- direction='from':保留 head,压缩 tail
- direction='up_to':保留 tail,压缩 head —— **会剥离旧 boundary** 防止"loader 反扫"取错锚点

### 3.5 buildPostCompactMessages 顺序

[compact.ts:330-338](src/services/compact/compact.ts#L330-L338):
```ts
return [
  result.boundaryMarker,
  ...result.summaryMessages,
  ...(result.messagesToKeep ?? []),
  ...result.attachments,
  ...result.hookResults,
]
```
**顺序固定** —— 由这个函数统一所有路径(autoCompact / sessionMemory / partialCompact)。boundary 在最前是为了让 `getMessagesAfterCompactBoundary` 能找到分界。

### 3.6 后压缩附件预算

[compact.ts:122-130](src/services/compact/compact.ts#L122-L130):
- `POST_COMPACT_MAX_FILES_TO_RESTORE = 5`(数量)
- `POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000`(单文件)
- `POST_COMPACT_TOKEN_BUDGET = 50_000`(总文件预算)
- `POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000`(单 skill)
- `POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000`(总 skill 预算)

`createPostCompactFileAttachments`([compact.ts:1415-1464](src/services/compact/compact.ts#L1415-L1464))同时做四件事:
1. 按 mtime 倒排取 maxFiles=5 个最近文件
2. 排除已在 messagesToKeep 出现的 Read 路径(`collectReadToolFilePaths` —— **避免重注**)
3. 排除 plan 文件 / CLAUDE.md(走专门 attachment)
4. 累计 token 超 50K 后停

### 3.7 Skill 截断(只保留 head)

[compact.ts:1657-1672](src/services/compact/compact.ts#L1657-L1672):
```ts
const SKILL_TRUNCATION_MARKER = '\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]'
function truncateToTokens(content: string, maxTokens: number): string {
  ...
  const charBudget = maxTokens * 4 - SKILL_TRUNCATION_MARKER.length
  return content.slice(0, charBudget) + SKILL_TRUNCATION_MARKER
}
```
**保留头部** —— 因为 skill 文件的 setup/usage 通常在前。Marker 告诉模型"想要全文你 Read 一下"。

### 3.8 sentSkillNames **不重置**(成本权衡)

[compact.ts:524-529](src/services/compact/compact.ts#L524-L529):
```
// Intentionally NOT resetting sentSkillNames: re-injecting the full
// skill_listing (~4K tokens) post-compact is pure cache_creation with
// marginal benefit.
```
**反直觉的工程选择**:压缩本应清空一切,但**主动**保留 skill listing 已发送状态以省 4K token。

### 3.9 reAppendSessionMetadata([compact.ts:706-711](src/services/compact/compact.ts#L706-L711))

```ts
// Re-append session metadata (custom title, tag) so it stays within
// the 16KB tail window that readLiteMetadata reads for --resume display.
```
压缩后 messages 数量大变,session 文件元数据(用户自定义标题)可能从 16KB 尾部窗口被挤出 → 重新 append 一份。**针对 disk format 限制的工程补偿**。

### 3.10 boundary 的 preservedSegment 重定向

[compact.ts:349-367](src/services/compact/compact.ts#L349-L367) `annotateBoundaryWithPreservedSegment`:
```ts
preservedSegment: {
  headUuid: keep[0]!.uuid,
  anchorUuid,  // 紧邻 keep[0] 之前应该是谁
  tailUuid: keep.at(-1)!.uuid,
}
```
为什么需要:messagesToKeep 在磁盘上保留**原始 parentUuid**(被 dedup 跳过没改写),loader 重放时需要这个三元组把链条修补成 `head→anchor` 和 `anchor's-other-children→tail`。

> 这是「事件溯源 + idempotent 重建」的典型实现:**写入侧不改历史,读取侧用 metadata 修补**。

### 3.11 groupMessagesByApiRound

[grouping.ts:1-64](src/services/compact/grouping.ts#L1-L64):
```
分组边界:每当 assistant 的 message.id 发生变化 → 新一组
```
比"按 user 消息分组"更细 —— SDK / CCR / eval 等单 prompt 多轮 agentic 模式下,user 消息可能只有 1 条,但 assistant→tool→assistant→tool→... 一来一回。这种分组才能让 PTL retry 按"轮次"丢弃。

### 3.12 三种 querySource 触发的 querySource 级递归守卫

`querySource` 字段在 M02 创建,但**整个 M06 都依赖它做递归守卫**:

| querySource 值 | 含义 | M06 中作用 |
|---|---|---|
| `compact` | 压缩自身的 LLM 请求 | shouldAutoCompact 立即 false |
| `session_memory` | sessionMemory 抽取后台请求 | shouldAutoCompact 立即 false |
| `marble_origami` | ctx-agent (CONTEXT_COLLAPSE) | shouldAutoCompact 立即 false(否则会 reset 主线程的 committed log) |
| `repl_main_thread*` / `sdk` / undefined | 真正的主线程 | postCompactCleanup 才执行 |

[postCompactCleanup.ts:1-77](src/services/compact/postCompactCleanup.ts#L1-L77) 的 `isMainThreadCompact` 用此判断是否清理 module-level state。**子代理压缩不能清理主线程状态**。

### 3.13 microCompact 的 token 估算

[microCompact.ts](src/services/compact/microCompact.ts) `estimateMessageTokens`:
- char 数 ÷ 4 × 4/3 padding
- padding 系数是为了 estimate ≥ actual,**保守宁多勿少**(否则 microCompact 算"还没到阈值"实际却到了)

### 3.14 sessionMemory 的"实验性外置 memory"路径

[sessionMemoryCompact.ts:514-630](src/services/compact/sessionMemoryCompact.ts#L514-L630):

`trySessionMemoryCompaction` 是一个**不调用 LLM 做压缩**的快速路径。前提:
- GrowthBook flag `tengu_sm_compact` + `tengu_session_memory` 都 ON
- 后台 extractMemories agent **已经**在前几轮把会话事实抽取到 sessionMemory 文件
- `lastSummarizedMessageId` 标记"已抽取到哪条"

逻辑:
1. 取 `lastSummarizedMessageId` 之后的所有 messages 作为 keep
2. 反向扩张直到达到 `minTokens=10K + minTextBlockMessages=5`(双下限),或 `maxTokens=40K`(上限)
3. **不调 LLM**,直接拼装:`boundary + summary(=sessionMemory 内容)+ messagesToKeep + planAttachment`
4. 校验 postCompactTokenCount 是否仍超 autoCompactThreshold,超则放弃返回 null,降级到 compactConversation

`adjustIndexToPreserveAPIInvariants`([sessionMemoryCompact.ts:232-314](src/services/compact/sessionMemoryCompact.ts#L232-L314)):
- 不能切割 tool_use / tool_result 配对
- 不能切割共享 message.id 的多个 assistant block(thinking + tool_use)

工程价值:**当外部已有 ground-truth memory,压缩可以 zero-LLM** —— 极致省钱省延迟。但要求精确知道"已抽取到哪条"。

### 3.15 compact cache prefix sharing(forked agent 复用主线程 cache)

[compact.ts:1136-1248](src/services/compact/compact.ts#L1136-L1248):

GrowthBook flag `tengu_compact_cache_prefix`(default true since Jan 2026 实验)启用 `runForkedAgent` 路径,使压缩请求**复用主线程 cache**:
- 关键约束:**不能设 maxOutputTokens**(否则 budget_tokens 被 clamp,thinking config 不一致 → cache miss)
- skipCacheWrite: true(避免污染主线程 cache)
- maxTurns:1(配合 NO_TOOLS_TRAILER)

实验证据(从注释抓取):"false path is 98% cache miss, costs ~0.76% of fleet cache_creation (~38B tok/day), concentrated in ephemeral envs (CCR/GHA/SDK)" —— 这是上线 default true 的真实理由。

回退:`getLastAssistantMessage` 找不到文本 / 抛错 → fallback 到普通 streaming 路径。

### 3.16 Activity Interval 心跳(防 WebSocket 超时)

[compact.ts:1167-1176](src/services/compact/compact.ts#L1167-L1176):

```ts
const activityInterval = isSessionActivityTrackingActive()
  ? setInterval(
      (statusSetter?: (status: 'compacting' | null) => void) => {
        sendSessionActivitySignal()
        statusSetter?.('compacting')
      },
      30_000,
      context.setSDKStatus,
    )
  : undefined
```
压缩可能 5-10s,期间没有其他消息流过 SDK transport。**主动每 30s 发 heartbeat** 防 server 断开。`setInterval` 透 setSDKStatus 进 callback 而非闭包捕获 —— 让单测 mock 更可控。

### 3.17 memdir 四类 memory 的 prompt 设计

[memoryTypes.ts](src/memdir/memoryTypes.ts):

| type | 触发场景 | 写入指引 | 不写 |
|---|---|---|---|
| user | 用户角色/偏好 | "I'm a data scientist" | 工作进度 |
| feedback | 用户纠正 / 确认 | "stop summarizing" | 一次性偏好 |
| project | 项目内事实 | "freeze begins 2026-03-05" | 代码可派生 |
| reference | 外部系统指针 | "bugs tracked in Linear INGEST" | 项目内文档 |

**WHAT_NOT_TO_SAVE_SECTION**(关键):
- 代码模式 / 路径 / 项目结构 → 派生于源码
- git history → 派生于 git
- bug 修复方案 → 派生于 commit message
- CLAUDE.md 已有 → 派生

> 注释:"H2: explicit-save gate. Eval-validated (memory-prompt-iteration case 3, 0/2 → 3/3)" —— prompt 是 **A/B eval 出来的**,不是拍脑袋。

### 3.18 memdir entrypoint 的双重截断

[memdir.ts:34-103](src/memdir/memdir.ts#L34-L103):
- `MAX_ENTRYPOINT_LINES = 200`(行)
- `MAX_ENTRYPOINT_BYTES = 25_000`(字节)
- 先按行裁,再按字节裁(裁到上一个 \n)
- warning 文本告诉模型**为什么**被截了("index entries are too long")

> 双重 cap 的理由:"long-line indexes that slip past the line cap (p100 observed: 197KB under 200 lines)"。即 200 行可以塞进 197KB,字节上限是补丁。

### 3.19 memdir 路径安全(deep)

[teamMemPaths.ts:22-64](src/memdir/teamMemPaths.ts#L22-L64) `sanitizePathKey`:
- null byte
- URL-encoded traversal(`%2e%2e%2f`)
- Unicode normalize 攻击(NFKC 后变成 `..`)
- 反斜杠
- 绝对路径前缀

[teamMemPaths.ts:109-171](src/memdir/teamMemPaths.ts#L109-L171) `realpathDeepestExisting`:
- 文件可能未存在,逐级向上 walk 直到 realpath 成功
- ENOENT 时再 lstat 区分"真不存在"vs"悬空 symlink"
- ELOOP 直接抛 PathTraversalError
- 非空 tail 时反向 join 回去

> PSR M22186 安全审计的实战补丁。**外置 memory 安全靠纸面 spec 是不够的,要真正 walk 文件系统**。

### 3.20 findRelevantMemories 的二次过滤

[findRelevantMemories.ts:39-75](src/memdir/findRelevantMemories.ts#L39-L75):
1. 第一层:`scanMemoryFiles` 取所有 .md 的 frontmatter
2. 第二层:`alreadySurfaced` 过掉前几轮已展示给主模型的(避免重复)
3. 第三层:Sonnet `sideQuery` 选 top-5(JSON-schema 约束输出)
4. 第四层:`recentTools` 提示 —— 当前正在用 `mcp__X__spawn` 这个工具时,过滤掉它的参考文档(主对话已经在用了)

> "active use is exactly when warnings/gotchas matter, but reference docs are noise" —— 主动反转 keyword overlap 选择器的偏置。

### 3.21 memoryAge 的人类可读化

[memoryAge.ts:11-20](src/memdir/memoryAge.ts#L11-L20):
```ts
if (d === 0) return 'today'
if (d === 1) return 'yesterday'
return `${d} days ago`
```
> 注释:"Models are poor at date arithmetic — a raw ISO timestamp doesn't trigger staleness reasoning the way '47 days ago' does."

`memoryFreshnessText` 仅对 >1 天的 memory 输出(避免噪音)。

### 3.22 KAIROS daily-log 模式(append-only)

[memdir.ts:327-370](src/memdir/memdir.ts#L327-L370):
- 持久 session(assistant 模式)→ 每日 append 到 `logs/YYYY/MM/YYYY-MM-DD.md`
- prompt 用 **pattern**(`logs/YYYY/MM/YYYY-MM-DD.md`)而不是 today 字面值
- 因为 prompt 被 cache,不能日期变化时 invalidate
- 模型自己从 `currentDate` 上下文(midnight rollover 时 attachment 注入)派生今天

> 这是 **prompt cache 友好的日期处理模式**,值得 borrow。

### 3.23 history.ts 的 paste store + 锁文件 + 反序列化

[history.ts](src/history.ts):
- `~/.claude/history.jsonl` 文件单一存储所有项目所有 session
- 大于 1024 字节 paste content 哈希后存外部 `paste-store/<hash>`(`storePastedText`),history.jsonl 只存 hash 引用
- 写入用 `lock`(文件锁,3 retries)防多进程冲突
- pendingEntries 缓冲 + flushPromptHistory 异步 flush
- `removeLastFromHistory`:刚写就撤销时 fast path 出 buffer,慢 path 加 timestamp 到 skip set
- `getHistory` 当前 session 优先 + 其他 session(window=100,**同窗内重排序**)

---

## 4. 数据流 / 控制流

### 4.1 主循环每轮的上下文管理

```
入口(M02:wrappedQuery)
  │
  ├─→ microCompact (per turn before send) [microCompact.ts]
  │    ├─→ time-based: idle > 60min ? clear COMPACTABLE_TOOLS results
  │    └─→ cached MC: register tool_results → next turn 替换 stub + cache_edits
  │
  ├─→ shouldAutoCompact [autoCompact.ts:160-239]
  │    ├─ querySource ∈ {compact, session_memory, marble_origami} → false
  │    ├─ DISABLE_AUTO_COMPACT env → false
  │    ├─ tengu_cobalt_raccoon flag (REACTIVE_COMPACT-only) → false
  │    ├─ isContextCollapseEnabled → false
  │    └─ tokens >= autoCompactThreshold → true
  │
  └─→ if true: autoCompactIfNeeded [autoCompact.ts:241-351]
       ├─ 熔断器:consecutiveFailures >= 3 → skip
       ├─ trySessionMemoryCompaction (实验) → 命中则结束
       └─ compactConversation (主路径)
            │
            ├─ executePreCompactHooks
            ├─ getCompactPrompt + summaryRequest = createUserMessage
            ├─ for(;;) PTL retry loop (MAX_PTL_RETRIES=3)
            │    ├─ streamCompactSummary
            │    │    ├─ promptCacheSharingEnabled?
            │    │    │    YES → runForkedAgent (复用主线程 cache, maxTurns:1, skipCacheWrite)
            │    │    │    NO  → queryModelWithStreaming (FileReadTool only, asSystemPrompt)
            │    │    └─ activityInterval 30s heartbeat
            │    ├─ summary = getAssistantMessageText(summaryResponse)
            │    └─ if startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE):
            │         truncateHeadForPTLRetry → continue
            │
            ├─ 清空 readFileState + loadedNestedMemoryPaths
            ├─ Promise.all([
            │     createPostCompactFileAttachments,  ← 5 files / 50K budget
            │     createAsyncAgentAttachmentsIfNeeded,
            │   ])
            ├─ createPlanAttachmentIfNeeded
            ├─ createPlanModeAttachmentIfNeeded
            ├─ createSkillAttachmentIfNeeded ← 25K budget / 5K/skill
            ├─ getDeferredToolsDeltaAttachment([])  ← 全集重宣
            ├─ getAgentListingDeltaAttachment([])
            ├─ getMcpInstructionsDeltaAttachment([])
            ├─ processSessionStartHooks('compact')
            ├─ createCompactBoundaryMessage + preCompactDiscoveredTools
            ├─ summaryMessages = [createUserMessage(getCompactUserSummaryMessage)]
            ├─ logEvent('tengu_compact', { ...analyzeContext metrics })
            ├─ notifyCompaction(querySource) [PROMPT_CACHE_BREAK_DETECTION]
            ├─ markPostCompaction
            ├─ reAppendSessionMetadata
            ├─ executePostCompactHooks
            └─ return CompactionResult
                  │
                  ↓
            buildPostCompactMessages(result) =
              [boundary, ...summaryMessages, ...messagesToKeep, ...attachments, ...hookResults]
                  │
                  ↓
            REPL setMessages(...) → 下一轮
```

### 4.2 reactiveCompact 的 PTL retry 回路

主请求(M05)抛 PROMPT_TOO_LONG → reactiveCompact 模块(本次未深入,见「待确认」)→ 调用本模块 `compactConversation` 的内部 retry。

### 4.3 sessionMemory 路径

```
extractMemories 后台 agent (autoCompact 之外)
  ├─ 每隔 N 轮被 spawn
  ├─ querySource = 'session_memory'
  ├─ 读 messages [lastSummarizedMessageId..end]
  ├─ 抽取事实写入 sessionMemory 文件
  └─ 更新 lastSummarizedMessageId

trySessionMemoryCompaction:
  ├─ shouldUseSessionMemoryCompaction (双 GB flag + env override)
  ├─ initSessionMemoryCompactConfig (远程 config 一次性)
  ├─ waitForSessionMemoryExtraction(timeout)
  ├─ getSessionMemoryContent / getLastSummarizedMessageId
  ├─ if isSessionMemoryEmpty → null (降级)
  ├─ calculateMessagesToKeepIndex (反向扩张达到 minTokens/minTextBlockMessages)
  ├─ adjustIndexToPreserveAPIInvariants (tool_use/tool_result + thinking block)
  ├─ filter 旧 boundary
  ├─ processSessionStartHooks
  ├─ createCompactionResultFromSessionMemory (NO LLM CALL)
  └─ 校验 postCompactTokenCount 仍 >= threshold → null (降级)
```

### 4.4 memdir 注入流

```
系统启动:
  ├─ context.ts:getSystemContext (cached)
  ├─ memdir.ts:loadMemoryPrompt
  │    ├─ KAIROS active? → buildAssistantDailyLogPrompt
  │    ├─ TEAMMEM enabled? → teamMemPrompts.buildCombinedMemoryPrompt
  │    └─ default → buildMemoryLines
  │         ├─ buildMemoryLines 含 TYPES_SECTION_INDIVIDUAL + WHEN_TO_ACCESS + TRUSTING_RECALL
  │         └─ truncateEntrypointContent(MEMORY.md) ≤ (200 lines, 25K bytes)
  │
  └─ 拼入 system prompt(被 prompt cache 命中,session 内不变)

每轮 user 提交后(M02):
  └─ findRelevantMemories(query, memdir, signal)
       ├─ scanMemoryFiles → MemoryHeader[]
       ├─ filter alreadySurfaced
       ├─ sideQuery(Sonnet) 选 top-5
       ├─ logMemoryRecallShape (telemetry)
       └─ 注入 attachment "relevant_memories"(含 memoryFreshnessText 警告)
```

---

## 5. 工程设计精髓(可直接迁移到自研 Agent)

### 5.1 ⭐ 多层压缩策略协同(分层防御)

**反模式**:只有"上下文满了 → LLM 总结一遍"这一种压缩。

**Claude Code 的做法**:四层从浅到深、从主动到被动、从无 LLM 到有 LLM、从同步到异步:
- **0 成本**:microCompact(无 LLM,只 mutate messages)
- **1 次 LLM**:autoCompact / 手动 /compact(有 LLM,但通过 `runForkedAgent` 复用主线程 cache)
- **0 LLM 但需后台抽取**:sessionMemory(分摊到每轮的后台 agent,压缩点上零调用)
- **被动应急**:reactiveCompact(API 已经报错才触发)

**复用要点**:不要把上下文管理压在单一策略上,要"轻先动 + 重保底"。

### 5.2 ⭐ 递归守卫(querySource-based)

任何"在压缩内调用 LLM"的设计都必须有 `querySource` 这种**调用源标识**。否则:
- 压缩 LLM 调用又触发压缩 → 死锁
- side query / agent fork 也可能触发 → 死锁

**复用要点**:LLM 调用入口处统一打 querySource 标签,任何**会触发压缩**的入口都查 querySource 黑名单。

### 5.3 ⭐ 熔断器(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES)

数据驱动:`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`。当用户的 context 已经"压不动"(压缩本身一直失败),不要每轮都试 —— 浪费 API 调用,也浪费用户耐心。

**复用要点**:任何"自动恢复"机制都要带"放弃尝试"的熔断阈值。

### 5.4 ⭐ NO_TOOLS_PREAMBLE + scratchpad + maxTurns:1 三件套

让模型"只输出文本"看似简单,实际 Sonnet 4.6+ 因为 adaptive thinking 可能误用工具。Claude Code 用三个手段叠加:
1. **prompt 开头**:NO_TOOLS_PREAMBLE 明示
2. **prompt 末尾**:NO_TOOLS_TRAILER 重复
3. **runtime**:maxTurns:1 + canUseTool 返回 deny

加上 `<analysis>` scratchpad 让模型有思考空间但**输出不污染**(用 formatCompactSummary 剥离)。

**复用要点**:让 LLM 做"仅文本输出"的任务,不能只靠 prompt,要 runtime 强制配合。

### 5.5 ⭐ 9-section structured summary(prompt-as-spec)

强结构 + 给示例 = 让模型按 schema 输出 markdown,而非 JSON。原因:summary 要被人读、被下次会话作为上下文,markdown 比 JSON 友好。

**关键 section 设计原则**:
- "All user messages" 强制逐字保留 —— 用户指令是"宪法"
- "Files and Code Sections" 含完整代码片段(有 file:line 引用)
- "Current Work" + "Optional Next Step" 让"中断后恢复"成为一等公民

**复用要点**:summary 不是"自由文本",是带 schema 的结构化产物。

### 5.6 ⭐ 后压缩附件预算(token-bounded restore)

压缩后注入回去的内容也要**有预算**:
- 5 files / 50K budget
- 5 skills / 25K budget
- 单文件 5K
- 超 budget 直接丢(filter 不是 truncate)

**反模式**:把所有"重要东西"都注回去 → 压缩等于无效。

**复用要点**:"恢复"也要 token-aware,不能恢复到压前规模。

### 5.7 ⭐ 「不重置」的工程权衡(sentSkillNames)

注释直陈:"~4K tokens saved per compact"。**反直觉**但**对的**选择:压缩不是"全部清零",有些状态保留比重新发更省。

**复用要点**:成本敏感时,用数据反推哪些 state 应该"跨压缩存活"。

### 5.8 ⭐ boundary + preservedSegment 的链条修补

事件溯源思路:**写入侧不改历史**(messagesToKeep 保留原始 parentUuid),**读取侧用 metadata 修补**链条(headUuid/anchorUuid/tailUuid 三元组)。

**复用要点**:append-only 存储 + metadata-based redirect 是处理"压缩后历史回放"的优雅模式。

### 5.9 ⭐ groupMessagesByApiRound(细粒度切分)

不是按"用户提交"分组,而是按 assistant message.id 边界 —— 因为单 prompt SDK / agentic 模式下 user 消息少,assistant 多。

**复用要点**:分组逻辑要看真实数据形态,不能想当然。

### 5.10 ⭐ truncateHeadForPTLRetry + 合成 user marker

切片导致结果以 assistant 开头 → API 拒绝(first message must be user)→ 前置 `[earlier conversation truncated for compaction retry]` 合成 user marker。

**复用要点**:任何切片操作都要校验切片后的"开头/结尾"格式是否合法。

### 5.11 ⭐ Activity heartbeat(防 transport 超时)

30 秒心跳,**为 transport 层(WebSocket)而非业务**。压缩 5-10s 没问题,但 SDK / Bridge transport 的 idle timeout 可能 30s。

**复用要点**:长任务要主动维持 transport heartbeat。

### 5.12 ⭐ KAIROS daily-log 的 cache-friendly 日期注入

prompt 里写 `logs/YYYY/MM/YYYY-MM-DD.md` **pattern**,today 字面值通过 `currentDate` attachment 在 midnight rollover 时**追加**。Prompt 被 cache 不会因日期变 invalidate。

**复用要点**:任何会"按日变化"的内容,要从 prompt 主体抽离到尾部 attachment。

### 5.13 ⭐ memoryFreshnessText 的人类可读化

模型对"2025-09-15T08:30:00Z"和"47 days ago"的反应不同 —— 后者更易触发 staleness reasoning。

**复用要点**:给模型的时间元数据要"人类化",不是机器化。

### 5.14 ⭐ memdir 的 entrypoint 双重截断 + warning 文本

```
WARNING: MEMORY.md is 197 KB (limit: 25 KB) — index entries are too long.
Only part of it was loaded. Keep index entries to one line under ~200 chars;
move detail into topic files.
```
不是简单 truncate,是**告诉模型为什么** → 模型下次写 entry 时就会简短。

**复用要点**:截断信息要带"诊断 + 教学"。

### 5.15 ⭐ findRelevantMemories 的 recentTools 反向过滤

正在用的工具,它的 reference doc 是 noise(你已经在用了),但 warnings/gotchas 仍要保留。这个区分**反直觉**但**对的**。

**复用要点**:retrieval 不是"匹配越多越好",要按"使用场景"反向去重。

### 5.16 ⭐ buildPostCompactMessages 单一函数(SST)

[compact.ts:330-338](src/services/compact/compact.ts#L330-L338) 把 boundary/summary/keep/attachments/hookResults 的拼接顺序**收敛到一个函数**。所有压缩路径(autoCompact / sessionMemory / partial)共享。

**复用要点**:多分支汇聚的"输出格式"应该集中在一个 builder,避免顺序错乱。

### 5.17 ⭐ analyzeContext 的"延后到 await 之后"调度

[compact.ts:683-694](src/services/compact/compact.ts#L683-L694) `analyzeContext` 11ms 同步遍历,但**故意放在压缩 API 调用之后**。原因:压缩 API await 时事件循环空闲,这时跑 sync walk 不抢渲染 / 不延迟用户感知。

**复用要点**:同步重操作要找"事件循环空闲窗口"调度。

### 5.18 ⭐ stripImagesFromMessages(节省压缩成本)

压缩 API 调用前,把 image / document 替换为 `[image]` 文本占位。理由:
- 摘要不需要图像
- 图像是大头,容易让压缩本身 PTL

**复用要点**:压缩输入也要"按用途裁剪",不是原样发。

### 5.19 ⭐ collectReadToolFilePaths 的去重

[compact.ts:1610-1655](src/services/compact/compact.ts#L1610-L1655) `createPostCompactFileAttachments` 不重注 `messagesToKeep` 里已经有 Read 结果的文件 —— 但**跳过 dedup stub**(stub 指向被压缩的旧 Read,要重注)。

**复用要点**:dedup 时要细分"真有内容"和"指针"。

### 5.20 ⭐ truncateToTokens 保留 head 而非中间

skill 文件压缩时**保留头部**(setup/usage 在前),不是 head + tail 摘抄。

**复用要点**:截断策略要利用文档结构先验。

---

## 6. 错误处理与边界

### 6.1 错误传播路径

| 错误 | 来源 | 处理 |
|---|---|---|
| `ERROR_MESSAGE_NOT_ENOUGH_MESSAGES` | compactConversation 入口 messages.length=0 | throw → autoCompactIfNeeded catch → 不计入 failures |
| `ERROR_MESSAGE_PROMPT_TOO_LONG` | PTL retry 用尽 | throw → addErrorNotificationIfNeeded(仅手动)|
| `ERROR_MESSAGE_INCOMPLETE_RESPONSE` | streamCompactSummary 重试 2 次后无 response | throw → notification |
| `ERROR_MESSAGE_USER_ABORT` | abortController.abort | 不显示 notification(用户主动) |
| sessionMemoryCompact error | 任何异常 | catch → logEvent('tengu_sm_compact_error') → 返回 null 降级到 compactConversation |
| autoCompact 异常 | catch | `consecutiveFailures + 1` → 熔断器 |

### 6.2 PTL retry 的边界条件

`truncateHeadForPTLRetry` 返回 null 的情况:
- groups.length < 2(只剩一组,丢什么都剩不下)
- dropCount < 1(理论上不会,防御性)
- `getPromptTooLongTokenGap` 返回 undefined → 兜底 20%

### 6.3 stale 边界恢复

`adjustIndexToPreserveAPIInvariants` 处理两种 streaming 副作用:
- 同 message.id 多 block(thinking + tool_use)→ 必须一起 keep
- tool_use / tool_result 配对 → 不能切开

### 6.4 OS 级文件锁(history.ts)

`flushPromptHistory` 用 `lock`(`stale: 10000, retries: 3`)防多进程冲突。锁失败 → 等 500ms 重试,5 次都失败 → 直接 give up(避免死循环)。

### 6.5 memdir 路径注入防御(team)

`validateTeamMemKey` 经过:
1. sanitizePathKey(null byte / URL-encoded / NFKC / 反斜杠 / 绝对)
2. resolve() 字符串前缀检查
3. realpathDeepestExisting() symlink 解析
4. isRealPathWithinTeamDir 真实路径前缀检查

任一失败 → PathTraversalError。**双层(string + filesystem)纵深防御**。

### 6.6 dangling symlink 区分

ENOENT 时再 `lstat`:
- lstat 成功且 isSymbolicLink → dangling symlink → throw
- lstat 也 ENOENT → 真不存在 → safe to walk up
- lstat 其他错 → 当前 ancestor 有 dangling symlink,继续 walk

### 6.7 sessionMemory 多种降级

| 场景 | 行为 |
|---|---|
| `tengu_session_memory` 或 `tengu_sm_compact` flag off | 直接 null |
| sessionMemory 文件不存在 | logEvent('tengu_sm_compact_no_session_memory') + null |
| sessionMemory 是模板(空内容) | logEvent('tengu_sm_compact_empty_template') + null |
| `lastSummarizedMessageId` 在 messages 中找不到 | logEvent('tengu_sm_compact_summarized_id_not_found') + null |
| postCompactTokenCount 仍 >= threshold | logEvent('tengu_sm_compact_threshold_exceeded') + null |

每种 null 都打**专属事件**,实验数据可分析。

### 6.8 memoryDir 不存在的安全开关

`isRealPathWithinTeamDir` 在 teamDir ENOENT 时**返回 true**(skip 检查)。理由:symlink 逃逸需要 teamDir 内已有 symlink → teamDir 不存在 → 不可能。第一层 string-level 校验仍生效。

---

## 7. 可迁移设计清单

| # | 设计 | Claude Code 实现 | 自研 Agent 借鉴方法 |
|---|---|---|---|
| 1 | **多层压缩策略** | microCompact / autoCompact / sessionMemory / reactive | 至少分"无 LLM(rule-based)" + "有 LLM(summarize)" + "应急(API 报错回退)" 三层 |
| 2 | **querySource 递归守卫** | autoCompact.ts:170-183 | 任何会触发压缩的 LLM 调用入口都打 source 标签 |
| 3 | **熔断器** | MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3 | 自动恢复机制必带"放弃阈值" |
| 4 | **NO_TOOLS_PREAMBLE + maxTurns:1** | prompt.ts | "仅文本"任务 prompt + runtime 双重锁 |
| 5 | **9-section summary schema** | BASE_COMPACT_PROMPT | 让 LLM 按结构化 markdown 而非 JSON 输出 summary |
| 6 | **后压缩附件预算** | POST_COMPACT_TOKEN_BUDGET=50K | 恢复也要 token-aware |
| 7 | **不全量重置** | sentSkillNames 故意保留 | 用数据决定 state 跨压缩存活策略 |
| 8 | **append-only history + metadata redirect** | preservedSegment | 历史不改写,链条修补靠 metadata |
| 9 | **细粒度分组** | groupMessagesByApiRound | 按真实交互形态分组,不是按 user 消息 |
| 10 | **transport heartbeat** | activityInterval=30s | 长 LLM 调用主动心跳维持 WS/SSE |
| 11 | **cache-friendly date** | KAIROS pattern + currentDate attachment | 易变内容从 prompt 主体抽离到尾部 |
| 12 | **memoryFreshnessText** | "47 days ago" | 时间元数据人类化 |
| 13 | **诊断式截断** | "Keep entries to one line under ~200 chars; move detail into topic files." | 截断带"为什么 + 怎么办" |
| 14 | **retrieval 反向去重** | recentTools 过滤 | retrieval 要按使用场景区分相关性 |
| 15 | **builder 函数收敛** | buildPostCompactMessages | 多路径汇聚的"输出格式"集中在一处 |
| 16 | **同步重操作延迟** | analyzeContext 在 await 之后 | 找事件循环空闲窗口跑 sync 任务 |
| 17 | **压缩输入裁剪** | stripImagesFromMessages | 压缩前主动裁剪 image/doc |
| 18 | **dedup-aware 去重** | collectReadToolFilePaths skip stub | dedup 区分"真内容"和"指针" |
| 19 | **head-preserving 截断** | truncateToTokens(skill) | 利用文档结构先验决定截哪段 |
| 20 | **forked-agent cache 复用** | runForkedAgent + skipCacheWrite | 子 LLM 调用复用父对话 cache prefix |
| 21 | **路径双层校验** | string check + realpath check | 任何"用户控制路径"都要双层(字符串 + 文件系统) |
| 22 | **降级链** | sessionMemory → compactConversation | 实验性优化路径必备明确的降级路径 |

---

## 8. 待确认问题

1. **services/SessionMemory/ 子目录** 本次未深入 —— `extractMemories.ts` 是后台抽取 agent;`prompts.ts` 含 `truncateSessionMemoryForCompact` / `isSessionMemoryEmpty` 实现细节;`sessionMemoryUtils.ts` 含 `getLastSummarizedMessageId` 等 module-level 状态。这些是 sessionMemory 路径完整图谱的关键。
2. **services/contextCollapse/(CONTEXT_COLLAPSE feature)** 多次被 autoCompact 守卫:90% 提交、95% 阻塞 spawn、`marble_origami` querySource、`isContextCollapseEnabled`。这是一个独立的"激进"上下文管理实验,值得单独对照。
3. **services/reactiveCompact 模块** 注释多次提及"reactive-compact 路径"但未在 services/compact/ 下找到。可能在 [services/](src/services/) 顶层或 utils 下。
4. **history.ts 与 paste-store 的关系** —— `pasteStore.hashPastedText / retrievePastedText / storePastedText` 实现未读;大 paste 的去重 / GC 策略待确认。
5. **utils/contextAnalysis.ts 的 analyzeContext** —— 每个分类(thinking / tool_use / tool_result / text...)的 token 统计字段尚未列全。
6. **utils/forkedAgent.ts 的 CacheSafeParams 完整字段** —— compact 路径用 `forkContextMessages` 注入,但 cacheSafeParams 还有什么?
7. **`tokenCountWithEstimation` 与 `roughTokenCountEstimationForMessages` 的精确算法差异** —— 在 [utils/tokens.ts](src/utils/tokens.ts) 和 [services/tokenEstimation.ts](src/services/tokenEstimation.ts),前者用 API 真实 input_tokens,后者纯 char-based 估算。这两个值在压缩前后多次 cross-check。
8. **memoryShapeTelemetry.ts** 仅在 findRelevantMemories.ts 引用 —— 是 ant-only 的 memory recall 实验数据。
9. **`getCompactUserSummaryMessage` 第三参数 transcriptPath 用途** —— prompt.ts 中已读但具体在 user message 里如何渲染,在 messages 渲染 (M12) 模块。
10. **PROMPT_CACHE_BREAK_DETECTION feature**(M05 已涉及)与本模块的 `notifyCompaction` 联动 —— 压缩后必须 reset cache baseline,否则 prompt cache break 误报。
11. **`tengu_compact_streaming_retry` flag 默认 false** —— streaming 失败的兜底重试目前未默认开。

---

## 9. 附录:M06 与 M02/M04/M05/M14 的接口

### M06 → M02(Agent loop)
- `autoCompactIfNeeded` 在每轮 user 提交前由 M02 调用,签名:`(messages, toolUseContext, cacheSafeParams, querySource, tracking, snipTokensFreed) → { wasCompacted, compactionResult, consecutiveFailures }`
- `tracking: AutoCompactTrackingState` 由 M02 维护(turnCounter / turnId / consecutiveFailures / compacted),M06 读 + 写 consecutiveFailures
- microCompact 在 M02 prepareMessagesForLLM 时被调用

### M06 → M04(Permission)
- `createCompactCanUseTool()` 永远 deny —— 在压缩 LLM 调用中**禁止任何工具**
- planMode 状态在压缩前检查 `appState.toolPermissionContext.mode === 'plan'` → 注入 plan_mode attachment 让模式延续

### M06 → M05(API)
- `streamCompactSummary` 调 `queryModelWithStreaming` 走完整 API 流式管线
- `runForkedAgent` 路径走 cache 复用,但 cacheSafeParams 必须**与主线程一致**(thinking config / tools / system prompt)
- 压缩后 `notifyCompaction(querySource, agentId)` reset M05 的 prompt cache break baseline
- PTL 错误识别依赖 `PROMPT_TOO_LONG_ERROR_MESSAGE` 字符串(M05 提供)+ `getPromptTooLongTokenGap`(M05 解析错误响应中的 token gap)

### M06 → M14(Sub-agent)
- `createAsyncAgentAttachmentsIfNeeded` 把 LocalAgentTaskState 转 attachment 注回主线程,让主对话感知正在跑的子 agent
- `getDeferredToolsDeltaAttachment / getAgentListingDeltaAttachment` 重宣 agent definitions

### M06 内部 import 拓扑
- `compact.ts` 是顶层,被 `autoCompact.ts` 调
- `sessionMemoryCompact.ts` 通过 `buildPostCompactMessages / annotateBoundaryWithPreservedSegment / createPlanAttachmentIfNeeded` 复用 compact.ts 工具
- `microCompact.ts` 不调任何其他 compact 文件,**完全独立**(因为它不调 LLM)
- `apiMicrocompact.ts` 在 [services/api/claude.ts](src/services/api/claude.ts) 中被调,生成 context_management 字段
- `prompt.ts` 是 pure constants + formatters,无副作用
- `grouping.ts` 只导出 `groupMessagesByApiRound`

### memdir 内部拓扑
- `memdir.ts` 顶层(loadMemoryPrompt 入口)
- `paths.ts` 提供 getAutoMemPath(memoize)
- `teamMemPaths.ts` 依赖 paths.ts(team 是 auto 子目录)
- `memoryScan.ts` 是无副作用的扫描原语,被 `findRelevantMemories.ts` 和 `extractMemories.ts`(待读) 共享 —— 注释提及"避免环依赖,从 findRelevantMemories.ts 拆出来"
- `findRelevantMemories.ts` 调 `sideQuery`(待对照,非本模块)
- `memoryAge.ts` 纯函数

---

## 10. 补读修正(11 个 compact 文件全部精读后)

> 把 `compact.ts` 1705 行 + `microCompact.ts` 530 行 + `sessionMemoryCompact.ts` 630 行 + `autoCompact.ts` 351 行 + `prompt.ts` 374 行 + 其它 6 个小文件全部从头读完之后,以下是 §1-§9 没覆盖、但对"自己开发 Agent"有价值的工程细节。每条带"为啥需要"与"启示"。

### 10.1 [深化] `stripImagesFromMessages` 还要剥 tool_result 内嵌 document

`compact.ts:145-200` 不仅剥顶层 image/document,还**递归剥 tool_result.content 数组里嵌套的 image/document**,全部替换为 `[image]`/`[document]` 文本标记。

**为啥**:
- 图像本身让"compact API 调用自己"撞 prompt-too-long(CCD 会话用户频繁附图)
- 完全删除让摘要丢失"曾经传过图"这一事实
- 替换为占位符两全

**启示**:Agent 做 summary 调用前必须做"内容降级"而非"内容删除"——保留语义占位符,后续 LLM 知道"这里曾有图"。

### 10.2 [新增] `stripReinjectedAttachments` 删 skill_discovery / skill_listing

`compact.ts:211-223` 把会被 post-compact 重新注入的 attachment 类型从喂给 summarizer 的消息里剔除。

**为啥**:这些 attachment 注定要在 reset 之后由 SkillDiscovery 重发。让 summarizer 看到它们等于把"过期的 skill 建议"写进摘要,污染下一轮。

**启示**:**凡是"会被自动重生"的 context,不要让总结器看到**。否则会有"幽灵 context"——逻辑上重置但语义上保留。

### 10.3 [新增] `truncateHeadForPTLRetry` 的双道险招

`compact.ts:243-291`:

**险招 1:自身标记清理**——退出前先剥离上一次重试自己留下的 `PTL_RETRY_MARKER`,否则它会成为新 group 0,20% 回退只会反复"丢标记、加回标记",进度为 0。

**险招 2:group 0 处理**——`groupMessagesByApiRound` 把 preamble 放在 group 0,丢掉 group 0 会让剩下的序列以 assistant 开头,API 拒收(首条必须是 user 角色),所以会合成一条 meta=true 的 user PTL_RETRY_MARKER 作占位。

**启示**:任何"重试时插桩"的标记必须在**下次重试一开始**就识别并清掉,否则会出现"重试进度为 0"的死循环。

### 10.4 [新增] PTL 重试双路径状态线索

`compact.ts:487-490`:PTL 重试时既要更新 `messagesToSummarize` **又要** thread 一份新的 `cacheSafeParams.forkContextMessages`。

**为啥**:forked-agent 路径根本不读 messages 参数,它读的是 cacheSafeParams 里 fork 用的快照。

**启示**:**同样数据通过两条路径流转时,每条路径都要单独更新**,否则会出现"主线已截断、forked 还是旧的"——下游随机用哪条路径就随机正确。

### 10.5 [新增] `compactionCallTotalTokens` 字段重命名(但保字段名)

`compact.ts:626-642`:`postCompactTokenCount` 这个事件字段实际语义是"compact API 调用本身的总 token 消耗"(≈ preCompactTokenCount),而**不是**新上下文的大小。新引入 `truePostCompactTokenCount` 才是真正的结果上下文大小。

**为啥**:历史字段名固化在 BQ 表里,改名会断历史。只能新加一个准确字段并加注释。下一轮 `shouldAutoCompact` 看到的是 truePostCompactTokenCount + 20-40K 系统 prompt,所以 `willRetriggerNextTurn: true` 是强信号,false 仍可能触发。

**启示**:**telemetry 字段名一旦发布就是合同**。用"新增字段 + 注释"而不是改名,即使旧字段名误导。

### 10.6 [新增] `analyzeContext` 在 API 响应之后才执行

`compact.ts:687-694`:`analyzeContext` 在 4.5K 消息会话上要遍历每个 content block,耗时 ~11ms,仅用于 telemetry 维度。放在 compact API 的 `await` **之后才同步走**,避免阻塞渲染循环。

**启示**:**telemetry 的同步计算要刻意推迟到"用户感知不到"的位置**。"反正都要算" + "算在哪儿都行" → 算在最贵 await 后面,用户的 perceived latency 被那个 await 吃掉了。

### 10.7 [新增] `reAppendSessionMetadata` 维护 16KB 尾窗口

`compact.ts:711, 1057`:compact 后**重新追加**session 元数据(自定义 title、tag),让它留在 `readLiteMetadata` 读取的 16KB 尾窗口里。

**为啥**:否则 post-compact 消息会把元数据挤出 16KB 窗口,`--resume` 列表显示自动生成的标题而不是用户起的名字。

**启示**:任何"按文件末尾窗口读取"的元数据(如 git tag、systemd journal、log tail)都需要在**大变更后重新追加**,否则会被推出窗口。

### 10.8 [新增] `streamCompactSummary` 双重 keep-alive

`compact.ts:1167-1176`:`setInterval(30_000)` 同时做两件事:
1. PUT /worker heartbeat (`sendSessionActivitySignal`)
2. 重发 `'compacting'` SDK 状态事件

**为啥**:compact API 调用 5-10+ 秒,其间没有任何消息流过传输层。WebSocket 会被 server 当 stale 关闭,bridge 断线。两个独立 keep-alive 是冗余防御。

**启示**:**任何长时间无下行流量的同步调用都要主动心跳**。心跳来源最好分多层(传输层 keep-alive + 应用层状态事件)——一层挂了另一层还能保活。

### 10.9 [新增] forked-agent 路径**不能**设 `maxOutputTokens`

`compact.ts:1180-1187`:cache 共享 fork 要求 cache-key 完全一致,包括 thinking config。设 `maxOutputTokens` 会通过 `Math.min(budget, maxOutputTokens-1)` **改写 budget_tokens**,造成 thinking 配置与主线不一致,cache miss。streaming fallback 路径**可以**设。

**启示**:**参数共享 cache key 时,必须列清楚"哪些字段会被内部钳位改写"**。`maxOutputTokens` 看起来与 thinking 无关,但通过 budget 钳位间接破坏 cache key。

### 10.10 [新增] `isApiErrorMessage` 守护 ESC 中止伪装的"成功摘要"

`compact.ts:1206-1212`:`query()` 把 `APIUserAbortError` 也 catch 后产出一条 synthetic assistant message,文本是 "Request was aborted."——**不以 "API Error" 开头**,所以调用方的 `startsWithApiErrorPrefix` 检查放行,假摘要被当成功摘要写进上下文。必须先看 `assistantMsg.isApiErrorMessage` 元数据 flag。

**启示**:**检测"是否成功"不能只看文本前缀**,要看明确的元数据 flag。文本前缀是 LLM 决定的,可能任意变化。

### 10.11 [新增] `defer_loading` 工具不计 token

`compact.ts:1273-1276`:当 tool search 开启时,往 compact 请求里加 ToolSearchTool + MCP 工具,但带 `defer_loading: true`,API 在 token 计数前会从 system_prompt_tools 里 filter 掉。

**启示**:**注意第三方 API 是否提供"声明但不计费"的工具传递机制**——你能让模型知道"有这些工具可用"而不消耗 prompt token。是非常 underused 的优化。

### 10.12 [新增] `partialCompactConversation` 'up_to' 必须剥离旧边界

`compact.ts:785-799`:`direction='up_to'` 时,新 `summary_B` 放在 kept 之前。如果 kept 里有旧 `boundary_A`,`findLastCompactBoundaryIndex` 反向扫描会先命中 `boundary_A`,导致新 `summary_B` 被丢。`'from'` 不剥离,因为 `summary_B` 在 kept 之后。

**启示**:涉及"反向扫描定位"的算法在**数据布局变更时要重新审视**——同一个 finder 函数在不同方向操作下行为不同。

### 10.13 [新增] 'up_to' 命中 cache 前缀的精妙

`compact.ts:852-857`:'up_to' 只把 `messagesToSummarize` 送 API(prefix 命中 cache);'from' 不得不送全部消息(尾巴本来就不在 cache 里)。PTL 重试会破坏 cache prefix 但能解锁。

**启示**:**在不同方向操作上下文时,明确"哪段对当前 cache 友好"**。"up_to" / "from" 看起来对称,在 cache 视角下完全不对称。

### 10.14 [新增] `createPostCompactFileAttachments` 跳过 `FILE_UNCHANGED_STUB`

`compact.ts:1610-1655`:扫描已被 dedup-stub 替换的 Read tool_result,对应 `tool_use_id` 放进 `stubIds`;后续不把这些 file_path 加进 `preservedReadPaths`。

**为啥**:stub 指向"更早的真实 Read",那次真实 Read 可能已被压缩掉。如果按 stub 跳过重新注入,模型会完全失去这个文件的内容。

**启示**:**任何"内容去重 stub"在跨边界操作时要回查"原始内容是否还存活"**。去重链很容易在边界变更时断裂。

### 10.15 [新增] `MAX_OUTPUT_TOKENS_FOR_SUMMARY=20_000` 基于 p99.99=17,387

`autoCompact.ts:28-30`:不是拍脑袋,是真实生产数据 p99.99 是 17,387 token,留 ~15% 余量到 20,000。

**启示**:**容量预留要基于真实分位数**——max 太极端(可能就一次异常 50K),p99.99 已经覆盖 99.99% 真实需求。少数 outlier 走 truncate 兜底,不为它们浪费 100% 用户的 token budget。

### 10.16 [深化] CONTEXT_COLLAPSE 抑制 autocompact 的精确门控

`autoCompact.ts:215-223`:
- collapse 是"90% commit / 95% blocking-spawn"
- autocompact 在 ~93% 触发——**夹在中间**
- 若不抑制,autocompact 会跑赢 collapse,把它正要保存的 granular context 全炸掉

**关键设计**:在这里抑制而**不是** `isAutoCompactEnabled()` 里抑制——后者会把 reactiveCompact 也禁掉(它直接读 `isAutoCompactEnabled`)。reactiveCompact 是 413 兜底,必须存活。

**启示**:**两套"上下文管理机制"共存时,要明确各自的触发阈值带,并通过精确门控让兜底机制存活**。"统一开关" 看起来干净,实际把不同语义的东西耦合。

### 10.17 [新增] `marble_origami` 防自毁

`autoCompact.ts:179-183`:若 ctx-agent (marble_origami) 自身上下文爆炸触发 autocompact,`runPostCompactCleanup` 会调 `resetContextCollapse`——**会摧毁主线已 commit 的日志**(模块级状态跨 fork 共享)。

**启示**:**跨 fork 共享模块级状态的清理函数,必须在"哪些 querySource 能触发它"上极度小心**。"模块级单例 + 多 agent" 是个潜伏炸弹,清理函数是引信。

### 10.18 [新增] `snipTokensFreed` 修正可见 token 数

`autoCompact.ts:165-167, 225`:snip 已经物理删消息,但**残留 assistant 的 usage 仍反映 snip 前的 input_tokens**。`tokenCountWithEstimation` 看不到节省。所以 snip 把估算的节省量传过来,autocompact 阈值判断时减掉。

**启示**:**当 telemetry 反映"过去状态"时,必须主动传递"delta 修正"**——否则后续逻辑会基于陈旧值反复触发(autocompact 看不到 snip 已经省下的 token,继续触发)。

### 10.19 [新增] BQ 2026-03-01:缺少 `notifyCompaction` 导致 20% 假阳性

`autoCompact.ts:297-305`:legacy compact 在内部自己调 `notifyCompaction`;sessionMemory 路径没调,造成 20% 的 `tengu_prompt_cache_break` 事件是假阳性(`systemPromptChanged=true, timeSinceLastAssistantMsg=-1`)。

**启示**:**新增的并行路径要"逐项对齐"老路径的副作用**,否则 telemetry 会被污染。新路径上线前 audit 老路径的所有"看起来无关的"调用。

### 10.20 [新增] 熔断 counter 通过返回值往上抛(不持有状态)

`autoCompact.ts:257-265, 341-349`:failures 计数器放在 tracking state 由调用方维护,`autoCompactIfNeeded` 不持有状态。每次返回 nextFailures 让 query loop 决定是否在下一轮再试。

**启示**:**跨调用计数器应该是返回值传递的**,不要让函数自身持有状态——否则测试与并发都难处理(任何全局可变状态都污染测试隔离)。

### 10.21 [新增] `TIME_BASED_MC_CLEARED_MESSAGE` 内联破循环依赖

`microCompact.ts:34-36`:这个常量本应从 `utils/toolResultStorage` 导入,但那会拉出 `sessionStorage → messages → api/errors → 回到本文件的 promptCacheBreakDetection` 循环依赖。改用**内联 + drift 测试守护**(单元测试比较内联值与源值确保一致)。

**启示**:**循环依赖的解法不止"重构拓扑"**,常量内联 + 同步测试也是合法手段。重构图全删要付出 PR 大;内联 + 测试只增 5 行。

### 10.22 [深化] `estimateMessageTokens` 必须与 `roughTokenCountEstimationForBlock` 对齐

`microCompact.ts:164-205`:
- thinking 只算 thinking 文本(不算 JSON 壳和 signature——signature 是元数据不被模型 tokenize)
- tool_use 只算 name + JSON.stringify(input),不算 JSON 壳和 id
- 最后 ×4/3 保守膨胀

**启示**:**token 估算函数之间必须"逐 block 类型对齐"**,否则两个估算的差值会在阈值判断里造成抖动。同一上下文,函数 A 估 95K,函数 B 估 98K → 一个判定"不超",一个判定"超"。

### 10.23 [新增] `isMainThreadSource` 的 prefix-match 修复

`microCompact.ts:247-251`:`outputStyle` 非默认时 querySource 是 `repl_main_thread:outputStyle:<style>`。原先的 `=== 'repl_main_thread'` 是**潜伏 bug**——非默认 outputStyle 用户被静默排除在 cached MC 之外。

**启示**:**任何 querySource 比较都要用 `startsWith`**;纯相等比较是 bug 模板。**这条规则适用整个 codebase**(也是 §10.44 的不变量 #1)。

### 10.24 [新增] time-based MC 短路 cached MC

`microCompact.ts:263-271`:时间间隔 >60min 时,server cache TTL 已过期;cached MC 的 `cache_edit` 操作建立在"warm cache"假设上,**没意义**。

**启示**:**多策略并存时要明确"哪个策略隐含哪个前提"**,前提失效就要短路掉。否则会做"零收益但有副作用"的工作。

### 10.25 [新增] `floor at 1` 防 `slice(-0)` 陷阱

`microCompact.ts:461`:`slice(-0)` 返回**整个数组**(不是空数组),且 `keepRecent=0` 又是"清空所有工具结果"的退化情况。两者叠加意义都不合理。强制 floor 到 1。

**启示**:**涉及 slice 负参数的代码要小心 `-0 ≠ 0`**——JS `Math.sign(-0) === -0`,`slice(-0) === slice(0) === whole array`。需要 `Math.max(1, n)` 保护。

### 10.26 [新增] `resetMicrocompactState` 在 time-based 后必须调

`microCompact.ts:511-517`:模块级 `cachedMCState` 持有的是上一轮的 tool ID。time-based 刚改了 prompt content(server cache 已失效)。下一轮 cached-MC 若还按旧 state 跑,会试图 `cache_edit` 一个 server 侧根本不存在的条目。

**启示**:**任何"修改了 prompt 内容"的操作之后,要把"假设 cache 命中状态"的下游模块状态重置**——cache 失效是级联的。

### 10.27 [新增] `baselineCacheDeletedTokens` 用于消除累计字段的"卡顿"

`microCompact.ts:373-394`:API 的 `cache_deleted_input_tokens` 是 cumulative,不是 per-operation。要计算"本次 cache_edits 删除了多少",必须先从上一条 assistant message 抓 baseline,回来后才能做减法。

**启示**:**任何 API 返回的 cumulative metric 都需要 client 端做差分**——不能直接当 per-operation 用。这是 telemetry 设计的常见陷阱。

### 10.28 [新增] 两种工具清理策略对应两种 token 形态

`apiMicrocompact.ts:19-32, 104-150`:
- **TOOLS_CLEARABLE_RESULTS**(shell/Grep/Glob/Read/WebFetch/WebSearch):bulk 在 `tool_result` 里 → 用 `clear_tool_inputs`
- **TOOLS_CLEARABLE_USES**(Edit/Write/NotebookEdit):bulk 在 `tool_use input`(diff 内容)里 → 用 `exclude_tools`("清掉所有除这些之外的")

**启示**:**不同工具的"重量"分布在 input 还是 output 不同位置**;清理 API 要按位置选策略。Read 的重量是返回的文件内容,Write 的重量是 input 的 diff——同样是"减肥"目标完全不同。

### 10.29 [新增] `clear_thinking_20251015` 必须显式设 `value: 1`

`apiMicrocompact.ts:82-87`:`keep: { type: 'thinking_turns', value: 1 }` 是因为 API schema 要求 `value>=1`,**省略会回退到模型默认**(往往 "all")反而不清理。

**启示**:**API 设计上"省略=默认"可能不是你想要的"省略=禁用"**,必须显式传 value 才有真清理效果。看 SDK 默认而非看 schema。

### 10.30 [新增] `clear_at_least = triggerThreshold - keepTarget`

`apiMicrocompact.ts:118-121`:不只设 trigger 阈值,还要设"至少清掉多少",否则 API 可能只挪一两个 tool_use 就退出,反复触发。

**启示**:**任何"触发 + 执行"的两段式 API,触发阈值之外还要设"最小执行量"**——否则"刚好不触发"和"触发了但没做啥"无限反复。

### 10.31 [新增] `adjustIndexToPreserveAPIInvariants` 两步修正

`sessionMemoryCompact.ts:232-314`:
- **Step 1**(tool 配对):必须在**全部 kept 范围内**收集 `tool_result_ids`(不是只看 startIndex 那一条),否则 streaming 切分会让一个 round 跨多个 message.id 相同的 message,导致后续配对失败
- **Step 2**(thinking 块):同一 message.id 的多条 streamed message,若 startIndex 落在 tool_use 那条,前面的 thinking 块会被切掉,`normalizeMessagesForAPI` 之后 thinking 没消息可合并被丢弃

**启示**:**streaming 把"概念上一条 assistant message"拆成多个 record**(同 id,不同 uuid)。基于"上一条/下一条"的切分算法必须先做"按 id 聚合"才能正确切。

### 10.32 [新增] `calculateMessagesToKeepIndex` floor 在最后一个 boundary

`sessionMemoryCompact.ts:368-371`:反向扩张时不能跨过最近的 compact boundary,否则 preserved-segment 的链有 disk 端断点(`att[0]→summary` 由 dedup-skip 制造的捷径),loader 反向遍历会绕过内层 kept 消息然后把它们 prune 掉。

**启示**:**边界点不只是"语义分界",也是"存储链的物理断点"**,扩张算法必须显式 floor。逻辑视图和物理视图不一致是个常见陷阱。

### 10.33 [新增] `messagesToKeep` 必须过滤旧 boundary

`sessionMemoryCompact.ts:575-581`:REPL 在产出 messages 后会做一次 boundary prune;若 `messagesToKeep` 里包含旧 boundary,prune 会把"新 boundary + 新 summary"也一并丢掉。

**启示**:**任何"被保留段"在重新拼接前要先做"语义类型过滤"**,特别是控制流标记类消息(如 boundary、separator、divider)。

### 10.34 [新增] `postCompactTokenCount` 阈值检查防"摘要比原文还大"

`sessionMemoryCompact.ts:605-614`:构建完 result 后**检查整体 token 是否仍超 autoCompactThreshold**——超就返回 null 让 legacy 路径接管。

**启示**:**自定义压缩路径必须有"结果反而更大就放弃"的逃生口**——任何"优化路径" 都可能在 edge case 上反向。逃生回退到通用路径是优雅降级。

### 10.35 [新增] `NO_TOOLS_PREAMBLE` 前后双重防御

`prompt.ts:19-26, 269-272`:Sonnet 4.6+ adaptive-thinking 模型有 2.79% 概率(4.5 是 0.01%)会尝试 tool call 即使 trailer 已说不要。`maxTurns=1` 下被拒就是"一次都没回字",falls through 到 streaming fallback 浪费一轮。

**对策**:把"不要 tool call" 放在 prompt 最前(preamble)和最后(trailer)双重位置。

**启示**:**模型升级会让"位置敏感的指令"重要性翻几十倍**;越关键的指令越要**前置+反复**。不要因为"上次没问题"就以为新模型也没问题。

### 10.36 [新增] `formatCompactSummary` 剥 `<analysis>` scratchpad

`prompt.ts:311-335`:让模型先在 `<analysis>` 块里"思考"再写 `<summary>`,但只把 summary 写进 context,**analysis 是一次性 drafting scratchpad**。

**启示**:**让 LLM 输出"思考过程 + 最终结果"两段,只入库结果**——比单纯让它"先思考再回答"更可控。CoT(chain of thought)+ extract pattern。

### 10.37 [新增] `suppressFollowUpQuestions` 强指令禁止寒暄

`prompt.ts:357-360`:显式说"不要 acknowledge summary、不要 recap、不要 'I'll continue' 前缀,pick up the last task as if the break never happened"。

**启示**:**模型在 compaction 后默认会有"哦那我接着..."的寒暄输出**,浪费 token 也破坏用户感知;用强禁止性指令压住。这是 prompt engineering 的反模式补救——本来该用 RLHF 训掉的行为,只能在 inference time 用 prompt 压。

### 10.38 [新增] `groupMessagesByApiRound` boundary 只看 assistant message.id

`grouping.ts:38-43`:**不追未解决 tool_use ID**。如果追了,对 malformed 对话(resume/截断后留下悬空 tool_use)会把 boundary "永久焊死",所有后续 round 合成一组。

**启示**:**选择 boundary 算法时要分析"最坏输入下会不会让边界永不触发"**——后者比"偶尔切错"还致命(永不切 → 数据永远不被处理)。

### 10.39 [新增] CC-1180:`grouping.ts` 抽到独立文件破循环依赖

`grouping.ts:18-21`:`compact.ts ↔ compactMessages.ts` 循环依赖让 module init 顺序漂移,触发了 CI shard-2 的 ws CJS/ESM 解析竞态。

**启示**:**循环依赖往往让"无关 bug"在意料之外的位置爆炸**;抽小函数到独立文件是廉价解法。`ws` 包的 CJS/ESM 解析竟然能被你的循环依赖影响——这种远程关联让人没法直接调试。

### 10.40 [新增] `isMainThreadCompact` 门控模块级 reset

`postCompactCleanup.ts:36-49`:子 agent 跟主线**共享同进程模块级状态**(contextCollapse store、`getMemoryFiles` 一次性 hook flag、`getUserContext` cache)。子 agent compact 触发这些 reset 会破坏主线。

**门控**允许:`undefined` / `repl_main_thread*` / `sdk`。

**启示**:**任何"模块级单例"在多 agent 共享进程里都是隐患**;清理函数要按调用方身份精确门控。"全局单例" 在 multi-tenant 架构里要么不存在,要么每个 reset 都需要 caller-aware。

### 10.41 [新增] `getUserContext.cache.clear` 必须和内层 reset 一起做

`postCompactCleanup.ts:52-61`:`getUserContext` 是 `getMemoryFiles` 的**外层 memoize**。只清内层不清外层,下一轮命中外层缓存,**永远不进内层**,armed 的 `InstructionsLoaded` hook 永远不触发。

**启示**:**多层缓存必须按"从外到内"全部清**;只清最内层是常见 bug。缓存图至少要画出来,reset 函数要明确"这层 reset 之后,谁可能还命中上游 cache?"

### 10.42 [新增] `timeBasedMCConfig` 的 GB 读取**外提**

`timeBasedMCConfig.ts`:gapThresholdMinutes=60 是 server 1h cache TTL 的"全用户安全值"——保证永不强制 miss 一个本来不会 miss 的请求。GB(GrowthBook) 读取**外提**到无条件位置确保 exposure event 永远触发,否则被下游条件 short-circuit 时 GB 看不到真实曝光,**实验数据有偏**。

**启示**:**GrowthBook / feature flag 的 exposure event 要在无条件位置触发**——否则你的实验 metric 会被"曝光选择"扭曲(只有满足下游条件的人才算曝光,这些人本来就更可能转化)。

### 10.43 跨文件不变量(KEEP IN SYNC 列表)

10 条跨文件必须同步的不变量:

1. **`querySource` 比较一律用 `startsWith`**:`isMainThreadSource`(microCompact)、`runPostCompactCleanup` 的 isMainThreadCompact、query.ts 350/1451 都用 startsWith 处理 `repl_main_thread:outputStyle:*` 变体。任何 `===` 比较都是潜伏 bug
2. **`shouldAutoCompact` + cleanup `querySource` 双重防自毁**:forked agent 类 querySource(`compact`、`session_memory`、`marble_origami`)必须在 shouldAutoCompact 早返 false;postCompactCleanup 必须按 querySource 守住模块级 reset。两道闸都得在
3. **`notifyCompaction` / `notifyCacheDeletion` 必须紧跟所有 cache-invalidate 操作**:legacy compact、sessionMemoryCompact、time-based MC、cached MC 任何一个修改了 prompt content 的路径都要调,否则 prompt_cache_break telemetry 出 ~20% 假阳性
4. **`markPostCompaction` 在所有 compact 成功路径都要调**:legacy + sessionMemory 都显式 mark;缺一就有下游 logic 误以为"还没 compact 过"
5. **boundary 之后保留段的拼接顺序固定**:`buildPostCompactMessages` 集中实现为 boundaryMarker → summaryMessages → messagesToKeep → attachments → hookResults。partialCompact 也走这个函数;任何手工拼接都会偏离
6. **`annotateBoundaryWithPreservedSegment` anchor 选法**:prefix-preserving(partial 'from')anchor = boundary;suffix-preserving(reactive / session-memory / partial 'up_to')anchor = 最后一条 summary。loader 的链修复算法依赖这个不变量
7. **token 估算函数对齐 block-by-block**:`estimateMessageTokens` 与 `roughTokenCountEstimationForBlock` 必须按 thinking/tool_use 的 token 算法逐项一致,否则两个估算的 drift 会让阈值判断在边缘抖动反复触发
8. **compaction 内 streaming 路径必须维持 30s 心跳**:任何 long-await 的 API 调用都要双 keep-alive(worker heartbeat + SDK 状态再发),否则 WebSocket bridge 会断
9. **forked-agent 共享 cache 时禁止任何会被内部钳位改写的参数**:thinking config / maxOutputTokens / model / tools / system prompt 必须与主线完全一致,否则 98% cache miss
10. **invoked skill 内容跨多次 compact 不重置**:`createSkillAttachmentIfNeeded` 需要它存活,`runPostCompactCleanup` 与 `compactConversation` 都明确**不清**。同理 `sentSkillNames` 也不清,省 ~4K tok/compact

### 10.44 补读后的新待确认问题

5 个新问题(原 §8 之外):

1. **`adjustIndexToPreserveAPIInvariants` 在 PTL 路径下的行为**——它只在 sessionMemoryCompact 调,legacy compact PTL 重试时不调。如果 legacy 的 group-based 切分也有 streaming 拆分问题,是否需要类似修复?
2. **`baselineCacheDeletedTokens` 在 sessionMemory 路径的等价物**——sessionMemory 不走 cache_edits,但 telemetry 上 "cache_deleted_input_tokens delta" 怎么算?
3. **`partialCompactConversation` 是否被用户主动 invoke**(slash command),还是只内部用?注释里多次提到 'up_to'/'from' 但没看到 user-facing entry
4. **`forkContextMessages` 完整 schema**——只看到 `messages` + `cacheSafeParams` 子集,还有什么字段?
5. **`stripImagesFromMessages` 是否考虑 video / audio block**?(将来的 multimodal 扩展)

---

**下一步**:M05 Model API client(`services/api/claude.ts` 3419 行),聚焦 Anthropic SDK 的封装、retry/重连、stream 处理、prompt caching、multi-region failover、token counting、stop_reason 调度、headers 注入(含 OTel/extras)。

> **结论**:M06 是 Claude Code 的"上下文工程"集大成之作。21 个工程精髓中,**前 7 个**(多层压缩、递归守卫、熔断器、NO_TOOLS 三件套、9-section schema、后压缩预算、不全量重置)是任何长跑 Agent 的**最低必备**。**后 14 个**则是从生产数据反推 / 安全审计 / eval 验证 / 实验灰度得来,值得**逐个 mapping** 到自研 Agent 设计。
