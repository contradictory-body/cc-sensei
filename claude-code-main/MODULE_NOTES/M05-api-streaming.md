# M05 模型 API 与流式调用

## 1. 模块定位

`services/api/*` 是位于 **Agent loop / Tool 层** 与 **Anthropic SDK / 第三方网关** 之间的"模型客户端层"。负责:

- 把 `query.ts` 给的 `messages + tools + options` 翻译为 `anthropic.beta.messages.create({stream:true})` 的入参
- 流式消费 `MessageStreamEvent` 并转换为内部 `AssistantMessage` 流
- 在网络/API 异常时按 4-5 路径升级:retry → fallback model → non-streaming → fail with /rewind hint
- 维护 prompt cache 的"破裂检测"(2-phase),写埋点诊断
- 维护 4 种 provider(Anthropic 直连 / Bedrock / Foundry / Vertex)的客户端
- 把每次请求的 `token usage` / `costUSD` / `requestId` / `gateway` / `betas` 写入 1P/OTel 埋点
- 把 SDK 异常翻译成对用户更友好的 `AssistantMessage`(带 /rewind / /model / /login 提示)

边界:**不**做 prompt 拼装(交给 `services/compact/` + `context.ts`)、**不**做 tool 调度(交给 `services/tools/`)、**不**做权限决策(交给 `hooks/useCanUseTool`)。

---

## 2. 关键文件

| 文件 | 行/字节 | 角色 |
|---|---|---|
| `services/api/claude.ts` | 3419 行 / 126K | **核心**: queryModel(streaming)、queryModelWithoutStreaming、addCacheBreakpoints、updateUsage、buildSystemPromptBlocks |
| `services/api/withRetry.ts` | 822 行 / 28K | retry 生成器(yield SystemAPIErrorMessage)、5 路 fallback 触发条件、persistent retry 模式 |
| `services/api/errors.ts` | 1199 行 / 41K | getAssistantMessageFromError(20+ 分支)、classifyAPIError(15 桶)、3P fallback suggestion |
| `services/api/errorUtils.ts` | 261 行 / 8.4K | extractConnectionErrorDetails(SSL 错误 cause chain)、formatAPIError、sanitizeAPIError(剥离 HTML) |
| `services/api/promptCacheBreakDetection.ts` | 728 行 / 26K | 2-phase 缓存破裂检测(record + check)、per-tool hash diff、LRU per source |
| `services/api/client.ts` | 390 行 / 16K | getAnthropicClient(4 provider 分支)、buildFetch 注入 x-client-request-id |
| `services/api/bootstrap.ts` | 142 行 / 4.6K | /api/claude_cli/bootstrap 拉取 client_data + additional_model_options(zod 校验,disk 缓存) |
| `services/api/logging.ts` | 789 行 / 24K | logAPIQuery / logAPIError / logAPISuccessAndDuration、detectGateway(7 种)、OTel span |
| `services/api/usage.ts` | 64 行 / 1.7K | fetchUtilization(/api/oauth/usage)→ 限额 / 配额可视化 |
| `services/api/firstTokenDate.ts` | 60 行 / 1.7K | 用户首次使用日期回写 config(用于 onboarding/告警) |
| `services/api/emptyUsage.ts` | ~30 行 | 单点常量 EMPTY_USAGE |
| `services/api/sessionIngress.ts` | 17K | 会话上行(待读) |
| `services/api/grove.ts` | 11K | Grove 反馈/政策弹窗(M01 中已部分接触) |
| `services/api/filesApi.ts` | 21K | 文件上传(图片/PDF) — 与 stream 主路径无直接耦合 |

---

## 3. 核心抽象

### 3.1 三个流(stream)

```
1) network stream      = anthropic SDK 内部的 SSE 解码流
2) message stream      = MessageStreamEvent[]  ← claude.ts 直接消费
3) UI stream           = AsyncGenerator<APIQueryResult>  ← 由 queryModel yield 输出
```

`UI stream` 的事件分两种:
- `{ type: 'stream_event', event: <BetaMessageStreamEvent>, ttftMs? }` — 透传给上层用于流式渲染
- `<AssistantMessage>` — 在 `content_block_stop` 后由 `normalizeContentFromAPI` 拼装并 yield

→ **设计含义**:UI 层既能拿到原始事件(用于 token-by-token 渲染),也能拿到组装好的消息(用于状态机推进)。

### 3.2 5 路 Fallback 升级链

```
queryModel
  ├─ withRetry 内部
  │    ├─ 普通 5xx/429 → 退避重试 (DEFAULT_MAX_RETRIES=10)
  │    ├─ 持续 529 ≥ 3 次 + 有 fallbackModel
  │    │    → throw FallbackTriggeredError → 上抛 query.ts → 切换模型重试
  │    ├─ 持续 529 ≥ 3 次 + 无 fallbackModel + 外部用户 + 非 sandbox
  │    │    → REPEATED_529_ERROR_MESSAGE
  │    ├─ 客户端身份错误(401, OAuth refresh, Bedrock/Vertex)→ 重建 client 再重试
  │    └─ context overflow ("input length and `max_tokens` exceed context limit")
  │         → 解析 token gap → 调整 max_tokens → 重试
  │
  ├─ 流外异常(stream 创建失败)
  │    └─ 4xx 的 createPath 上的 404 → 先尝试 stream → 失败再走 non-streaming
  │
  ├─ stream 内异常(中途断流)
  │    └─ 走 executeNonStreamingRequest(120s/300s 超时) → cap 64K tokens
  │
  └─ stream watchdog(空闲超时)
       ├─ STREAM_IDLE_WARNING_MS = 45s → 仅警告
       └─ STREAM_IDLE_TIMEOUT_MS = 90s → abort,转 non-streaming
```

**关键观察**:每一层都不认知更高层的存在 — `withRetry` 不知道 `executeNonStreamingRequest` 的存在,`queryModel` 也不知道 `query.ts` 会拦截 `FallbackTriggeredError`。这是"职责分层 + 异常向上贯穿"的典型模式。

### 3.3 Sticky-on Beta Header Latches

`claude.ts:1412-1456` 中 4 个 latch:

| Latch | 触发条件 | 清除时机 |
|---|---|---|
| `afkHeaderLatched` | 任意 afk 请求曾经发起过 | `/clear` `/compact` |
| `fastModeHeaderLatched` | speed='fast' 曾经发起过 | `/clear` `/compact` |
| `cacheEditingHeaderLatched` | 曾经发过 cache_edits | `/clear` `/compact` |
| `thinkingClearLatched` | 曾用过 redact_thinking | `/clear` `/compact` |

**为什么是 sticky-on?**:`anthropic_beta` header 一旦从 `[a,b,c]` 变成 `[a,b]`,会 invalidate Mycro 缓存的 KV page。每次切换都丢一次 ~50-70K token 的 prompt cache。所以**保持 header 一直加上**比"按需加"更便宜(空 header 与有 header 不命中同一缓存)。

→ `claude.ts:1080-1111`(advisor latches)、`claude.ts:1412-1456`(主 latches)

### 3.4 单 message-level cache_control marker

`claude.ts:3063-3211` `addCacheBreakpoints`:

```
markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
└─ 只在最后(或倒数第二)一条消息的最后一个 content block 上挂 cache_control: {type:'ephemeral', ttl?:'1h', scope?:'global'}
└─ 同时把所有 lastCCMsg 之前的 tool_result block 自动加 cache_reference: tool_use_id(用于 cached MC 模式)
```

**为什么只挂一个?** Mycro 服务端为每个 cache_control 算一个 KV page 锚点;锚点越多,锚点之间的差异都得记录;一个锚点 = 一个缓存边界 = 增量重算最少。

注释里的硬约束:
```ts
// IMPORTANT: Do not add any more blocks for caching or you will get a 400.
//            We can only have a maximum of 4 cache control blocks.  -- buildSystemPromptBlocks
```

### 3.5 2-Phase Prompt Cache Break Detection

```
recordPromptState (Phase 1, before send)
  ├─ 14 字段哈希: systemHash / toolsHash / cacheControlHash / toolNames / perToolHashes /
  │              systemCharCount / model / fastMode / globalCacheStrategy / betas /
  │              autoModeActive / isUsingOverage / cachedMCEnabled / effortValue / extraBodyHash
  ├─ 第一次见 → 存基线
  └─ 后续 → 与基线 diff,生成 12-flag pendingChanges
       └─ 不发任何事件(等响应才决定是否真的破了)

checkResponseForCacheBreak (Phase 2, after response)
  ├─ 触发条件: cache_read_tokens 比上次掉 (>5% AND >2000 tokens)
  ├─ 把 pendingChanges 翻成可读 reason: "cache_control changed; tool added: GrepTool"
  ├─ 把 'mcp__*' tool 名 sanitize 成 'mcp'(防文件路径泄漏)
  ├─ 触发 tengu_prompt_cache_break 埋点
  └─ ant 用户额外写 /tmp/.../cache-break-diff-XXXX 给团队复盘
```

**核心见解**:**单独看 hash 变化预判会过报警**(很多 schema 变化在缓存层根本无影响)。**单独看 cache_read drop 不知道为什么破**。**两者关联**才能产出 actionable 数据。

→ `promptCacheBreakDetection.ts:182-185` 的 `sanitizeToolName('mcp__*' → 'mcp')` 是埋点合规性的重要一环

### 3.6 Provider 客户端选择

`client.ts:88-316`:

```
useBedrock        → AnthropicBedrock (AWS_BEARER_TOKEN_BEDROCK 优先,refreshAndGetAwsCredentials 兜底)
useFoundry        → AnthropicFoundry (Azure AD: DefaultAzureCredential 或 API key)
useVertexAI       → AnthropicVertex (projectId fallback,避开 12s GCE metadata 超时)
default           → Anthropic       (apiKey null + OAuth authToken;USE_STAGING_OAUTH baseURL 切换)
```

**`AnthropicVertex` 的 12s 防御**(`client.ts:221-298`):
- 当用户没设 `GCLOUD_PROJECT` 也没设 `GOOGLE_APPLICATION_CREDENTIALS` 时,默认 SDK 会去 GCE metadata server `http://169.254.169.254/...`,在非 GCP 环境 12 秒超时
- 这里**预先**调 `getProjectIdSync()`(从 `gcloud config` 等几个低开销来源)注入,避免 SDK 走 metadata server

→ 这是典型的"对 SDK 黑盒行为做主动短路"的工程动作。

### 3.7 4-字段 BetaMessageStreamParams 装配

`claude.ts:1538-1729` `paramsFromContext` **闭包**:

```ts
const paramsFromContext = (retryContext?: RetryContext) => ({
  // 必填基础
  model, messages, system, tools, max_tokens,
  // 缓存与 thinking
  thinking: getAPIContextManagement(...),  // adaptive vs budget
  // 用户/effort/budget
  metadata: getAPIMetadata(),
  effort: configureEffortParams(...),
  output_config: configureTaskBudgetParams({...}),
  // betas
  betas: mergedBetas,
  // 速度/优先级
  speed: fastMode ? 'fast' : undefined,
  // ant-only
  anthropic_beta: { ... }
})
```

**关键设计**:`paramsFromContext` 是**闭包**,因为它会被多次调用 — `withRetry` 每次 retry 都重新调用一次,从而:
- `retryContext.maxTokensOverride` 能在 context overflow 后调小
- `previousRequestId` 能拿到上次 attempt 的 ID(请求关联)

但 `consumePendingCacheEdits()` 是**只能消费一次**的副作用,所以**必须在 `paramsFromContext` 定义之前**就调用一次缓存下来(`claude.ts:1531-1532`),后续每个 attempt 复用同一个 cacheEdits。

### 3.8 Generator + Yield 的 retry 状态推送

```ts
async function* withRetry(fn, ...) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(retryContext)  // 成功直接返回 BetaMessage
    } catch (e) {
      if (shouldRetry(e)) {
        yield createSystemAPIErrorMessage(...)  // 让 UI 看到"retrying..."
        await sleep(getRetryDelay(attempt))
      } else throw e
    }
  }
}
```

**含义**:`withRetry` 既是"重试 wrapper",也是"事件流" — UI 立即看到失败并显示倒计时,不需要轮询。

→ `withRetry.ts:170-517`

### 3.9 释放 stream 资源(GH #32920)

```ts
const releaseStreamResources = () => {
  if (stream) {
    try { stream.controller?.abort?.() } catch {}
    try { result?.response?.body?.cancel?.() } catch {}
  }
}

try { ... }
finally {
  releaseStreamResources()  // 总是释放
}
```

**为什么必要?** Anthropic SDK 内的 SSE 解析器持有 native TLS socket buffer,如果不在 finally 显式 cancel,GC 不会释放 native 内存,导致长会话内存泄漏。这是 GH issue #32920 报告的 bug 修复。

→ `claude.ts:1519-1526` + `claude.ts:2810-2820`

### 3.10 message_delta 的 0 值"防回填"

```ts
function updateUsage(usage, part) {
  if (part.usage.input_tokens > 0) usage.input_tokens = part.usage.input_tokens
  if (part.usage.cache_creation_input_tokens > 0) ... // > 0 guard
  if (part.usage.cache_read_input_tokens > 0) ...
  // output_tokens 没有 > 0 guard,因为它单调累加
}
```

**为什么要 > 0 guard?** Anthropic API 在 `message_delta` 事件里会返回 `input_tokens=0` 等"未变化"的字段(传输优化);但如果直接覆盖,就会把 `message_start` 里实际值清零。

→ `claude.ts:2924-2987`

---

## 4. 数据流 / 控制流

### 4.1 入口

```
query.ts (Agent loop) 
  └─ queryModel(messages, system, tools, options, model, advisor?, advisorHistory?)
       ↓
       claude.ts:1017
```

### 4.2 主流程时序(成功路径)

```
1. queryModel(args)
2. 检查 tengu-off-switch → 通过
3. 解析 mergedBetas、effort、taskBudget、taskBudgetRemaining
4. 处理 advisor model(如果有)
5. tools 过滤 → toolsForCacheDetection / toolsForAPI
6. normalizeMessagesForAPI(messages)
7. ensureToolResultPairing(messages)  ← 修复孤立 tool_use/tool_result
8. stripExcessMediaItems(messages)    ← 100 媒体上限
9. computeFingerprintFromMessages()   ← 在 inject 之前
10. <available-deferred-tools> sentinel inject(若 useDeltaInjection 关闭)
11. buildSystemPromptBlocks(...)      ← 含 cache_control 锚点
12. 4 个 latch 检查(afk/fastMode/cacheEditing/thinkingClear)
13. recordPromptState(...) ← Phase 1
14. startLLMRequestSpan(...) ← OTel(beta only)
15. consumePendingCacheEdits() ← 只调一次
16. paramsFromContext = (retryContext?) => {...}  ← 闭包
17. withRetry(async () => {
18.   const result = await anthropic.beta.messages.create({
19.     ...paramsFromContext(),
20.     stream: true
21.   }).withResponse()
22.   return result  // {request_id, response, body:stream}
23. })
24. setup stream watchdog (45s warn / 90s timeout)
25. for await (part of body) {
26.   switch (part.type) {
27.     case 'message_start': updateUsage(usage, part)
28.     case 'content_block_start': contentBlocks[index] = init block
29.     case 'content_block_delta': merge into contentBlocks[index]
30.     case 'content_block_stop': 
31.         normalizeContentFromAPI() 
32.         yield AssistantMessage
33.     case 'message_delta': updateUsage(usage, part); stop_reason captured
34.   }
35.   yield {type:'stream_event', event: part, ttftMs?}
36. }
37. checkResponseForCacheBreak(...) ← Phase 2
38. logAPISuccessAndDuration(...)
39. finally: releaseStreamResources()
```

### 4.3 错误路径

```
catch (streamingError) {
  if (APIUserAbortError) re-throw
  if (CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) throw
  
  // 转 non-streaming
  const message = await executeNonStreamingRequest({
    ...paramsFromContext(),
    consecutive_529_errors  // 必须保留计数!
  })
  yield message
}
catch (error) {
  if (FallbackTriggeredError) re-throw  // 让 query.ts 切换 model
  
  // 404 stream 创建失败 → 重新走 non-streaming
  // 其他 → 翻译为用户消息
  const errorMsg = getAssistantMessageFromError(error)
  yield errorMsg
  logAPIError(...)
}
finally {
  stopSessionActivity()
  releaseStreamResources()
}
```

### 4.4 异步 / 取消

- `signal: AbortController` 通过 options 传入,任何阶段都能 abort
- `APIUserAbortError` 是用户主动取消(esc),与 watchdog idle abort 区分(StreamIdleAbortError)
- `setupGracefulShutdown` 在进程信号时会调 cleanup registry,把 stream cancel

---

## 5. 工程设计精髓

### 原则 1:Sticky-on Beta Headers — 性能 > 简洁

- **体现**:`claude.ts:1412-1456` 的 4 个 latch(afk/fastMode/cacheEditing/thinkingClear)
- **代码**:
  ```ts
  if (afk) afkHeaderLatched = true
  // 后续即使 afk=false,只要 afkHeaderLatched=true 就继续加 header
  // 只在 /clear /compact 时清除
  ```
- **为什么重要**:Mycro KV page 缓存对 betas 子集敏感,header 一变就丢一次 50-70K cache。**latch on** 比"精确按需"便宜得多
- **复用方式**:对自研 Agent,**任何会被服务端 hash 进缓存键的字段**(model、temperature、tools schema、betas、metadata),要么稳定不变,要么 latch on
- **代价**:多发了几个无意义的 beta header(API 端也得忍受); `/clear` 必须显式重置 latch

### 原则 2:单 message-level cache_control marker(最多 4)

- **体现**:`claude.ts:3063-3211` `addCacheBreakpoints` + `claude.ts:3213-3237` `buildSystemPromptBlocks`
- **代码注释**:
  ```ts
  // IMPORTANT: Do not add any more blocks for caching or you will get a 400.
  ```
- **为什么重要**:每个 cache_control 是一个 KV page 锚点。多锚点 = 多增量计算 = 缓存击穿概率更大。Anthropic API 强制 ≤4
- **复用方式**:任何"分段缓存"的设计都应该极少地放锚点(1 个 system_prompt 锚 + 1 个 messages 末尾锚就够)
- **代价**:必须严格控制 cache_control 数量;一旦多了就 400

### 原则 3:2-Phase 缓存破裂检测

- **体现**:`promptCacheBreakDetection.ts` 的 `recordPromptState`(Phase 1) + `checkResponseForCacheBreak`(Phase 2)
- **关键数字**:
  - MIN_CACHE_MISS_TOKENS = 2000(绝对阈值)
  - 5%(相对阈值)
  - MAX_TRACKED_SOURCES = 10(LRU)
- **为什么重要**:**单看 hash 变化**误报多(很多变化不影响缓存); **单看 cache_read drop** 不知道为什么破。两者关联才产生可行动数据
- **复用方式**:
  - 任何"指标突变 + 上游配置变化"的关联告警都应该 2-phase
  - **总是要"sanitize"高维输入**(如 `mcp__path/to/tool` → `mcp`),避免分析数据爆炸 + 防文件路径泄漏
- **代价**:per-source 状态需要 LRU 限大小;哈希算法选错会过/欠报

### 原则 4:Generator + Yield 的"实时状态推送"

- **体现**:`withRetry.ts:170-517` 是 `async function*`(生成器),失败时 `yield SystemAPIErrorMessage`,成功时 `return BetaMessage`
- **代码模式**:
  ```ts
  async function* withRetry(...) {
    for (attempt of 1..max) {
      try { return await fn(retryContext) }
      catch (e) {
        if (shouldRetry(e)) {
          yield createSystemAPIErrorMessage(...)  // UI 立即看到
          await sleep(...)
        } else throw e
      }
    }
  }
  ```
- **为什么重要**:UI 不需要轮询 retry 状态;一行代码搞定"重试中倒计时"
- **复用方式**:任何"循环+UI 反馈"场景都用 `async function*` 替代回调
- **代价**:消费侧得 `for await ... of`,代码风格强制改变

### 原则 5:Pre-Consume Cache Edits(只能消费一次的副作用)

- **体现**:`claude.ts:1531-1532`,在 `paramsFromContext` 闭包定义**之前**就调用 `consumePendingCacheEdits()` 和 `getPinnedCacheEdits()`
- **代码模式**:
  ```ts
  // ONE-TIME side effect
  const newCacheEdits = consumePendingCacheEdits()
  const pinnedEdits = getPinnedCacheEdits()
  
  const paramsFromContext = (retryContext?) => ({
    cache_edits: [...pinnedEdits, ...newCacheEdits],  // closure capture
    ...
  })
  // paramsFromContext 会被调用多次(每次 retry, logging),但 newCacheEdits 只能 consume 一次
  ```
- **为什么重要**:闭包多次调用时,绝不能在闭包内消费 unique 资源
- **复用方式**:任何"重试可能重复执行"的场景里,把"一次性副作用"提到外面
- **代价**:需要识别哪些函数有"消费"语义;对调用顺序敏感

### 原则 6:Latched Eligibility(防止会话中途切换缓存键)

- **体现**:`claude.ts:393-434` `should1hCacheTTL` — 用户 eligible 状态、allowlist 状态都在 bootstrap state 里 latch
- **代码模式**:
  ```ts
  // 第一次问 → 计算 + 存
  // 后续问 → 直接读
  // /clear → 重置
  ```
- **为什么重要**:GrowthBook flag 在会话中可能 flip(实验切换、overage 状态变化),但**不应该让一次会话内**用"5min TTL"和"1h TTL"交错,会大量制造缓存破裂
- **复用方式**:对任何"按用户/会话决定的策略",应该 once-per-session latch,不要每次重新读
- **代价**:不能随实验组动态调整;`/clear` 必须明确重置

### 原则 7:Pre-Extracted Scalars(避免闭包污染)

- **体现**:`claude.ts:1735-1759`,在 `withRetry` 调用前把所有日志要用的 scalar 提取出来,只把这些 scalar 交给 `.then(...)`
- **代码模式**:
  ```ts
  // BEFORE retry
  const logModelForLater = model
  const logBetasForLater = mergedBetas
  const logRequestSetupMs = Date.now() - start
  
  // AFTER retry
  withRetry(...)
    .then(result => logAPISuccessAndDuration({
      model: logModelForLater,
      betas: logBetasForLater,
      requestSetupMs: logRequestSetupMs,
      ...
    }))
  ```
- **为什么重要**:`.then(...)` 闭包如果引用 `model` 这种"还在 queryModel 局部"的变量,会**把整个 queryModel 函数栈钉在内存里**,直到 logAPISuccess 完成 — 长会话累积起来是 ~30MB 内存泄漏
- **复用方式**:**任何放进 fire-and-forget 闭包的变量,先 destructure 提取**
- **代价**:多了几行 const 重命名;代码可读性略降

### 原则 8:Pre-Injection Fingerprint(身份归因)

- **体现**:`claude.ts:1325` `computeFingerprintFromMessages(messages)` 在 `<available-deferred-tools>` synthetic block 注入**之前**算指纹
- **为什么重要**:用户消息的指纹应只反映**用户输入**,不能掺杂 Agent 后期合成的延迟工具说明 — 这关系到 Anthropic 的反 distillation / abuse detection 系统能否正确归因
- **复用方式**:任何"在用户输入上后期注入系统消息"的场景,**都要在注入前固化"用户视角"的所有派生量**(指纹 / 分析 hash / fp)
- **代价**:必须严格控制变量计算的时序

### 原则 9:Stream Watchdog(双层超时)

- **体现**:`claude.ts:1857-1928` 设置 `STREAM_IDLE_WARNING_MS=45s` 和 `STREAM_IDLE_TIMEOUT_MS=90s`
- **为什么是双层?** 单层 timeout 一旦超过就 abort,用户体验差;**先 warn 后 abort** 给了被动恢复的可能性 + 给用户一个明确的进度信号
- **gated by**:`CLAUDE_ENABLE_STREAM_WATCHDOG` env(默认关闭) — 因为某些代理 / 防火墙会出现 30s 静默后再来一波正常数据
- **复用方式**:任何流式接口都加 watchdog,但要给关掉的逃生出口
- **代价**:误报会让"耐心等待型"长 stream 被 abort

### 原则 10:Foreground-Only 529 Retries

- **体现**:`withRetry.ts:50-105` `FOREGROUND_529_RETRY_SOURCES` 白名单
- **代码模式**:
  ```ts
  const FOREGROUND_529_RETRY_SOURCES = new Set([
    'repl_main_thread', 'sdk', ...
  ])
  
  if (is529Error(e) && !FOREGROUND_529_RETRY_SOURCES.has(querySource)) {
    throw e  // 立即放弃,不重试
  }
  ```
- **为什么重要**:529 = "服务端过载"。如果**所有 sub-agent / 后台调用**都重试,会 3-10× 放大网关压力,加重过载
- **复用方式**:任何"重试可能放大上游压力"的场景,**只让用户在场的 foreground 任务重试**
- **代价**:后台任务直接失败概率高;但比拖死整个集群好

### 原则 11:消费源 LRU 限大小(MAX_TRACKED_SOURCES = 10)

- **体现**:`promptCacheBreakDetection.ts:101-115`
- **为什么重要**:每个 sub-agent 有独立 cache 状态。如果用户在一次会话里 spawn 100 个 sub-agent,per-state 哈希数据可能膨胀到几 MB
- **复用方式**:任何 per-actor 状态 map 都要有 LRU 限制
- **代价**:LRU 命中率不高时,某些 agent 的 cache 检测会被覆盖

### 原则 12:Vertex Project ID 主动注入(避开 12s metadata 超时)

- **体现**:`client.ts:221-298`,当用户既没设 `GCLOUD_PROJECT` 也没设 `GOOGLE_APPLICATION_CREDENTIALS` 时,**预先**调 `getProjectIdSync()` 注入 project_id,避开 SDK 的 GCE metadata server 默认行为
- **为什么重要**:GCE metadata 在非 GCP 环境会**默默卡 12 秒**才超时,用户体验灾难
- **复用方式**:任何 SDK 有 metadata server 自动发现行为的场景,都要预先短路
- **代价**:对 SDK 内部行为有耦合,版本升级要测

### 原则 13:Provider 客户端的 4 分支 + 重建机制

- **体现**:`client.ts:88-316` 4 个 if-else;`withRetry.ts:189-251` 在 401 / Bedrock auth fail / Vertex auth fail 时调 `recreateClient()`
- **为什么重要**:有些错误是"client 状态过期"而非"请求本身错"(OAuth token 已轮换、AWS credential 已 rotate)。重建一次 client 即可
- **复用方式**:对任何"长期持有 client + 短期 auth"的场景,提供 `getClient(forceRefresh:true)` 通道
- **代价**:重建 client 本身有开销;要去重(避免每次 retry 都重建)

### 原则 14:错误分类 ⇄ 用户消息 ⇄ 分析事件 三件套

- **体现**:`errors.ts` 同时提供:
  1. `getAssistantMessageFromError(error)` → 给用户看的友好消息(20+ 分支,带 /rewind /model /login 提示)
  2. `classifyAPIError(error)` → 给分析平台的 15 桶分类(aborted, server_overload, prompt_too_long, ...)
  3. `categorizeRetryableAPIError(error)` → 给 SDK 调用方的 4 桶(rate_limit, authentication_failed, server_error, unknown)
- **为什么重要**:同一个错误,**用户视角、分析视角、调用方视角**关心的维度不同;混在一个分类里会两头不讨好
- **复用方式**:错误分类不是 1 个 enum,而是**多个独立的视图**
- **代价**:需要维护 3 套映射;3 套之间要保持语义一致

### 原则 15:HTML Sanitize(防 CloudFlare 错误页污染)

- **体现**:`errorUtils.ts:107-130` `sanitizeMessageHTML` — 检查 `<!DOCTYPE html` / `<html` 标记,提取 `<title>` 文本,否则返回空串
- **为什么重要**:CloudFlare / 各种代理偶尔在 5xx 响应里返回完整 HTML 页;原样回显给用户会破坏 TUI 渲染
- **复用方式**:任何调用第三方 HTTP API 的地方,**都要预设响应可能不是 JSON 而是 HTML 错误页**
- **代价**:title 没有时丢掉信息;少数情况下可能屏蔽真正的错误细节

### 原则 16:深度受限的 cause-chain 遍历(防循环 self-cause)

- **体现**:`errorUtils.ts:42-83` `extractConnectionErrorDetails`,`maxDepth=5`,且 `current.cause !== current` 检查
- **代码**:
  ```ts
  while (current && depth < maxDepth) {
    if (current instanceof Error && 'code' in current) return ...
    if (current.cause !== current) { current = current.cause; depth++ }
    else break  // 自指 cause
  }
  ```
- **为什么重要**:某些错误库会让 `error.cause = error` 形成自循环;无限递归会 OOM
- **复用方式**:遍历任何"链表式"数据都要限深 + 自指检查

### 原则 17:NestedAPIError 的形状探测(JSONL round-trip)

- **体现**:`errorUtils.ts:144-198` 处理 `--resume` 加载 JSONL 时,APIError 已丢失 `.message` 属性,但 `.error.error.message`(标准 API)或 `.error.message`(Bedrock)还在
- **为什么重要**:跨 provider / 跨 serialization 时,错误对象形状不稳定。**必须双层兜底**
- **复用方式**:对任何"持久化错误"的场景,**反序列化时要支持多形状**
- **代价**:多写几行 if-else;但比 crash 强

### 原则 18:7 种 Gateway 自动检测

- **体现**:`logging.ts:56-139` `detectGateway` — 7 种 AI gateway(litellm/helicone/portkey/cloudflare-ai-gateway/kong/braintrust/databricks)的响应头前缀 + URL 后缀指纹
- **为什么重要**:埋点要区分"原生 Anthropic API"和"经过中间代理"的成功率/延迟;不知道 gateway 就无法定位代理侧问题
- **复用方式**:任何调第三方 SDK 的客户端,在埋点里都加 "is_proxied / proxy_kind" 维度
- **代价**:每加一个新 gateway 都要更新指纹表

### 原则 19:Bootstrap Endpoint 的 Disk Cache(只在变更时写)

- **体现**:`bootstrap.ts:114-141` `fetchBootstrapData` — 拉取 `/api/claude_cli/bootstrap`,与现有 config diff,**只在变更时**调 `saveGlobalConfig`
- **为什么重要**:启动期不写盘可以省 spinner;但每次启动都写盘会触发文件锁竞争 + 不必要的 fsync
- **复用方式**:任何"远程配置 + 本地缓存"模式,**都要 isEqual 比较再写**
- **代价**:isEqual 算错就拒不更新

### 原则 20:Anti-Distillation Opt-In(`fake_tools`)

- **体现**:`claude.ts:270-330` `getExtraBodyParams` — 仅 1P CLI 用户(`USER_TYPE === 'ant'`)才能 opt-in `fake_tools`(防止竞品 distill 输出)
- **为什么重要**:Anthropic 内部对 1P 用户开放 abuse 防御工具;3P 用户禁用以保护普通用户隐私
- **复用方式**:任何"内部 vs 外部"的能力分级,都用 USER_TYPE + feature flag 双锁
- **代价**:需要严格保护 USER_TYPE 不被伪造

---

## 6. 错误处理与边界条件

### 6.1 getAssistantMessageFromError 的 20+ 分支

(`errors.ts:425-934`,按优先级排序)

| 触发条件 | 用户消息 / 行为 | apiError 类别 |
|---|---|---|
| Timeout | "Request timed out..." | request_timeout |
| ImageSizeError / ImageResizeError | 提示降图片大小 | invalid_request |
| CUSTOM_OFF_SWITCH_MESSAGE | "Capacity off switch..." | rate_limit |
| 429 with rate-limit-unified-* headers | getRateLimitErrorMessage(读 unified header 算时间) | rate_limit |
| 429 其他 | 解析内层 `"message":"..."` 给用户 | rate_limit |
| "Extra usage is required..." | "Run /extra-usage to enable" | invalid_request |
| "prompt is too long" | PROMPT_TOO_LONG + errorDetails for compact retry | invalid_request |
| PDF 错误(max pages / password / not valid) | 具体提示 | invalid_request |
| Image 太大 / many-image dimensions | 具体提示 | invalid_request |
| AFK_MODE_BETA_HEADER 400 | "Auto mode is unavailable..." | invalid_request |
| 413 | getRequestTooLargeErrorMessage | invalid_request |
| "tool_use ids were found without tool_result..." | "Run /rewind to recover" + log mismatch | unexpected_tool_result |
| "tool_use ids must be unique" | "Run /rewind" | duplicate_tool_use_id |
| Subscriber + Opus + invalid_model | "Claude Opus is not available with the Claude Pro plan" | invalid_model |
| "Credit balance is too low" | billing_error | invalid_request |
| "Organization has been disabled" | check ANTHROPIC_API_KEY env source for blame | auth_error |
| "x-api-key" | CCR_AUTH_ERROR_MESSAGE / INVALID_API_KEY_*_MESSAGE | invalid_api_key |
| 403 OAuth token revoked | getTokenRevokedErrorMessage | token_revoked |
| 401/403 OAuth org not allowed | getOauthOrgNotAllowedErrorMessage | oauth_org_not_allowed |
| Generic 401/403 | "Please run /login" | auth_error |
| Bedrock model id error | 3P fallback suggestion (opus-4-6 → opus41 etc) | bedrock_model_access |
| 404 | "/model" hint with 3P fallback suggestion | invalid_model |
| APIConnectionError | formatAPIError(SSL/timeout 细化) | connection_error |
| Generic Error | API_ERROR_MESSAGE_PREFIX + error.message | server_error |

### 6.2 classifyAPIError 的 15 桶分析分类

(`errors.ts:965-1161`,优先级从上到下)

```
aborted / api_timeout / repeated_529 / capacity_off_switch / rate_limit / 
server_overload / prompt_too_long / pdf_too_large / pdf_password_protected / 
image_too_large / tool_use_mismatch / unexpected_tool_result / 
duplicate_tool_use_id / invalid_model / credit_balance_low / invalid_api_key / 
token_revoked / oauth_org_not_allowed / auth_error / bedrock_model_access / 
ssl_cert_error / connection_error / server_error / client_error
```

### 6.3 fallback 触发条件汇总

| 路径 | 文件:行 | 触发条件 |
|---|---|---|
| streaming → non-streaming | claude.ts:2404-2597 | 流中途异常,且 CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK 未设 |
| 404 stream creation → non-streaming | claude.ts:2598-2807 | stream 创建时 404,先 fallback 试一次 |
| stream watchdog idle abort → non-streaming | claude.ts:1857-1928 | 90s 无事件,abort 后 catch fallback |
| stream-no-events → throw "Stream ended without receiving any events" | claude.ts:2350-2363 | for-await 完了但 contentBlocks 都没初始化 — 多半是代理只返了 [DONE] |
| consecutive 529 ≥ 3 + fallbackModel → FallbackTriggeredError | withRetry.ts:326-365 | query.ts 必须捕获并切模型重试 |

### 6.4 max_tokens context overflow 自动恢复

`withRetry.ts:550-595` `parseMaxTokensContextOverflowError`:

```ts
const MATCH = /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
// 解析得 inputTokens / requestedMaxTokens / contextLimit
// availableContext = contextLimit - inputTokens - SAFETY_BUFFER(1000)
// 如果 availableContext > FLOOR_OUTPUT_TOKENS(3000),retryContext.maxTokensOverride = availableContext
// 否则 throw(连 3000 都剩不下,做不下去)
```

**含义**:用户给的 max_tokens 太乐观时,API 不再硬拒绝,而是让客户端**自己缩小并重试**。

### 6.5 Persistent Retry(无人值守)

`withRetry.ts:433-503`:
- 触发:`CLAUDE_CODE_UNATTENDED_RETRY=1`
- 行为:5xx/429 不再有 max_retries,而是 exponential backoff 直到 5min 上限,持续 6h
- 关键:`HEARTBEAT_INTERVAL_MS=30s` 的 chunked sleep,避免被 SIGTERM 杀掉(让 host 觉得进程还活着)

### 6.6 SIGINT / Abort 的多路径

| 来源 | error 类 | 处理方式 |
|---|---|---|
| 用户 ESC | APIUserAbortError | 直接 re-throw,exit_path='clean' |
| stream watchdog timeout | StreamIdleAbortError | 先 logEvent('tengu_stream_idle_aborted'),再走 non-streaming fallback |
| process SIGTERM | n/a | gracefulShutdown → cleanupRegistry → stream.cancel |

---

## 7. 可迁移设计清单

| 设计 | 适用场景 | 复用方式 | 风险 |
|---|---|---|---|
| Sticky-on Beta Header Latches | 任何 server-side 缓存对 header 子集敏感的 API | bootstrap state 存 latch flag,/clear 重置 | 多发了 header,API 端要忍受 |
| 单 cache_control marker(≤4) | 任何分段 prompt cache | `markerIndex = messages.length-1` | API 强制约束,违反就 400 |
| 2-phase 缓存破裂检测 | 任何"配置变化 → 性能突变"诊断 | recordState + checkResponse 关联 | per-source LRU 必须限大小 |
| Generator + Yield 重试推送 | 任何"循环 + UI 反馈"场景 | `async function*` + yield SystemMessage | 消费侧得 for-await |
| Pre-consume side effect | 任何"重试可能多次执行 closure"场景 | 一次性副作用提到 closure 之外 | 必须识别消费语义函数 |
| Latched eligibility | 任何按用户/会话决定的策略 | once-per-session 算,存 bootstrap state | 实验组无法动态切换 |
| Pre-extracted scalars | fire-and-forget closure 内引用大对象 | 提前 destructure | 多写几行 const |
| Pre-injection fingerprint | 在用户输入上后期注入合成块的场景 | 注入前固化派生量 | 时序敏感 |
| Stream watchdog(双层) | 任何流式接口 | 45s warn / 90s timeout / env 关 | 误报会 abort 长 stream |
| Foreground-only 529 retry | sub-agent / 批量 / 后台 | 白名单 querySource | 后台任务直接失败 |
| Per-source LRU(MAX=10) | 任何 per-actor 状态 map | sharted Map + LRU evict | 命中率不高时被覆盖 |
| Vertex projectId 主动注入 | SDK 有 metadata server 自动发现行为的场景 | 预先短路 | 与 SDK 内部耦合 |
| Provider 客户端重建 | 长持有 client + 短期 auth | 401/auth-fail 重建一次 | 重建有开销,需去重 |
| 错误分类三件套 | 任何错误处理需要分别面向用户/分析/调用方 | 三个独立映射 | 维护 3 套要保持语义同步 |
| HTML sanitize | 调第三方 HTTP API | 检测 `<!DOCTYPE html` 替换为 title 或空 | title 没有时丢信息 |
| 深度限 cause-chain 遍历 | 错误链遍历 | maxDepth=5 + cause!==current 自检 | — |
| NestedAPIError 多形状探测 | 反序列化错误对象 | 多层 nested 兜底 | — |
| Gateway 自动检测 | 调第三方 SDK 客户端 | 响应头前缀 + URL 后缀指纹 | 维护指纹表 |
| Bootstrap diff-only write | 远程配置 + 本地缓存 | isEqual 后再写盘 | isEqual 算错拒不更新 |
| USER_TYPE + feature flag 双锁 | 内外能力分级 | env + 编译期 feature DCE | USER_TYPE 不能伪造 |

---

## 8. 待确认问题

1. **`logAPIError` 的耦合点**:`logging.ts:235-396` 在 `getAssistantMessageFromError` 之后调用。如果 `consumeInvokingRequestId()` 在 logError 内部抛错,会不会让原始错误丢失? — 需要追 utils/agentContext.js 但该文件不可见
2. **`startLLMRequestSpan / endLLMRequestSpan` 的 OTel exporter**:仅 ant 用户启用 — 但 `endLLMRequestSpan` 在 `logAPIError` 也调用,会不会在普通用户身上 no-op 但留 hidden cost? — 需要看 `utils/telemetry/sessionTracing.ts`(不可见)
3. **`recreateClient()` 的具体实现**:`withRetry.ts:189-251` 调用了 OAuth refresh / Bedrock recreds / Vertex recreds 但具体函数名不一致;`utils/auth.ts` 不可见
4. **Persistent retry 与 stream watchdog 的交互**:CLAUDE_CODE_UNATTENDED_RETRY 模式下,stream 中途的 90s idle 是否会让整个 attempt 失败 → 进入 6h 持续重试? — 实测才能确认
5. **`shouldDeferLspTool` 的策略**:`claude.ts:786-792` 当 LSP 状态为 'pending' / 'not-started' 时延迟暴露;但 LSP 启动需要多久?如果一直 pending,LSPTool 永远不出现? — 需要看 `services/lsp/manager.ts`
6. **`getNonstreamingFallbackTimeoutMs`**:CCR 模式 120s vs 默认 300s 的边界(`claude.ts:807-811`)。但如果用户已经在 sandbox 里,API 时延上限是 600s — 是否会出现"sandbox 自己等到 600s,但 CCR fallback 已经在 120s 时放弃"的不一致?
7. **`extractQuotaStatusFromHeaders`**:`claude.ts:2398-2402` 从响应头读配额状态 — 但 claude.ts 引用但具体解析没读到。可能在 utils/quota.ts(不可见)
8. **`isNonInteractiveSession` 与 `setLastApiCompletionTimestamp` 的目的**:`logging.ts:451-578` `logAPISuccess` 给非交互会话也打了埋点 — 但是 print 模式的会话寿命短,这些埋点上传到 SerialBatchEventUploader 是否能保证 flushed?
9. **`ANTHROPIC_BASE_URL` 在 detectGateway 与 isCCRMode 的区别**:CCR(Claude Code Remote)是否会被同时识别为 gateway? — 需要看 isCCRMode 实现
10. **`grove.ts` 是否影响 streaming 主路径**:Grove 是政策弹窗 / 反馈系统,但和 API 客户端在同目录;猜测仅在错误流中出现,但需要 grep 确认
11. **`sessionIngress.ts`(17K)未读**:与会话 ingress 有关,可能对 SDK 模式重要

---

## 附录:M05 与其他模块的接口

```
M02 (Agent loop / query.ts)
   ↓ queryModel(messages, system, tools, options, model)
M05 (services/api/claude.ts)
   ↓ withRetry + anthropic.beta.messages.create({stream:true})
M05 errors.ts (catch translates to AssistantMessage)
M05 logging.ts (1P + OTel events)
M05 promptCacheBreakDetection.ts (record + check)
M05 client.ts (4-provider)
   ↓
@anthropic-ai/sdk → Anthropic / Bedrock / Foundry / Vertex
```

```
M02 ←→ M05:
- 入参由 context.ts(M06) + tools.ts(M03) + auth(utils/auth) + bootstrap state 拼装
- M05 yield 的 AssistantMessage 由 query.ts 喂回 messages 数组进入下轮循环
- FallbackTriggeredError 由 query.ts 抓取并切换 fallbackModel

M04(权限)与 M05 的隔离:
- M05 不做权限决策(仅决定"是否能调 API")
- 但 M05 的 betas/effort/taskBudget 与 M04 的 permissionMode 都来自 ToolUseContext

M19(状态)与 M05 的协作:
- bootstrap state 存:latches(afk/fast/cacheEditing/thinkingClear)、cache eligibility、last requestId、queryModel 累计 duration
- /clear /compact 触发的 latch 重置都在 bootstrap state 实现
```

---

## 七、补读修正(把 9 个未读的 `services/api/*` 辅助文件全部精读后)

下面是把 `sessionIngress.ts`(514 行)、`grove.ts`(357 行)、`filesApi.ts`(748 行)、`dumpPrompts.ts`(226 行)、`adminRequests.ts`、`metricsOptOut.ts`、`overageCreditGrant.ts`、`referral.ts`、`ultrareviewQuota.ts` 共 ~2030 行一字一字读完后,在前文 M05 主路径总结之外发现的辅助调用矩阵机制. 这一节回答的核心问题是:**"主 LLM 调用之外,客户端跟服务端还有哪些'非主路径' API,每一种应该怎么写才不出事."**

### §7.1 sessionIngress.ts —— 会话日志的乐观并发持久化

#### 7.1.1 Per-session sequential wrapper (`sessionIngress.ts:29-55`)
模块顶层 `sequentialAppendBySession: Map<sessionId, sequentialFn>`. 每个 session 第一次 append 时懒创建 `sequential(...)` 包装,后续按同 session 串行. 多 sub-agent 并发追加**不同** session 不互相阻塞,**同** session 始终串行(Last-Uuid 链表锚点不能并发).

#### 7.1.2 Last-Uuid 乐观并发链 (`sessionIngress.ts:69-87`)
每次 PUT 带 `Last-Uuid: <上次成功 append 的 uuid>` 头. 成功后 `lastUuidMap[sessionId] = entry.uuid`. 无锁 CAS 单链表 append.

#### 7.1.3 **409 三段恢复策略** (`sessionIngress.ts:90-141`,本文件最讲究的部分)

```
409 → server returns x-last-uuid
  case A: serverLastUuid === entry.uuid
    → 自己的 entry 其实已经存了,只是上次响应丢了
    → 把 lastUuid 改为自己, 记 'session_persist_recovered_from_409'
    → return true(伪成功)
  case B: serverLastUuid 是别的 uuid
    → 别的写者推进了链
    → 把 lastUuid 改为服务端的, continue retry
  case C: 服务端没返回 x-last-uuid(v1 endpoint)
    → 回头 GET 全部 logs, 在 list 末尾找最后一个有 uuid 的 entry
    → 改成那个 uuid, continue retry
```

**复用要点**: 任何"链表式追加 + 网络"场景, recovery 至少需要 3 段(自己实际成功了 / 别人推进了 / 不知道头在哪).

#### 7.1.4 指数退避 8s 上限 (`sessionIngress.ts:178`)
`min(BASE * 2^attempt, 8000)`. 10 次重试,base 500ms,8s cap. 与主 LLM `withRetry.ts` 动辄 5 min cap 不同 —— 辅助路径不能拖死主流程.

#### 7.1.5 v1 / v2 双端点共存 (`sessionIngress.ts:267-414`)
- 旧 `session-ingress`(50k 条上限)
- 新 `/v1/code/sessions/{id}/teleport-events`(分页 1000/页)
迁移期客户端需同时兼容. `cursor=null` 用 `== null` 双等号(覆盖 null + undefined),strict `=== undefined` 在 proto/json 序列化器输出字符串 `"null"` 时会无限循环.

#### 7.1.6 100 页硬上限 (`sessionIngress.ts:308-311`)
1000/页 × 100 页 = 100k events. 触顶不抛错,返回已有 + warn. **优雅降级 > 完美失败**.

#### 7.1.7 404 在 migration window 里有歧义 (`sessionIngress.ts:334-353`)
page 0 的 404 既可能是"会话真的不存在"也可能是"路由没部署/threadstore 未 backfill". 返回 null 让 caller 回退到 session-ingress,迁移完成后自然消亡.

#### 7.1.8 401 不一致是故意 (`sessionIngress.ts:144-148` vs `:355-360`)
- append(后台异步):失败 return false,继续写本地
- fetch(用户主动 resume):必须告知用户 `/login`,用 throw 让上层显示

#### 7.1.9 `/clear` 释放所有 sub-agent 的 lastUuid map (`sessionIngress.ts:507-514`)
避免主会话清空后 sub-agent 链对接到新会话.

### §7.2 grove.ts —— 隐私公告/法定截止日的非阻塞架构

#### 7.2.1 双 endpoint:account/settings + claude_code_grove (`grove.ts:52-85, 232-278`)
`getGroveSettings` 读用户已选,`getGroveNoticeConfig` 读服务端策略. 两个都用 `memoize` + `withOAuth401Retry`.

#### 7.2.2 **失败不缓存,避免死锁** (`grove.ts:75-83`)
> Don't cache failures — transient network issues would lock the user out of privacy settings for the entire session (deadlock: dialog needs success to render the toggle).

`getGroveSettings.cache.clear?.()` 在 catch 内显式清. lodash-es memoize 的"失败也会被缓存"陷阱标准修法.

#### 7.2.3 写后必须 `cache.clear?.()` (`grove.ts:109-114, 144`)
`markGroveNoticeViewed()` 和 `updateGroveSettings()` 成功后都显式 cache.clear,防同会话内重 mount 读到陈旧 `viewed_at`.

#### 7.2.4 `isQualifiedForGrove` 的"冷启动绝不阻塞"原则 (`grove.ts:157-193`)
- 无缓存 → 立刻返 false,后台 `void fetchAndStoreGroveConfig`
- 有缓存但 stale → 返回 cached,后台刷
- 有缓存且 fresh → 直接返

**冷启动宁可少显示一次法定公告,也不阻塞 REPL 加载**.

#### 7.2.5 3 秒短超时丢弃 Grove 弹窗 (`grove.ts:251`)
宁可不显示也不让用户等.

#### 7.2.6 写死的法定生效日期 (`grove.ts:346-352`)
`October 8, 2025` hard-coded. 非交互模式宽限期内 stderr 通知 + 静默继续;宽限期过 → `gracefulShutdown(1)` 退出.

#### 7.2.7 **`isEssentialTrafficOnly()` 全局静默开关** (`grove.ts:55, 234`)
所有辅助接口先检查这个 env(7 处:grove / metricsOptOut / overageCreditGrant / referral / claudeAiLimits / policyLimits / trustedDevice / feedback). **事故响应的 master kill switch**.

### §7.3 filesApi.ts —— Files API 下载/上传/列表

#### 7.3.1 双 beta header 必须同发 (`filesApi.ts:27`)
```ts
const FILES_API_BETA_HEADER = 'files-api-2025-04-14,oauth-2025-04-20'
```
`oauth-2025-04-20` 启用 Bearer OAuth on public-api routes. 缺这个 → 404. **两个 beta flag 必须同发**.

#### 7.3.2 自研 `retryWithBackoff` 而非复用 `withRetry` (`filesApi.ts:97-123`)
`withRetry.ts` 是 generator(yield SystemAPIErrorMessage 让 UI 可见). Files API 是后台任务 UI 无需可见 → 自研 Promise-returning. `MAX_RETRIES=3`, BASE=500ms, 2^attempt 无 cap.

#### 7.3.3 401/403/404 用 `throw` 而非 `return {done:false}` (`filesApi.ts:161-170`)
catch 里只回 axios retryable 错误, 其他穿透出 retry 循环. **4xx 不重试**靠 throw 实现.

#### 7.3.4 `buildDownloadPath` 的 path traversal 防御 (`filesApi.ts:187-210`)
`path.normalize` + 检查 `..` 前缀 reject. 同时消除"冗余前缀"(`<base>/<session>/uploads/`).

#### 7.3.5 **500MB 单文件上限,read 后才检查** (`filesApi.ts:82, 411-423`)
不在上传前 stat,在 read 后用 `Buffer.length` 检查. **杜绝 file-grow-after-stat 攻击**.

#### 7.3.6 手写 multipart/form-data + UUID boundary (`filesApi.ts:425-455`)
不用 `form-data` 库,手动拼 Buffer. boundary 用 `crypto.randomUUID()` 防同毫秒并行上传冲突.

#### 7.3.7 `UploadNonRetriableError` 私有异常类 (`filesApi.ts:555-560`)
401/403/413 + axios cancel 都抛该异常. **统一两种非 retriable 路径**比 boolean flag 干净.

#### 7.3.8 `parallelWithLimit` 手写 worker pool (`filesApi.ts:280-307`)
不用 p-limit 等库. 减少依赖、行为可预测.

#### 7.3.9 Cursor pagination 用 `after_id` 而非 offset (`filesApi.ts:631-704`)
文件 ID 是 ULID(单调递增). 避免 offset 在"新数据插入"时的窗口偏移.

#### 7.3.10 `parseFileSpecs` 接受空格分隔的 multi-spec (`filesApi.ts:722-748`)
sandbox-gateway 注入方式不规范,客户端兜底解析. 每条 `<file_id>:<relative_path>`,**首个**冒号切分允许 path 含冒号.

### §7.4 dumpPrompts.ts —— Ant fetch hook 的精打细算

#### 7.4.1 **双层去重:fingerprint(便宜) + sha256(贵)** (`dumpPrompts.ts:74-128`)
```ts
function initFingerprint(req) {
  return `${req.model}|${toolNames}|${sysLen}`  // 只读 length 不 stringify
}
```
fingerprint 相等 → 跳过 300ms stringify;fingerprint 变了再算 sha256 决定是否写 `system_update`. **廉价代理筛选 + 昂贵真比对**.

#### 7.4.2 5 条 in-memory cache 给 `/issue` (`dumpPrompts.ts:14-57`)
模块顶层数组,push 后超 5 条 shift. `/issue` 上传问题报告时附最近请求. Ant only.

#### 7.4.3 **`setImmediate` 推迟解析,不阻塞实际 API call** (`dumpPrompts.ts:163-167`)
> Parsing+stringifying the request (system prompt + tool schemas = MBs) takes hundreds of ms. Defer so it doesn't block the actual API call.

#### 7.4.4 SSE chunks 离线 reparse (`dumpPrompts.ts:178-209`)
对流式响应,克隆 response,在 `void async` 内读完整流再 split SSE 事件二次解析. **响应数据二次复制 + 解析**完全不影响主流 SSE 消费. 代价:**对 ant 用户内存增加 2 倍 response size**.

#### 7.4.5 **每个 query 重建 fetch 防内存泄漏** (`query.ts:582-590`)
> Each call to createDumpPromptsFetch creates a closure that captures the request body. Creating it once means only the latest request body is retained (~700KB), instead of all request bodies from the session (~500MB for long sessions).

### §7.5 adminRequests.ts —— Team/Enterprise 升级请求

#### 7.5.1 简单 CRUD,无重试无缓存
3 个 endpoint,都用 `prepareApiRequest()`,没 401 retry. **用户主动行为不需要这些机制**.

#### 7.5.2 服务端按 (user, request_type) 去重 (`adminRequests.ts:42-47`)
客户端不做幂等键.

#### 7.5.3 手拼 query string 而非 URLSearchParams (`adminRequests.ts:82-85`)
后端要 `?statuses=a&statuses=b`,Node URLSearchParams 某些版本会 `?statuses=a,b` 不兼容.

### §7.6 metricsOptOut.ts —— 两级缓存的 org 设置

#### 7.6.1 两级 TTL (`metricsOptOut.ts:22-27`)
- 内存 1h
- 磁盘 24h

> This is what collapses N `claude -p` invocations into ~1 API call/day.

#### 7.6.2 **Scope check 在缓存读之前** (`metricsOptOut.ts:128-136`)
> Service key OAuth sessions lack user:profile scope → would 403. This check runs before the disk read so we never persist auth-state-derived answers.

**缓存 key 不只是 user, 还隐含"用什么 auth 方式问的"**. service-key 拿不到的字段不能喂给 full-OAuth 用户. **cache poisoning 的真实工程修复**.

#### 7.6.3 `also403Revoked: true` (`metricsOptOut.ts:62`)
比 grove.ts 更激进 —— 403 也触发 refresh.

#### 7.6.4 错误不写盘 (`metricsOptOut.ts:96-98`)
transient failure 不应 overwrite known-good disk value.

#### 7.6.5 写盘前比对 unchanged 跳过 (`metricsOptOut.ts:100-106`)
并发情况下多个 CLI 看到 stale 都来写 → 文件锁竞争. 先比对再写.

#### 7.6.6 **该模块在 src/ 内无调用方**
grep 结果零命中. 可能是 SDK 公共导出 / 死代码 / dynamic import. (`待确认 Q1`)

### §7.7 overageCreditGrant.ts —— 锁感知 saveConfig

#### 7.7.1 1h TTL per-org cache (`overageCreditGrant.ts:22, 48-55`)
`getCachedOverageCreditGrant()` 同步 reader,stale 返 null;`refreshOverageCreditGrantCache()` 异步写. **双角色函数读写完全分离**.

#### 7.7.2 **`saveGlobalConfig` 接受 `(prev) => next` 函数** (`overageCreditGrant.ts:87-119`,全文最讲究)
```ts
saveGlobalConfig(prev => {
  // prev 是已获取文件锁后从磁盘重读的最新版本
  if (unchanged) return prev  // skip write
  return mergedNewValue(prev)
})
```
避免 lock-acquire 之间被其他进程覆盖. **inc-4552 pattern**.

#### 7.7.3 货币硬编码 USD (`overageCreditGrant.ts:127-135`)
其他货币返 null 让 UI 隐藏 amount.

### §7.8 referral.ts —— Passes 资格的 in-flight dedup

#### 7.8.1 **`fetchInProgress` 单例 promise** (`referral.ts:23-24, 176-220`)
```ts
let fetchInProgress: Promise<...> | null = null
async function fetchAndStorePassesEligibility() {
  if (fetchInProgress) return fetchInProgress
  fetchInProgress = (async () => { try { ... } finally { fetchInProgress = null } })()
  return fetchInProgress
}
```
多 UI 节点同时 mount,共享一个 in-flight. `memoize` 帮不了你 —— memoize 缓存已完成的结果而非进行中的 promise.

#### 7.8.2 `shouldCheckForPasses` 三重门 (`referral.ts:71-77`)
`orgUuid && isClaudeAISubscriber() && getSubscriptionType() === 'max'`. **先检查 tier 再发请求**.

#### 7.8.3 9 种货币符号表 (`referral.ts:128-137`)
fallback `${currency} ` 带尾空格(让 "BRL 50" 不别扭).

#### 7.8.4 Cache reuse 但隐去 timestamp (`referral.ts:261-268`)
解构剥离 timestamp 字段后返回. 类型断言 `as ReferralEligibilityResponse`.

### §7.9 ultrareviewQuota.ts —— 仅 38 行的纯查询

#### 7.9.1 Peek 与 consume 分离 (`ultrareviewQuota.ts:14-17`)
> Peek the ultrareview quota for display and nudge decisions. Consume happens server-side at session creation.

**客户端从不"扣减"配额**(避免双方失同).

#### 7.9.2 5s 超时,nullable 容忍 (`ultrareviewQuota.ts:30-37`)
任何错误 return null,UI 应有 fallback 状态.

### §7.10 跨文件不变量

#### 不变量 API-1: `isEssentialTrafficOnly` 全网络静默开关
辅助接口 7 处一致检查. **主路径(claude.ts)从不检查**,主路径就是 essential.

#### 不变量 API-2: OAuth 重试封装统一为 `withOAuth401Retry`
3 处:bootstrap / grove / metricsOptOut. 其他用 `prepareApiRequest()` + `getOAuthHeaders()` —— 不自带 401 retry. **两套体系并存待统一** (`待确认 Q2`).

#### 不变量 API-3: Per-org cache map 模式
`globalConfig.<feature>Cache[orgId]`. `{info, timestamp}` 形状. **多 org 用户长期使用会累积无限 entries**(无 LRU).

#### 不变量 API-4: Memoize on read, manual clear on write
读用 memoize,写后显式 `cache.clear()`. **与 React Query invalidateQueries 类似**.

#### 不变量 API-5: Cache 写前 unchanged 比对(write amplification 防御)
metricsOptOut / overageCreditGrant / grove 都先比 enabled / grant_amount / grove_enabled 等核心字段,unchanged 就 skip write. **inc-4552 pattern**.

#### 不变量 API-6: beta-period URL 双链路兼容
sessionIngress(v1/v2 共存)、files-api + oauth(必须共发)、grove(两个 endpoint). **API 端做大改时客户端必须长期兼容多个 endpoint**.

#### 不变量 API-7: `logForDebugging` vs `logForDiagnosticsNoPII` 二元埋点
sessionIngress 全程混用. **PII vs no-PII 边界严格**.

#### 不变量 API-8: User-Agent 二选一
`getClaudeCodeUserAgent()` 只含 product/version;`getUserAgent()` 含 product/version/Node/OS. **信息量分级**:account/settings 只暴露最少, Statsig 类需 UA 详情用于实验分组.

#### 不变量 API-9: axios 而非 fetch
全部辅助 API 都用 axios. **`validateStatus: status => status < 500` 一行解决"4xx 不抛、5xx 抛"语义**, native fetch 还要手动 try/catch.

### §7.11 关键工程模式(可复用)

| 模式 | 适用场景 |
|---|---|
| A: Per-key sequential executor | 按 key 分桶的写(session log / kafka topic / file lock) |
| B: Optimistic concurrency with chain head adoption | 链表式 append 持久化(transcript / event log / CRDT) |
| C: Cheap-then-expensive change detection | 高频变化检测但实际改变罕见(config / prompt / render skip) |
| D: Closure-aware retain prevention | 用户提供的 hook/wrapper,生命期超出 request 会 retain |
| E: Lock-fresh write via prev-fn pattern | 多进程共享 disk 状态(config / cache / token) |
| F: Fire-on-cold, return-stale-on-warm | 宁可不显示也别阻塞(legal / upsell / metric opt-out) |
| G: In-flight promise singleton | 多 UI 节点同时 mount 共享一次远程读 |
| H: Service-key vs OAuth-key cache 隔离 | 不同 auth 看到不同字段的 API |
| I: 防 cursor=null 死循环的 `== null` 双等 | 任何 cursor 分页(proto/json 不一致) |
| J: Retry 上限 vs 优雅降级 | 辅助路径失败的形式是默认值,不是抛错 |

### §7.12 安全 / 合规相关

| # | 内容 | 文件 |
|---|---|---|
| 安全 1 | Path traversal:`path.normalize` + `..` reject(仍不防 symlink) | filesApi:187-210 |
| 安全 2 | TOCTOU defense in upload:read 后才检查 size | filesApi:411-423 |
| 安全 3 | USER_TYPE 模块级 early-return + 编译期 DCE 移除 | dumpPrompts |
| 安全 4 | Session token 在 stderr 不输出 | sessionIngress 全文 |
| 安全 5 | CloudFlare HTML 净化在 errorUtils | (已知,M02) |
| 合规 1 | Consumer Terms 法定截止日 hard-coded 2025-10-08(应运行时读) | grove:346-352 |
| 合规 2 | metricsOptOut 先 scope 再 query 防 service-key cache 污染 | metricsOptOut:128-136 |

### §7.13 待确认问题(M05 补读新增)

12. `metricsOptOut.ts` 是否仍在用? grep 显示 src/ 内 zero callers. (`待确认 Q1`)

13. `prepareApiRequest()` vs `withOAuth401Retry` 的分工权威 doc?

14. `session_ingress_token` 与 OAuth `accessToken` 的关系? 两条 path 用不同 token,后端如何区分?

15. filesApi 用 `ANTHROPIC_BASE_URL` 但 sessionIngress 用 `getOauthConfig().BASE_API_URL`,env 与 hardcoded 是否对得上?

16. `grove.ts` 两个 endpoint 在 `Promise.all` 并行调,是否有 cache 互相污染的可能?

17. `appendSessionLog` 10 次重试 + 8s cap = 最长 ~80s. sub-agent 写很快时串行化 backlog 多少? abort 时如何清?

18. filesApi `MAX_FILE_SIZE_BYTES=500MB` 与 Anthropic Files API 文档的真实上限对得上吗?

19. `dumpPrompts` 的 sequential 写文件有无竞争? 同 query 两次请求迅速到来 fingerprint 都不同会不会两份 entries 交错?

20. `referral.ts` 的 `fetchInProgress` 没 timeout 兜底. fetch hang 时所有后续 caller 永久 share 同一卡住的 promise. 需 AbortController?

21. `inc-4552` 是公开事故还是内部? grep 仅此一处提到.

22. sessionIngress v2 teleport endpoint 在 401 时 throw "session expired",但 v1 path 同样 401 时 return false. 混合调用会有不一致行为.

### §7.14 与既有 M05 文档的合并建议

新增 §2.5 "辅助调用矩阵" 按主题分组:
- **会话级**:sessionIngress(transcript 持久化)
- **法务/合规**:grove
- **资源管理**:filesApi / overageCreditGrant / ultrareviewQuota / adminRequests
- **元数据**:metricsOptOut / referral
- **调试**:dumpPrompts(Ant only)

**最大工程教训**:Anthropic 把"主 LLM 调用"和"辅助调用"严格隔离两套库(主走 SDK + withRetry generator,辅走 axios + 简单 retry). **功能边界清晰带来错误处理边界清晰** —— 主路径必须把错误升级为 UI 事件,辅路径必须降级为默认值. 这是 M05 全模块最值得自研 Agent 借鉴的总原则.
