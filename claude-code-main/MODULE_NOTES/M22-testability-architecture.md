# M22 · Testability Architecture (VCR / Mock / DI / Retry / Watchdog)

## 0. 这章定位 + 一段重要 caveat

读 leaked source 想找一坨 `*.test.ts` —— 找不到。tests 在外部 build 里被剥掉了。但**production 代码自身**包含大量 "为了让它能测、能在生产里模拟边界条件、能让 ANT 内部和 3P 走差异路径" 的脚手架。本章梳理的就是**这些脚手架的形状**, 不是测试本身。

> 类比: 你拆一辆量产车找不到工厂的检测仪, 但车上有 OBD-II 接口、tap point、debug header — 整车 wiring 设计就考虑了"可观测、可注入、可中断"。M22 讲的是 Claude Code production runtime 里这套 "tap point + injection seam"。

涉及的核心文件:
- [src/services/vcr.ts](src/services/vcr.ts) (406 行)
- [src/services/mockRateLimits.ts](src/services/mockRateLimits.ts) (882 行)
- [src/services/rateLimitMocking.ts](src/services/rateLimitMocking.ts) (144 行) — facade
- [src/services/api/client.ts](src/services/api/client.ts) (389 行) — DI 入口
- [src/services/api/withRetry.ts](src/services/api/withRetry.ts) (822 行) — 重试 generator
- [src/services/api/errors.ts](src/services/api/errors.ts) (1207 行) — 错误分类
- [src/services/api/claude.ts](src/services/api/claude.ts) (3419 行) — streaming + fallback
- [src/services/claudeAiLimits.ts](src/services/claudeAiLimits.ts) (516 行) — quota state + listener
- [src/services/claudeAiLimitsHook.ts](src/services/claudeAiLimitsHook.ts) (24 行) — React subscriber
- [src/services/tokenEstimation.ts](src/services/tokenEstimation.ts) (token-count VCR consumer)
- [src/services/mcp/client.ts:492](src/services/mcp/client.ts#L492) `wrapFetchWithTimeout` — 另一处 fetch 包装

---

## 1. VCR pattern: sha1(input) → fixtures/<name>-<hash>.json

`vcr.ts:88-347` 是一套 record/replay 系统, **三个层级**:

```
withFixture<T>(input, name, f)         // 最底, 任意类型
  ↑
withVCR(messages, f)                    // 用于 non-streaming + Haiku
withStreamingVCR(messages, f)           // 用于流式 (buffer → replay)
withTokenCountVCR(messages, tools, f)   // 用于 token-count
```

启动 gate: `shouldUseVCR()` (vcr.ts:23-33)
- `NODE_ENV === 'test'` → on
- `USER_TYPE === 'ant' && FORCE_VCR` → on (ant 员工本地调试用)
- 其他 → off (3P 用户跑 production 永不写 fixture)

### 1.1 fixture 命名: input → sha1 前缀

每条 user message content 单独 hash, 取 sha1 hex 前 6 位, 用 `-` 连成 filename:

```ts
`fixtures/${dehydratedInput.map(_ => createHash('sha1').update(jsonStringify(_)).digest('hex').slice(0, 6)).join('-')}.json`
```

**为什么是每条 message 单独 hash 用 `-` 连而不是整体 hash**: 调试时 `ls fixtures/` 可以看到 prefix 部分相同的 fixture(同一段对话历史 + 不同 follow-up), 知道这些 fixture 共享 prefix。整体 hash 看不出关系。

### 1.2 dehydrate / hydrate: normalization tokens

写 fixture 前把 input + output 里所有"会随机变"的字符串替换成 token, 读 fixture 时反过来:

| token | 替代的内容 |
|---|---|
| `[CONFIG_HOME]` | `~/.claude` 或 `$CLAUDE_CONFIG_DIR` |
| `[CWD]` | `process.cwd()` |
| `[NUM]` | 数字字面量 (随机生成的内部 id) |
| `[DURATION]` | 时间数值 |
| `[COST]` | 美元成本数值 |
| `[COMMANDS]` / `[FILES]` | 路径片段 |
| `UUID-${index}` | 流中第 N 个 UUID (deterministic) |
| `[TIMESTAMP]` | unix epoch |

Windows 还有**双重处理**: JSON 中的 escaped backslash 路径 (`C:\\Users\\...`) 和 forward-slash 形式 (`/c/Users/...`) 都要 normalize 成 `[CWD]`, 否则 macOS 录的 fixture 在 Windows replay 不匹配。

### 1.3 deterministic UUID 在 dehydrate 期间, randomUUID 在 hydrate 期间

`dehydrate` 时碰到 UUID → 替换成 `UUID-${counter++}`(同一 fixture 内 counter reset, 第 N 个 UUID 永远是 `UUID-N`)。
`hydrate` 时碰到 `UUID-N` → 替换成 `randomUUID()`(每次 replay 拿到的实际 UUID 都新, 但**结构**一致)。

这个组合解决: "fixture 文件要稳定(便于 diff), 但 replay 出来的 UUID 在 process 内还得能正常用(不能两个对象拿到同一 UUID, 否则下游对象池冲突)"。

### 1.4 CI 安全网: VCR_RECORD 显式打开

```ts
if ((env.isCI || process.env.CI) && !isEnvTruthy(process.env.VCR_RECORD)) {
  throw new Error(`Fixture missing: ${filename}. Re-run tests with VCR_RECORD=1, then commit the result.`)
}
```

CI 默认**不自动录新 fixture**。否则任何"忘 commit fixture" 的 test 在 CI 里都会自动录一份 fly 就过, 你永远不知道 fixture 缺哪些 (导致 fixture 飘移)。强制人手 `VCR_RECORD=1` 重新跑、commit。

**抄给 Agent**: 任何 fixture/cache 类系统在 CI 必须有"显式录制 flag", 不要默默生成。

### 1.5 fixture 路径可被环境变量覆盖

`process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT ?? getCwd()` — 多个 test crate 共享 fixture 时用。

---

## 2. mockRateLimits.ts: ANT-only mutator + 20 scenarios

[mockRateLimits.ts](src/services/mockRateLimits.ts) 提供给 ANT 内部 `/mock-limits` 命令调用, 让员工**在 production 进程里**伪造各种 429/quota state 来测试 UI。

### 2.1 USER_TYPE 'ant' gate 在每个 mutator 上

```ts
export function setMockHeaders(headers: Record<string, string>): void {
  if (process.env.USER_TYPE !== 'ant') return  // ← defense in depth
  mockHeaders = headers
  ...
}
```

每个 setter / getter 都重复这个 check, **不依赖调用方守门**。3P 用户即便偶然触发了 `/mock-limits`(比如 IDE 自动补全没禁掉), 也不会污染状态。

### 2.2 20 个 MockScenario 枚举

`MockScenario` union 有 20 种:
- `none` / `unset`
- `5h_warning` / `5h_rejected` / `5h_overage_allowed` / `5h_overage_rejected` / `5h_overage_out_of_credits`
- `7d_warning` / `7d_rejected` / `7d_opus_warning` / `7d_opus_rejected` / `7d_sonnet_warning` / `7d_sonnet_rejected`
- `overage_allowed_warning` / `overage_rejected` / `overage_out_of_credits` / `overage_org_disabled` / `overage_member_disabled`
- `fast_mode_short_retry_after` / `fast_mode_long_retry_after`

每个 scenario 有 `headers` map + `expiry` 计算函数。

### 2.3 module-level mutable state(故意)

```ts
let mockHeaders: Record<string, string> = {}
let mockExpiry: number | null = null
let mockFastModeRateLimitExpiry: number | null = null
```

直接 module-level let。理由: mock 是"单进程内、单 session 内、调试期间临时存在"的状态, 不需要 store/atom 抽象。**做 Agent 时也可以这样省事**: 调试 hook 不需要架构纯洁性, module-level let 反而最直观。

### 2.4 lazy expiry: 第一次出错那一刻才算 expiry

`isMockFastModeRateLimitScenario`: 创建 mock 时 expiry 是 `null`。第一次拦截到 fast mode 请求时, 才把 `mockFastModeRateLimitExpiry = Date.now() + retryAfterSeconds * 1000`。后续每次返回 mock 的 retry-after 是 `Math.max(0, mockFastModeRateLimitExpiry - Date.now()) / 1000`。

**为什么 lazy**: 用户开 `/mock-limits fast_mode_short_retry_after` 后可能要去 dialog 里点几下、看 UI 显示对不对, 真正发请求是 5 分钟后。如果 expiry 立刻起算, 这 5 分钟就被白白消耗。lazy 保证"从第一次撞到才开始计时"。

### 2.5 `CLAUDE_MOCK_HEADERLESS_429` env var

```ts
export function getMockHeaderless429Message(): string | null {
  if (process.env.CLAUDE_MOCK_HEADERLESS_429) {
    return process.env.CLAUDE_MOCK_HEADERLESS_429
  }
  return null
}
```

这个 env var 让 `-p` non-interactive mode + SDK 调用 也能模拟 "429 但没 quota header" 的边界 case。`/mock-limits` 命令本身需要 interactive REPL, 这里给非交互场景留了一个口子。

---

## 3. Facade: rateLimitMocking.ts 隔离 mock 与生产

[rateLimitMocking.ts](src/services/rateLimitMocking.ts) 是 4 个函数:

```ts
processRateLimitHeaders(headers): Headers       // ← 透明替换
shouldProcessRateLimits(isSubscriber): boolean  // ← 或门: 真订阅者 OR ant 在 mock
checkMockRateLimitError(model, isFastMode): APIError | null
isMockRateLimitError(error): boolean
```

`processRateLimitHeaders` 是关键: 生产代码调用它 **不知道有 mock**。production headers 进去, 如果有 mock 则 mock 出来, 否则原样出。

```ts
export function processRateLimitHeaders(headers: globalThis.Headers): globalThis.Headers {
  if (shouldProcessMockLimits()) {
    return applyMockHeaders(headers)  // 内部 clone + overwrite
  }
  return headers
}
```

[claudeAiLimits.ts:475](src/services/claudeAiLimits.ts#L475) 调用方:
```ts
const headersToUse = processRateLimitHeaders(headers)
```

**production 代码完全不写 `if (mock) ... else ...`**。所有 mock 路径都被 facade 吸收。

**抄给 Agent**: mock 系统必须通过 facade 注入到 production, 不要让 production 代码到处写 `if (env.MOCK) ...`。

---

## 4. Multi-provider DI: getAnthropicClient

[client.ts:1-389](src/services/api/client.ts) 提供一个工厂函数:

```ts
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,           // ← 关键 DI seam
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic>
```

根据 env var 分流:

| env var | 切到 |
|---|---|
| `CLAUDE_CODE_USE_BEDROCK` | `@anthropic-ai/bedrock-sdk` |
| `CLAUDE_CODE_USE_VERTEX` | `@anthropic-ai/vertex-sdk` |
| `CLAUDE_CODE_USE_FOUNDRY` | Foundry SDK |
| (none) | first-party Anthropic |

### 4.1 SKIP_*_AUTH: mock 认证

```ts
SKIP_BEDROCK_AUTH    // bedrock 跳 AWS 签名, 用空 creds (proxy 测试)
SKIP_VERTEX_AUTH     // vertex 跳 Google auth, 用空 token
SKIP_FOUNDRY_AUTH    // foundry 跳 Azure auth
```

[main.tsx:408-411](src/main.tsx#L408) 启动检查:
```ts
if (isEnvTruthy(CLAUDE_CODE_USE_BEDROCK) && !isEnvTruthy(CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {...}
if (isEnvTruthy(CLAUDE_CODE_USE_VERTEX) && !isEnvTruthy(CLAUDE_CODE_SKIP_VERTEX_AUTH)) {...}
```

**用途**: 内网测试代理(代理已经签好名, SDK 不需要再签), 或 CI 里跑 Bedrock SDK 但不想配真实 AWS creds。

### 4.2 USE_STAGING_OAUTH: staging baseURL

OAuth 走 staging 时 baseURL 变。一行 env var 切环境, 不需要重新 build。

### 4.3 buildFetch wraps fetch with CLIENT_REQUEST_ID_HEADER

```ts
function buildFetch(originalFetch, fetchOverride?) {
  const base = fetchOverride ?? originalFetch
  return async (url, init) => {
    const headers = new Headers(init?.headers)
    if (!headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    return base(url, { ...init, headers })
  }
}
```

**重要 caveat (注释里写)**: CLIENT_REQUEST_ID_HEADER 只在 first-party 路径上能在 Anthropic 端 trace 到。Bedrock/Vertex/Foundry **不会 log 它**, 一旦出 incident, 这部分请求 "对得上 client side 时间戳但对不上 server side request id" — 注释明确标 "inc-4029 class" 风险。

### 4.4 createStderrLogger: 注入自定义 logger

SDK 默认把 retry warning 写到 stdout, 这会污染 `-p` 模式的输出。`createStderrLogger()` 工厂函数返一个 logger 重定向到 stderr, 通过 `ClientOptions.logger` 注入。

---

## 5. withRetry: async generator + heartbeat + persistent mode

[withRetry.ts:1-822](src/services/api/withRetry.ts) 是整个重试机制的中枢, 签名:

```ts
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client, attempt, context) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T>
```

返回 **async generator**, yield 的是 `SystemAPIErrorMessage` (中间状态), 最终 return `T`。

### 5.1 Constants 一眼记住

| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_MAX_RETRIES` | 10 | 普通错误的重试次数 |
| `MAX_529_RETRIES` | 3 | 529 (capacity) 单独算预算 |
| `BASE_DELAY_MS` | 500 | exponential backoff 起点 |
| `PERSISTENT_MAX_BACKOFF_MS` | 5 min | persistent mode 单次 sleep 上限 |
| `PERSISTENT_RESET_CAP_MS` | 6 h | persistent 累计 sleep 上限 |
| `HEARTBEAT_INTERVAL_MS` | 30 s | persistent 模式心跳 yield 间隔 |
| `SHORT_RETRY_THRESHOLD_MS` | 20 s | fast mode 短 retry-after 阈值 |
| `MIN_COOLDOWN_MS` | 10 min | fast mode 长 retry-after 触发 cooldown 后最少持续 |
| `DEFAULT_FAST_MODE_FALLBACK_HOLD_MS` | 30 min | fast mode fallback 默认持续 |

### 5.2 Persistent mode: 30s chunked sleep + heartbeat yield

普通 retry sleep 是 setTimeout 完事。**persistent mode** (`UNATTENDED_RETRY` 环境变量, 比如 cron-driven session) 不一样:

```ts
const delay = getRetryDelay(error, attempt)  // 可能 5min, 10min, 1h
const chunks = Math.ceil(delay / HEARTBEAT_INTERVAL_MS)  // 30s 一段
for (let i = 0; i < chunks; i++) {
  await sleep(Math.min(HEARTBEAT_INTERVAL_MS, remaining))
  yield buildSystemAPIErrorMessage({...})  // ← 让 host 知道我还活着
}
```

**为什么 chunked**: 长 sleep 期间, 上游 host (比如 IDE plugin 或 cron daemon) 可能因为"30s 没收到 yield"标记 session 为 idle / dead 然后 kill。每 30s yield 一个 status message 等于 "心跳", 让 host 知道这个 generator 还在跑只是在等 cooldown。

### 5.3 Fast mode 短/长 retry-after 分流

```ts
if (retryAfter < SHORT_RETRY_THRESHOLD_MS) {
  // 短: 重试当前 attempt 用 fast mode (保 cache)
  await sleep(retryAfter)
  // 重试时仍用 fast model
} else {
  // 长: 切到 standard model, hold 至少 10min
  fastModeFallbackUntil = Date.now() + Math.max(MIN_COOLDOWN_MS, retryAfter)
  yield buildFallbackTriggeredMessage()  // 让外层 model picker 切到 standard
}
```

**核心 trade-off**: 短 retry-after (比如 5s, 因为流量峰值) → 等等就好, 不丢 cache。长 retry-after (5min+, 因为真到 quota 上限) → 直接切到 standard model, 否则等 5min cache 已经过期再切。

### 5.4 shouldRetry 决策树

```ts
function shouldRetry(error, attempt) {
  if (error.headers?.get('x-should-retry') === 'false') return false  // ← server 显式说不要重试
  if (isCCRAuthError(error)) return false   // CCR auth 错误不重试 (用户配置错, 重试也徒劳)
  if (status === 408 || 409 || 429 || 401) return attempt < maxRetries
  if (status >= 500 && status < 600) {
    if (status === 529) return retry529Count < MAX_529_RETRIES
    return attempt < maxRetries
  }
  return false
}
```

**关键**: `x-should-retry: false` 直接停。这是 server 告诉 client "重试也没用, 别浪费"。很多人写 retry 只看 status code, 忘了这个 hint。

### 5.5 CannotRetryError vs FallbackTriggeredError

```ts
class CannotRetryError extends Error {}      // ← 跳出整个 withRetry, 让外层处理
class FallbackTriggeredError extends Error {} // ← 切换 model 的信号
```

后者特别重要: 切 model **不能在 withRetry 内做**, 因为 model 切换涉及 cache key 重新计算、tool list 可能不同, 必须返回到外层 `query.ts` 重新构造 params。withRetry 只负责 yield 信号, 不负责执行切换。

### 5.6 parseMaxTokensContextOverflowError 调整

某些 max_tokens 超过 context 上限的错误, 错误消息里告诉 client "你 max_tokens 太高, 降到 X 重试就 OK"。withRetry 读这个 X, 通过 `retryContext.maxTokensOverride` 传回 operation, 下次重试就用低的值。

**这是产品级的细节**: 用户的 prompt 可能正好压在 context boundary, 第一次报错, 第二次自动 downgrade max_tokens 就过了, 用户无感。

### 5.7 getRetryDelay 加 0.25× jitter

```ts
const delay = baseDelay * Math.pow(2, attempt)  // exponential
const jitter = delay * 0.25 * Math.random()
return delay + jitter
```

**为什么 0.25 不是常见的 0.5**: 0.5 jitter 会让"最快的 retry 比期望快 1/3", 在重 traffic 下会让一批 client 集中冲击。0.25 既能错峰又不会让 retry 整体偏快太多。

---

## 6. errors.ts: 30+ branch 错误分类

[errors.ts:1-1207](src/services/api/errors.ts) 把 raw API error 转成用户友好的 SDKAssistantMessage。核心两个函数:

```ts
export function classifyAPIError(error: unknown): string
export function categorizeRetryableAPIError(error: APIError): SDKAssistantMessageError
```

`classifyAPIError` 是个超大 switch / 一堆 regex / 字符串 includes, 约 30+ branch:

| branch (节选) | 触发条件 | 用户消息举例 |
|---|---|---|
| timeout | `error.message.includes('socket hang up')` | "Request timed out..." |
| image size | `error.message.includes('image bytes exceed')` | "Image too large, try a smaller one" |
| capacity off switch | `headers['anthropic-capacity-off-switch']` | "Anthropic is reducing capacity..." |
| 429 with quota header | `status === 429 && headers['anthropic-ratelimit-unified-status']` | (走 claudeAiLimits 处理) |
| prompt-too-long | `error.message.includes('prompt is too long')` + `parsePromptTooLongTokenCounts` | "Your prompt is X tokens, max Y" |
| PDF page | `'unsupported page'` | "PDF unsupported" |
| PDF password | `'pdf cannot be encrypted'` | "PDF is password protected" |
| image size | `isMediaSizeError(error)` | "Image too large" |
| AFK beta header | (header presence) | "AFK mode not available" |
| 413 | status === 413 | "Payload too large" |
| tool_use/tool_result mismatch | message includes | "Tool result for unknown tool_use" |
| duplicate tool_use | message includes | "Duplicate tool use id" |
| invalid model (sub vs ant) | model name check | (用户类型不同消息不同) |
| credit balance | message includes | "Out of credits..." |
| API key disabled | message includes | "ANTHROPIC_API_KEY disabled" |
| x-api-key | (auth header) | "x-api-key invalid" |
| OAuth revoked | message includes | "OAuth token revoked, re-login" |
| OAuth org not allowed | message includes | "Your org doesn't have access" |
| 401/403 | status | "Auth failed" |
| Bedrock model access | provider + status | "Bedrock denied access to this model" |
| 404 stream | (special) | (走 fallback) |
| connection error | network | "Connection failed" |
| fallback | (other) | (generic message) |

### 6.1 parsePromptTooLongTokenCounts 用 regex 抠出数字

```ts
const m = /prompt is too long: (\d+) tokens > (\d+) maximum/.exec(message)
if (m) {
  return { current: Number(m[1]), max: Number(m[2]) }
}
```

抠出来给 `compact` 服务用 —— 自动 compact 时知道目标要降到多少 token。

### 6.2 isMediaSizeError → 触发 compact retry

```ts
if (isMediaSizeError(error) && hasCompactableContent(messages)) {
  yield { type: 'compact_retry', target: tokenLimit - 100 }
}
```

图片大小超 → 自动 trigger compact 把图缩小或删掉 → 重试。用户感受是"我贴了张大图, agent 自己处理好了"。

### 6.3 get3PModelFallbackSuggestion: 3P version chain

Bedrock/Vertex 上 model name 带 version (`claude-sonnet-4-5-20251001@v1`), 当遇到 "model not available" 错误, 建议用户切到最近的可用版本。这是 3P 特有的, first-party 不需要 (model name 不带 version)。

---

## 7. claude.ts: stream watchdog + 3 fallback entry points + sticky latches

[claude.ts](src/services/api/claude.ts) 3419 行, 三个主要 export:

```ts
export async function* queryModel(...): AsyncGenerator<...>      // 主入口, 用 withRetry 包
export async function* queryModelWithStreaming(...): AsyncGenerator<...>  // VCR 外层 wrap
export async function queryModelWithoutStreaming(...): Promise<AssistantMessage>  // 非流式
```

### 7.1 Sticky beta header latches: cache safety

```ts
let afkHeaderLatched = false
let fastModeHeaderLatched = false
let cacheEditingHeaderLatched = false
let thinkingClearLatched = false
```

每个 latch 一旦 set, **整个 session 都发那个 beta header**。即便后续 retry 不再需要那个 feature, header 也继续发。

**为什么**: cache key 包含 beta header 列表。如果某次请求 latched header, 下次请求不发, cache key 变了, 整段对话上下文要重新发 → 巨贵。一致发 header 保证 cache hit。

### 7.2 paramsFromContext: closure builder per retry attempt

```ts
const paramsFromContext = (retryContext: RetryContext): BetaMessageStreamParams => {
  return {
    model: getEffectiveModel(retryContext),  // ← 可能切换 (fast → standard)
    max_tokens: retryContext.maxTokensOverride ?? getMaxOutputTokensForModel(model),
    messages: addCacheBreakpoints(messages, ...),
    system: buildSystemPromptBlocks(...),
    tools: filterTools(...),
    thinking: getThinkingConfig(...),
    ...(afkHeaderLatched ? { betas: [...betas, 'afk'] } : {}),
    ...
  }
}
```

每次 retry 调用这个 closure 重新算 params。retryContext 带着上次失败的信息(maxTokensOverride / shouldDisableTools / ...), closure 用这些信息调整。

### 7.3 Stream watchdog: 90s idle abort

```ts
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS) || 90_000

let streamIdleTimer: NodeJS.Timeout | null = null
let streamIdleAborted = false
const resetStreamIdleTimer = () => {
  clearTimeout(streamIdleTimer)
  streamIdleTimer = setTimeout(() => {
    streamIdleAborted = true
    stream.controller.abort()
  }, STREAM_IDLE_TIMEOUT_MS)
}

for await (const event of stream) {
  resetStreamIdleTimer()  // ← 每收到一个 chunk 就重置
  ...
}
```

整个 stream 90s 没收到 chunk → 强制 abort → 走 non-streaming fallback。

通过 `CLAUDE_ENABLE_STREAM_WATCHDOG=0` 关掉(emergency disable)。

### 7.4 STALL_THRESHOLD_MS = 30s: 早期 stall 检测

```ts
if (Date.now() - streamStartTime > STALL_THRESHOLD_MS && firstChunkNotYetSeen) {
  logEvent('tengu_stream_stall_detected', {...})
  // 不 abort, 只记 telemetry
}
```

30s 还没收到第一个 chunk → 记 telemetry。**不 abort**, 因为 cold-start 大 prompt 偶尔会 25-40s 才出第一个 chunk。只是埋点用来事后分析。

### 7.5 三个非流式 fallback 入口

```
1. 流式 error  → catch 块 → executeNonStreamingRequest()
2. watchdog abort → streamIdleAborted=true → catch 走 fallback
3. 404 on stream creation (.withResponse() 阶段) → outer catch → fallback
```

第 3 个最隐蔽: SDK v2.1.8 改了 raw stream API, 某些 model 在 `stream.withResponse()` 阶段就抛 404, 还没开始迭代。这个 error 不会被普通 try/await 抓到, 需要单独 outer catch。

### 7.6 FallbackTriggeredError 必须 propagate

```ts
catch (error) {
  if (error instanceof FallbackTriggeredError) {
    throw error  // ← 必须扔给 query.ts, 不能在这里处理
  }
  ...
}
```

切 model 的逻辑在 `query.ts`, 这里只是信号站。

### 7.7 releaseStreamResources: 防 native memory leak

```ts
finally {
  releaseStreamResources(stream)  // ← GH #32920 fix
}
```

SDK 流持有的 TLS socket buffer 是 native 资源, JS GC 不一定及时清。显式 `stream.controller.abort()` + null 引用 让 V8 早释放。

### 7.8 isNonStreamingFallbackDisabled: 双 kill switch

```ts
const env = isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK)
const gb = getFeatureValue('tengu_disable_streaming_to_non_streaming_fallback', false)
return env || gb  // ← 任一打开就关掉 fallback
```

env var 是本地 emergency, GrowthBook 是远程 emergency。出 inc 时 SRE 可以远程关掉(env 改不动客户机器)。

### 7.9 initialConsecutive529Errors: 529 budget 跨流式/非流式共享

streaming 收到 529 计数, 进 non-streaming fallback 后仍算到 `MAX_529_RETRIES=3` 里。否则 streaming 用了 2 次, fallback 又用 3 次, 总共 5 次, 超 budget。

### 7.10 cost tracked in finally

```ts
let totalCost = 0
try { ... yield events ... }
finally {
  addToTotalSessionCost(totalCost)  // ← 即便用户中途 .return() 也算
}
```

generator 被 `.return()` 提前终止时, 已经花的 token cost 必须计入, 否则 cost-tracker 漏算。

### 7.11 MAX_NON_STREAMING_TOKENS = 64_000

非流式 10min 上限(API doc), SDK 算出来是 21333 token cap, 这里 bypass 用 client-level timeout, 上调到 64k。

### 7.12 adjustParamsForNonStreaming: thinking budget 同步降

切 non-streaming 时, max_tokens 可能从 64k → 16k。如果 thinking.budget_tokens 还是 32k 就违反 API 约束 (`max_tokens > thinking.budget_tokens`)。

```ts
adjustedParams.thinking.budget_tokens = Math.min(
  adjustedParams.thinking.budget_tokens,
  cappedMaxTokens - 1,  // 必须严格小于
)
```

### 7.13 isMaxTokensCapEnabled + CAPPED_DEFAULT_MAX_TOKENS = 8k

```ts
// BQ p99 output = 4,911 tokens; 32k/64k 默认 over-reserve 8-16× slot capacity
const defaultTokens = isMaxTokensCapEnabled()
  ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
  : maxOutputTokens.default
```

**生产洞察**: 99% 请求 output 不到 5k token, 但 default 是 32k/64k。这会让 server 给每个请求"占"过多的 slot 容量, 导致整体 throughput 降。改成默认 8k, 真要超的请求走 `query.ts max_output_tokens_escalate` 一次重试用 64k。

GrowthBook flag `tengu_otk_slot_v1` 控制是否启用 (3P 默认 false, 因为 Bedrock/Vertex 没验证)。

---

## 8. claudeAiLimits.ts: quota state + listener pattern

[claudeAiLimits.ts:139-197](src/services/claudeAiLimits.ts#L139) 持有 module-level `currentLimits`, 通过 `statusListeners: Set<StatusChangeListener>` 广播:

```ts
export const statusListeners: Set<StatusChangeListener> = new Set()

export function emitStatusChange(limits: ClaudeAILimits) {
  currentLimits = limits
  statusListeners.forEach(listener => listener(limits))
  logEvent('tengu_claudeai_limits_status_changed', {...})
}
```

[claudeAiLimitsHook.ts](src/services/claudeAiLimitsHook.ts) (24 行):
```ts
export function useClaudeAiLimits(): ClaudeAILimits {
  const [limits, setLimits] = useState({ ...currentLimits })
  useEffect(() => {
    const listener = (newLimits) => setLimits({ ...newLimits })
    statusListeners.add(listener)
    return () => { statusListeners.delete(listener) }
  }, [])
  return limits
}
```

**经典 pub/sub**: state 在 module level, hook 订阅 / unsubscribe。任意多个 React 组件都能用同一份 state, 不需要 Context Provider。

### 8.1 Early warning: 双策略 (header-based + time-relative)

```ts
// 优先用 server 的 surpassed-threshold header
function getHeaderBasedEarlyWarning(headers): ClaudeAILimits | null
// fallback: 客户端按 windowSeconds + utilization 算
function getTimeRelativeEarlyWarning(headers, config): ClaudeAILimits | null
```

3 套 7d 阈值:
```ts
{ utilization: 0.75, timePct: 0.6 }   // 70%过去前用了 75%
{ utilization: 0.5,  timePct: 0.35 }  // 35%过去前用了 50%
{ utilization: 0.25, timePct: 0.15 }  // 15%过去前用了 25%
```

任一命中就 warn 用户"你这速率撑不到 reset"。

**为什么客户端也要算**: 早期 server 还没部署 surpassed-threshold header, 客户端 fallback 计算保证向后兼容。新版本 server 部署后, header 路径接管。

### 8.2 isUsingOverage = 主 status rejected + overageStatus allowed

```ts
const isUsingOverage = status === 'rejected' &&
  (overageStatus === 'allowed' || overageStatus === 'allowed_warning')
```

主 quota 用光 → 走 overage(额外计费)。UI 显示 "You're using extra usage at $X/Mtok"。

### 8.3 cacheExtraUsageDisabledReason: 持久化到 globalConfig

```ts
const reason = headers.get('anthropic-ratelimit-unified-overage-disabled-reason') ?? null
const cached = getGlobalConfig().cachedExtraUsageDisabledReason
if (cached !== reason) {
  saveGlobalConfig(current => ({ ...current, cachedExtraUsageDisabledReason: reason }))
}
```

为什么持久化: 用户没主动开 overage 的话, UI 想显示"为啥你不能用 overage"必须有 reason。如果只在 in-memory, 重启 reason 消失, UI 显示不全。

### 8.4 nonInteractive 跳 pre-check

```ts
if (getIsNonInteractiveSession()) {
  return  // -p mode: 真请求紧跟着, 用真请求 headers 更新
}
```

`-p` 单次模式下, 不发额外的 quota-check 请求 (浪费 token), 用真请求的 response headers 顺便更新 limits。

### 8.5 essential traffic only: 跳网络调用

```ts
if (isEssentialTrafficOnly()) return
```

privacy level "essential only" 时, quota check 这种"为了 UI 显示"的额外请求全跳。隐私优先。

---

## 9. Env-var feature gates (15+ CLAUDE_CODE_*)

完整列表 (按 grep 出来 14 个文件 30+ 处):

| env var | 作用 |
|---|---|
| `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` | 切 provider |
| `CLAUDE_CODE_SKIP_BEDROCK/VERTEX/FOUNDRY_AUTH` | mock auth |
| `CLAUDE_CODE_USE_CCR_V2` | 切 CCR v2 transport |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | 关 fallback |
| `CLAUDE_CODE_ENABLE_STREAM_WATCHDOG` | 关 watchdog |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | 调 watchdog 阈值 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | override max_tokens |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | 关 fast mode |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | 关 feedback survey |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | 关 background tools |
| `CLAUDE_CODE_DISABLE_CRON` | 关 cron tool |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 关 auto-memory |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | 关 terminal title |
| `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL` | 关 message virtual scroll |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | 关 file checkpoint |
| `CLAUDE_CODE_FORCE_FULL_LOGO` | 强制完整 logo |
| `CLAUDE_CODE_FORCE_SANDBOX` | 强制 sandbox |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | 切 prompt 补全 |
| `CLAUDE_CODE_ENABLE_XAA` | XAA MCP |
| `CLAUDE_CODE_TEST_FIXTURES_ROOT` | VCR fixture 路径 |
| `CLAUDE_MOCK_HEADERLESS_429` | mock 无 header 的 429 |
| `USER_TYPE` | ant / sub / 3P 分流 |
| `FORCE_VCR` | ant 本地 VCR |
| `VCR_RECORD` | CI 显式录制 |
| `NODE_ENV` | test 自动开 VCR |
| `USE_STAGING_OAUTH` | OAuth staging |

**核心模式**: 几乎每个新功能都有"emergency kill switch", `isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_X)`。出 inc 时 SRE 让用户加 env var 重启即可绕开, 不需要紧急发 patch。

`isEnvTruthy` 和 `isEnvDefinedFalsy` 配对:
- `isEnvTruthy("1"/"true"/"yes")` → true
- `isEnvDefinedFalsy("0"/"false"/"no")` → true (其他 → false)

**区别**: `DISABLE_X` 默认 false, 用 `isEnvTruthy` 判断 "is on"; `ENABLE_X` 默认 true, 用 `isEnvDefinedFalsy` 判断 "is off"。这样 unset 永远是默认行为, 不被环境变量意外打破。

---

## 10. 其他可测性 seam 散点

### 10.1 wrapFetchWithTimeout (mcp/client.ts:492)

```ts
export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike
```

接受 FetchLike, 返回 FetchLike, 中间加 timeout + Accept header 规范化。**纯 wrapper, 不知道 mcp 细节**, 任何 fetch 都能套。

### 10.2 wrapFetchWithStepUpDetection (mcp/auth.ts:1354)

OAuth step-up flow 的 fetch 包装。同样是 FetchLike → FetchLike, 检测到 401 step-up challenge 时触发重新认证。

### 10.3 LSPClient factory (lsp/LSPClient.ts:51)

```ts
export function createLSPClient(...): LSPClient
```

factory function 而不是 class constructor — 内部用 closure 持有状态, 暴露公开方法。优于 class: 不需要 `this`, 不需要 inheritance, 测试时直接构造 mock 工厂函数返一个对象就行。

### 10.4 module-level mutable state (有意为之)

- `mockHeaders` (mockRateLimits.ts)
- `mockExpiry`
- `currentLimits` (claudeAiLimits.ts)
- `rawUtilization`
- `statusListeners`
- `afkHeaderLatched` 等 4 个 (claude.ts)

全部 module-level `let`。架构纯净度低, 但**实际工作良好** —— Node.js single-process model 下, 每个进程一份 state, 重启全清。不需要架构成依赖注入容器。

**抄给 Agent**: 不要为了"架构纯洁"把所有 state 塞容器, 单进程 module-level let 足够多数场景。

### 10.5 essential traffic gate (privacyLevel)

`isEssentialTrafficOnly()` 在多处 gate:
- quota check 跳
- telemetry 减少
- feedback survey 跳
- experiment 上报跳

privacy 极端模式只发"agent 必需"的请求, 不发任何"为了 UX/feedback"的请求。这是合规层面的 testability — 测试某些隐私 mode 下系统行为, 必须有 gate 让所有"非必要 traffic"统一关掉, 不要散在各处。

---

## 11. 给做 Agent 时能偷的招(M22 增补)

抄这些, 做 Agent 的"可观测可注入可中断" 少踩 5 个月坑:

1. **VCR pattern**: input → sha1 hash → fixture file, dehydrate/hydrate 规范化所有"非确定性"字段(path / num / uuid / timestamp).
2. **CI 显式 record flag**: 默认不写 fixture, 防"忘 commit fixture 在 CI 里默默通过"。
3. **每条 message 单独 hash 用 `-` 连**: filename 能看出 prefix 共享, 调试好。
4. **deterministic UUID-${N} in dehydrate, randomUUID in hydrate**: 文件稳定, runtime 唯一。
5. **mock 系统通过 facade 注入**: production 代码不写 `if (mock) ...`, facade 内部判断。
6. **ANT-only gate 在每个 mutator 上**: `if USER_TYPE !== 'ant' return`, 别信调用方守门。
7. **lazy expiry**: mock state 第一次撞到才开始算计时, 避免设了就消耗。
8. **module-level let 是合法的**: 不要为了"架构"把所有 state 塞容器。
9. **getClient factory function with `fetchOverride?` param**: 关键 DI seam, 测试和 proxy 都用得上。
10. **SKIP_*_AUTH env vars**: provider 切换 + mock auth, 内网代理测试必备。
11. **多个 env var emergency switch**: `DISABLE_X` 默认 false, 出 inc 让 SRE 远程指导用户 enable。
12. **isEnvTruthy vs isEnvDefinedFalsy 配对**: `DISABLE` 用 truthy, `ENABLE` 用 falsy, 默认行为永远不被环境意外打破。
13. **withRetry as async generator**: yield 中间状态 (heartbeat / status message), 最终 return result, 比单 Promise 灵活。
14. **persistent mode chunked sleep**: 长 sleep 切 30s 段, 每段 yield heartbeat 防 host kill。
15. **fast/slow retry-after 分流**: 短 retry 等等就好(保 cache), 长 retry 切 model(避免 cache 过期再切)。
16. **x-should-retry header 优先**: server 显式说不要重试就别重试, 不只看 status code。
17. **FallbackTriggeredError 信号扔上层**: 切 model 不在 retry 内做, propagate 到外层重新构造 params。
18. **classifyAPIError 30+ branch**: 不要嫌多, 用户体验是从"看到 raw error" 到 "看到 actionable message" 的全部细节。
19. **regex 抠出 prompt-too-long 数字**: 让 compact 知道目标。
20. **sticky beta header latched 整个 session**: 保 cache key 一致。
21. **stream watchdog 90s idle abort**: 偶发挂起的 stream 必须有机制 abort。
22. **STALL_THRESHOLD_MS 30s 不 abort 只埋点**: cold-start 大 prompt 偶尔慢, 不要直接 abort 让用户重试。
23. **三个 fallback 入口**: streaming error / watchdog abort / 404 on stream creation (.withResponse 阶段独特)。
24. **releaseStreamResources in finally**: native TLS buffer 显式释放, JS GC 不及时。
25. **cost track in finally**: generator 被 `.return()` 提前终止仍要算 cost。
26. **non-streaming fallback 双 kill switch**: env + GrowthBook, 远程能关。
27. **MAX_NON_STREAMING_TOKENS 64k bypass SDK 21k 默认**: client-level timeout 让 cap 更高。
28. **adjustParamsForNonStreaming**: 切 non-streaming 时 thinking.budget_tokens 必须 < max_tokens。
29. **default max_tokens 8k(BQ p99 4.9k)**: 99% 不需要 32k, 真要超的走 escalate retry。
30. **listener pattern: Set<Listener> + module state**: 不需要 Context, 不需要 Zustand, 简单到飞起。
31. **早期 warning 双策略 header + 时间相对**: server 还没部署 header 时客户端 fallback 算, server 部署后接管。
32. **cacheExtraUsageDisabledReason persist 到 globalConfig**: 重启不丢, UI 总能显示原因。
33. **nonInteractive 跳 pre-check**: -p 模式下不发额外 quota-check, 用真请求顺便。
34. **essential traffic only gate**: privacy 极端模式统一关所有"非必要 traffic"。
35. **createStderrLogger redirects SDK warning**: -p 模式 stdout 不被污染。
36. **CLIENT_REQUEST_ID_HEADER inject + 注释 caveat**: 标 Bedrock/Vertex/Foundry 不 log → "inc-4029 class" 风险。
37. **wrapFetchWithTimeout FetchLike → FetchLike**: 纯 wrapper 模式, 不关心 baseFetch 细节, 任意 fetch 都能套。
38. **createLSPClient factory 不用 class**: closure 持状态, 暴露方法对象, 测试时构造 mock 工厂返对象就行。

---

## 12. 5 个最有"工程含量"的设计点 (M22 提炼)

1. **VCR sha1 + dehydrate**: 让 record/replay 系统能跨平台 cross-platform, fixture 在 git 里稳定不抖。这是"可重现 bug 报告"和"快速 regression 测试"的基石。
2. **withRetry async generator + heartbeat**: 把长 sleep 切 30s 段每段 yield 心跳, 解决"上游 host 没耐心等"的问题。单 Promise 做不到, generator 让"中间过程可观察"。
3. **三个 fallback 入口 + FallbackTriggeredError propagate**: streaming 出问题的方式有三种(error / idle / 404-on-create), 每种都要走 fallback, 信号必须传到 query.ts 才能切 model。设计能看到对"失败种类"的全面理解。
4. **mock facade 隔离 production / mock**: production 代码不写 `if (mock)`, 所有 mock 路径被 facade 吸收。这是工程上"零成本可测"的典范。
5. **module-level state + listener pattern**: 没用 Context/Zustand/Redux, 就一个 `Set<Listener>` + module `let`。简单到几乎是反 pattern, 但**实际是最匹配 Node.js single-process model 的设计**。架构纯洁性不是目标, 解决问题是。

---

## 13. 收尾

M22 不是 unit test 列表(那部分被 strip 了), 而是**production runtime 内置的可测性脚手架**: VCR / mock / DI / retry generator / watchdog / fallback / listener。这套脚手架的核心思想:

- **可注入**: 关键路径(fetch, client, logger)都接收 override 参数。
- **可观察**: state 通过 listener 广播, generator yield 中间状态。
- **可中断**: 每个长操作都有 timeout / abort / kill switch。
- **可降级**: streaming → non-streaming, fast model → standard, max_tokens 自动降。
- **可重现**: VCR 让对话能 record/replay, fixture 跨平台稳定。
- **可远程控制**: env var + GrowthBook 双 kill switch, SRE 出 inc 时不需要发版。

跟 M10(bridge) / M11(Ink) / M14(子代理) / M19(state) 联动。**测试不是写多少 test case, 是产品代码本身能不能被外部观测、注入、中断、降级**。M22 把这部分讲透。

---

## 最后送你 6 句话记一辈子(M22)

> **1. VCR: input → sha1 hash → fixture, dehydrate 把 path/num/uuid/timestamp 全换 token, CI 必须 VCR_RECORD=1 显式录。**
> **2. mock 系统通过 facade(processRateLimitHeaders)注入, production 代码完全不写 `if (mock)`。**
> **3. getAnthropicClient 接 `fetchOverride?` + `SKIP_*_AUTH` env var, 多 provider DI 一招通杀。**
> **4. withRetry 是 async generator yield SystemAPIErrorMessage, persistent mode 切 30s 段心跳防 host kill。**
> **5. 三个 fallback 入口(streaming error / watchdog 90s idle / 404 on stream creation), FallbackTriggeredError 必须 propagate 到 query.ts 切 model。**
> **6. module-level let + Set<Listener> 广播 = state 管理的最低成本方案, 不要为"架构"上 Context/Zustand。**
