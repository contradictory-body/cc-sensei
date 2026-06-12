# M10 Bridge / IDE / 远程会话

> 范围:`src/bridge/`(31 文件 / ~530KB)、`src/remote/`(4 文件)、`src/server/`(3 文件),以及 `hooks/useReplBridge.tsx`(REPL 侧消费)。
> 关注主轴:**Claude Code 作为子进程被外部驱动**(IDE/网页/手机)的进程内/进程间通信、JWT 鉴权、SSE/WebSocket 重连、流式状态机、跨进程取消/超时、跨进程缓存(token/secret)、跨进程 OAuth 续期。
> 目标:把 bridge 看作"我自己开发 Agent 时给 SDK / IDE / 网页客户端开门的那一层",并提炼可复用模式。

---

## 0. 模块定位

### 0.1 三种独立的"桥"

读完整个目录后,bridge 模块其实承担了三类**不同方向**的连接,容易混在一起。先把它们分开:

| 方向 | 名字 | 入口 | 核心问题 |
|---|---|---|---|
| **CLI 进程内** REPL 镜像到云端 | "Bridge" / "Remote Control" | `bridge/bridgeMain.ts` + `bridge/replBridge.ts` + `bridge/initReplBridge.ts` | 让 REPL 的所有键入/输出/工具能在云端被镜像 + 远程驱动 |
| **CLI 作为子进程**被 daemon spawn 来跑某个 session | "Bridge child" / "session runner" | `bridge/sessionRunner.ts`(daemon 侧) + `--bridge-session-id`(child 侧 — main.tsx 接收) | 给 daemon 提供"一次性 session"的 spawn / kill / token 刷新 / 输出回流 |
| **CLI 客户端**订阅服务端跑着的 session(无本地 child) | "Remote session" | `remote/RemoteSessionManager.ts` + `remote/SessionsWebSocket.ts` | 让本地 REPL 充当"瘦客户端",所有 work 在云端容器执行 |

第四个相关方向:`server/directConnectManager.ts` 是**完全相反**的方向 — 把本地 claude 当成一个 mini HTTP+WS server,让其它客户端连上来。这是"自托管 / VPC 内"的玩法,不走 Anthropic 后端。

### 0.2 与其它模块的边界

- **M02 Agent loop** 完全不感知 bridge:bridge 只是给 REPL 加了一层"额外的输入输出对端",通过 `useReplBridge` hook 注入。
- **M04 权限**:bridge 把远端的 `can_use_tool` 桥接成本地 permission flow(`bridgePermissionCallbacks.ts`)。远端不参与决策,本地照常弹 UI / 用 rules。
- **M05 API**:bridge 不调 Anthropic API;它代理的是 **Claude Code 自己的 session API**(`/v1/sessions/*`、`/v1/code/sessions/*`、`/worker/*`)。
- **M06 Compact**:compact 与 bridge 在 `SessionsWebSocket` 那层有一个具体交互 — 服务端在 compact 期间会偶发返回 `4001 session not found`,客户端必须把它当作**临时错误**而不是永久关闭。

---

## 1. 文件清单与字节地图

```
src/bridge/  (31 文件)
├── bridgeMain.ts             2999 行 / 115K   daemon 主循环(IDE 端长连接)
├── replBridge.ts             2406 行 / 100K   REPL 侧 bridge 适配主体
├── remoteBridgeCore.ts       1008 行 /  39K   env-less v2 bridge 入口
├── createSession.ts           384 行 /  12K   环境侧 session 创建/归档/重命名
├── replBridgeTransport.ts     370 行 /  15K   v1/v2 统一传输接口
├── initReplBridge.ts          569 行 /  24K   REPL bridge bootstrap 包装
├── sessionRunner.ts           550 行 /  18K   每 session 的 ProcessTransport
├── bridgeApi.ts              ~430 行 /  18K   环境 API HTTP 客户端
├── bridgeMessaging.ts        ~400 行 /  16K   消息编解码 + control_* 协议
├── envLessBridgeConfig.ts     165 行 /  7K    无环境模式 Zod 配置
├── jwtUtils.ts               ~230 行 /  9K    JWT 解析 + 过期判断
├── inboundAttachments.ts      175 行 /  6K    Web composer 上传文件接收
├── bridgeStatusUtil.ts        163 行 /  5K    状态线 / glimmer / OSC-8 hyperlink
├── trustedDevice.ts           210 行 /  8K    可信设备 token
├── bridgeUI.ts                530 行 /  17K   chalk-based 状态显示
├── bridgePointer.ts          ~190 行 /  8K    bridge 指针(谁是当前 owner)
├── bridgeEnabled.ts           202 行 /  8K    feature gate / 诊断
├── bridgeDebug.ts             135 行 /  5K    ant-only fault injection
├── pollConfig.ts              110 行 /  5K    poll 配置 Zod schema
├── pollConfigDefaults.ts       82 行 /  4K    默认 poll 间隔 / TTL
├── bridgePermissionCallbacks.ts  43 行 /  1K  bridge ↔ permission interface
├── bridgeConfig.ts             48 行 /  2K   token / base URL 取值
├── codeSessionApi.ts          168 行 /  5K   env-less v2 HTTP layer
├── debugUtils.ts              141 行 /  4K   redactSecrets / axios error 描述
├── inboundMessages.ts          80 行 /  3K   image mediaType ↔ media_type 校正
├── replBridgeHandle.ts         36 行 /  1K   handle singleton
├── sessionIdCompat.ts          57 行 /  3K   cse_* ↔ session_* 转换
├── workSecret.ts              ~140 行 /  5K   work secret base64url 编解码
├── flushGate.ts                ~70 行 /  2K   write 缓冲门
├── capacityWake.ts             ~70 行 /  2K   容量唤醒事件
└── types.ts                    262 行 /  10K  共享类型与接口

src/remote/  (4 文件)
├── RemoteSessionManager.ts    344 行 /  9K   远程会话生命周期 + permission
├── SessionsWebSocket.ts       404 行 / 12K   /v1/sessions/ws/{id}/subscribe
├── sdkMessageAdapter.ts       303 行 /  9K   SDKMessage → REPL Message
└── remotePermissionBridge.ts   78 行 /  2K   合成 AssistantMessage / Tool stub

src/server/  (3 文件)
├── directConnectManager.ts    213 行 /  6K   本地 ws server / send / recv
├── createDirectConnectSession.ts  88 行 / 2K  POST /sessions
└── types.ts                    57 行 /  1K   server 配置 + session 索引
```

---

## 2. Bridge daemon 主循环(bridgeMain.ts + bridgeApi.ts)

> 这一节描述 **`claude remote-control`** 子命令——CLI 进程作为一个**长跑 daemon**接收云端工作单元(WorkResponse),spawn child claude 来跑,把输出回流到 session API。

### 2.1 注册环境(register)

`bridgeApi.registerBridgeEnvironment(config)`:

- POST `/v1/environments/register`
- 头:`anthropic-beta: environments-2025-11-01` + `x-organization-uuid`
- body:`{environment_id, source_machine, sources, max_capacity, source_workspaces, metadata.{worker_type, max_sessions, spawn_mode, sandbox}, reuse_environment_id?}`
- 返回:`{environment_id, environment_secret}` — secret 是后续所有 `pollForWork` 的认证凭据(不是 OAuth token)

关键点:
- **client-generated environment_id 是幂等键**。重启 daemon 时传同一个 UUID → 服务端复用环境,不创建新的(同时把 reuse_environment_id 传给 backend 走"reconnect existing")。
- **secret 是环境级别**,不是 session 级别。pollForWork 拿这个;但是 ack / event-send 改用 session 的 `session_ingress_token`(从 work_secret 里解出来),粒度更细。

### 2.2 长轮询(pollForWork)

`bridgeApi.pollForWork(envId, envSecret, signal, reclaimOlderThanMs)`:

- POST `/v1/environments/{id}/poll`,authorize 用 `environment_secret`
- body:`{environment_id, reclaim_older_than_ms?}`
- 服务端**长轮询**(挂起到有 work 或超时)
- 返回 `WorkResponse | null`

`WorkResponse` 结构(types.ts:23):
```ts
{
  id, type: 'work',
  environment_id, state,
  data: { type: 'session' | 'healthcheck', id },
  secret: string,    // base64url-encoded JSON = work_secret
  created_at
}
```

`reclaim_older_than_ms`:服务端如果发现某个 work 已经被 daemon 领走但**心跳超过这个时长没续**,把它重新分配给新的 poll。**这是分布式工作队列的标准 reclaim 模式**——确保 daemon 崩了之后工作不会永远卡在 in-flight。

### 2.3 三种 poll 状态(pollConfigDefaults.ts)

`pollConfigDefaults.ts:1-82`:

| 状态 | 间隔 | 触发 |
|---|---|---|
| `POLL_INTERVAL_MS_NOT_AT_CAPACITY` | 2000ms | 还能接更多 session |
| `POLL_INTERVAL_MS_AT_CAPACITY` | **600_000ms (10 min)** | 已满,等 capacity wake |
| `reclaim_older_than_ms` | 5000ms | poll body 里告诉服务端"5s 没续约的 work 我可以接" |
| `session_keepalive_interval_v2_ms` | 120_000ms | 子 session ingress keep-alive(防上游 proxy GC) |
| `non_exclusive_heartbeat_interval_ms` | 0 (off by default) | heartbeatWork 兼容 PR #22145 |

**10 分钟在满载时 poll** 看起来很反直觉,但有数据支撑:
- Redis TTL 4 小时,10 分钟有 **24× 余量**
- 满载时 daemon 已经被本地 child 喂饱了 CPU,频繁 poll 是浪费
- 真有人想从外部追加 session(超出容量),服务端通过 **capacity wake**(WebSocket 长连接的旁路通知)主动唤醒 daemon — 见 `capacityWake.ts`

### 2.4 pollConfig 校验哲学(pollConfig.ts)

`pollConfig.ts:1-110` 是教科书级的"配置校验防御":

```ts
const zeroOrAtLeast100 = z.number().refine(
  n => n === 0 || n >= 100,
  '...reject 1-99ms (unit confusion: ops typed seconds, got milliseconds)'
)
```

为啥要 "0 or ≥100"?

- 全部允许的话,**有人把 `10` 当 10 秒填进去**,实际 10ms → daemon CPU 100%
- **`floor` 不能用 z.number().min(100)** 因为 0 是合法 disable 值

更狠的 object-level refine:

```ts
.refine(c => !(c.non_exclusive_heartbeat_interval_ms === 0 && c.at_capacity_ms === 0))
```

意思是 heartbeat=0 + atCapacityPoll=0 **同时**为 0 → 整个 config 拒收。为啥?这两个一起 0 → daemon 在容量满时不断 /poll 跑 tight loop。

**整套 config schema 失败时 fallback 到 DEFAULT_POLL_CONFIG**(整份重置),**不接受 partial trust**——某个字段错就连带整份不要,因为字段之间有耦合,部分接受可能造出比默认更危险的状态。

### 2.5 work_secret 与 session_ingress_token(workSecret.ts)

WorkResponse 里的 `secret` 字段是 base64url 编码的 JSON。解出来是 `WorkSecret`(types.ts:33):

```ts
{
  version, session_ingress_token,
  api_base_url,
  sources: [...],
  auth: [{type, token}, ...],
  claude_code_args?,
  mcp_config?,
  environment_variables?,
  use_code_sessions?   // 服务端选择走 v2 CCR transport
}
```

要点:
- **session_ingress_token 是 JWT** — 给 child session 用,直连 session ingress(不经环境 API)。
- **auth.token 是 OAuth token** — 给 child 用来调 Anthropic API(模型调用)。
- **use_code_sessions** 是服务端驱动的 transport 选择 — 不是客户端决定,**服务端在 `prepare_work_secret()` 里决定**(types.ts:50 注释:Same field the BYOC runner reads at environment-runner/sessionExecutor.ts)。客户端只是**遵从**。

### 2.6 daemon → child 的 spawn(sessionRunner.ts)

`createSessionSpawner({...}).spawn(opts, dir)` 返回 SessionHandle。

**环境变量被精心选择**(sessionRunner.ts:142-220 等):
- **strip** `CLAUDE_CODE_OAUTH_TOKEN`(child 不能用 daemon 的 token — daemon 跑 IDE 用户的账号,child 跑 work 提供者的账号,两者**必须分离**)
- **set** `CLAUDE_CODE_ENVIRONMENT_KIND='bridge'`(child 通过这个识别"我在被 bridge 调度")
- **set** `CLAUDE_CODE_SESSION_ACCESS_TOKEN=session_ingress_token`
- **set** `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2='1'`(切换 ingress 上行协议)
- 条件 set `CLAUDE_CODE_USE_CCR_V2`(use_code_sessions=true 时)
- 条件 set `CLAUDE_CODE_WORKER_EPOCH=workerEpoch`(v2 时,从 /worker/register 拿到)
- `windowsHide: true, stdio: ['pipe','pipe','pipe']`

`scriptArgs` 的微妙差异(types.ts + sessionRunner 内分支):
- 编译二进制(`process.argv[0]` 末尾是 `claude` 而不是 `node`):空 args
- npm install 的:**第一个 arg 必须是 `process.argv[1]`(脚本路径)**

> 为啥要这么做? GitHub issue **anthropics/claude-code#28334**:当 npm-installed,node 把 `--sdk-url` 误解为 node option。`scriptArgs` 显式带上脚本路径让 node 知道"这后面的是用户 args 不是 node options"。

### 2.7 SessionHandle 的 lifecycle(sessionRunner.ts)

```ts
type SessionHandle = {
  sessionId
  done: Promise<SessionDoneStatus>
  kill()             // SIGTERM (Windows fallback to default)
  forceKill()        // SIGKILL + sigkillSent 标记
  activities         // 最近 10 个 SessionActivity 的环形缓冲
  currentActivity
  accessToken
  lastStderr         // 最近 10 行 stderr 环形缓冲
  writeStdin(data)
  updateAccessToken(token)  // 把新 token 通过 stdin JSON 注入
}
```

关键工程细节:

1. **forceKill 用 `sigkillSent` 标记**而不是依赖 `child.killed`:Node child_process 的 killed 字段在 SIGTERM 后不可靠,**SIGKILL 之后必须用自己的 flag 区分**(否则会重复发 SIGKILL,Windows 上 SIGKILL fallback 到 `kill()` 默认行为可能再次 kill 已死进程)。

2. **stderr 环形缓冲**(默认 10 行):session 失败时上报这 10 行给服务端定位,**不上报整个 stderr**(可能包含敏感信息 + 太大)。

3. **per-session debug+transcript 文件**:`bridge-session-{safeId}.log` 是 debug 日志,`bridge-transcript-{safeId}.jsonl` 是事件 transcript。`safeFilenameId(id)` 强制只允许 `[a-zA-Z0-9_-]`,**防止 sessionId 中的特殊字符做路径注入**。

4. **updateAccessToken 通过 stdin 发 JSON**:`{type:'update_environment_variables', variables:{CLAUDE_CODE_SESSION_ACCESS_TOKEN: token}}`。child 监听 stdin 解析这个特殊消息,**不重启进程就能换 token**。这是无缝 OAuth/JWT 续期的关键。

### 2.8 createSession HTTP 层(createSession.ts)

四个端点(`createSession.ts:1-384`):

1. `POST /v1/sessions` (createBridgeSession) — daemon 主动创建一个 session(给 IDE 用的工具)
2. `GET /v1/sessions/{id}` — 取 environment_id + title 用于 resume
3. `POST /v1/sessions/{id}/archive` — 归档,**接受任何 status,409 当作 idempotent 成功**
4. `PATCH /v1/sessions/{id}` — 改 title(rename),sessionId 走 `toCompatSessionId()` 转换(cse_ → session_)

所有四个端点都要:
- `anthropic-beta: ccr-byoc-2025-07-29`(注意:**与 bridgeApi.ts 的 `environments-2025-11-01` 不一样**)
- `x-organization-uuid`

代码内特别注释:**archiveBridgeSession 没有 try/catch**,呼叫方必须自己包(`initReplBridge` 内用 `.catch` 包)。这种**"故意不吞错"的设计**让上层根据具体场景决定要不要 log / 重试 / 忽略,比一个万能 try/catch 更清晰。

### 2.9 sendPermissionResponseEvent 的双 ingress(bridgeApi.ts)

发 control_response(permission 决策)有两条路:
- **环境 API**:`POST /v1/environments/{envId}/sessions/{sId}/events`,用 environment_secret
- **session ingress 直连**:`POST {session_ingress_url}/v1/sessions/{sId}/events`,用 session_ingress_token

直连 ingress 更快(不绕环境 API),但要求 ingress URL 已经被解析(从 work_secret 里取)。bridge 优先走 ingress,失败时 fallback 环境 API。

---

## 3. REPL bridge(replBridge.ts + initReplBridge.ts + replBridgeTransport.ts)

这一节描述**反方向**——**用户的 REPL** 想让自己被远程驱动(网页/手机能看到我的会话状态,能远程提交消息)。

### 3.1 入口分叉(initReplBridge.ts)

`initReplBridge.ts:1-569` 是 REPL bootstrap 包装,主要做三件事:
1. cross-process OAuth backoff check(下文 3.2)
2. 选 v1 / env-less v2 / outbound-only 三条路径(下文 3.3)
3. 初始化 BridgeLogger 并打印连接 banner(QR code + URL)

**Title precedence**(代码注释):
```
initialName (CLI --name 参数)
  → /rename 设置(sessionStorage)
  → 最后一条有意义的 user 消息派生 (deriveTitle)
  → 生成的 slug "remote-control-graceful-unicorn"
```

`onUserMessage` 计数策略:
- count=1:用 `deriveTitle` 派生占位符 + 后台 fire `generateSessionTitle`(Haiku 调用,1-15s)
- count=3:用整段 conversation 重新 generate(更好的总结)
- 用 `genSeq` 计数器**防止竞态**:count-1 的 Haiku 可能在 count-3 已经 fire 后才返回,要丢弃过期结果

### 3.2 跨进程 OAuth backoff(initReplBridge.ts)

`bridgeOauthDeadExpiresAt` + `bridgeOauthDeadFailCount≥3`:

- 多个 Claude Code 实例可能**同时**启动并各自尝试 bridge,如果用户的 OAuth token 已经死了,**N 个实例同时打 N 次 401** → 服务端被刷
- 用**全局 config 的 expiry 字段**做跨进程协调:某个实例发现 OAuth 真死了,设置一个 `bridgeOauthDeadExpiresAt`(比如未来 5 分钟);其它实例启动时先 check 这个字段,在 expiry 内**直接跳过 bridge**
- **Datadog 2026-03-08 数据**:single IPs generating **2879 401s/day** — 这个 backoff 是从这个 incident 反推出来的

三步 OAuth 校验:
1. `checkAndRefreshOAuthTokenIfNeeded` — 尝试 refresh
2. 如果 expiry-buffer 还在 future 但 token 真过期了(冷启动场景)→ 用 `tokens.expiresAt <= Date.now()` 严格判断("truly dead" check),**不能用 `isOAuthTokenExpired`** — 后者有 5-min buffer 用于 proactive refresh,但 cold path 上需要严格判断
3. cross-process backoff 标记是否需要 set/clear

### 3.3 三条路径

```ts
if (tengu_bridge_repl_v2 && !perpetual) {
  initEnvLessBridgeCore({...})  // env-less v2: 不走环境 API
} else if (ccrMirrorEnabled) {
  // outbound-only mode: 只 outbound 推消息,不订阅 SSE
} else {
  initBridgeCore({..., archive: {timeoutMs: 1500}})  // v1: 环境 API + child spawn
}
```

> 重要:**env-less v2 ≠ CCR v2 transport**
> - env-less 是把"环境 API"层去掉(没有 /environments/poll),直接走 session API
> - CCR v2 transport 是 /worker/* 那套传输层,跟环境 API 共存
> 同一个 session 可能跑在(env-less + CCR v2)/(有环境 + CCR v2)/(有环境 + v1 ingress)三种组合

### 3.4 ReplBridgeTransport 统一接口(replBridgeTransport.ts)

`replBridgeTransport.ts:1-370` 定义了 v1 / v2 共用的接口:

```ts
interface ReplBridgeTransport {
  write(payload, opts)
  writeBatch(payloads, opts)
  close(): void
  isConnectedStatus(): bool
  getStateLabel(): string
  setOnData(cb)
  setOnClose(cb)
  setOnConnect(cb)
  connect()
  getLastSequenceNum(): number
  droppedBatchCount(): number
  reportState(state)      // 'idle'|'running'
  reportMetadata({...})
  reportDelivery(uuid, kind: 'received'|'processed')
  flush()
}
```

#### v1 adapter(HybridTransport pass-through)
- `getLastSequenceNum` 永远返回 0(v1 没有 SSE sequence)
- 直接转发到 `HybridTransport`(已有的 SSE 上行/HTTP 下行混合方案)

#### v2 adapter(SSE + CCRClient)
- 在 createV2ReplTransport 内部 **integrated 一次 registerWorker**(POST /worker/register)
- `getAuthHeaders` 是 **closure per-instance**,多 session 时每个 transport 用自己的 token(单 session 时回退到 process-wide env var)
- `reportDelivery` 立即发 **'received' + 'processed' 两次 ACK** — 修复 daemon 重启时"幽灵 prompt"问题:观察到 21→24→25 的洪水(同一 prompt 反复重发)

**onEpochMismatch (409)** 流程:
1. 关闭 ccr + sse 连接
2. 触发 `onCloseCb(4090)`
3. **必须 throw**(注释直陈)— 否则 `handleEpochMismatch` 的 `never` 返回类型在 runtime 被违反

**四个 close code**:
- 4090:epoch superseded(另一个实例替你 register 了,你被踢)
- 4091:init failure
- 4092:SSE reconnect budget exhausted

**`ccrInitialized`** 是 write-readiness gate,**独立于 SSE open**:
- SSE 的 `connect()` 永远不 resolve(它在 await 读循环)
- 但 CCR 写通道 ready 时可以独立 fire `ccrInitialized = true`
- outbound-only 模式整个跳过 sse.connect()

### 3.5 env-less bridge(remoteBridgeCore.ts + codeSessionApi.ts)

env-less 是 2026 年新加的路径,目的是让"没有环境(没有 daemon)"的客户端也能远程驱动 — 例如纯 web 用户从 claude.ai 创建一个 session,本地 CLI 不需要做 daemon 就能 attach。

**流程**(`remoteBridgeCore.ts:1-1008` + `codeSessionApi.ts:1-168`):

```
1. POST /v1/code/sessions       body: {title, bridge: {}, tags?}
   → {session: {id: 'cse_*'}}   (bridge:{} 是 oneof runner 的 positive signal,必须传)

2. POST /v1/code/sessions/{id}/bridge   header: X-Trusted-Device-Token
   → {worker_jwt, api_base_url, expires_in, worker_epoch}
   worker_epoch 是 protojson int64-as-string,需要 Number.isFinite + Number.isSafeInteger 校验

3. createV2ReplTransport(...)   建立 SSE + CCRClient

4. createTokenRefreshScheduler  refreshBufferMs=300_000 (5 分钟前 refresh JWT)

5. 401 → rebuildTransport(getLastSequenceNum 旧值 → 新 transport 的 initialSequenceNum)
```

**关键工程**:

- **每次 /bridge 调用 server 自动 bump epoch**(服务端 PR #292605/#293280)— 这个调用**就是** registration。客户端不需要单独的 /register。
- **rebuildTransport** 被 proactive refresh 和 401 recovery 共用 — 先 `getLastSequenceNum()` **再** `close()`,把旧高水位传给新 transport 的 `initialSequenceNum`,断点续传不丢消息。
- **authRecoveryInFlight 标记在 await 之前 claim** — 笔记本唤醒时 proactive timer + 401 同时 fire,要防止两条路径同时 rebuildTransport(双重 epoch bump)
- **ConnectCause** telemetry 三状态:`'initial' | 'proactive_refresh' | 'auth_401_recovery'` — 方便排查"是谁触发的重连"
- **onConnectTimeout** = `connect_timeout_ms` (15s default) 后 onConnect/onClose 都没触发 → 上报 `tengu_bridge_repl_connect_timeout`(~1% silent failures 的可见性)
- **initialFlushDone = false on 401 recovery** — writeBatch 会 silent no-op on closed uploader;新 onConnect 触发 re-flush

**Teardown 顺序**:
```
cancelAll → clearTimeout → flushGate.drop → reportState('idle')
  → write result message → archiveSession(401 retry)
  → transport.close
```

每一步必须按顺序——例如 `reportState('idle')` 必须在 write result 之前,否则服务端会觉得 session 还在 running 而不接 result;archiveSession 必须在 close 之前,否则没传输通道。

`ArchiveTelemetryStatus` 5 桶:`'ok' | 'skipped_no_token' | 'network_error' | 'server_4xx' | 'server_5xx'`

`withRetry` 用 **exponential backoff + jitter**:
```
delay = init_retry_base_delay_ms * 2^(attempt-1) ± init_retry_jitter_fraction * base
```

### 3.6 envLessBridgeConfig.ts 的"地板拒绝"哲学

`envLessBridgeConfig.ts:1-165` 定义了 env-less bridge 的全部可配参数。校验哲学是 **"floor reject entirely"**:

- 任何 floor 违反(比如 `init_retry_max_attempts < 1`)→ **整个 config 丢弃**,fall back DEFAULT
- 不允许 partial trust

具体 cap 的来历:
- `heartbeat_interval_ms`:cap **5-30s** — 服务端 TTL 60s,2× margin
- `heartbeat_jitter_fraction`:cap **0.5** — 最坏情况 45s 间隔,仍在 60s TTL 之内
- `token_refresh_buffer_ms`:cap **30min** — **拒绝"buffer-vs-delay 语义反转"**(ops 误填 `expires_in - 5min` 而不是 `5min`)
- `teardown_archive_timeout_ms`:cap **2000ms** — gracefulShutdown race(整体退出 cap 2s)
- `connect_timeout_ms`:**5-60s** — 观察 p99 ~2-3s

最有意思的:**`min_version` 用 semver.lt(v, '0.0.0') 不抛出**来验证 — semver 库的 valid() 偶尔返回 null,这种"双重否定"用法保证只接受 valid semver。

### 3.7 cseShimGate 与依赖反转(sessionIdCompat.ts)

`sessionIdCompat.ts:1-57` 实现 `cse_*` ↔ `session_*` ID 转换。worker 端点要 `cse_*`(新),compat 端点要 `session_*`(老)。

shim 的开关用 **依赖反转**(`setCseShimGate(gate)`)而不是直接调 GrowthBook:

> 为啥? **避免 SDK bundle 拉入** `bridgeEnabled → growthbook → config` 的依赖链 — SDK 用户不需要 GrowthBook,但又需要这个 ID 转换函数。DI 让两个使用场景共享代码但不共享依赖。

shim **默认 active**(`isCseShimEnabled` defaults true)— 关掉它需要显式 flip `tengu_bridge_repl_v2_cse_shim_enabled`。

---

## 4. 协议帧(bridgeMessaging.ts + flushGate.ts + bridgePointer.ts)

### 4.1 bridgeMessaging.ts:协议编解码

控制流通过 **`control_request` / `control_response` / `control_cancel_request`** 三类消息,以及若干 `bridge.*` 事件(状态/元数据/容量等)。每个 control_request 有 `request_id`,response 通过 request_id 关联。

**重要的 control 子类型**(出现在 sdkMessageAdapter / RemoteSessionManager / DirectConnect):
- `can_use_tool`:服务端问客户端"这个工具能用吗?",客户端在本地通过 permission flow 决定,response 是 `{behavior: 'allow', updatedInput} | {behavior: 'deny', message}`
- `interrupt`:客户端发,要求服务端 interrupt 当前 turn
- `error`:任何 subtype 拒收时回的 error response(防止服务端永远 hang)

### 4.2 flushGate.ts:write 缓冲门

`flushGate.ts:1-70` 是一个 **lazy flush gate**:
- 初始 closed,所有 write 累积进 buffer
- 某个事件(比如 ccrInitialized)调 `flushGate.open()` → 一次性 flush 全部累积
- `flushGate.drop()` 永久关闭并丢弃(用于 teardown)

为啥要这个?**初始化是个分布式状态机**——SSE / CCRClient / register / token 校验四件事各自异步,完成顺序不固定。如果某个 write 在 ccrInitialized 之前发,它会失败(写到 null transport)。flushGate 让上游可以**无脑 write**,gate 决定何时真正下推。

### 4.3 bridgePointer.ts:Owner 协调

`bridgePointer.ts:1-190` 解决"哪个进程是当前 bridge owner"。同一台机器可能跑多个 Claude Code 实例,**只有一个**能 register environment 并接收 work(否则会争抢)。

机制:
- 全局 config 存 `bridge_pointer = {pid, started_at, environment_id}`
- 新实例启动时 check pointer,如果 pid 还活着 → 让步(自己不 register)
- pid 不活 → 抢占 pointer 并 register

**bridge_pointer 还存了 environment_id**——继任者用同一个 environment_id 再 register 实现 resume(参见 2.1 的幂等性)。

---

## 5. Inbound 路径(inboundAttachments.ts + inboundMessages.ts)

### 5.1 web → CLI 的附件投递(inboundAttachments.ts:1-175)

用户在网页 composer 上传文件 → web app 调 `POST /api/{org}/upload` → 得到 `file_uuid` → 把 `file_uuid` 嵌入消息发给 bridge → CLI 这边:

```
1. extractInboundAttachments(message)  → [{file_uuid, file_name}, ...] (Zod validate)
2. for each:
   a. sanitizeFileName(file_name) → basename + replace /[^a-zA-Z0-9._-]/g; fallback 'attachment'
   b. uuid prefix (first 8 chars) → 防同名碰撞
   c. GET /api/oauth/files/{uuid}/content  → 下载
   d. write 到 ~/.claude/uploads/{sessionId}/<prefix>-<sanitized-name>
3. prependPathRefs(processedBlocks, attachmentPaths)
   → 在 LAST text block 前面插 @"path1" @"path2"
```

**为什么是 LAST text block?** processUserInputBase 读 `inputString` from `processedBlocks[length - 1]` — 第一块可能是 image 之类的 non-text,@ 引用必须放在真正的 prompt 文本块。

**quoted `@"path"`** 是关键 — `extractAtMentionedFiles` 把 unquoted `@/Users/John Smith/...` 在第一个空格处截断,会把 "John Smith" 那种带空格路径吃掉。引号形式强制把整个路径当一个 token。

### 5.2 image 字段名修复(inboundMessages.ts:1-80)

`normalizeImageBlocks` 解决一个**会污染整个 session** 的 bug:

- iOS / web client 可能发 `mediaType`(camelCase)而不是 `media_type`(snake_case)
- 也可能完全 omit 这个字段
- 如果不修:第一次发图后,**每次后续 API 调用都报 `media_type: Field required`** — 整个 session 报废

`normalizeImageBlocks`:
1. 如果有 `mediaType` 字段 → 改名为 `media_type`
2. 如果没有任何字段 → `detectImageFormatFromBase64` 推断格式(从 magic bytes)
3. **fast path zero-alloc scan**:扫一遍发现没有 malformed block → **直接返回原数组引用**,不分配新内存

第三点很重要:在长会话里,绝大多数消息没有问题,**避免无谓的内存分配/拷贝**。

---

## 6. 状态/UI(bridgeStatusUtil.ts + bridgeUI.ts)

### 6.1 bridgeStatusUtil.ts:状态线工具

`bridgeStatusUtil.ts:1-163` 提供:

- **StatusState** = `'idle' | 'attached' | 'titled' | 'reconnecting' | 'failed'`
- **timestamp 格式化**(HH:MM:SS)
- **buildBridgeConnectUrl / buildBridgeSessionUrl**(QR 用)
- **computeGlimmerIndex / computeShimmerSegments** — 字符级的微光动画
  - 用 **grapheme segmentation + stringWidth** 处理多字节(emoji + CJK + ANSI 控制码)
- **wrapWithOsc8Link(text, url)** — OSC 8 终端超链接序列(`\x1b]8;;{url}\x1b\\` ... `\x1b]8;;\x1b\\`),**零视觉宽度** — 在 iTerm2/wezterm/Windows Terminal 这类支持的终端里点击可跳转

**TOOL_DISPLAY_EXPIRY_MS = 30000**:工具消息 30 秒后从状态行淡出
**SHIMMER_INTERVAL_MS = 150**:微光动画帧率

### 6.2 bridgeUI.ts:chalk 渲染层

`bridgeUI.ts:1-530` 是无 Ink 的 TUI 渲染(`claude remote-control` 主屏不用 Ink,因为它要在 React 启动之前打印 banner + QR)。

关键技巧:**手动 cursor 控制 + 视觉行计数**

```ts
function countVisualLines(text: string): number {
  const cols = process.stdout.columns || 80
  let count = 0
  for (const logical of text.split('\n')) {
    if (logical.length === 0) { count++; continue }
    const width = stringWidth(logical)
    count += Math.max(1, Math.ceil(width / cols))   // 处理 wrap
  }
  if (text.endsWith('\n')) count--  // 末尾 \n 不算新视觉行
  return count
}

function clearStatusLines(): void {
  if (statusLineCount <= 0) return
  write(`\x1b[${statusLineCount}A`)   // cursor up N lines
  write('\x1b[J')                      // erase from cursor to end of screen
  statusLineCount = 0
}
```

**为什么不能用简单的 `\r` 覆盖?** 因为 status 块可能 wrap 成多个视觉行(终端窄、URL 长、QR code),`\r` 只回到当前视觉行的开头。必须按视觉行数往上挪。

**QR code 用 `qrcode` 包**,errorCorrectionLevel `'L'` — 最低纠错,**最大密度** = 同样信息量字符更少 = 终端里更紧凑(因为 QR 是 utf8 字符画)。

`generateQr` **异步生成**:`regenerateQr(url)` 不阻塞 banner 打印,Promise resolve 后 `renderStatusLine()` 触发重绘。

---

## 7. trustedDevice.ts:可信设备

`trustedDevice.ts:1-210`:

```
TRUSTED_DEVICE_GATE = 'tengu_sessions_elevated_auth_enforcement'
```

bridge session 创建需要 SecurityTier=ELEVATED → 服务端要求 client 出示 trusted device token。

**为什么单独搞 "trusted device"** 而不是直接 OAuth?因为 OAuth token 5 分钟就到期/refresh,过期窗口里 token 可能被 leak;trusted device token 90 天 rolling,设备绑定,**它证明的是"这个物理设备是用户的"** 而不是"这个 token 是 fresh 的"。

**关键 enrollment 流程**:
- `POST /api/auth/trusted_devices` body `{display_name: 'Claude Code on ${hostname()} · ${process.platform}'}`
- 服务端 gate on `account_session.created_at < 10min`(注释:enrollment **必须发生在 /login 后 10 分钟内**)
- token 写入 OS keychain / 等价 secure storage

**clearTrustedDeviceToken on /login**:避免发上一个账号的 token(if user switches accounts during async enrollment window)。

**两阶段 rollout**:
- 阶段 1:CLI 发 `X-Trusted-Device-Token` header,**服务端 no-op**
- 阶段 2:server-side enforcement flag flip
- 这样可以**先观察 CLI 端 token 携带率**,确保 99%+ 携带后再开启 enforcement,避免 enforcement 上线那瞬间踢爆未升级的 client

**storage read memoized**(macOS `security` subprocess ~40ms 一次),但 GrowthBook gate 是 live(无需 restart 即可 flip)。

---

## 8. Feature gating(bridgeEnabled.ts + bridgeConfig.ts + bridgeDebug.ts)

### 8.1 bridgeEnabled.ts 的诊断链

`bridgeEnabled.ts:1-202` 提供:
- `isBridgeEnabled()` — sync,sub+gate 都得过
- `isBridgeEnabledBlocking()` — 慢路径,await 全部 config 加载完
- `getBridgeDisabledReason()` — **诊断链**:
  - `!isClaudeAISubscriber` → "/login required"
  - `!profileScope` → "/login required"(setup-token / CLAUDE_CODE_OAUTH_TOKEN 是 inference-only,bridge 需要 profile scope)
  - `!organizationUuid` → "/login required"
  - `!gate` → "not yet enabled"
- `isEnvLessBridgeEnabled()` — v2 独立 gate
- `isCseShimEnabled()` — defaults true
- `checkBridgeMinVersion()` — semver 比较 tengu_bridge_min_version
- `getCcrAutoConnectDefault()`, `isCcrMirrorEnabled()` — ant-only opt-ins

**positive ternary pattern**(`docs/feature-gating.md` 推崇的写法):
```ts
isBridgeEnabled() ? doBridgeStuff() : doFallback()
```
而不是
```ts
!isBridgeDisabled() ? doBridgeStuff() : doFallback()
```

> 为啥?**负向写法不能完全消除外部 build 的 inline string literals**。bundler 看到 `if (!disabled)` 仍然会保留 disabled 那条分支的代码字面量。positive 写法 + DCE 能彻底剔掉未走的分支(不让"功能名"出现在 ant-only build 的最终 bundle 里)。

**isClaudeAISubscriber 用 try/catch 包**:main.tsx:5698 在 `enableConfigs()` 之前就调用,会抛 "Config accessed before allowed" — 此时认为 not-subscriber,fallback。

### 8.2 bridgeConfig.ts 的两层配置

`bridgeConfig.ts:1-48`:

```ts
getBridgeTokenOverride()      // CLAUDE_CODE_BRIDGE_TOKEN env (ant-only)
getBridgeBaseUrlOverride()    // CLAUDE_CODE_BRIDGE_BASE_URL env (ant-only)
getBridgeAccessToken()        // override → 真实 OAuth store
getBridgeBaseUrl()            // override → 默认 base URL
```

**override 只在 ant-only 路径下生效**(env var 控制)。生产用户只会走 OAuth store。

### 8.3 bridgeDebug.ts:ant-only fault injection

`bridgeDebug.ts:1-135` 实现 `/bridge-kick` 命令,在 dev / 内部 dogfood 时主动模拟 bridge API 失败:

```ts
type BridgeFault = {
  method: 'poll' | 'register' | 'reconnect' | 'heartbeat'
  kind: 'fatal' | 'transient'
  status, errorType, count
}

wrapApiForFaultInjection(api):
  返回 wrapped api,某个 method 被调用时:
  - 查 fault queue
  - kind='fatal' → throw BridgeFatalError(stop)
  - kind='transient' → throw 普通 Error(retry)
  - 每次消费 count--,count=0 移除
```

为什么 fatal vs transient 用**两个不同 Error 类**?bridge 的 catch 块通过 `e.status` 或 instanceof 区分:fatal 直接退出,transient 走 retry path。

**真实失败数据(BQ 2026-03-12 7-day window)**:
- poll 404 not_found_error:**147K sessions/week**(secrets 过期是首要失败)
- ws_closed 1002/1006:**22K/week**
- register transient:residual blips

这些数据决定 bridge 重试策略的 weight。

---

## 9. JWT(jwtUtils.ts)与 debugUtils.ts

### 9.1 jwtUtils.ts:JWT 解析

(读取过的内容,简要):
- 解 base64url payload(JWT 是 `.` 分隔的 header.payload.signature)
- 取 `exp` 字段
- 提供 `isJWTExpired(jwt, bufferSeconds)`、`getJWTRemainingMs(jwt)`
- **本地解,不验签** — 验签由服务端做,客户端只用来决定"该不该 refresh"

### 9.2 debugUtils.ts:redactSecrets

`debugUtils.ts:1-141` 实现 secret 脱敏:

```ts
const SECRET_FIELD_NAMES = [
  'session_ingress_token',
  'environment_secret',
  'access_token',
  'secret',
  'token'
]

redactSecrets(value):
  if string && < 16 chars → '[REDACTED]'
  if string && ≥ 16 chars → first8 + '...' + last4
  if object → 递归(对 SECRET_FIELD_NAMES 命中的 key)
```

**两段式截断**:短的全 redact(全文太短,partial 透出已经够暴露);长的留首尾(便于排查 — 知道是不是同一个 token)。

`debugBody`:统一格式化 axios body / response(2000-char limit)
`debugTruncate`:任意长字符串截断(末尾加 `[+N chars]`)
`describeAxiosError`:**附加 server's response body 的 message** — axios 默认 toString 只包含 status code,常常排查不到根因

---

## 10. remote/(瘦客户端模式)

### 10.1 RemoteSessionManager.ts:远程 session 管理器

`remote/RemoteSessionManager.ts:1-344`:

```
本地 CLI ↔ SessionsWebSocket ↔ /v1/sessions/ws/{id}/subscribe ↔ 云端 CCR 容器
        本地 CLI ↔ HTTP POST /v1/sessions/{id}/events ↔ 云端 CCR
```

WebSocket 收到 SDKMessage / control_request / control_cancel_request / control_response,RemoteSessionManager 分发:
- **SDKMessage** → callbacks.onMessage(给 REPL 渲染)
- **control_request `can_use_tool`** → 存到 pendingPermissionRequests Map + onPermissionRequest 回调
- **control_cancel_request** → 从 Map 删 + onPermissionCancelled
- **control_response** → 仅 debug 日志
- 其它 subtype(如 `interrupt`)→ **发 error response,防止服务端 hang**(line 198-213)

**Permission 流程**:服务端要弹权限时发 `control_request` → 本地通过 `respondToPermissionRequest(requestId, result)` 回 `control_response`,带上 `{behavior, updatedInput | message}`。这个 result 完全等同于本地 permission flow 的 PermissionResult,**就是 M04 的协议照搬到远端**。

**viewerOnly 模式**:`claude assistant` 命令的纯查看者 — Ctrl+C/Escape **不** 发 interrupt;60s 重连 timeout 禁用;session title 不更新。

### 10.2 SessionsWebSocket.ts:WS 客户端

`remote/SessionsWebSocket.ts:1-404`:

**架构**:
- 优先 Bun WebSocket(支持 headers / proxy / tls 选项),fallback 到 `ws` 包
- 静态常量:`RECONNECT_DELAY_MS=2000`、`MAX_RECONNECT_ATTEMPTS=5`、`PING_INTERVAL_MS=30000`

**Close code 处理**(line 247-287)— 教科书级的"分类处理":

```
4001 (session not found) — 转 sessionNotFoundRetries (max 3),
  因为 compact 期间服务端会短暂认为 session stale
4003 (unauthorized) — PERMANENT_CLOSE_CODES,立即放弃
其它 — 普通 reconnect,max 5 次
```

**为什么 4001 单独处理?** 注释直陈:
> The server may briefly consider the session stale while the CLI worker is busy with the compaction API call and not emitting events.

也就是说,客户端在 compact(M06)期间长时间没发事件 → 服务端 watchdog 觉得断了 → 4001。但实际客户端还活着——所以**短暂重试 3 次**而不是立即放弃。

**isSessionsMessage(value)** — **不用 hardcoded type allowlist**:
> A hardcoded allowlist here would silently drop new message types the backend starts sending before the client is updated.

只 check `typeof value.type === 'string'`,把决定权下放给 downstream handlers。**前向兼容性的工程姿势**。

**ping/pong**:每 30s 主动 ping,**容错 ping 错误**(`try { ws.ping?.() } catch {}`)— 因为 close handler 会处理底层错误,ping 失败不直接 raise。

### 10.3 sdkMessageAdapter.ts:SDK → REPL

`remote/sdkMessageAdapter.ts:1-303` 把云端的 `SDKMessage` 转成本地 REPL 的 `Message` 类型:

```
SDKAssistantMessage → AssistantMessage
SDKPartialAssistantMessage → StreamEvent
SDKResultMessage → SystemMessage (仅 error,success ignored — 减噪)
SDKSystemMessage init → SystemMessage "Remote session initialized"
SDKStatusMessage compacting → "Compacting conversation…"
SDKToolProgressMessage → "Tool X running for Ys…"
SDKCompactBoundaryMessage → SystemMessage(带 compactMetadata)

user message:
  - tool_result block(detected by content shape,**不是 parent_tool_use_id**)
    → createUserMessage(content, toolUseResult, uuid, timestamp)
  - 注释:parent_tool_use_id NOT reliable —
    agent-side normalizeMessage() hardcodes to null for top-level tool results
  - 否则 ignored(已在本地 REPL 添加过)
```

**convertToolResults / convertUserTextMessages opts**:
- direct connect 模式 ON `convertToolResults`(tool results from remote server)
- 历史回放模式 ON `convertUserTextMessages`(需要把过去的 user 消息渲染出来)
- live WS 模式两者都 OFF(本地已加)

**unknown type** — 不抛错,只 `logForDebugging`,**向前兼容**(同 10.2)。

### 10.4 remotePermissionBridge.ts:合成对象

`remote/remotePermissionBridge.ts:1-78` 解决一个奇葩问题:本地 permission UI 需要 `AssistantMessage` 才能渲染,但远端的 tool use **没有真实的 AssistantMessage**(它在云端容器里)。

```ts
createSyntheticAssistantMessage(request, requestId):
  造一个 AssistantMessage,id=`remote-${requestId}`,
  content=[{type:'tool_use', id, name, input}],
  usage=全0
```

```ts
createToolStub(toolName):
  造一个最小 Tool 接口,
  isReadOnly=false, needsPermissions=true,
  renderToolUseMessage=展示前 3 个 input field
```

为什么需要 Tool stub? 因为远端可能用 **MCP tools 本地没加载**(MCP server 跑在容器里)— 本地拒绝时不知道这工具长什么样,stub 让 FallbackPermissionRequest 至少能渲染。

---

## 11. server/(自托管模式)

### 11.1 createDirectConnectSession.ts

`server/createDirectConnectSession.ts:1-88`:

```ts
POST {serverUrl}/sessions
body: {cwd, dangerously_skip_permissions?}
header: Authorization: Bearer {authToken}
→ {session_id, ws_url, work_dir?}
```

`DirectConnectError` 是显式的 error 类型,把 connect / HTTP / schema 三种失败统一封装。

### 11.2 directConnectManager.ts:WS 客户端

`server/directConnectManager.ts:1-213`(比 SessionsWebSocket 简化版):

- 单一 WebSocket 连接
- **消息以 newline-delimited JSON 流过**(line 66 — `data.split('\n')`)— 区别于 SessionsWebSocket 的"一个消息一个 WS frame"
- 过滤 `control_response / keep_alive / control_cancel_request / streamlined_text / streamlined_tool_use_summary / system:post_turn_summary` — 这些是 SDK-only 噪音

**sendMessage 格式**(line 130-140):
```ts
{
  type: 'user',
  message: { role: 'user', content },
  parent_tool_use_id: null,
  session_id: ''
}
```
注释:**Must match SDKUserMessage format expected by `--input-format stream-json`** — 因为对端是个被 spawn 的 claude 进程,通过 stdin 接收这个格式。

**sendErrorResponse** — 对未识别 control_request subtype 主动回 error(同 10.1)

**isStdoutMessage** — 只 check `'type' in value && typeof value.type === 'string'`(同 10.2 哲学)。

### 11.3 server/types.ts

`server/types.ts:1-57`:
- `connectResponseSchema` — Zod 校验 POST /sessions response
- `ServerConfig` — port/host/authToken/unix?/idleTimeoutMs?/maxSessions?/workspace?
- `SessionState` = `'starting' | 'running' | 'detached' | 'stopping' | 'stopped'`
- `SessionInfo` — id/status/createdAt/workDir/process/sessionKey?
- `SessionIndexEntry` — sessionId/transcriptSessionId/cwd/permissionMode?/createdAt/lastActiveAt
  - 持久化到 `~/.claude/server-sessions.json`,跨 server 重启可 resume

---

## 12. 跨模块工程精髓(对自研 Agent 的可复用部分)

下面这些是读完 bridge/remote/server 三个目录后最值得直接抄进自研 Agent 的设计。

### 12.1 进程间通信的"双 token 分层"

bridge 把"长期身份"和"短期使用"分开:
- **OAuth token**:用户 claude.ai 账号,长期(refresh 7 天)
- **session_ingress_token (JWT)**:某个 session 专用,短期(分钟级),只能写到这个 session
- **environment_secret**:某个环境专用,中期(创建时给,不 rotate),只能 poll 这个环境
- **trusted_device_token**:设备绑定,90 天 rolling,只用于"我是这个设备"

**关键见解**:每一层有自己的 scope 和过期策略。leak 任何一个**不能升级权限**。

**对自研 Agent 的启发**:不要用一个万能 token。即使是单租户内部 Agent,也至少分:
- 长期身份 token(用户登录)
- 短期 session token(由长期 token 换发,绑定具体 session)
- 工具特定 token(由 session token 换发,绑定具体外部服务)

### 12.2 子进程通信的"协议消息式 stdin"

`SessionHandle.updateAccessToken` 通过 stdin 发 `{type:'update_environment_variables', variables:{...}}` 让 child 无重启换 token。这比"用 SIGUSR1 触发 reload"更可靠:

- 信号是异步的,child 可能在 critical section 不响应
- stdin 消息是顺序的,child 在自己的 event loop 里处理
- 消息可以带 payload,信号不能
- 消息可以扩展(将来加 `update_config / refresh_mcp / dump_state` 都用一个通道)

**对自研 Agent 的启发**:子进程通信不要只走信号 + 共享文件。stdin 一个 JSON-RPC-like 通道几乎能搞定全部 control plane 需求。

### 12.3 配置校验的"地板拒绝"

`envLessBridgeConfig.ts` + `pollConfig.ts` 的 floor-reject-entirely 哲学:

- 任何字段违反 floor → **整份 config 退回 default**
- 不允许 partial trust(部分接受可能造出耦合违反的状态)
- floor 不是 min,而是"业务安全的最小值"(比如 polling 不能比 100ms 更快)

**对自研 Agent 的启发**:配置层 schema 要思考"字段间的耦合不等式" — 用 object-level `.refine()` 把这些写出来。

### 12.4 服务端反向控制流(control_request / control_response)

bridge / remote / direct connect **三种 transport** 都用同样的协议:服务端发 `control_request`,客户端用同 `request_id` 回 `control_response`。`subtype` 决定具体语义(`can_use_tool / interrupt / ...`)。

**unrecognized subtype 立即回 error response 而不是 ignore** — 防止服务端永远 hang。

**对自研 Agent 的启发**:任何"对端会问我问题"的协议,无论 WebSocket / SSE / IPC,都建立一个 request_id 关联的请求-响应通道。**对不认识的请求要主动回 error,绝不静默丢弃**。

### 12.5 跨进程协调:dead-token backoff

`bridgeOauthDeadExpiresAt` + `bridgeOauthDeadFailCount≥3`:多个进程通过 **shared config** 协调"这个 token 是死的,大家都别试了"。

- 单一进程 backoff 解决不了 N 实例并发 N×401
- 协调存到 config 文件(其它进程启动时 check)
- 设过期时间,避免永远卡死

**对自研 Agent 的启发**:任何"多实例共享身份"场景,把 failure state 写到共享存储 + TTL。一个失败 = 全部冷却。

### 12.6 sequence-based 断点续传

`getLastSequenceNum()` 在 close 之前调 → 传给新 transport 的 `initialSequenceNum`。

- 服务端按 sequence 推送
- 客户端重连时告诉服务端"我收到了 N,从 N+1 推"
- 服务端用 ring buffer 留最近 K 条
- 客户端在 ring 里的能恢复,过期的就丢

**对自研 Agent 的启发**:任何 SSE/WS 流式消费,服务端必须提供 sequence + ring buffer + resume-from-N。Last-Event-Id 标准头就是干这个的。

### 12.7 inbound 路径的"字段名修复"

`normalizeImageBlocks` 修 `mediaType` → `media_type`,**zero-alloc fast path**(无问题时返回原数组引用)。

**关键洞察**:**API 上的字段名错误会污染整个 session**——错误数据 → 服务端拒收 → 客户端重发 → 又拒收 → 死循环。修复必须在 **inbound 边界**,而不是等到上传时。

**对自研 Agent 的启发**:所有外部输入(用户 / IDE / 网页)进入 Agent 内部状态前,必须经过一个 normalizer。normalizer 做两件事:1) 字段名/格式校正;2) 零拷贝 fast path(99% 数据无问题时不分配内存)。

### 12.8 文件名 sanitize 的"uuid prefix collision"

inbound 附件用 `<first8-of-uuid>-<sanitized-name>` 命名。

- 单纯 sanitize → 不同 UUID 同名 → 后写覆盖前写
- 完全用 UUID → 用户看到的不是原文件名
- prefix 折衷:有可识别原名 + UUID 防碰撞

**对自研 Agent 的启发**:任何"用户提供文件名 + 持久化"场景,都用这个 pattern。

### 12.9 quoted @"path" 处理空格

bridge 把 inbound 附件路径以 `@"path with spaces"` 形式 prepend 到用户消息——extractAtMentionedFiles 必须识别 quoted form。

**对自研 Agent 的启发**:任何"@-mention / #-tag / 任何 sigil"的输入解析,都支持 quoted form。最稳妥的方式是 lexer 不做 sigil 内部 split,把 sigil 之后到下个 whitespace 当一个 atom。

### 12.10 close code 的分层语义

WebSocket close code 不是单一"断开"信号,而是分层:
- **4001 transient**(compact 期间的临时 stale)→ 重试 3 次
- **4003 permanent**(unauthorized)→ 立即放弃
- **4090 epoch superseded**(被新实例替换)→ 不重试,通知上层
- **4091/4092**(init failure / SSE budget)→ 不重试

**对自研 Agent 的启发**:自定义 close code(4000-4999)是 WebSocket 标准留给应用层的 — 别把 transient/permanent/policy 混成一个。客户端的重连决策应该是 close code 的纯函数。

### 12.11 "向前兼容的解析器"

`isSessionsMessage` / `isStdoutMessage` 都**只 check `type` 是字符串**,不 hardcode allowlist。

理由:服务端先于客户端升级时,会发新的 message type,**hardcode allowlist 会让客户端silent drop**。改成"接受任何带 type 字段的 object,downstream 处理 unknown",失败时 `logForDebugging`。

**对自研 Agent 的启发**:协议解析不要写 enum allowlist。downstream handlers 自己负责"未知类型如何处置"。

### 12.12 service 端 fault injection

`bridgeDebug.ts` 的 `wrapApiForFaultInjection` 在客户端代码里**主动注入**特定错误,让 QA 不用搞坏服务端就能测客户端的容错。

- BridgeFault 队列,按方法和次数消费
- `kind: 'fatal' | 'transient'` 用不同 Error 类区分(catch 块通过 instanceof 决策)

**对自研 Agent 的启发**:任何"API 客户端"应该有一个 fault injection 包装,默认 no-op,debug 命令可注入。**这比起重启服务搞坏更轻量**。

### 12.13 archive 不抛错的边界设计

`archiveBridgeSession` **故意不 try/catch**——上层根据自己场景决定:
- teardown 路径用 `.catch(noop)`(不影响主流程)
- explicit /archive 命令用 try/catch + 用户提示

**对自研 Agent 的启发**:库函数不要万能 try/catch。让 error 自然往上走,在**最知情**的层处理。一个 swallow 万能 try/catch 是 anti-pattern。

### 12.14 dependency injection 防 SDK 膨胀

`setCseShimGate(gate)` 让 SDK 不需要拉入 GrowthBook 依赖也能用 ID 转换。

**对自研 Agent 的启发**:任何**双用户场景**(CLI + SDK,内部 + 外部)的工具函数,都用 DI 而不是直接 import 重 dep。SDK 用户用 default 或自己的实现。

### 12.15 transcript / debug log 分离

每个 child session 同时写:
- `bridge-session-{safeId}.log` — 自由文本 debug
- `bridge-transcript-{safeId}.jsonl` — 结构化事件 transcript

debug log 给人看,transcript 给工具/replay 用。**分开比合并好**——transcript 可以喂 replay 工具调试 race;debug log 可以 grep。

**对自研 Agent 的启发**:观测性输出**强结构化** + **自由文本**两条流分开存,不要混到一份。

### 12.16 status line 的视觉行计数

`countVisualLines` 处理 wrap (终端宽度 / stringWidth)、`\n` 末尾不计、单字符 width(emoji / CJK / ANSI)— 才能正确 cursor up 清屏。

**对自研 Agent 的启发**:任何 TUI 状态行更新,必须 grapheme + wide-char 感知。`text.split('\n').length` 是个**致命**的偷懒。

### 12.17 OSC-8 hyperlink 的"零宽链接"

`wrapWithOsc8Link` 把 url 嵌进 OSC-8 escape — **视觉上看不到 url,但鼠标点击可跳**。比起明文 URL 占行,既不浪费空间又可点击。

**对自研 Agent 的启发**:终端 UI 里所有"可以跳转的东西"(GitHub PR、Linear ticket、本地文件)都用 OSC-8。fallback 不支持的终端自动剥掉 escape 显示明文。

### 12.18 teardown 顺序的"严格依赖"

env-less bridge 的 teardown:
```
cancelAll → clearTimeout → flushGate.drop → reportState('idle')
  → write result message → archiveSession(401 retry) → transport.close
```

每步前后顺序不能换 — `reportState('idle')` 必须先于 write result(否则服务端把 result 看成新 turn);archive 必须先于 close(否则没传输通道)。

**对自研 Agent 的启发**:teardown 路径要画 dependency DAG,**显式记录顺序约束的 why**。代码 + 注释 + 单元测试三层固化(单测可以是"按错顺序应该报错")。

### 12.19 reclaim_older_than_ms 模式

`pollForWork` 主动告诉服务端"5s 没续约的 work 我可以接"。

**关键见解**:work queue 的"防失主"机制——领走者死了,留下的 work 永远卡死 → 必须有反向"reclaim 时间窗"。

**对自研 Agent 的启发**:任何"先抢后干"的工作池,worker 必须周期性续约 + queue 必须支持"X 没续约可以 reclaim"。Sidekiq / Resque / Celery 都有这个机制,但很多自研版本忘了——结果一台 worker 崩了,它正在干的 100 个 job 永远不被重做。

### 12.20 client-generated environment_id 幂等键

daemon 第一次启动生成 UUID 作为 `environment_id`,**重启时复用同一个**。

服务端看到已存在的 environment_id → 不创建新的,**reconnect to existing**。

**对自研 Agent 的启发**:任何"创建资源"的 API 都接受 client-side 幂等键。client 重启不会导致资源泄露。

### 12.21 双 ingress fallback

`sendPermissionResponseEvent`:**先 session ingress 直连**(快,bypass 环境 API),失败 fallback 环境 API。

**对自研 Agent 的启发**:多通路的 API 客户端,优先 "fast path" + fallback "slow but reliable path"。fast path 失败不上报错误,fallback 失败才 raise。

### 12.22 不同 anthropic-beta header 用于不同生命周期阶段

- `environments-2025-11-01` — 环境 API
- `ccr-byoc-2025-07-29` — session API
- 同一个客户端**同时**在用两个 beta

**关键见解**:beta header 是 API 版本的 negotiation,**不需要全模块统一**。不同子 API 独立 versioning。

**对自研 Agent 的启发**:版本管理颗粒度按 API surface,不按客户端实例。客户端记一组 active betas,每个请求按 endpoint 选择正确的 set。

### 12.23 两阶段 rollout(client → server enforcement)

trusted device:
- 阶段 1:client 主动发 `X-Trusted-Device-Token`,server no-op
- 阶段 2:server enforcement 开启

**关键见解**:**不能"server flip 当天 client 才开始发"** — 那一瞬间 server 拒收所有未升级 client。**必须先观察 client 携带率达到 99%+,再 flip server**。

**对自研 Agent 的启发**:任何"client 行为变化 + server 验证"的功能,都按"先 client 静默携带 → 观察普及率 → 再 server enforce"两阶段上。

### 12.24 GrowthBook gate 的 live vs memoize 权衡

trustedDevice.ts:
- **storage read memoized**(macOS keychain ~40ms,每次 fork 很贵)
- **GrowthBook gate live**(不 cache,允许 runtime flip)

**对自研 Agent 的启发**:任何"feature flag + 重 IO"组合,**flag live**(以便快速 kill switch),**IO memoize**(避免性能塌方)。

### 12.25 secret redaction 的两段策略

`redactSecrets`:
- < 16 chars → `[REDACTED]`(全 redact)
- ≥ 16 chars → first8 + `...` + last4

**关键见解**:debug 日志里**完全脱敏会让排查无门**(同一个 token 反复出现还是不同 token?)— 留首尾既能区分又安全。

**对自研 Agent 的启发**:secret redaction 不要一刀切。短的全 redact,长的留指纹便于追踪。

### 12.26 protojson int64-as-string 反序列化

`worker_epoch` 服务端用 protobuf int64,JSON 表示是 string(避免 JS Number 精度问题)。客户端必须:
- 接受 number 或 string
- 转 number 后用 `Number.isFinite + Number.isSafeInteger` 双校验

**对自研 Agent 的启发**:任何 grpc/protobuf 后端 + JSON 客户端,都要考虑 int64 string 化。**不要直接 `parseInt(x)`**,会丢精度。

### 12.27 worker_jwt local-parse,server verify

JWT 在客户端解 base64url payload 取 `exp`,但**不验签**——验签由服务端做。

**对自研 Agent 的启发**:JWT 的"剩余时间"判断**必须本地解,不要每次 API call**。但**业务决策不能用本地解的 claim**(那是 unverified)。本地解只用于 lifecycle(是否该 refresh)。

### 12.28 archive 状态 5 桶

`ArchiveTelemetryStatus = 'ok' | 'skipped_no_token' | 'network_error' | 'server_4xx' | 'server_5xx'`

不是"ok / failed"二分,而是按可操作维度分:
- `skipped_no_token` → 用户从未登录,正常
- `network_error` → 用户网络问题,不算 bug
- `server_4xx` → client bug
- `server_5xx` → server bug

**对自研 Agent 的启发**:telemetry 桶按 actionable 分,而不是按 success/failure。"failed" 没有指导意义。

### 12.29 cache miss 防御的 sequence preservation

env-less bridge 401 recovery:
1. `getLastSequenceNum()` **before** close
2. `transport.close()`
3. `createV2ReplTransport(initialSequenceNum: lastSeq)`

如果反着写(先 close 再取 seq),seq 已经丢了——新 transport 从 0 开始,服务端 ring buffer 已经过 5000,**所有积压消息无法 resume**。

**对自研 Agent 的启发**:重建任何 stateful client 之前,**先采集需要继承的所有状态**(seq、cursor、subscription list),再销毁旧的。"先关后建"是常见 bug source。

### 12.30 connect_timeout watchdog

`onConnectTimeout`:`cfg.connect_timeout_ms` (15s) 后 onConnect/onClose 都没触发 → 上报 telemetry。

**关键见解**:**真正的灾难失败是"什么都不发生"**——既没连上也没失败,任何 retry/recovery 都不触发。watchdog 是给这种 silent failure 留可见性。

**对自研 Agent 的启发**:任何"会触发回调"的 API 都加 timeout 监视器。回调不来比来错误更可怕。

---

## 13. 待确认问题

1. **`coordinator/` 与 bridge 的 worker_type 关系**:bridge 把 `claude_code_assistant` 当作可能值,但具体在 coordinator 哪里设置待确认
2. **`replBridge.ts` 中部 ~1500 行未完整对照**(本次主要根据 prior session 总结 + 头尾)— **关键状态机部分应再次精读 5-10 个 onUserMessage / onAssistantMessage / onResult 分支**
3. **server/types.ts** 中的 SessionIndex 持久化结构在 SessionIndexManager(未在本仓库)— 完整恢复逻辑无法验证
4. **bridge_pointer 的具体冲突解决细节**(`bridgePointer.ts` 仅快速扫读)— "新实例如何抢占已存在 pointer" 的精确策略待精读

---

## 14. 一句话总结

bridge 模块是一套**为"Claude Code 作为子进程被外部驱动"打造的全栈通信层**,横跨 daemon ↔ work queue ↔ child session、CLI 端 REPL ↔ 云端 session、CLI 客户端 ↔ 远程容器三种方向。每一种方向都是**重连 + 鉴权 + sequence resume + permission 桥接 + 状态机**的组合,**约 60% 代码都是从生产事故反推的防御**(单 IP 401 风暴、compact 期间 4001、cache prefix 失效、phantom prompts、…)。可复用度极高 — 任何"我的 Agent 想被外部驱动"的项目都能直接抄 90% 的 pattern。
