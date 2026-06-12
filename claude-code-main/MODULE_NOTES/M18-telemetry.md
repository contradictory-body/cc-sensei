# M18 · Telemetry / Analytics / Transports

> 范围: `src/services/analytics/` (9 文件, 4040 行) + `src/cli/transports/` (7 文件, 3242 行) + `src/services/internalLogging.ts` (90 行). 共 17 个文件, 7372 行.
> 关键词: marker 类型 PII 校验 · queue-before-sink · killswitch+sampling+allowlist 三层闸门 · Datadog 卡片白名单 · OpenTelemetry 批处理 · disk-backed quadratic backoff · 跨实例并发安全 · GrowthBook remote-eval workaround · proto-generated type · WS 重连 · SSE/CCR v2 双通道 · SerialBatchEventUploader.
> 子模块依赖: M16 (gracefulShutdown 调 shutdownDatadog/flush), M14 (subagent 触发 agent_id 字段), M19 (sessionId 串联), M17 (privacyLevel 关闸).

---

## 一、模块边界与文件清单

### analytics 子模块
| 文件 | 行数 | 角色 |
|------|------|------|
| [index.ts](src/services/analytics/index.ts) | 174 | 公共 API + eventQueue + 双 sink 入口 |
| [sink.ts](src/services/analytics/sink.ts) | 115 | initializeAnalyticsSink — 同时挂 Datadog + 1P |
| [sinkKillswitch.ts](src/services/analytics/sinkKillswitch.ts) | 25 | GrowthBook `tengu_frond_boric` 拉杆 |
| [config.ts](src/services/analytics/config.ts) | 38 | 测试 / Bedrock / Vertex / Foundry / privacyLevel 关闸 |
| [datadog.ts](src/services/analytics/datadog.ts) | 307 | 40 事件白名单 + 字段重命名 + user bucket |
| [firstPartyEventLogger.ts](src/services/analytics/firstPartyEventLogger.ts) | 449 | OpenTelemetry LoggerProvider + 配置 hot-reload |
| [firstPartyEventLoggingExporter.ts](src/services/analytics/firstPartyEventLoggingExporter.ts) | 806 | 自定义 exporter + disk-backed retry + auth fallback |
| [growthbook.ts](src/services/analytics/growthbook.ts) | 1155 | feature flag/gate + remote-eval SDK workaround |
| [metadata.ts](src/services/analytics/metadata.ts) | 973 | envContext + processMetrics + tool name sanitize |
| [internalLogging.ts](src/services/internalLogging.ts) | 90 | Anthropic 内部 K8s/容器探针 |

### transports 子模块
| 文件 | 行数 | 角色 |
|------|------|------|
| [transportUtils.ts](src/cli/transports/transportUtils.ts) | 45 | getTransportForUrl — 3 路由分发 |
| [WebSocketTransport.ts](src/cli/transports/WebSocketTransport.ts) | 800 | WS 全双工 + 重连 + sleep 检测 + replay |
| [HybridTransport.ts](src/cli/transports/HybridTransport.ts) | 282 | WS 读 + HTTP POST 写 |
| [SSETransport.ts](src/cli/transports/SSETransport.ts) | 711 | SSE 读 + HTTP POST 写 (CCR v2) |
| [SerialBatchEventUploader.ts](src/cli/transports/SerialBatchEventUploader.ts) | 275 | 通用串行批量上传 primitive |
| [WorkerStateUploader.ts](src/cli/transports/WorkerStateUploader.ts) | 131 | PUT /worker 合并补丁 |
| [ccrClient.ts](src/cli/transports/ccrClient.ts) | 998 | CCR v2 worker 生命周期 + 4 个 uploader |

---

## 二、analytics 公共 API: eventQueue + queueMicrotask drain

[index.ts:13-44](src/services/analytics/index.ts#L13-L44) 定义两个 marker 类型:

```ts
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = string & never
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = string & never
```

`& never` 让任何普通 string **直接赋值会编译失败**, 必须显式 cast — cast 处就是 PII 审查锚点. 这不是运行时校验, 是给 reviewer 的 "你看过这段没". 比写一堆 lint 规则便宜.

[index.ts:60-110](src/services/analytics/index.ts#L60-L110) 公共 API `logEvent` / `logEventAsync` 的行为分两阶段:

```ts
let sink: ((event: AnalyticsEvent) => void) | null = null
const eventQueue: AnalyticsEvent[] = []

export function attachAnalyticsSink(s: (event: AnalyticsEvent) => void): void {
  sink = s
  queueMicrotask(() => {
    while (eventQueue.length > 0) {
      const event = eventQueue.shift()
      if (event && sink) sink(event)
    }
  })
}
```

**启动顺序问题**: CC 初始化时 `logEvent('cli_startup', ...)` 可能在 GrowthBook / OpenTelemetry 还没 ready 之前就被调用. 如果 `logEvent` 在 sink null 时直接 drop, 这些早期事件丢失. 如果阻塞等 sink, 启动慢一截.

解法: **queue 在内存, sink 一就绪用 `queueMicrotask` 异步排空**. `queueMicrotask` 比 `setTimeout(0)` 优: 在当前同步代码块结束、下一个 task 开始前执行, 比 Promise.resolve().then 更接近"立即"且不绕 Promise 状态机. 启动 critical path 零阻塞.

`logEventAsync` 是同 `logEvent` 的 await 版本, 给批处理结尾 ensure-flush 场景 (`await logEventAsync(...)` 后立即 process.exit 不丢事件).

---

## 三、sink: Datadog + 1P 双 fanout, killswitch 独立

[sink.ts](src/services/analytics/sink.ts) 的 `initializeAnalyticsSink` 调用:

```ts
attachAnalyticsSink(event => {
  if (shouldTrackDatadog()) {
    sendDatadogEvent(event)  // 40 事件白名单内才发
  }
  if (is1PEventLoggingEnabled()) {
    logFirstPartyEvent(event)  // 全部 forward
  }
})
```

**为什么 Datadog 和 1P 分两条线?**
- Datadog 是**通用监控**, 后端按字段维度建索引, **cardinality 敏感** — toolName 不能直接进去, mcpServerName 不能直接进去, 否则字段维度爆炸.
- 1P (OpenTelemetry → Anthropic 自家 backend) 是**业务事件管道**, 字段语义化, 经 proto 定义, 不怕 cardinality.

[sink.ts:67-89](src/services/analytics/sink.ts#L67-L89) `shouldTrackDatadog()`:

```ts
let cachedShouldTrackDatadog: boolean | null = null

export function shouldTrackDatadog(): boolean {
  if (isSinkKilled('datadog')) return false  // killswitch
  const cached = checkGate_CACHED_OR_BLOCKING('tengu_log_datadog_events')
  if (cached !== null) {
    cachedShouldTrackDatadog = cached
    return cached
  }
  return cachedShouldTrackDatadog ?? false  // GrowthBook 未就绪 fallback
}
```

注意 `cachedShouldTrackDatadog` 在内部缓存上次值. 因为 GrowthBook 启动期间 (未拉到 disk cache) `checkGate_CACHED_OR_BLOCKING` 返回 null, 这时回退用上次进程的缓存. 避免启动期间事件全 drop.

[sinkKillswitch.ts](src/services/analytics/sinkKillswitch.ts) 全文 25 行, 注释强调:

```
// MUST NOT be called from is1PEventLoggingEnabled():
// is1PEventLoggingEnabled gates GrowthBook auto-exposure events,
// which are themselves 1P events — calling checkGate inside that path
// would recurse infinitely.
```

这是**真实踩过的坑**. killswitch 用 `tengu_frond_boric` (混淆名), 拉杆操作 incident 响应人员能搜出来, 但攻击者翻代码不知道这是 kill switch.

---

## 四、config: 多源关闸

[config.ts:6-38](src/services/analytics/config.ts#L6-L38) `isAnalyticsDisabled()`:

```ts
export function isAnalyticsDisabled(): boolean {
  if (process.env.NODE_ENV === 'test') return true
  if (getModelProvider() === 'bedrock') return true
  if (getModelProvider() === 'vertex') return true
  if (process.env.CLAUDE_CODE_USE_FOUNDRY) return true
  if (getPrivacyLevel() === 'opt-out') return true
  return false
}
```

5 条独立关闸. 用户拉 `CLAUDE_CODE_USE_BEDROCK=1` 或选 `privacyLevel: 'opt-out'`, **整条 analytics 链路全停**. 这种"任一条件成立则关"的设计比"全部开"安全 — 默认 strict.

`isFeedbackSurveyDisabled` 函数注释明确: **不会**因为 3P provider 而关 feedback survey — survey 是用户主动按 button 触发, 不算事件追踪.

---

## 五、Datadog: 40 事件白名单 + cardinality 防御

[datadog.ts:24-71](src/services/analytics/datadog.ts#L24-L71) `DATADOG_ALLOWED_EVENTS`:

```ts
const DATADOG_ALLOWED_EVENTS = new Set([
  'cli_startup',
  'cli_session_end',
  'cli_request_failure',
  'cli_websocket_connect_error',
  'cli_websocket_pong_timeout',
  // ... 40 个
])
```

只有运营关心的"系统健康"事件进 Datadog. 业务事件 (用户按 alt+i 等) 走 1P. **Datadog 月费按事件量收, 白名单是钱**.

[datadog.ts:73-101](src/services/analytics/datadog.ts#L73-L101) `TAG_FIELDS` 集合:

```ts
const TAG_FIELDS = new Set([
  'arch', 'clientType', 'model', 'platform', 'serverType', 'sessionId',
  'userId', 'version', // ...
])
```

只有这些进 Datadog tag (索引列), 其他字段进 message 主体 (全文检索, 不索引). 这是**索引成本控制**.

[datadog.ts:107-149](src/services/analytics/datadog.ts#L107-L149) **字段重命名 + cardinality 防御**:

```ts
function sanitizeForDatadog(event: AnalyticsEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    // `status` is reserved by Datadog (log level field)
    if (key === 'status') {
      out['http_status'] = value
      if (typeof value === 'number') {
        out['http_status_range'] = `${Math.floor(value / 100)}xx`
      }
      continue
    }
    // MCP toolName has unbounded cardinality
    if (key === 'toolName' && typeof value === 'string' && value.startsWith('mcp__')) {
      out['toolName'] = 'mcp'
      continue
    }
    // External user model normalization
    if (key === 'model' && process.env.USER_TYPE !== 'ant') {
      out['model'] = getCanonicalName(value)
      continue
    }
    out[camelToSnakeCase(key)] = value
  }
  return out
}
```

注意每条 transform 的目的:
1. `status` → `http_status` — Datadog `status` 是 log level (error/warn/info), 撞名会被错分级别.
2. MCP toolName → `"mcp"` — 防止 `mcp__github__list_issues`, `mcp__slack__send_message` 等 N 万个 tool name 撑爆 Datadog 索引.
3. 外部用户 model 走 `getCanonicalName` 把内部代号映射成公开名.
4. camelCase → snake_case — Datadog 字段约定.

[datadog.ts:154-181](src/services/analytics/datadog.ts#L154-L181) **user bucket**:

```ts
function getUserBucket(userId: string | undefined): number | undefined {
  if (!userId) return undefined
  const hash = createHash('sha256').update(userId).digest('hex')
  return parseInt(hash.slice(0, 8), 16) % 30
}
```

为啥 mod 30? 估算 unique user 用. 不直接送 userId (cardinality 等于用户数 = 千万级), 而是 hash 后 mod 30 — bucket 数 30 个, 但通过 bucket 分布的偏斜可以估算 unique user (count-distinct on bucket × 30, 用 capture-recapture 修正). cardinality 从千万降到 30, 索引成本 → 0.

[datadog.ts:213-249](src/services/analytics/datadog.ts#L213-L249) **dev version 截断**:

```ts
function truncateDevVersion(v: string): string {
  // e.g. "1.0.123-dev.20251101.183059" → "1.0.123-dev"
  return v.replace(/-dev\.[\d.]+$/, '-dev')
}
```

dev 版本带 timestamp, 每次 build 不同, cardinality 又爆. 截尾, 同 PR 的所有 build 视作一个版本.

[datadog.ts:260-300](src/services/analytics/datadog.ts#L260-L300) `shutdownDatadog` 在 gracefulShutdown 时 flush 残留 batch.

精髓: **Datadog 的字段语义和 cardinality 约束都不写在 Datadog SDK 里, 必须在 client 侧 transform**. 否则索引爆炸 + 计费爆炸. 这套 sanitize 是把通用 SDK 当裸 wire 用的代价.

---

## 六、firstPartyEventLogger: OpenTelemetry + 3 步 hot-swap

[firstPartyEventLogger.ts:33-69](src/services/analytics/firstPartyEventLogger.ts#L33-L69) 用 OpenTelemetry `LoggerProvider`:

```ts
const provider = new LoggerProvider({ resource })
provider.addLogRecordProcessor(
  new BatchLogRecordProcessor(new FirstPartyEventLoggingExporter(opts), {
    scheduledDelayMillis: 10000,  // 10s flush
    maxExportBatchSize: 200,
    maxQueueSize: 8192,
  })
)
```

为啥 `BatchLogRecordProcessor` 而不是 SimpleProcessor? Simple 是同步 await export, 阻塞业务流; Batch 是后台 flush, 业务零等待.

[firstPartyEventLogger.ts:139-186](src/services/analytics/firstPartyEventLogger.ts#L139-L186) `is1PEventLoggingEnabled`:

```ts
export function is1PEventLoggingEnabled(): boolean {
  if (isAnalyticsDisabled()) return false
  if (isSinkKilled('firstParty')) return false
  return true
}
```

简单堆叠 — 任一关闸都关.

[firstPartyEventLogger.ts:200-256](src/services/analytics/firstPartyEventLogger.ts#L200-L256) **配置 hot-reload — 3 步 swap**:

```ts
export async function reinitialize1PEventLoggingIfConfigChanged(): Promise<void> {
  const currentSig = JSON.stringify(currentConfigSnapshot)
  const newConfig = readBatchConfigFromGB()
  const newSig = JSON.stringify(newConfig)
  if (currentSig === newSig) return

  // Step 1: null logger so no new events buffer into the old provider
  const oldProvider = activeProvider
  activeProvider = null
  
  // Step 2: forceFlush the old provider (drains its batch)
  try {
    await oldProvider.forceFlush()
  } catch (err) {
    logForDiagnosticsNoPII('error', '1p_logger_flush_failed_during_swap')
    // Restore on failure — keep using old provider
    activeProvider = oldProvider
    return
  }
  
  // Step 3: build new provider, swap in
  const newProvider = buildProvider(newConfig)
  activeProvider = newProvider
  currentConfigSnapshot = newConfig
  await oldProvider.shutdown()
}
```

为啥 3 步? 直接 `activeProvider = new ...` 会:
- 老 provider batch 里的 200 个事件没 export, GC 时丢.
- 切换瞬间新事件可能进老 provider (race).

3 步保证: 先 stop accept (null) → 排空 → swap in. 失败回滚到老 provider 继续用 — **degraded but functional** 比 silent failure 强.

精髓: **任何"运行时换 backend"必须 stop-flush-swap 三步**, 否则丢数据.

---

## 七、firstPartyEventLoggingExporter: disk-backed retry 灵活退化

[firstPartyEventLoggingExporter.ts:71-95](src/services/analytics/firstPartyEventLoggingExporter.ts#L71-L95) 存储路径:

```ts
const BATCH_UUID = randomUUID()  // 进程内只生成一次

function getFailedEventsFilePath(): string {
  return path.join(
    homedir(),
    '.claude/telemetry',
    `1p_failed_events.${sessionId}.${BATCH_UUID}.json`
  )
}
```

**为啥 BATCH_UUID?** 多个 CC 进程同时跑, 都往一个文件写 → 写并发损坏 JSON. 每个 BATCH 一个 UUID, 文件名不冲突. 进程退出时仅自己的文件留下, 下一进程的 `retryPreviousBatches` 才能不污染自己当前 BATCH 文件.

[firstPartyEventLoggingExporter.ts:108-156](src/services/analytics/firstPartyEventLoggingExporter.ts#L108-L156) `retryPreviousBatches`:

```ts
async retryPreviousBatches(): Promise<void> {
  const dir = path.join(homedir(), '.claude/telemetry')
  const files = await fs.readdir(dir).catch(() => [])
  for (const file of files) {
    // 关键: 排除自己的 BATCH_UUID
    if (file.includes(BATCH_UUID)) continue
    if (!file.startsWith('1p_failed_events.')) continue
    
    const filePath = path.join(dir, file)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const events = content.split('\n').filter(Boolean).map(jsonParse)
      await this.sendEventsInBatches(events)
      await fs.unlink(filePath)  // 成功后删
    } catch {
      // 留着, 下次再试
    }
  }
}
```

启动时扫 `~/.claude/telemetry/`, 把上次进程没发完的 batch 试一遍. 网络掉线一周, 重启后继续补.

[firstPartyEventLoggingExporter.ts:230-289](src/services/analytics/firstPartyEventLoggingExporter.ts#L230-L289) `sendEventsInBatches` 短路:

```ts
private async sendEventsInBatches(events: LogRecord[]): Promise<void> {
  for (let i = 0; i < events.length; i += this.maxBatchSize) {
    const batch = events.slice(i, i + this.maxBatchSize)
    try {
      await this.exportBatch(batch)
    } catch (err) {
      // First batch failed → don't burn remaining batches against a dead server.
      // Append all remaining to disk and bail.
      await this.appendToDisk(events.slice(i))
      return
    }
  }
}
```

**第一个 batch fail 直接放弃后面所有 batch**. 因为整 export 失败 90% 是网络全挂或 server 全死, 后面 batch 一定也挂 — 不挂网就挂 retry quota. 直接转写盘下次再试, 比逐 batch 试节省一轮 timeout.

[firstPartyEventLoggingExporter.ts:344-388](src/services/analytics/firstPartyEventLoggingExporter.ts#L344-L388) **quadratic backoff**:

```ts
private async sendWithRetry(batch: LogRecord[]): Promise<void> {
  let attempts = 0
  while (attempts < this.maxAttempts) {
    attempts++
    try {
      await this.sendOnce(batch)
      return
    } catch (err) {
      const delay = Math.min(
        this.baseBackoffDelayMs * attempts ** 2,  // 二次
        this.maxBackoffDelayMs                     // cap 30s
      )
      await sleep(delay)
    }
  }
}
```

二次而非指数 (2^n). 指数 5 次后已经 16x baseDelay → 8s; 二次 5 次 = 25x → 12.5s. 二次"涨得快但顶得低", 比指数温和, 适合 server 临时 5xx 而不是网络长断.

[firstPartyEventLoggingExporter.ts:418-498](src/services/analytics/firstPartyEventLoggingExporter.ts#L418-L498) **auth fallback**:

```ts
private async sendOnce(batch: LogRecord[]): Promise<void> {
  const headers = this.skipAuth ? {} : await this.getAuthHeaders()
  let response = await fetch(url, { headers, body, method: 'POST' })
  
  if (response.status === 401 && !this.skipAuth) {
    // Auth might be expired or backend is misconfigured.
    // Try once without auth — backend might accept anonymous for some events.
    response = await fetch(url, { body, method: 'POST' })
    if (response.ok) {
      logForDiagnosticsNoPII('warn', '1p_event_logging_succeeded_without_auth')
      return
    }
  }
  // ...
}
```

401 后**降级不带 auth 再试一次**. 1P backend 配置成支持匿名 (sampled, 信任 sessionId) — 比"401 → 完全丢" 好. degraded but functional.

[firstPartyEventLoggingExporter.ts:550-624](src/services/analytics/firstPartyEventLoggingExporter.ts#L550-L624) `transformLogsToEvents` **`_PROTO_*` 字段提升**:

```ts
function transformLogsToEvents(records: LogRecord[]): Event[] {
  return records.map(rec => {
    const { _PROTO_skill_name, _PROTO_plugin_name, _PROTO_marketplace_name, ...rest } = rec.attributes
    
    return {
      ...stripProtoFields(rest),  // defensive: 再次剥掉漏网的
      skill_name: _PROTO_skill_name,       // 提升到 proto 字段
      plugin_name: _PROTO_plugin_name,
      marketplace_name: _PROTO_marketplace_name,
      timestamp: rec.hrTimeNs,
      severity: rec.severityText,
    }
  })
}
```

**这是 PII routing 的核心模式**:
- 业务代码写事件时, 把 `_PROTO_skill_name: "code-reviewer"` 当普通 metadata.
- Sink fanout 时, [sink.ts:99-115](src/services/analytics/sink.ts#L99-L115) **Datadog 路径调 `stripProtoFields(event)`** — `_PROTO_*` 全删, Datadog 看不到 skill 名 (因为它是 user content, 可能含 PII).
- 1P 路径调 `transformLogsToEvents` — `_PROTO_*` **提升**到 proto 顶层字段, 1P backend 按字段读取.

同一份事件, 两条线一份 strip, 一份 hoist. 双 sink 共享 event object 而不需要事先拆.

---

## 八、growthbook: SDK workaround 集合

[growthbook.ts:67-89](src/services/analytics/growthbook.ts#L67-L89) `getGrowthBookClient`:

```ts
export const getGrowthBookClient = memoize(() => {
  const gb = new GrowthBook({
    apiHost: getGrowthBookApiHost(),
    clientKey: getGrowthBookClientKey(),
    enableDevMode: false,
    subscribeToChanges: false,  // 关掉 SSE
    attributes: getInitialAttributes(),
    apiHostRequestHeaders: getAuthHeaders(),  // 一次性 baked-in
    trackingCallback: trackGrowthBookExposure,
  })
  return gb
})
```

memoize 保证一个进程一个 client. 但下面有个 hairy detail.

[growthbook.ts:154-202](src/services/analytics/growthbook.ts#L154-L202) **remote-eval workaround**:

```ts
const remoteEvalFeatureValues = new Map<string, unknown>()

export function processRemoteEvalPayload(payload: RemoteEvalPayload | null): void {
  if (!payload || Object.keys(payload).length === 0) {
    // 防御: GB SDK 偶尔返 {} 而非完整 payload, 直接 set 会把所有 flag 失效 → blackout
    logForDiagnosticsNoPII('warn', 'gb_empty_remote_eval_payload')
    return
  }
  
  for (const [feature, evaluation] of Object.entries(payload)) {
    remoteEvalFeatureValues.set(feature, evaluation.value)
  }
}
```

`getFeatureValue` SDK API 和 SDK setForcedFeatures 的命名不一致 — SDK 内部用 `value`, 但 public API 用 `defaultValue`. 直接调 SDK 拿不到 remote-eval 的真实值. 解法: **自维护一个 `remoteEvalFeatureValues` Map**, 用 `setForcedFeatures` 强制 override.

empty-payload guard: 网络抖动 / server bug 返 `{}`, 没这个 guard 会把所有 feature 标记为无值 → 整个 CC 进入未配置状态 → 各种 fallback 行为 → bug 暴雨. 这是**踩过的坑**.

[growthbook.ts:354-401](src/services/analytics/growthbook.ts#L354-L401) **三种 read API**:

```ts
// 同步, 从内存或 disk cache 读
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(feature: string, defaultValue: T): T

// 异步, 必要时阻塞拉远程
export async function getFeatureValue_BLOCKS_ON_INIT<T>(feature: string, defaultValue: T): Promise<T>

// 同 boolean gate
export function checkGate_CACHED_OR_BLOCKING(gate: string): boolean | null
```

**API 命名带 `_CACHED_MAY_BE_STALE` 是显式告知调用方**: 这是个 "尽力而为" 读, 可能拿不到最新值. `_BLOCKS_ON_INIT` 是 "我会等到 ready". 三个 API 让 caller 自己选 trade-off — 启动 critical path 用 CACHED (不阻塞), security check 用 BLOCKING.

[growthbook.ts:530-578](src/services/analytics/growthbook.ts#L530-L578) `checkSecurityRestrictionGate`:

```ts
export async function checkSecurityRestrictionGate(gate: string): Promise<boolean> {
  // Security gates MUST wait for any in-flight re-init
  if (reinitializingPromise) {
    await reinitializingPromise
  }
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE(gate) ?? false
}
```

**重要**: auth 换之后正在 reinit GrowthBook client, security gate 必须等. 如果不等, 拿到旧 client 的 cache, 可能允许了不该允许的操作.

[growthbook.ts:670-712](src/services/analytics/growthbook.ts#L670-L712) `refreshGrowthBookAfterAuthChange`:

```ts
export async function refreshGrowthBookAfterAuthChange(): Promise<void> {
  // apiHostRequestHeaders is baked at construction time — can't mutate
  reinitializingPromise = (async () => {
    const old = getGrowthBookClient.cache.get(undefined)
    await old?.destroy()
    getGrowthBookClient.cache.clear()  // memoize cache
    // Next call creates new client with fresh auth
    await getGrowthBookClient().loadFeatures()
  })()
  await reinitializingPromise
  reinitializingPromise = null
}
```

GrowthBook SDK 不支持运行时换 header. 只能 destroy + 新建. 中间窗口必须 reinitializingPromise gate. 重启进程不算解 — auth refresh 在 1 个进程生命周期内常发生.

[growthbook.ts:818-866](src/services/analytics/growthbook.ts#L818-L866) `setupPeriodicGrowthBookRefresh`:

```ts
const REFRESH_INTERVAL_MS = process.env.USER_TYPE === 'ant' ? 20 * 60 * 1000 : 6 * 60 * 60 * 1000
// Ant: 20min, External: 6hr

setInterval(async () => {
  await refreshGrowthBook()
}, REFRESH_INTERVAL_MS)
```

长跑 session (服务器 24/7 的 Conductor 实例) 不能用启动时的 cache 一整天 — feature flag 改了得反映出来. Ant 内部 20 分钟一次方便 dogfooding, 外部 6 小时一次省服务器.

[growthbook.ts:933-988](src/services/analytics/growthbook.ts#L933-L988) `CLAUDE_INTERNAL_FC_OVERRIDES`:

```ts
function applyEnvOverrides(): void {
  if (process.env.USER_TYPE !== 'ant') return
  const raw = process.env.CLAUDE_INTERNAL_FC_OVERRIDES
  if (!raw) return
  const overrides = jsonParse(raw)
  // overrides: {"feature_name": value, ...}
  for (const [feature, value] of Object.entries(overrides)) {
    remoteEvalFeatureValues.set(feature, value)
  }
}
```

只对 Anthropic 内部用户开放 (USER_TYPE='ant'). 给 eval harness / 内部测试用 — 通过环境变量强制 override flag, 不走 GrowthBook server.

---

## 九、metadata: env/proc 元数据 + tool input 截断

[metadata.ts:67-148](src/services/analytics/metadata.ts#L67-L148) **EventMetadata**:

```ts
export type EventMetadata = {
  envContext: EnvironmentContext  // 静态: OS/runtime/packageManager
  processMetrics: ProcessMetrics  // 动态: CPU/RSS/uptime
  agentId?: string
  parentSessionId?: string
  agentType?: 'foreground' | 'subagent'
  teamName?: string
  subscriptionType?: string
  rh?: ResourceHints
  model: string
  betas: string[]
}
```

每个事件都附上这些. 串联 session / agent / process 维度.

[metadata.ts:175-238](src/services/analytics/metadata.ts#L175-L238) `buildEnvContext` (memoized):

```ts
const buildEnvContext = memoize(async (): Promise<EnvironmentContext> => {
  return {
    os: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    runtime: detectRuntime(),       // bun/node/deno
    package_managers: await detectPackageManagers(),  // npm/yarn/pnpm/bun
    runtimes: await detectRuntimes(),                 // python/go/...
    wsl_version: await getWslVersion(),
    linux_distro_info: await getLinuxDistroInfo(),
    vcs: await detectVcs(),
    isClaubbit: process.env.CLAUDE_CLAUBBIT === '1',
    isConductor: process.env.CLAUDE_CONDUCTOR === '1',
    isLocalAgentMode: process.env.CLAUDE_LOCAL_AGENT === '1',
    isClaudeCodeRemote: process.env.CLAUDE_CODE_REMOTE === '1',
    isCi: detectCi(),
    isGithubAction: process.env.GITHUB_ACTIONS === 'true',
    // ...
  }
})
```

memoize 因为这些一进程不会变. 启动时算一次, 之后零开销读. detect 函数大多是 `which python` 这种 ⇒ 启动可能慢 100ms.

[metadata.ts:301-348](src/services/analytics/metadata.ts#L301-L348) `buildProcessMetrics`:

```ts
let prevCpuUsage = process.cpuUsage()
let prevWallTimeMs = Date.now()

export function buildProcessMetrics(): ProcessMetrics {
  const cpuUsage = process.cpuUsage()
  const wallTimeMs = Date.now()
  const deltaCpuUs = (cpuUsage.user + cpuUsage.system) - (prevCpuUsage.user + prevCpuUsage.system)
  const deltaWallMs = wallTimeMs - prevWallTimeMs
  const cpuPercent = deltaWallMs > 0 ? deltaCpuUs / (deltaWallMs * 1000) * 100 : 0
  
  prevCpuUsage = cpuUsage
  prevWallTimeMs = wallTimeMs
  
  return {
    rssBytes: process.memoryUsage().rss,
    heapBytes: process.memoryUsage().heapUsed,
    cpuPercent,
    uptimeSec: process.uptime(),
  }
}
```

`process.cpuUsage()` 返累计 CPU 时间. 算 percent 必须**差分**: (这次 CPU - 上次 CPU) / (这次 wall - 上次 wall). 否则得到的是"从启动到现在的平均 CPU%" — 长跑 session 完全无用.

[metadata.ts:455-523](src/services/analytics/metadata.ts#L455-L523) `sanitizeToolNameForAnalytics`:

```ts
export function sanitizeToolNameForAnalytics(
  toolName: string,
  mcpServerType?: string,
  mcpServerBaseUrl?: string,
): string {
  if (!toolName.startsWith('mcp__')) return toolName
  
  if (isAnalyticsToolDetailsLoggingEnabled(mcpServerType, mcpServerBaseUrl)) {
    return toolName  // local-agent / claudeai-proxy / official registry / builtin
  }
  return 'mcp_tool'  // user-installed MCP — 不暴露 server/tool 名
}
```

[metadata.ts:539-570](src/services/analytics/metadata.ts#L539-L570) `isAnalyticsToolDetailsLoggingEnabled`:

```ts
function isAnalyticsToolDetailsLoggingEnabled(
  mcpServerType?: string,
  mcpServerBaseUrl?: string,
): boolean {
  if (mcpServerType === 'local-agent') return true
  if (mcpServerType === 'claudeai-proxy') return true
  if (mcpServerBaseUrl?.startsWith(OFFICIAL_MCP_REGISTRY_BASE_URL)) return true
  if (toolName && BUILTIN_MCP_SERVER_NAMES.has(extractServerName(toolName))) return true
  return false
}
```

**白名单允许暴露的 MCP**:
- `local-agent` — CC 自己起的 sub-process, 信任.
- `claudeai-proxy` — Claude.ai 自家 MCP server, 信任.
- 官方 registry URL — 经过 Anthropic 审核.
- BUILTIN_MCP_SERVER_NAMES (feature-gated) — 内置一批知名 server.

其他用户自己装的 MCP, tool name 可能含敏感信息 (e.g., `mcp__internal-vault__decrypt`), 不暴露.

[metadata.ts:638-712](src/services/analytics/metadata.ts#L638-L712) `extractMcpToolDetails`:

```ts
export function extractMcpToolDetails(toolName: string): { serverName: string; toolName: string } | null {
  const match = toolName.match(/^mcp__([^_]+)__(.+)$/)
  if (!match) return null
  return { serverName: match[1], toolName: match[2] }
}
```

格式约定: `mcp__<server>__<tool>`. 严格 `__` 双下划线分隔. 单下划线允许在 server/tool name 里 (e.g., `mcp__my_server__do_thing`).

[metadata.ts:752-825](src/services/analytics/metadata.ts#L752-L825) `truncateToolInputValue`:

```ts
const TOOL_INPUT_STRING_TRUNCATE_AT = 512
const MAX_DEPTH = 2
const MAX_COLLECTION_ITEMS = 20

function truncateToolInputValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max depth]'
  if (typeof value === 'string') {
    return value.length > TOOL_INPUT_STRING_TRUNCATE_AT
      ? value.slice(0, TOOL_INPUT_STRING_TRUNCATE_AT) + '... [truncated]'
      : value
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_COLLECTION_ITEMS).map(v => truncateToolInputValue(v, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue  // 跳过 _internal keys
      out[k] = truncateToolInputValue(v, depth + 1)
    }
    return out
  }
  return value
}
```

为啥这些限制?
- 512 字符 — `Edit` tool 的 `new_string` 可能整段代码, 完整发会让 1 个事件 100KB+. 截断保留前 512 够 debug.
- depth 2 — 防 deeply nested obj 撑爆 payload.
- 20 items — 一个 array 截掉只看前 20.
- `_` keys 跳过 — 内部 marker (e.g., `_PROTO_*`) 不进 tool input log.

[metadata.ts:874-940](src/services/analytics/metadata.ts#L874-L940) `getFileExtensionsFromBashCommand`:

```ts
const FILE_COMMANDS = new Set(['rm', 'mv', 'cp', 'touch', 'mkdir', 'chmod', 'chown',
  'cat', 'head', 'tail', 'sort', 'stat', 'diff', 'wc', 'grep', 'rg', 'sed'])

export function getFileExtensionsFromBashCommand(command: string): string[] {
  const tokens = command.split(/&&|\|\||;|\|/).flatMap(t => t.trim().split(/\s+/))
  const exts = new Set<string>()
  let inFileCmd = false
  for (const token of tokens) {
    if (FILE_COMMANDS.has(token)) {
      inFileCmd = true
      continue
    }
    if (!inFileCmd) continue
    const ext = path.extname(token).toLowerCase()
    if (ext && /^\.[a-z0-9]+$/.test(ext)) {
      exts.add(ext)
    }
  }
  return [...exts]
}
```

只在 FILE_COMMANDS allowlist 之后的 token 才看 ext. 否则 `grep "\.json" file.txt` 会把 `.json` 当成 file ext. allowlist 让 telemetry 数据更准.

[metadata.ts:957-973](src/services/analytics/metadata.ts#L957-L973) `to1PEventFormat`:

```ts
import type { EnvironmentMetadata } from '../../generated/proto/environment_metadata.pb.js'

export function to1PEventFormat(metadata: EventMetadata): Record<string, unknown> {
  // EnvironmentMetadata 是 proto-generated type, 编译时严格匹配字段
  const envMeta: EnvironmentMetadata = {
    arch: metadata.envContext.arch,
    runtime: metadata.envContext.runtime,
    // ...
  }
  return {
    environment_metadata: envMeta,
    // ...
  }
}
```

**proto-generated type 的关键价值**: 之前用手写 type 时发生过 **4 次**事故 — 加了字段但忘了往 1P 发, 字段 silent 漏发, 一个月后才发现. proto-generated 强制每个字段都有 type, 漏发字段编译失败.

---

## 十、transportUtils: 3 路由分发

[transportUtils.ts:16-45](src/cli/transports/transportUtils.ts#L16-L45) **优先级**:

1. `CLAUDE_CODE_USE_CCR_V2` → `SSETransport` (SSE 读 + POST 写)
2. ws:// + `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` → `HybridTransport` (WS 读 + POST 写)
3. ws:// 默认 → `WebSocketTransport` (WS 全双工)

`CLAUDE_CODE_USE_CCR_V2` 是 CCR v2 模式 (新). HybridTransport 是 v1 到 v2 的过渡. WebSocketTransport 是原始模式.

精髓: **传输层用 env var feature flag 完整切换**. 三套实现并存, 同一接口 `Transport`, 上层零感知.

---

## 十一、WebSocketTransport: 重连 + sleep 检测 + replay

[WebSocketTransport.ts:42-47](src/cli/transports/WebSocketTransport.ts#L42-L47) `PERMANENT_CLOSE_CODES`:

```ts
const PERMANENT_CLOSE_CODES = new Set([
  1002, // protocol error
  4001, // session expired
  4003, // unauthorized
])
```

碰到这些**直接 closed, 不重连** — 重连必失败. 但 4003 有特例: 如果 `refreshHeaders` 返回新 token, 重连可能成功.

[WebSocketTransport.ts:159-193](src/cli/transports/WebSocketTransport.ts#L159-L193) **Bun vs Node WebSocket 双实现**:

```ts
if (typeof Bun !== 'undefined') {
  const ws = new globalThis.WebSocket(url, { headers, proxy, tls })
  ws.addEventListener('open', this.onBunOpen)
  // ...
} else {
  const { default: WS } = await import('ws')
  const ws = new WS(url, { headers, agent, ...tls })
  ws.on('open', this.onNodeOpen)
  // ...
}
```

两 runtime 的 WS API 不同:
- Bun 用 DOM-like `addEventListener('open', cb)`.
- Node ws 用 EventEmitter `on('open', cb)`.

为啥不统一? Bun 原生 WS 支持 headers/proxy 选项, Node WS 需第三方包. 各自用各自最佳 path. 上层 sendLine 用统一 `ws.send(data)` 接口隐藏差异.

[WebSocketTransport.ts:195-200](src/cli/transports/WebSocketTransport.ts#L195-L200) **handler 用 class property arrow function**:

注释解释为啥: "Without removal, each reconnect orphans the old WS object + its 5 closures until GC". inline closure 会绑定到具体的 WebSocket 实例, removeEventListener 不掉 → 老 WS 持有不释放 → GC 不掉 → 内存累积. arrow function 作为 class property → 每个实例 1 个稳定 reference → removeWsListeners 能精确卸载.

[WebSocketTransport.ts:472-489](src/cli/transports/WebSocketTransport.ts#L472-L489) **sleep 检测**:

```ts
if (
  this.lastReconnectAttemptTime !== null &&
  now - this.lastReconnectAttemptTime > SLEEP_DETECTION_THRESHOLD_MS  // 60s
) {
  // 距离上次 reconnect 尝试 > 60s, 机器睡过了
  this.reconnectStartTime = now      // 重置预算
  this.reconnectAttempts = 0
}
```

笔记本合盖 / VM pause / SIGSTOP → setInterval 不 fire → 上次 reconnect 时间和 now 差很大. 这种"看起来 silent 60s+" 99% 是 sleep, 应该 reset budget 重新算; 不 reset 的话 elapsed 已经超 RECONNECT_GIVE_UP_MS (10min), 一醒来就给 up.

[WebSocketTransport.ts:712-735](src/cli/transports/WebSocketTransport.ts#L712-L735) **ping interval 内的 sleep 检测**:

```ts
this.pingInterval = setInterval(() => {
  const now = Date.now()
  const gap = now - lastTickTime
  lastTickTime = now
  if (gap > SLEEP_DETECTION_THRESHOLD_MS) {
    // 60s 没 tick — sleep 醒后单次 fire 大 gap
    // ws.ping() 在死 socket 上不报错 (bytes 进 kernel buffer), 直接重连
    this.handleConnectionError()
    return
  }
  // ...
})
```

Sleep 醒来 setInterval 不补 missed ticks, 只 fire 一次. 这个 callback 拿到的 gap = sleep 时长. 直接重连不等 ping/pong round-trip — 死 socket 的 ping 不会立即报错 (kernel buffer 接住).

[WebSocketTransport.ts:574-633](src/cli/transports/WebSocketTransport.ts#L574-L633) **replayBufferedMessages**:

```ts
private replayBufferedMessages(lastId: string): void {
  const messages = this.messageBuffer.toArray()
  let startIndex = 0
  if (lastId) {
    const lastConfirmedIndex = messages.findIndex(m => 'uuid' in m && m.uuid === lastId)
    if (lastConfirmedIndex >= 0) {
      startIndex = lastConfirmedIndex + 1
      const remaining = messages.slice(startIndex)
      this.messageBuffer.clear()
      this.messageBuffer.addAll(remaining)
      // ...
    }
  }
  const messagesToReplay = messages.slice(startIndex)
  for (const message of messagesToReplay) {
    this.sendLine(jsonStringify(message) + '\n')
  }
  // 故意不清 buffer — 确认前都留着
}
```

**最关键点**: replay 后**不清 buffer**. 等服务端下次 reconnect 时再次告知 `X-Last-Request-Id`, 才删. 防御场景: replay 后立刻连接掉, 服务端没处理, 这些 message 还在 buffer 里, 下次 reconnect 再发.

[WebSocketTransport.ts:767-792](src/cli/transports/WebSocketTransport.ts#L767-L792) `startKeepaliveInterval`:

```ts
if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
  return  // CCR 模式下不需要 — sessionActivity 已经管 keepalive
}

this.keepAliveInterval = setInterval(() => {
  this.ws.send(KEEP_ALIVE_FRAME)  // 5min 一次
}, DEFAULT_KEEPALIVE_INTERVAL)
```

WS 维持需要"数据帧" — ping/pong 控制帧不计 (Cloudflare 5min idle 不看 ping). 必须发 data 帧.

精髓总结:
- **PERMANENT_CLOSE_CODES** — 显式列举不可恢复的 close code.
- **sleep detection** — 两处 (handleConnectionError gap + ping interval gap).
- **Bun/Node 双 WS 实现** — 各 runtime 最优 API.
- **arrow function as property** — 才能 removeEventListener.
- **replay buffer 不清直到下次 confirm** — 防双重失联.
- **data frame keepalive** — 控制帧不解 Cloudflare idle.

---

## 十二、SSETransport: SSE + POST + 序列号 resume

[SSETransport.ts:55-116](src/cli/transports/SSETransport.ts#L55-L116) **parseSSEFrames**:

按 SSE 规范增量 parse:
- `\n\n` 分隔 frame.
- `:` 开头是 comment (keepalive).
- 每行 `field: value`, field ∈ {`event`, `id`, `data`}.
- 多 `data:` 拼 `\n`.
- 行间 colon 后单空格 strip.

逻辑虽小但**完全照 SSE spec**, 不能简化. 不照 spec 的 SSE parser 在 nginx/cloudflare 中转下会 corrupt.

[SSETransport.ts:212-216](src/cli/transports/SSETransport.ts#L212-L216) `initialSequenceNum`:

```ts
if (initialSequenceNum !== undefined && initialSequenceNum > 0) {
  this.lastSequenceNum = initialSequenceNum
}
```

构造时 caller 传 high-water mark. 不传, 首次 connect 会让 server replay 整 session 历史 (从 seq 0). 高频换 transport 场景 (replBridge), 这个 high-water mark 通过 `getLastSequenceNum()` 在旧 transport close 前读出, 传给新 transport.

[SSETransport.ts:245-266](src/cli/transports/SSETransport.ts#L245-L266) **resume**:

```ts
const sseUrl = new URL(this.url.href)
if (this.lastSequenceNum > 0) {
  sseUrl.searchParams.set('from_sequence_num', String(this.lastSequenceNum))
}
// ...
const headers = { Accept: 'text/event-stream', 'anthropic-version': '2023-06-01' }
if (this.lastSequenceNum > 0) {
  headers['Last-Event-ID'] = String(this.lastSequenceNum)
}
```

两路传 high-water mark: URL query (server primary) + Last-Event-ID header (SSE spec primary). 服务端兼容两种.

[SSETransport.ts:351-396](src/cli/transports/SSETransport.ts#L351-L396) **去重 + 高水位推进**:

```ts
if (this.seenSequenceNums.has(seqNum)) {
  // 重复 frame (resume 边界, server bug, etc.)
  logForDiagnosticsNoPII('warn', 'cli_sse_duplicate_sequence')
} else {
  this.seenSequenceNums.add(seqNum)
  if (this.seenSequenceNums.size > 1000) {
    // 限内存 — 远低于 lastSequenceNum 的删
    const threshold = this.lastSequenceNum - 200
    for (const s of this.seenSequenceNums) {
      if (s < threshold) this.seenSequenceNums.delete(s)
    }
  }
}
if (seqNum > this.lastSequenceNum) {
  this.lastSequenceNum = seqNum
}
```

seenSet 1000 上限, 触发就 prune. 只 keep 最近 200 — dedup window 200 个 frame 足够 (Cloudflare retry 不超过 100 frame 错位).

[SSETransport.ts:542-558](src/cli/transports/SSETransport.ts#L542-L558) **liveness timeout**:

```ts
private readonly onLivenessTimeout = (): void => {
  this.livenessTimer = null
  logForDiagnosticsNoPII('error', 'cli_sse_liveness_timeout')
  this.abortController?.abort()
  this.handleConnectionError()
}

private resetLivenessTimer(): void {
  this.clearLivenessTimer()
  this.livenessTimer = setTimeout(this.onLivenessTimeout, LIVENESS_TIMEOUT_MS)  // 45s
}
```

Server 15s 发 keepalive comment, 45s 不见任何 frame (含 keepalive) 算死. `onLivenessTimeout` 是 **arrow function class property** — 同 WebSocketTransport 的理由, 避免 setTimeout 闭包内存累积 (每 frame 都 reset).

[SSETransport.ts:469-535](src/cli/transports/SSETransport.ts#L469-L535) **reconnect**:

- 起算时间 `reconnectStartTime` (第一次失败时设).
- 时间预算 `RECONNECT_GIVE_UP_MS = 600_000` (10min).
- exponential backoff 1s → 2s → 4s → ... cap 30s.
- ±25% jitter.

刷新 headers (从 `refreshHeaders` callback 拿) — 因为 SSE 用 fetch, 必须 baked 新 header 重 connect. 不像 WS 可以保持 connection.

---

## 十三、HybridTransport: WS 读 + POST 写 + 100ms stream buffer

[HybridTransport.ts:54-108](src/cli/transports/HybridTransport.ts#L54-L108) extends WebSocketTransport. 读路径继承; 写路径 override:

```ts
this.uploader = new SerialBatchEventUploader<StdoutMessage>({
  maxBatchSize: 500,
  maxQueueSize: 100_000,  // 内存 only — bridge fire-and-forget, 不 await
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitterMs: 1000,
  maxConsecutiveFailures,
  send: batch => this.postOnce(batch),
})
```

注释提示: bridge 用 `void transport.write()` (fire-and-forget), 不会触发 backpressure, queueSize 必须设得足够大 (100k) 当内存上限.

[HybridTransport.ts:118-138](src/cli/transports/HybridTransport.ts#L118-L138) **100ms stream_event 缓冲**:

```ts
override async write(message: StdoutMessage): Promise<void> {
  if (message.type === 'stream_event') {
    this.streamEventBuffer.push(message)
    if (!this.streamEventTimer) {
      this.streamEventTimer = setTimeout(
        () => this.flushStreamEvents(),
        BATCH_FLUSH_INTERVAL_MS,  // 100ms
      )
    }
    return  // 不 await — caller 不关心
  }
  // 非 stream_event: 先 flush 缓冲 (保序), 再 enqueue 自己
  await this.uploader.enqueue([...this.takeStreamEvents(), message])
  return this.uploader.flush()
}
```

LLM 流 text_delta 每秒 50+ 个事件. 直接每次 1 个 POST → 50 POST/s, 服务端飘. 100ms buffer 攒一波再发, POST 从 50/s 降到 10/s.

但 stream_event 一定要保序 — 非 stream_event 来时必须先 flush buffer 否则下游收到的次序错.

[HybridTransport.ts:175-194](src/cli/transports/HybridTransport.ts#L175-L194) **close 的 grace period**:

```ts
override close(): void {
  // ...
  const uploader = this.uploader
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  void Promise.race([
    uploader.flush(),
    new Promise<void>(r => {
      graceTimer = setTimeout(r, CLOSE_GRACE_MS)  // 3s
    }),
  ]).finally(() => {
    clearTimeout(graceTimer)
    uploader.close()
  })
  super.close()
}
```

close 是 sync (return immediately), 但 uploader 还在尝试 flush. race 一个 3s 超时, 哪个先 win 都关. **best-effort 不阻塞调用方退出**.

[HybridTransport.ts:201-261](src/cli/transports/HybridTransport.ts#L201-L261) **postOnce 错误分类**:

```ts
if (response.status >= 200 && response.status < 300) return  // ok
if (response.status >= 400 && response.status < 500 && response.status !== 429) {
  return  // 4xx 永久, 丢弃, 不抛 — uploader 推进
}
// 429 / 5xx — throw, uploader 重试
throw new Error(`POST failed with ${response.status}`)
```

抛与不抛是显式约定 — SerialBatchEventUploader 看到 throw 就 retry, 没 throw 就推进. 4xx 永久故障特地"成功返回" (虽然没真发).

---

## 十四、SerialBatchEventUploader: 通用串行批量 primitive

[SerialBatchEventUploader.ts:26-33](src/cli/transports/SerialBatchEventUploader.ts#L26-L33) `RetryableError`:

```ts
export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message)
  }
}
```

服务端 429 + Retry-After 头, caller 包成 `RetryableError(..., retryAfterMs)` 抛. uploader 看到就用 server 的 hint 当 delay, 不用自己算 backoff.

[SerialBatchEventUploader.ts:101-119](src/cli/transports/SerialBatchEventUploader.ts#L101-L119) **backpressure**:

```ts
async enqueue(events: T | T[]): Promise<void> {
  // ...
  while (
    this.pending.length + items.length > this.config.maxQueueSize &&
    !this.closed
  ) {
    await new Promise<void>(resolve => {
      this.backpressureResolvers.push(resolve)
    })
  }
  // ...
}
```

caller `await uploader.enqueue(...)` 时, queue 满会 block. 这是显式 backpressure — 上层异步循环放慢, 不丢消息. 但**caller 必须 await** 才生效.

[SerialBatchEventUploader.ts:212-233](src/cli/transports/SerialBatchEventUploader.ts#L212-L233) **takeBatch byte limit + un-serializable handling**:

```ts
private takeBatch(): T[] {
  // ...
  while (count < this.pending.length && count < maxBatchSize) {
    let itemBytes: number
    try {
      itemBytes = Buffer.byteLength(jsonStringify(this.pending[count]))
    } catch {
      // BigInt / circular ref / throwing toJSON → 永远没法 send
      // 留着会 poison queue 卡 flush, 必须当场丢
      this.pending.splice(count, 1)
      continue
    }
    if (count > 0 && bytes + itemBytes > maxBatchBytes) break
    bytes += itemBytes
    count++
  }
  return this.pending.splice(0, count)
}
```

**两个关键点**:
1. 单 item 超 maxBatchBytes 也得发 (count > 0 才检查 byte limit) — 否则 stuck.
2. **un-serializable 当场丢**. 内置 toJSON 抛错 / BigInt / 循环引用 — 永远发不出去, 不丢就 flush hang 死. 用 try-catch + splice.

[SerialBatchEventUploader.ts:156-202](src/cli/transports/SerialBatchEventUploader.ts#L156-L202) **drain loop**:

```ts
while (this.pending.length > 0 && !this.closed) {
  const batch = this.takeBatch()
  try {
    await this.config.send(batch)
    failures = 0
  } catch (err) {
    failures++
    if (failures >= maxConsecutiveFailures) {
      this.droppedBatches++
      this.config.onBatchDropped?.(batch.length, failures)
      failures = 0
      continue  // 丢, 继续下一 batch
    }
    // Re-queue at front. concat (单次分配) 而非 unshift(...batch) (O(n) shift).
    this.pending = batch.concat(this.pending)
    const retryAfterMs = err instanceof RetryableError ? err.retryAfterMs : undefined
    await this.sleep(this.retryDelay(failures, retryAfterMs))
  }
}
```

注释强调用 `batch.concat(this.pending)` 而非 `unshift(...batch)`. 前者一次分配新数组, 后者每个 item 都 shift 全 pending — O(n²) 退化. 失败路径才走, 但失败可能连续触发.

[SerialBatchEventUploader.ts:235-253](src/cli/transports/SerialBatchEventUploader.ts#L235-L253) **retryDelay 含 server hint**:

```ts
private retryDelay(failures: number, retryAfterMs?: number): number {
  const jitter = Math.random() * this.config.jitterMs
  if (retryAfterMs !== undefined) {
    const clamped = Math.max(
      this.config.baseDelayMs,
      Math.min(retryAfterMs, this.config.maxDelayMs),
    )
    return clamped + jitter  // server hint + jitter
  }
  const exponential = Math.min(
    this.config.baseDelayMs * 2 ** (failures - 1),
    this.config.maxDelayMs,
  )
  return exponential + jitter  // exp + jitter
}
```

Server 的 Retry-After 也叠 jitter — 防 thundering herd. 多 session 都收到同 retryAfter, 都准时 retry → 同步 burst. jitter 散开.

---

## 十五、WorkerStateUploader: 1-in-flight + RFC 7396 合并

[WorkerStateUploader.ts:29-46](src/cli/transports/WorkerStateUploader.ts#L29-L46) `enqueue`:

```ts
enqueue(patch: Record<string, unknown>): void {
  if (this.closed) return
  this.pending = this.pending ? coalescePatches(this.pending, patch) : patch
  void this.drain()
}
```

只有**1 个 in-flight + 1 个 pending**. 第 3 个 enqueue 来时**合并**到 pending 而非 queue. 因为 PUT /worker 是 state replace — 中间状态没意义, 只发最新.

[WorkerStateUploader.ts:106-131](src/cli/transports/WorkerStateUploader.ts#L106-L131) `coalescePatches`:

```ts
function coalescePatches(base, overlay): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (
      (key === 'external_metadata' || key === 'internal_metadata') &&
      merged[key] && typeof merged[key] === 'object' &&
      typeof value === 'object' && value !== null
    ) {
      // RFC 7396 merge — overlay 覆盖, null 保留 (服务端删字段)
      merged[key] = { ...merged[key], ...value }
    } else {
      merged[key] = value  // top-level: last value wins
    }
  }
  return merged
}
```

**top-level keys** (e.g., `worker_status`): 覆盖.
**metadata keys** (`external_metadata`): RFC 7396 merge — 浅 merge, null 当 sentinel 留着 (服务端见 null 当删).

[WorkerStateUploader.ts:70-86](src/cli/transports/WorkerStateUploader.ts#L70-L86) **重试 + 吸收新 patch**:

```ts
private async sendWithRetry(payload): Promise<void> {
  let current = payload
  let failures = 0
  while (!this.closed) {
    const ok = await this.config.send(current)
    if (ok) return
    failures++
    await sleep(this.retryDelay(failures))
    // 重试期间新 patch 进 pending → 合并到 current 一起发
    if (this.pending && !this.closed) {
      current = coalescePatches(current, this.pending)
      this.pending = null
    }
  }
}
```

重试期间又来新 patch, **合到 current 一起发**. 服务端只看最终态, 不需要序列化中间态. 节省 N 次 PUT.

---

## 十六、CCRClient: 4 uploader + 文字 delta coalesce

[ccrClient.ts:262-308](src/cli/transports/ccrClient.ts#L262-L308) **4 个 uploader**:

```ts
private readonly workerState: WorkerStateUploader              // PUT /worker
private readonly eventUploader: SerialBatchEventUploader<...>  // POST client events
private readonly internalEventUploader: SerialBatchEventUploader<...>  // POST internal
private readonly deliveryUploader: SerialBatchEventUploader<...>       // POST delivery acks
```

各自独立 backoff 和队列. 因为它们的特性不同:
- workerState — replace, 合并, 1-in-flight.
- eventUploader — append, 大批量 (maxQueueSize=100k), 高频.
- internalEventUploader — 小队列 (200), 严控 — 不是 user-facing 但 transcript 关键.
- deliveryUploader — ack 用, 小 (64), 服务端只关心是否曾发.

各自配置 maxBatchSize/maxQueueSize/baseDelayMs 不同, 适配各自 traffic shape.

[ccrClient.ts:104-118](src/cli/transports/ccrClient.ts#L104-L118) **StreamAccumulatorState**:

```ts
export type StreamAccumulatorState = {
  byMessage: Map<string, string[][]>  // messageId → blocks[idx] → chunks
  scopeToMessage: Map<string, string>  // {session_id}:{parent_tool_use_id} → active messageId
}
```

[ccrClient.ts:141-203](src/cli/transports/ccrClient.ts#L141-L203) `accumulateStreamEvents` 是**这模块最复杂的设计**:

```ts
const touched = new Map<string[], CoalescedStreamEvent>()
for (const msg of buffer) {
  switch (msg.event.type) {
    case 'message_start':
      // 记录 messageId 给后续 delta
      state.scopeToMessage.set(scope, id)
      state.byMessage.set(id, [])
      out.push(msg)
      break
    case 'content_block_delta':
      if (msg.event.delta.type !== 'text_delta') {
        out.push(msg); break  // 非 text_delta 透传
      }
      const blocks = state.byMessage.get(messageId)
      const chunks = (blocks[msg.event.index] ??= [])
      chunks.push(msg.event.delta.text)
      const existing = touched.get(chunks)
      if (existing) {
        existing.event.delta.text = chunks.join('')  // 覆盖 — 同 block 只发一个 snapshot
        break
      }
      // 第一次 touch 这个 block, push 一个新 snapshot 进 out
      const snapshot: CoalescedStreamEvent = { /* full-so-far text */ }
      touched.set(chunks, snapshot)
      out.push(snapshot)
      break
  }
}
```

**关键设计**:
- 每个 block (index) 在 100ms 窗口内只产生 **1 个 snapshot event**, text 是从 block 开头到此刻**全文**.
- 用 `touched.set(chunks, snapshot)` 索引到已 push 的 snapshot, 后续 delta 改它的 text — 同对象引用, push 进 out 的也跟着改.
- **mid-stream reconnect 友好**: client 收任一 snapshot 都是自完备文本, 不需要拼前面.

这比 "把全部 delta 直接转发" 优很多 — 100ms 内 50 个 delta, 转发是 50 个 frame, snapshot 是 1 个. 而且 client 重连不丢 — 拿最新 snapshot 即可.

为啥不在 stop 事件清 accumulator? 注释说: "abort/error paths skip stop events". 改成在 `writeEvent` 收到 complete assistant message 时清 — 那是 reliable end-of-stream signal.

[ccrClient.ts:62-68](src/cli/transports/ccrClient.ts#L62-L68) `MAX_CONSECUTIVE_AUTH_FAILURES = 10`:

注释解释场景:
- expired JWT 直接 exit (no retry will succeed).
- 看起来 valid 但 server 说 401 → server-side blip (userauth 挂 / KMS 抖) → ride out 10 × 20s = 200s.

[ccrClient.ts:586-614](src/cli/transports/ccrClient.ts#L586-L614) `request` 401 处理:

```ts
if (response.status === 401 || response.status === 403) {
  const tok = getSessionIngressAuthToken()
  const exp = tok ? decodeJwtExpiry(tok) : null
  if (exp !== null && exp * 1000 < Date.now()) {
    // JWT 真过期 — exit
    this.onEpochMismatch()
  }
  // Token 看起来 valid, 但 server 给 401 — 算 server-side blip, 累计
  this.consecutiveAuthFailures++
  if (this.consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
    this.onEpochMismatch()  // 10 次后放弃
  }
}
```

**先看 JWT exp** — 用客户端 clock 判断"是不是肯定过期了". 是 → 立即 exit (重试 100% 失败). 不是 → 累计计数.

[ccrClient.ts:443-446](src/cli/transports/ccrClient.ts#L443-L446) **delivery ack 注册在 ctor**:

```ts
transport.setOnEvent((event: StreamClientEvent) => {
  this.reportDelivery(event.event_id, 'received')
})
```

为啥放 ctor 而非 initialize()? 注释: "remoteIO must be free to call transport.connect() immediately after without racing the first SSE catch-up frame against an unwired onEventCallback". 防 race — 第一个 frame 进来时 callback 必须已 wired.

[ccrClient.ts:678-695](src/cli/transports/ccrClient.ts#L678-L695) **heartbeat schedule + jitter**:

```ts
const schedule = (): void => {
  const jitter = this.heartbeatIntervalMs * this.heartbeatJitterFraction * (2 * Math.random() - 1)
  this.heartbeatTimer = setTimeout(tick, this.heartbeatIntervalMs + jitter)
}
const tick = (): void => {
  void this.sendHeartbeat()
  if (this.heartbeatTimer === null) return  // close() during sendHeartbeat
  schedule()
}
schedule()
```

`tick` 内 check timer === null — close() 在 sendHeartbeat 异步期间发生, 不应再 schedule. 这是**fire-and-forget 异步操作和 close 的 race 处理范式**.

[ccrClient.ts:904-958](src/cli/transports/ccrClient.ts#L904-L958) `getWithRetry` 10 次 attempts:

不用 SerialBatchEventUploader 因为是 GET (单个 request, 没 batch 概念). 自己 10 attempts + exp backoff cap 30s + jitter 500ms.

---

## 十七、internalLogging.ts: Anthropic 内部探针

[internalLogging.ts:17-30](src/services/internalLogging.ts#L17-L30) `getKubernetesNamespace`:

读 `/var/run/secrets/kubernetes.io/serviceaccount/namespace`. 不在 K8s pod 里这个文件不存在 — 返 "namespace not found". 在 laptop 跑直接 `USER_TYPE !== 'ant'` 早 return null.

[internalLogging.ts:35-66](src/services/internalLogging.ts#L35-L66) `getContainerId`:

读 `/proc/self/mountinfo`, 匹配两种 pattern:
- Docker: `/docker/containers/<64-hex>`
- Containerd: `/sandboxes/<64-hex>`

为啥? Anthropic 内部 devbox 用 K8s, OCI runtime 是 containerd. 但开发机器可能 Docker. 同模式同函数支持两种.

[internalLogging.ts:71-90](src/services/internalLogging.ts#L71-L90) `logPermissionContextForAnts`:

```ts
export async function logPermissionContextForAnts(...) {
  if (process.env.USER_TYPE !== 'ant') return
  void logEvent('tengu_internal_record_permission_context', { ... })
}
```

只对 Anthropic 用户. 把 `toolPermissionContext` JSON 化连同 namespace + container ID 一起发. 这是 internal 诊断 — 帮 Anthropic 排查内部 staff 的 permission 配置问题.

---

## 十八、跨文件 / 跨模块的精髓

### 1. Marker type 强制 PII review
[index.ts:13-18](src/services/analytics/index.ts#L13-L18) 的 `& never` 类型, 给 reviewer 一个具体的 cast point 来看 "这字段安全吗"; 不需要全文搜 `logEvent`.

### 2. queue-before-sink
[index.ts:60-82](src/services/analytics/index.ts#L60-L82) startup critical path 零阻塞, 事件不丢.

### 3. 三层闸门
config-level disabled, killswitch (GrowthBook), sample rate. 任一关都不发. 防御深度.

### 4. 双 sink 一份 event, route 差异化
[sink.ts:99-115](src/services/analytics/sink.ts#L99-L115) Datadog strip `_PROTO_*`, 1P hoist `_PROTO_*`. PII routing 不重复构造 event.

### 5. 多 source 字段约定: Datadog 反向工程
[datadog.ts:107-149](src/services/analytics/datadog.ts#L107-L149) `status` → `http_status` 之类, **客户端 transform** 而非服务端. 因为 Datadog 字段 hard-coded 在 SDK.

### 6. Cardinality 控制三招
- mod 30 user bucket — 千万降到 30.
- MCP toolName → "mcp" — 不暴露用户 server 名.
- dev version 截尾 — 一 PR 一版本.

### 7. OpenTelemetry 选 BatchLogRecordProcessor 而非 Simple
后台 flush 不阻塞业务流. 必须配 scheduledDelayMillis / maxExportBatchSize / maxQueueSize.

### 8. 3 步 hot-swap
[firstPartyEventLogger.ts:200-256](src/services/analytics/firstPartyEventLogger.ts#L200-L256) null logger → forceFlush old → swap in new + 失败回滚.

### 9. Disk-backed retry with BATCH_UUID isolation
[firstPartyEventLoggingExporter.ts:71-156](src/services/analytics/firstPartyEventLoggingExporter.ts#L71-L156) 跨进程并发安全, 跨进程会延续未发.

### 10. quadratic backoff vs exponential
二次涨得快但顶得低 (5 次 = 25x), 适合短期 server 抖动.

### 11. Auth fallback (401 → no auth retry)
[firstPartyEventLoggingExporter.ts:418-498](src/services/analytics/firstPartyEventLoggingExporter.ts#L418-L498) 配合 backend 接受匿名事件 → degraded but functional.

### 12. `_PROTO_*` 双路由
[firstPartyEventLoggingExporter.ts:550-624](src/services/analytics/firstPartyEventLoggingExporter.ts#L550-L624) 同字段 strip/hoist 两路, 业务代码零意识.

### 13. GrowthBook 3 API 让 caller 选 trade-off
`_CACHED_MAY_BE_STALE` / `_BLOCKS_ON_INIT` / `_CACHED_OR_BLOCKING` — 命名传达语义, caller 自己决定.

### 14. 启动时 disk cache fallback
没拿到 remote, 回退读 `~/.claude/feature_cache.json`. 启动不阻塞.

### 15. Periodic refresh 6hr/20min
长跑 session 不能用启动 cache 一辈子. ant 20min 方便 dogfooding.

### 16. CLAUDE_INTERNAL_FC_OVERRIDES env
Anthropic-internal eval harness override flag. 不走 server, 测试可复现.

### 17. proto-generated type
[metadata.ts:957-973](src/services/analytics/metadata.ts#L957-L973) 编译时强制字段 — 改 proto 才能改字段, 不漏发.

### 18. Bun/Node 双 WS 实现
[WebSocketTransport.ts:159-193](src/cli/transports/WebSocketTransport.ts#L159-L193) 各自最佳 path, 上层接口统一.

### 19. arrow function as class property
能 removeEventListener / clearTimeout, 防内存累积.

### 20. Sleep detection (双处)
[WebSocketTransport.ts:472-489](src/cli/transports/WebSocketTransport.ts#L472-L489) 重置 reconnect budget; [WebSocketTransport.ts:712-735](src/cli/transports/WebSocketTransport.ts#L712-L735) ping interval gap 直接重连.

### 21. data frame keepalive
WS 控制帧不解 proxy idle. 必须发数据帧 (5min 一次).

### 22. Replay buffer 不清直到下次 confirm
[WebSocketTransport.ts:574-633](src/cli/transports/WebSocketTransport.ts#L574-L633) 防双重失联 message 丢.

### 23. SSE 严格按 spec
[SSETransport.ts:55-116](src/cli/transports/SSETransport.ts#L55-L116) 不按 spec 在 nginx/cloudflare 下 corrupt.

### 24. SSE 序列号 dedup with prune
[SSETransport.ts:351-396](src/cli/transports/SSETransport.ts#L351-L396) seenSet 1000 上限, prune to lastSeq - 200.

### 25. SSE liveness 45s = 3 × keepalive
3 个 keepalive 周期, 容忍 1 个 drop.

### 26. 100ms stream_event buffer
[HybridTransport.ts:118-138](src/cli/transports/HybridTransport.ts#L118-L138) LLM stream 高频, buffer 攒一波. 非 stream_event 来时 flush 保序.

### 27. close grace period race
[HybridTransport.ts:175-194](src/cli/transports/HybridTransport.ts#L175-L194) `Promise.race([flush, timeout(3s)])` — best effort 不阻塞退出.

### 28. SerialBatchEventUploader 显式 throw 控制 retry
caller 抛 → retry, 不抛 → 推进. 让 caller 决定哪些 error 算 retryable.

### 29. RetryableError + retryAfterMs
server 429 + Retry-After → caller 包成 RetryableError, uploader 用 server hint 当 delay + jitter.

### 30. Un-serializable item 当场丢
[SerialBatchEventUploader.ts:212-233](src/cli/transports/SerialBatchEventUploader.ts#L212-L233) try-catch + splice. 不丢就 flush hang.

### 31. concat 而非 unshift re-queue
重试路径用 `batch.concat(this.pending)` 单次分配, 避免 O(n²).

### 32. WorkerStateUploader 1-in-flight + RFC 7396 merge
state replace 类的 API 不需要序列化中间态. metadata 用 RFC 7396 浅 merge, null 当 sentinel.

### 33. CCRClient 4 uploader 各自配置
worker state / client events / internal events / delivery acks — 不同 traffic shape, 各自 baseDelayMs/maxQueueSize.

### 34. Stream text_delta coalesce 成 full-so-far snapshot
[ccrClient.ts:141-203](src/cli/transports/ccrClient.ts#L141-L203) 100ms window 内同 block 只发 1 个事件, text 全文 — mid-stream reconnect 友好.

### 35. Accumulator 清理用 assistant complete 而非 stop event
abort/error 路径跳 stop, complete 是 reliable signal.

### 36. JWT 客户端 exp 短路
[ccrClient.ts:586-614](src/cli/transports/ccrClient.ts#L586-L614) 401 时先看 JWT exp, 真过期 → exit (重试 100% 失败). 看着 valid → 累计.

### 37. delivery callback 注册在 ctor
防第一个 SSE frame 与 callback wiring 的 race.

### 38. tick callback check timer === null
[ccrClient.ts:687-693](src/cli/transports/ccrClient.ts#L687-L693) close 在异步 sendHeartbeat 期间发生, 不应再 schedule. 通用 race 处理范式.

---

## 十九、给 Agent 实现的建议清单

1. **PII routing 用 marker type** — 比 lint 规则便宜, reviewer 知道哪里看.
2. **logEvent queue 在内存, sink 一就绪 queueMicrotask drain** — 启动不丢事件.
3. **Datadog/1P 分两条 sink** — 通用监控 vs 业务事件管道.
4. **配置关闸用 OR** — 任一禁用就关, 默认 strict.
5. **Datadog 事件白名单** — 钱.
6. **TAG_FIELDS 只索引这些** — 钱.
7. **MCP toolName → "mcp"** 给通用 backend, **保留全名**给业务 backend (按白名单).
8. **mod 30 user bucket** — unique user 估算 cardinality 千万降 30.
9. **dev version 截尾** — 一 PR 一版本.
10. **`status` → `http_status` 重命名** — 避撞 Datadog reserved.
11. **OpenTelemetry BatchLogRecordProcessor** — 后台 flush 不阻塞.
12. **3 步 hot-swap** — null logger → forceFlush → swap, 失败回滚.
13. **Disk-backed failed events + BATCH_UUID** — 跨进程并发安全.
14. **quadratic backoff** — 温和.
15. **Auth fallback (401 → 不带 auth 再试)** — degraded but functional.
16. **`_PROTO_*` 字段双路由** — 一份 event, sink 处分别处理.
17. **GrowthBook 3 API 命名** — `_CACHED_MAY_BE_STALE` 等让 caller 选 trade-off.
18. **empty payload guard** — 远程 server 返 `{}` 直接 ignore, 不入 cache.
19. **periodic refresh 6hr/20min** — 长跑 session 不能用启动 cache.
20. **env var override (`CLAUDE_INTERNAL_FC_OVERRIDES`)** — 内部测试逃生口.
21. **proto-generated type** — 改 proto 才能改字段, 不漏发.
22. **process.cpuUsage() 差分算 percent** — 否则平均下来无用.
23. **tool input truncate 512 字符 + depth 2 + 跳 `_` keys** — payload 不爆.
24. **FILE_COMMANDS allowlist 才取 ext** — 避免 grep pattern 误判.
25. **MCP server allowlist 才暴露 tool 名** — local-agent / claudeai-proxy / 官方 registry / builtin.
26. **PERMANENT_CLOSE_CODES 不重试** — 显式列举.
27. **WS Bun/Node 双实现** — 各 runtime 最佳 path.
28. **handler 用 arrow function as class property** — 才能 removeEventListener.
29. **sleep detection 双处** — handleConnectionError gap + ping gap.
30. **data frame keepalive** — 控制帧不解 proxy idle (Cloudflare 5min).
31. **replay buffer 不清直到下次 server confirm** — 防双重失联.
32. **SSE 严格按 spec** — `\n\n` 分隔, comment, multi-data 拼.
33. **SSE seq dedup + 1000 prune to lastSeq-200**.
34. **SSE liveness 45s = 3 × keepalive**.
35. **100ms stream_event buffer + 非 stream 来时 flush 保序**.
36. **close grace race(flush, 3s timeout)** — best effort.
37. **SerialBatchEventUploader: throw → retry, 不抛 → 推进**.
38. **RetryableError + retryAfterMs + jitter** — 防 thundering herd.
39. **un-serializable 当场 splice 丢** — 否则 flush hang.
40. **re-queue 用 batch.concat(pending) 不用 unshift(...batch)** — O(n²) 退化.
41. **WorkerStateUploader 1-in-flight + RFC 7396 merge**.
42. **CCRClient 4 uploader 各自配置** — traffic shape 不同.
43. **text_delta coalesce 成 full-so-far snapshot** — mid-stream reconnect 友好.
44. **accumulator 用 complete signal 清, 不用 stop event** — abort/error 跳 stop.
45. **JWT exp 客户端短路 401 处理** — 真过期 exit, 看似 valid 累计.
46. **delivery callback 注册在 ctor 防 race**.
47. **tick callback check timer===null** — 异步期间 close 的通用范式.

---

## 二十、收尾

M18 = 把 "事件" 这个看似简单的概念, 做到了**可观测性 / 隐私 / cardinality / 故障恢复 / 跨进程并发** 五个维度全顾及.

最有"工程含量"的几个点:
- **marker type `& never`** — 静态强制 PII 审查.
- **`_PROTO_*` 双路由** — 同 event 两条 sink 处理差异化.
- **proto-generated EnvironmentMetadata** — 防 4 次"忘加字段"事故.
- **disk-backed retry + BATCH_UUID** — 跨进程并发安全.
- **GrowthBook empty-payload guard** — 防 server bug 全 flag blackout.
- **JWT exp 客户端短路** — 401 区分"必死" vs "可恢复".
- **text_delta full-so-far snapshot coalesce** — mid-stream reconnect 友好.
- **sleep detection 双处** — 防 sleep 醒来的连接坟场.
- **stream_event buffer + 非 stream flush 保序** — LLM stream 的 N→1 优化保 ordering.
- **3 步 hot-swap** — 配置 reinit 不丢数据.

跟 M11 (Ink) / M14 (subagent) / M16 (commands) / M17 (config) / M19 (state) 联动. 抄这章给 Agent 加 telemetry, 少踩三年的坑. 这章看似 "就是发个 POST", 实际是**整套 client-side observability platform**. **强烈推荐反复读, 尤其 firstPartyEventLoggingExporter.ts 和 ccrClient.ts**.
