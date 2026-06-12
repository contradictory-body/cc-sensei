# M09 · LSP 集成

> 范围: `src/services/lsp/*` (7 文件) + `src/tools/LSPTool/*` (6 文件) + `src/components/LspRecommendation/*` (1 文件) + `src/hooks/useLspPluginRecommendation.tsx` + `src/hooks/notifs/useLspInitializationNotification.tsx`
> 共 16 文件 / ~4419 行
> 关联模块: M03 (plugins, LSP server config 来源) · M11 (Ink, 推荐菜单和通知) · M14 (附件系统, 诊断作为 file attachment) · M16 (graceful shutdown) · M19 (appState.plugins.errors, fileHistory.trackedFiles)

---

## 一、模块定位

LSP (Language Server Protocol) 让 Claude Code 拥有 IDE 级别的代码语义能力:
- **主动查询**: agent 可以 `goToDefinition` / `findReferences` / `hover` / `documentSymbol` / `workspaceSymbol` / `goToImplementation` / `prepareCallHierarchy` / `incomingCalls` / `outgoingCalls` 共 9 个操作.
- **被动反馈**: LSP server 通过 `textDocument/publishDiagnostics` 推 type error / lint 警告, Claude Code 在下一轮自动注入到 message 附件, 让 agent 看到自己改坏的代码.

LSP 不是 Claude Code 自己启的, 而是**只能通过 plugin 注册**(`config.ts:11` 注释). 这把 LSP 跟用户/项目设置解耦, 让 plugin 作者自由声明 server.

---

## 二、文件清单

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/services/lsp/config.ts` | 79 | 从 plugin 拉所有 LSP server 配置, 容错合并 |
| `src/services/lsp/manager.ts` | 289 | 单例生命周期: 4 态 init / reinit / waitFor / shutdown |
| `src/services/lsp/LSPClient.ts` | 447 | vscode-jsonrpc 包装, 启停 child process |
| `src/services/lsp/LSPServerManager.ts` | 420 | 多 server 路由 + 文件 didOpen 状态机 |
| `src/services/lsp/LSPServerInstance.ts` | 511 | 单 server 状态机 + crash recovery + ContentModified retry |
| `src/services/lsp/LSPDiagnosticRegistry.ts` | 386 | pending diagnostics 容器 + LRU 跨轮 dedup |
| `src/services/lsp/passiveFeedback.ts` | 328 | 注册 `publishDiagnostics` handler, 转发到 registry |
| `src/tools/LSPTool/LSPTool.ts` | 860 | 工具入口, 9 操作的 dispatch + UNC/巨文件 guard |
| `src/tools/LSPTool/schemas.ts` | 215 | discriminated union 输入 schema |
| `src/tools/LSPTool/formatters.ts` | 592 | 9 操作的输出 formatter + URI 归一化 |
| `src/tools/LSPTool/prompt.ts` | 22 | tool 描述文本, 给 agent 看 |
| `src/tools/LSPTool/UI.tsx` | 228 | REPL 内 tool use/result 渲染 + 符号上下文 |
| `src/tools/LSPTool/symbolContext.ts` | 90 | sync 读 64KB, 用正则提取光标处 symbol |
| `src/components/LspRecommendation/LspRecommendationMenu.tsx` | 87 | 推荐菜单 + 30s 自动消失 |
| `src/hooks/useLspPluginRecommendation.tsx` | 193 | 推荐流程, timeout vs dismiss 阈值 |
| `src/hooks/notifs/useLspInitializationNotification.tsx` | 142 | 5s 轮询 LSP 状态, 推通知 |

---

## 三、分层架构

```
┌─────────────────────────────────────────────────────────┐
│                  LSPTool (tools/LSPTool/)               │  ← agent 调用入口
│   9 ops → method/params → LSPServerManager.sendRequest  │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│           LSPServerManager (services/lsp/)              │  ← 单例, 多 server 路由
│   extensionMap / openedFiles / sendRequest dispatch     │
└──────┬─────────────────┬────────────────────────────────┘
       │                 │
       │                 ▼
       │     ┌────────────────────────┐
       │     │   LSPServerInstance    │  ← 每个 server 一个, 状态机
       │     │   start/stop/restart   │
       │     │   crash recovery       │
       │     │   ContentModified retry│
       │     └───────────┬────────────┘
       │                 │
       │     ┌───────────▼────────────┐
       │     │      LSPClient         │  ← vscode-jsonrpc 包装
       │     │  spawn / connection /  │
       │     │  pendingHandlers queue │
       │     └────────────────────────┘
       │
       │     ┌────────────────────────┐
       └────▶│LSPDiagnosticRegistry   │  ← pending diagnostics + LRU dedup
             │ (passiveFeedback)      │
             └────────────────────────┘
```

3 层职责完全不重叠. 加新功能(例如 `documentColor` 操作)只需要在 LSPTool 加一个 schema + getMethodAndParams 分支, 不动下层.

---

## 四、`config.ts` · plugin-only LSP 发现

### 4.1 `getAllLspServers()`

```ts
// 文件: src/services/lsp/config.ts
export async function getAllLspServers(): Promise<LspServerCollection> {
  const allServers: Record<string, ScopedLspServerConfig> = {}
  const plugins = await getAllRegisteredPlugins()
  const results = await Promise.all(
    plugins.map(async (plugin) => {
      try {
        return await getPluginLspServers(plugin)  // ← 来自 utils/plugins/lspPluginIntegration (待确认)
      } catch (error) {
        logError(`Failed to load LSP servers from plugin ${plugin.id}:`, error)
        return {}
      }
    })
  )
  for (const scopedServers of results) {
    Object.assign(allServers, scopedServers)  // ← 后来的赢, 后注册的 plugin 覆盖前面的
  }
  return { servers: allServers }
}
```

设计精髓:
- **`Promise.all` 并发**, plugin 互不阻塞.
- **try/catch per plugin**, 一个 plugin 配置坏不影响其他 plugin.
- **`Object.assign` 合并**, 后注册者覆盖前者; 用 scopedName 做 key, 形式如 `${pluginId}:${serverName}`, 防冲突.

> 注释 (`config.ts:11`): "LSP servers ONLY via plugins (not user/project settings)". 这是产品决策, 把 LSP 推给 plugin 生态, 避免 user/project 层管理复杂.

---

## 五、`manager.ts` · 单例 + 4 态生命周期

### 5.1 模块级状态

```ts
// 文件: src/services/lsp/manager.ts
let lspManagerInstance: LSPServerManager | undefined
let initializationState: 'not-started' | 'pending' | 'success' | 'failed' = 'not-started'
let initializationError: Error | undefined
let initializationGeneration = 0                // ← 关键: invalidate stale init promise
let initializationPromise: Promise<void> | undefined
```

为啥不是 class? — 跟 M18 sink/uploader 一致, **factory + closure** 比 class 友好 DCE, 也避免 `this` 混乱.

### 5.2 `initializeLspServerManager()` 流程

```
                         ┌─ isBareMode() → return early ─┐ (scripted -p 模式不需要 LSP)
                         │
initializeLspServerManager
                         │
                         ├─ if instance exists → return        (幂等)
                         │
                         ├─ initializationState = 'pending'
                         ├─ initializationGeneration++         (每次 init 都给一个 gen 号)
                         │
                         ├─ initializationPromise = (async () => {
                         │     const myGen = initializationGeneration
                         │     try {
                         │       const config = await getAllLspServers()
                         │       const mgr = createLSPServerManager(config)
                         │       await mgr.initialize()
                         │       if (myGen !== initializationGeneration) {
                         │         await mgr.shutdown()         // ← 我已被新 init 取代
                         │         return
                         │       }
                         │       lspManagerInstance = mgr
                         │       registerLSPNotificationHandlers(mgr)   // ← 拼接到诊断 registry
                         │       initializationState = 'success'
                         │     } catch (e) {
                         │       initializationState = 'failed'
                         │       initializationError = e
                         │     }
                         │ })()
                         │
                         └─ return initializationPromise
```

**generation 计数器** 是这套设计的精髓: `reinitializeLspServerManager()` 来的时候直接 `initializationGeneration++`, 旧的 init promise 在落地时发现 `myGen !== current`, 自己把刚启的 server `shutdown()` 掉退场. 不需要 cancelToken.

### 5.3 `reinitializeLspServerManager()` · #15521 fix

```ts
// 文件: src/services/lsp/manager.ts
export async function reinitializeLspServerManager(): Promise<void> {
  if (lspManagerInstance) {
    void lspManagerInstance.shutdown()  // ← fire-and-forget, 不让 shutdown 阻塞
    lspManagerInstance = undefined
  }
  initializationState = 'not-started'
  initializationError = undefined
  initializationPromise = undefined
  await initializeLspServerManager()
}
```

issue #15521 场景: 启动时 plugin list memoize 太早, 等 marketplace 拉完才有真实 plugin. 这个函数让 plugin 系统 reconcile 完后**重启 LSP**.

### 5.4 `waitForInitialization()` · caller-side gate

```ts
export async function waitForInitialization(): Promise<void> {
  if (initializationState === 'pending' && initializationPromise) {
    await initializationPromise
  }
}
```

LSPTool 的 `shouldDefer: true` + `call()` 头部:
```ts
const status = getInitializationStatus()
if (status === 'pending') await waitForInitialization()
```
这样 init 没完就调 LSPTool 不会丢请求, 而是等.

### 5.5 `isLspConnected()` → `LSPTool.isEnabled()`

```ts
export function isLspConnected(): boolean {
  if (!lspManagerInstance) return false
  for (const server of lspManagerInstance.servers.values()) {
    if (server.getState() !== 'error') return true
  }
  return false
}
```

只要有 **1 个 server 不是 error** 就 enable LSPTool. 工具显示与否由这函数决定.

### 5.6 `shutdownLspServerManager()`

```ts
export async function shutdownLspServerManager(): Promise<void> {
  if (!lspManagerInstance) return
  try {
    await lspManagerInstance.shutdown()
  } finally {
    lspManagerInstance = undefined
    initializationState = 'not-started'
    initializationError = undefined
    initializationPromise = undefined
  }
}
```

**`finally` 块清状态**, 即使 shutdown throw 也保证下次 init 是干净的. M16 graceful shutdown 调这函数.

---

## 六、`LSPClient.ts` · vscode-jsonrpc 包装

### 6.1 `createLSPClient(serverName, onCrash?)` factory

闭包变量:
```ts
let process: ChildProcess | undefined
let connection: MessageConnection | undefined
let startFailed = false
let startError: Error | undefined
let isStopping = false
const pendingHandlers: PendingHandler[] = []          // ← onNotification 缓存
const pendingRequestHandlers: PendingRequestHandler[] = []  // ← onRequest 缓存
```

### 6.2 `start()` 顺序

```
1. spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
2. await Promise.race([
     once(process, 'spawn'),       // 成功
     once(process, 'error'),       // ENOENT 等
   ])                              // ← 关键: 必须先确认 spawn 成功再访问 stdin/stdout
3. process.stderr.on('data', d => logServerStderr(serverName, d))
4. process.on('error', e => {  if (!isStopping) onCrash?.(e) })
5. process.on('exit', (code, sig) => { if (!isStopping) onCrash?.(...) })
6. process.stdin.on('error', e => { if (!isStopping) onCrash?.(e) })  // ← 防 stdin write 后 unhandled rejection
7. const messageReader = new StreamMessageReader(process.stdout)
8. const messageWriter = new StreamMessageWriter(process.stdin)
9. connection = createMessageConnection(messageReader, messageWriter, logger)
10. connection.onError(...)  → 在 listen 之前注册
11. connection.onClose(...)  → 在 listen 之前注册
12. connection.listen()
13. connection.trace(Trace.Verbose, ...).catch(...)  // ← 包 catch 防 unhandled
14. for (const ph of pendingHandlers) connection.onNotification(ph.method, ph.handler)
15. for (const prh of pendingRequestHandlers) connection.onRequest(prh.method, prh.handler)
```

**第 2 步 spawn-then-stream** 是关键. 直接拿 `process.stdin/stdout` 不等 spawn, 如果是 ENOENT (命令不存在), `stream.write` 立刻 throw `EPIPE` 包装成 unhandled rejection, 进程崩.

**第 10-11 步 onError/onClose 必须在 listen 之前**. listen 后第一个消息可能就是 close, 来不及绑 handler 就丢了.

**`isStopping` flag** (`LSPClient.ts:` 大量使用): 防 `stop()` 主动 kill 时 stderr/error/exit 触发 `onCrash` 引起 spurious 日志.

### 6.3 `pendingHandlers` 队列模式

```ts
function onNotification(method: string, handler: (params: any) => void): void {
  if (connection) {
    connection.onNotification(method, handler)
  } else {
    pendingHandlers.push({ method, handler })  // ← lazy: 在 start() 后 flush
  }
}
```

`passiveFeedback.registerLSPNotificationHandlers()` 在 server 启动**之前**就可能注册 handler. 这套队列让代码不用考虑 "我何时调 onNotification", 安全延后.

### 6.4 `stop()` 总是清理

```ts
async function stop(): Promise<void> {
  isStopping = true
  try {
    if (connection) {
      try { await connection.sendRequest('shutdown') } catch {}  // ← LSP 优雅
      try { connection.sendNotification('exit') } catch {}
    }
  } finally {
    if (connection) { try { connection.dispose() } catch {} ; connection = undefined }
    if (process) {
      process.removeAllListeners()
      try { process.kill() } catch {}
      process = undefined
    }
    // 保留 startFailed / startError 供下次诊断
    isStopping = false  // ← 允许 restart
  }
}
```

设计要点:
- `connection.dispose()` 释放 reader/writer.
- `process.removeAllListeners()` 防内存泄漏.
- 保留 `startFailed/startError` 让外层知道为什么挂了.
- `isStopping = false` 重置, 支持 `restart()`.

---

## 七、`LSPServerInstance.ts` · 单 server 状态机

### 7.1 状态

```ts
type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
```

```
stopped ──start()──▶ starting ──init OK──▶ running
                         │                    │
                         │                    ├──crash────────▶ error ──restart()──▶ starting
                         │                    │
                         │                    └──stop()──▶ stopping ──▶ stopped
                         │
                         └──init fail──▶ error
```

### 7.2 `crashRecoveryCount` vs `restartCount` 双计数器

```ts
let crashRecoveryCount = 0   // 异常崩重启次数, start() 检查 cap
let restartCount = 0          // 用户主动 restart() 次数
const maxRestarts = config.maxRestarts ?? 3
```

为啥分开? — `restart()` 是 user/tool 触发, 不应被自动重启 cap 卡死. 例如用户改了 plugin 配置, restart 是预期; 但 server 半小时崩 100 次, 必须停.

### 7.3 lazy `require('./LSPClient.js')`

```ts
// 文件: src/services/lsp/LSPServerInstance.ts
async function start(): Promise<void> {
  ...
  const { createLSPClient } = require('./LSPClient.js')  // ← 不是 import!
  ...
}
```

vscode-jsonrpc 自带 ~129KB code. 如果没有 plugin 声明 LSP server, 整个 `LSPClient.js` 永不加载, **启动加快 ~50ms**. 类似 M18 的 lazy import.

### 7.4 `start()` 完整流程

```ts
// 状态切到 starting
state = 'starting'

// 校验 config (这些字段未实现, 写了会 throw)
if (config.restartOnCrash != null) throw '...not yet implemented'
if (config.shutdownTimeout != null) throw '...not yet implemented'

// crash recovery cap
if (crashRecoveryCount > maxRestarts) {
  state = 'error'
  throw new Error(`Server ${name} exceeded max restarts (${maxRestarts})`)
}

// 创建 client (crash 回调)
client = createLSPClient(name, (error) => {
  state = 'error'
  lastError = error
  crashRecoveryCount++
})

// 启动 child process
await client.start({ command, args, cwd })

// LSP initialize 请求
const initParams: InitializeParams = {
  processId: process.pid,
  clientInfo: { name: 'claude-code', version: VERSION },
  capabilities: {
    textDocument: {
      synchronization: { didSave: true },
      publishDiagnostics: {},
    },
    general: { positionEncodings: ['utf-16'] },  // ← 显式声明
    workspace: {
      configuration: false,       // ← 我们不实现, 但仍处理 server 的 workspace/configuration 请求 (返回 null)
      workspaceFolders: false,    // ← 同样不实现
    },
  },
  workspaceFolders: [{ uri: pathToFileURL(cwd).toString(), name: path.basename(cwd) }],
  rootPath: cwd,                  // ← deprecated 但仍需要 (typescript-language-server)
  rootUri: pathToFileURL(cwd).toString(),  // ← 同上
}

// startupTimeout 包装
const initPromise = client.sendRequest('initialize', initParams)
const result = config.startupTimeout
  ? await withTimeout(initPromise, config.startupTimeout, async () => {
      await client.stop()
      initPromise?.catch(() => {})  // ← swallow 抛弃的 rejection
    })
  : await initPromise

// initialized 通知
client.sendNotification('initialized', {})

state = 'running'
restartCount = 0  // 成功了, 重置
```

**`general.positionEncodings: ['utf-16']`**: LSP 3.17 引入 utf-8 / utf-16 / utf-32 三种编码声明. 我们只支持 utf-16(JS 字符串原生), 显式声明避免 server 用 utf-8 算位置算错.

**`workspaceFolders` + `rootPath/rootUri`** 全发: rootPath/rootUri 是 LSP 3.6 之前的 deprecated 字段, 但 typescript-language-server 的某些路径仍依赖 rootUri. 双发兼容.

### 7.5 `sendRequest()` · ContentModified retry

```ts
const LSP_ERROR_CONTENT_MODIFIED = -32801
const RETRY_BASE_DELAY_MS = 500
const MAX_RETRIES = 3

async function sendRequest<R>(method: string, params?: any): Promise<R> {
  if (state !== 'running') throw ...
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await client.sendRequest(method, params)
    } catch (error) {
      const code = (error as { code?: number }).code  // ← duck typing
      if (code === LSP_ERROR_CONTENT_MODIFIED && attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt))  // ← exponential
        continue
      }
      throw error
    }
  }
}
```

`ContentModified` 是 rust-analyzer 索引建立中常见的瞬时错误. 第 1 次 500ms, 第 2 次 1000ms, 第 3 次 2000ms. 总等 3.5s, 之后才报错.

**duck typing `(error as { code?: number }).code`**: 项目里有两个 vscode-jsonrpc 版本 (8.2.0 和 8.2.1) 共存(NPM 依赖间接重复), `error instanceof ResponseError` 时常 false. 直接读 code 最稳.

### 7.6 `withTimeout` helper

```ts
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } catch (e) {
    await onTimeout?.()
    throw e
  } finally {
    if (timer) clearTimeout(timer)  // ← 关键: 即使 success 也清, 防孤儿 timer
  }
}
```

**`.finally(clearTimeout)`** 防孤儿 timer 把 node event loop 锁住 (process 不退出).

---

## 八、`LSPServerManager.ts` · 多 server 路由

### 8.1 状态

```ts
const servers = new Map<string, LSPServerInstance>()
const extensionMap = new Map<string, string[]>()   // '.ts' → ['typescript-lsp', 'biome-lsp']
const openedFiles = new Map<string, string>()       // URI → server name (谁开了它)
```

### 8.2 `initialize()` 构建 extensionMap

```ts
for (const [scopedName, serverConfig] of Object.entries(collection.servers)) {
  if (!serverConfig.command) {
    logError(`LSP server ${scopedName} has no command`)
    continue
  }
  if (!serverConfig.extensionToLanguage) {
    logError(`LSP server ${scopedName} has no extensionToLanguage`)
    continue
  }
  try {
    const instance = createLSPServerInstance(scopedName, serverConfig)
    servers.set(scopedName, instance)
    for (const ext of Object.keys(serverConfig.extensionToLanguage)) {
      const arr = extensionMap.get(ext) ?? []
      arr.push(scopedName)
      extensionMap.set(ext, arr)
    }
  } catch (e) {
    logError(`Failed to create LSP server ${scopedName}:`, e)
  }
}
```

**per-server try/catch**: 一个 plugin 写错配置不影响其他.

**注册 `workspace/configuration` handler** (每个 server 创建后):
```ts
instance.onRequest('workspace/configuration', (params) => {
  // TypeScript LSP 即使收到 configuration: false 也会发这请求
  return params.items.map(() => null)  // ← null 表示 "no config", 协议合规
})
```

### 8.3 `getServerForFile(filePath)`

```ts
function getServerForFile(filePath: string): LSPServerInstance | undefined {
  const ext = path.extname(filePath).toLowerCase()
  const serverNames = extensionMap.get(ext)
  if (!serverNames || serverNames.length === 0) return undefined
  return servers.get(serverNames[0])  // ← 第一个赢
}
```

**第一个 server 赢**, 没有优先级机制 (`LSPServerManager.ts:201` 附近有 TODO 注释). 实际场景里, 同一扩展名同时被多个 server 抢的概率低; 真要解决可以加 plugin 优先级字段.

### 8.4 `ensureServerStarted(server)`

```ts
async function ensureServerStarted(server: LSPServerInstance): Promise<void> {
  const state = server.getState()
  if (state === 'stopped' || state === 'error') {
    await server.start()
  } else if (state === 'starting') {
    // 等启动完成 (内部 promise 共享)
  } else if (state === 'stopping') {
    throw new Error(`Server ${server.name} is stopping`)
  }
  // running 直接返回
}
```

### 8.5 `openFile(filePath, content)` · 幂等 + didOpen

```ts
async function openFile(filePath: string, content?: string): Promise<void> {
  const server = getServerForFile(filePath)
  if (!server) return
  await ensureServerStarted(server)
  const uri = pathToFileURL(filePath).toString()
  if (openedFiles.get(uri) === server.name) return  // ← 已经开过, 不重复
  const ext = path.extname(filePath).toLowerCase()
  const languageId = server.config.extensionToLanguage?.[ext] ?? 'plaintext'
  const text = content ?? fs.readFileSync(filePath, 'utf-8')
  server.client.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId, version: 1, text },
  })
  openedFiles.set(uri, server.name)
}
```

**幂等**: didOpen 同一文件两次 → 协议 undefined behavior (有的 server 抛错有的忽略). 用 openedFiles map 拦.

### 8.6 `changeFile()` · 必要时 fallback 到 `openFile()`

```ts
async function changeFile(filePath: string, content: string): Promise<void> {
  const server = getServerForFile(filePath)
  if (!server) return
  await ensureServerStarted(server)
  const uri = pathToFileURL(filePath).toString()
  if (openedFiles.get(uri) !== server.name) {
    // LSP 规范: didChange 前必须 didOpen
    return openFile(filePath, content)
  }
  server.client.sendNotification('textDocument/didChange', {
    textDocument: { uri, version: getNextVersion() },
    contentChanges: [{ text: content }],  // ← 整文件替换, 不算 delta
  })
}
```

**整文件替换** (`contentChanges: [{ text }]`) 比 incremental 简单, 也避免 version 错位 bug.

### 8.7 `shutdown()` 容错聚合

```ts
async function shutdown(): Promise<void> {
  const toStop = Array.from(servers.values())
  const results = await Promise.allSettled(toStop.map(s => s.stop()))
  const errors = results.filter(r => r.status === 'rejected').map(r => (r as any).reason)
  servers.clear()
  extensionMap.clear()
  openedFiles.clear()
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} server(s) failed to stop`)
  }
}
```

**`Promise.allSettled` + AggregateError**: 不让一个 server 失败把其他 server 留死. M18 的 sink shutdown 也是同款模式.

---

## 九、`LSPDiagnosticRegistry.ts` · 异步交付 + LRU dedup

### 9.1 数据结构

```ts
interface PendingLSPDiagnostic {
  uuid: string
  uri: string
  diagnostics: LSPDiagnostic[]
  serverName: string
  timestamp: number
  attachmentSent: boolean
}

const pendingDiagnostics = new Map<string, PendingLSPDiagnostic>()  // uuid → record

// 跨轮 dedup
const deliveredDiagnostics = new LRUCache<string, Set<string>>({ max: 500 })
//                                          ↑URI    ↑diagnosticKey Set

// 配额
const MAX_DIAGNOSTICS_PER_FILE = 10
const MAX_TOTAL_DIAGNOSTICS = 30
```

LRU max=500 files 兜底: 长会话不让 cache 无限增长.

### 9.2 `createDiagnosticKey(diag)`

```ts
function createDiagnosticKey(diag: LSPDiagnostic): string {
  return JSON.stringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source,
    code: diag.code,
  })
}
```

stable key 覆盖 LSP 诊断的"语义身份". 文件位置 + 错误内容相同 = 同一个 diagnostic, 不重发.

### 9.3 `addPendingDiagnostic()` · 收到 LSP 推送时

```ts
function addPendingDiagnostic(uri: string, diagnostics: LSPDiagnostic[], serverName: string): void {
  if (diagnostics.length === 0) return  // ← 空清空场景: 不入 pending, 让 attach 自动 reset
  pendingDiagnostics.set(generateUuid(), {
    uuid, uri, diagnostics, serverName,
    timestamp: Date.now(),
    attachmentSent: false,
  })
}
```

### 9.4 `checkForLSPDiagnostics()` · agent 拉取

```ts
function checkForLSPDiagnostics(): DiagnosticFile[] {
  // 1. 收集所有未送的 pending
  const allPending = Array.from(pendingDiagnostics.values()).filter(p => !p.attachmentSent)
  if (allPending.length === 0) return []

  // 2. 按 URI 分组
  const byUri = new Map<string, LSPDiagnostic[]>()
  for (const p of allPending) {
    const existing = byUri.get(p.uri) ?? []
    existing.push(...p.diagnostics)
    byUri.set(p.uri, existing)
  }

  // 3. dedup (跨轮)
  const result: DiagnosticFile[] = []
  let totalSent = 0
  for (const [uri, diagnostics] of byUri) {
    if (totalSent >= MAX_TOTAL_DIAGNOSTICS) break

    const seen = new Set<string>()                              // batch 内 dedup
    const previously = deliveredDiagnostics.get(uri) ?? new Set()  // 跨轮 dedup
    const unique: LSPDiagnostic[] = []
    for (const d of diagnostics) {
      try {
        const key = createDiagnosticKey(d)
        if (seen.has(key) || previously.has(key)) continue
        seen.add(key)
        unique.push(d)
      } catch {
        unique.push(d)  // ← key 生成失败仍 include, 防丢
      }
    }
    if (unique.length === 0) continue

    // 4. 严重性排序
    unique.sort((a, b) => severityToNumber(a.severity) - severityToNumber(b.severity))

    // 5. per-file cap
    const capped = unique.slice(0, MAX_DIAGNOSTICS_PER_FILE)

    // 6. total cap
    const remaining = MAX_TOTAL_DIAGNOSTICS - totalSent
    const finalSet = capped.slice(0, remaining)
    totalSent += finalSet.length

    result.push({ uri, diagnostics: finalSet })

    // 7. 更新 deliveredDiagnostics
    const merged = new Set(previously)
    for (const d of finalSet) {
      try { merged.add(createDiagnosticKey(d)) } catch {}
    }
    deliveredDiagnostics.set(uri, merged)
  }

  // 8. 标记 pending 已送 + 删
  for (const p of allPending) {
    p.attachmentSent = true
    pendingDiagnostics.delete(p.uuid)
  }

  return result
}
```

设计精髓:
- **3 层 cap**: per-file 10 + total 30 + LRU 500 files.
- **严重性排序**: Error 先, Warning 次, Info 最后. 截断不丢关键信息.
- **mark attachmentSent + delete pending** 在 success 之后做, 失败时 pending 留着, 下次再试.

### 9.5 `clearDeliveredDiagnosticsForFile(uri)`

```ts
function clearDeliveredDiagnosticsForFile(uri: string): void {
  deliveredDiagnostics.delete(uri)
}
```

agent 编辑文件后必须调这函数 (M07 fs 模块的 Edit/Write tool 完成后): 因为编辑会让 LSP 重新分析, 重新发 publishDiagnostics, 这些 "新" 诊断可能 key 相同 (例如同一个 "x is not defined" 还在), 必须重新让它通过 dedup.

---

## 十、`passiveFeedback.ts` · 接 LSP server 的 publishDiagnostics

### 10.1 `mapLSPSeverity(n)`

```ts
function mapLSPSeverity(n: 1|2|3|4|undefined): 'Error'|'Warning'|'Info'|'Hint' {
  switch (n) {
    case 1: return 'Error'
    case 2: return 'Warning'
    case 3: return 'Info'
    case 4: return 'Hint'
    default: return 'Error'  // ← 安全 default: 当作 Error 不漏
  }
}
```

### 10.2 `formatDiagnosticsForAttachment(uri, diagnostics)`

把 LSP 诊断转成 agent 可读的 attachment text:
```
src/foo.ts:
  10:5  Error    Cannot find name 'x'.  [ts(2304)]
  15:2  Warning  Unused variable 'y'.   [eslint(no-unused-vars)]
```

实现:
```ts
function formatDiagnosticsForAttachment(uri: string, diagnostics: LSPDiagnostic[]): string {
  let filePath = uri
  try { filePath = fileURLToPath(uri) } catch { /* keep uri */ }
  // ↑ 容错: fileURLToPath 对某些非标准 URI 会 throw, fallback 原 uri
  const lines = [`${filePath}:`]
  for (const d of diagnostics) {
    const sev = mapLSPSeverity(d.severity)
    const line = d.range.start.line + 1
    const ch = d.range.start.character + 1
    const code = d.code !== undefined ? ` [${d.source ?? ''}(${d.code})]` : ''
    lines.push(`  ${line}:${ch}  ${sev}  ${d.message}${code}`)
  }
  return lines.join('\n')
}
```

### 10.3 `registerLSPNotificationHandlers(manager)` · 关键集成点

```ts
function registerLSPNotificationHandlers(manager: LSPServerManager): {
  totalServers: number
  successCount: number
  registrationErrors: Array<{ server: string, error: Error }>
  diagnosticFailures: Map<string, { count: number, lastError: Error }>
} {
  const totalServers = manager.servers.size
  let successCount = 0
  const registrationErrors: Array<{ server: string, error: Error }> = []
  const diagnosticFailures = new Map<string, { count: number, lastError: Error }>()

  for (const [name, serverInstance] of manager.servers) {
    if (!serverInstance || typeof serverInstance.onNotification !== 'function') {
      logError(`Server ${name} missing onNotification, skipping`)
      registrationErrors.push({ server: name, error: new Error('missing onNotification') })
      continue
    }
    try {
      serverInstance.onNotification('textDocument/publishDiagnostics', (params) => {
        try {
          if (!params || typeof params !== 'object' || !('uri' in params) || !('diagnostics' in params)) {
            return  // ← 协议怪异时静默
          }
          const { uri, diagnostics } = params as { uri: string, diagnostics: LSPDiagnostic[] }
          if (diagnostics.length === 0) return  // ← 空清空, 不入 pending
          addPendingDiagnostic(uri, diagnostics, name)
          diagnosticFailures.delete(name)  // ← 成功一次, 清失败计数
        } catch (innerErr) {
          const rec = diagnosticFailures.get(name) ?? { count: 0, lastError: innerErr as Error }
          rec.count++
          rec.lastError = innerErr as Error
          diagnosticFailures.set(name, rec)
          if (rec.count >= 3) {
            logWarning(`Server ${name} has failed ${rec.count} consecutive publishDiagnostics`)
          }
        }
      })
      successCount++
    } catch (outerErr) {
      registrationErrors.push({ server: name, error: outerErr as Error })
    }
  }

  return { totalServers, successCount, registrationErrors, diagnosticFailures }
}
```

设计精髓:
- **per-server validation**: `typeof onNotification !== 'function'` → skip, 不让一个 server bug 把其他 server 注册流程废掉.
- **双层 try/catch**: 外层 (注册失败) + 内层 (handler 跑时失败), 分两个 surface 暴露.
- **连续失败计数器** 阈值 3 才告警, 偶尔抖动不打扰.
- **handler 成功一次清计数**, 避免老的失败计数让 server 永远显示告警.
- **返回 stats**, 让外层 (manager init success 后) 决定要不要给用户提示.

---

## 十一、`LSPTool.ts` · 9 操作的 agent 工具入口

### 11.1 工具属性

```ts
// 文件: src/tools/LSPTool/LSPTool.ts
const LSPTool: Tool = {
  name: LSP_TOOL_NAME,             // 'LSP'
  prompt: DESCRIPTION,              // 来自 prompt.ts
  inputSchema: { /* wide schema for tool registration */ },
  isLsp: true,                      // ← 标记位
  shouldDefer: true,                // ← scheduler 延后执行直到 LSP init
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultSizeChars: 100_000,      // ← 截断保护
  isEnabled: () => isLspConnected(), // ← 没 server 就隐藏
  ...
}
```

`shouldDefer: true` + `isEnabled` 是关键: tool registry 启动期间就拿到 LSPTool, 但 isEnabled 在 LSP 没 ready 前一直 false, 工具不显示给 agent; ready 后才出现.

### 11.2 `validateInput` · UNC 路径安全 + discriminated union

```ts
async function validateInput(input: any): Promise<ValidateResult> {
  // 1. 用 discriminated union 解析 (好错误信息)
  const parsed = lspToolInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, errorCode: 1, message: zodErrorToString(parsed.error) }
  }
  const { filePath } = parsed.data

  // 2. UNC 路径完全跳过 (Windows 安全)
  const abs = path.resolve(filePath)
  if (abs.startsWith('\\\\') || abs.startsWith('//')) {
    return { ok: false, errorCode: 4, message: 'UNC paths not supported (security)' }
  }

  // 3. fs.stat 检查存在
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
  } catch {
    return { ok: false, errorCode: 2, message: `File not found: ${filePath}` }
  }
  if (!stat.isFile()) {
    return { ok: false, errorCode: 3, message: `Not a file: ${filePath}` }
  }

  return { ok: true }
}
```

**UNC 路径 (`\\server\share`)** 在 Windows 上访问会触发 NTLM 认证向远程 server 发送凭证. agent 如果被诱导调 LSP `\\evil.com\share\file.ts`, 用户的 NT hash 就泄了. **完全 skip 是安全做法** (相比"resolve 后再验证"更稳).

### 11.3 `call()` 主流程

```ts
async function* call(input: any, context: ToolCallContext) {
  // 1. 等 init
  if (getInitializationStatus() === 'pending') {
    await waitForInitialization()
  }
  const manager = getLspManagerInstance()
  if (!manager) {
    return yieldError('LSP not initialized')
  }

  // 2. 巨文件 guard
  const { filePath, operation, line, character } = input
  const stat = await fs.promises.stat(filePath)
  if (stat.size > MAX_LSP_FILE_SIZE_BYTES) {  // 10MB
    return yieldError(`File too large for LSP (${stat.size} > ${MAX_LSP_FILE_SIZE_BYTES})`)
  }

  // 3. 文件没开就开
  if (!manager.isFileOpen(filePath)) {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    await manager.openFile(filePath, content)
  }

  // 4. 算 method + params (1-based → 0-based)
  const { method, params } = getMethodAndParams(operation, filePath, line - 1, character - 1)

  // 5. 调 server
  const server = manager.getServerForFile(filePath)!
  const result = await server.sendRequest(method, params)

  // 6. callHierarchy 二段查询
  if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
    const items = result as CallHierarchyItem[]
    if (!items || items.length === 0) {
      return yieldNoResult(operation)
    }
    const followupMethod = `callHierarchy/${operation}`
    const followupResult = await server.sendRequest(followupMethod, { item: items[0] })
    return yieldFormatted(operation, followupResult)
  }

  // 7. gitignore filter (locations 类操作)
  if (operation === 'goToDefinition' || operation === 'findReferences' || operation === 'goToImplementation') {
    const filtered = await filterGitIgnoredLocations(result as Location[])
    return yieldFormatted(operation, filtered)
  }

  return yieldFormatted(operation, result)
}
```

设计精髓:
- **1-based → 0-based 在边界**: agent 看到的是行号 1-based (符合人类直觉), LSP 协议是 0-based, 边界处转换.
- **callHierarchy 二段**: prepareCallHierarchy 拿 item, 再 callHierarchy/{incoming|outgoing}Calls 拿 calls. 第一段失败直接 noResult, 不浪费第二个 RPC.
- **gitignore filter** 防 agent 看 `node_modules/` 里的搜索结果污染.

### 11.4 `filterGitIgnoredLocations(locations)`

```ts
async function filterGitIgnoredLocations(locations: Location[]): Promise<Location[]> {
  if (locations.length === 0) return []
  const filePaths = locations.map(l => uriToFilePath(l.uri))
  const uniquePaths = [...new Set(filePaths)]
  const BATCH = 50
  const ignoredSet = new Set<string>()
  for (let i = 0; i < uniquePaths.length; i += BATCH) {
    const batch = uniquePaths.slice(i, i + BATCH)
    try {
      const proc = execFile('git', ['check-ignore', '--', ...batch], { timeout: 5000 })
      const stdout = await proc.promise
      const ignored = stdout.split('\n').filter(Boolean)
      ignored.forEach(p => ignoredSet.add(p))
    } catch (err) {
      // exit code 1 = no ignored, normal; exit code 128 = not in git repo, treat as none ignored
      if (err.code === 0 || err.code === 1 || err.code === 128) continue
      logError('git check-ignore failed:', err)
    }
  }
  return locations.filter(l => !ignoredSet.has(uriToFilePath(l.uri)))
}
```

**batched 50 paths**: 一次 git check-ignore 命令行参数太多会 ENAMETOOLONG. 50 是安全值.
**5s timeout**: git 慢 disk 也要在 5s 内, 不让 LSPTool 卡死.

### 11.5 `getMethodAndParams(operation, ...)` 表驱动

```ts
function getMethodAndParams(op: string, filePath: string, line: number, character: number) {
  const uri = pathToFileURL(filePath).toString()
  const textDocument = { uri }
  const position = { line, character }
  switch (op) {
    case 'goToDefinition':
      return { method: 'textDocument/definition', params: { textDocument, position } }
    case 'findReferences':
      return { method: 'textDocument/references', params: { textDocument, position, context: { includeDeclaration: true } } }
    case 'hover':
      return { method: 'textDocument/hover', params: { textDocument, position } }
    case 'documentSymbol':
      return { method: 'textDocument/documentSymbol', params: { textDocument } }
    case 'workspaceSymbol':
      return { method: 'workspace/symbol', params: { query: filePath } }  // filePath 在 workspaceSymbol 操作里实际是 query
    case 'goToImplementation':
      return { method: 'textDocument/implementation', params: { textDocument, position } }
    case 'prepareCallHierarchy':
      return { method: 'textDocument/prepareCallHierarchy', params: { textDocument, position } }
    case 'incomingCalls':
    case 'outgoingCalls':
      return { method: 'textDocument/prepareCallHierarchy', params: { textDocument, position } }
      // ↑ 第一段都用 prepare, 第二段在 call() 里二次发
    default:
      throw new Error(`Unknown operation: ${op}`)
  }
}
```

### 11.6 `uriToFilePath(uri)` · URI 反解 + Windows fix

```ts
function uriToFilePath(uri: string): string {
  let path = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)  // ← Windows: /C:/foo → C:/foo
  try {
    path = decodeURIComponent(path)
  } catch {
    // 保留原值, 不阻塞
  }
  return path
}
```

Windows 的 file URI 是 `file:///C:/Users/foo` (3 个斜杠), 解析后开头多一个 `/`. 这一行 `if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)` 修了它.

---

## 十二、`schemas.ts` · discriminated union

```ts
// 文件: src/tools/LSPTool/schemas.ts
const filePathSchema = z.string().min(1)
const positionSchema = z.number().int().positive()

export const lspToolInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('goToDefinition'),    filePath: filePathSchema, line: positionSchema, character: positionSchema }),
  z.object({ operation: z.literal('findReferences'),    filePath: filePathSchema, line: positionSchema, character: positionSchema }),
  z.object({ operation: z.literal('hover'),             filePath: filePathSchema, line: positionSchema, character: positionSchema }),
  z.object({ operation: z.literal('documentSymbol'),    filePath: filePathSchema, line: positionSchema, character: positionSchema }),
  z.object({ operation: z.literal('workspaceSymbol'),   filePath: filePathSchema, line: positionSchema, character: positionSchema }),
  z.object({ operation: z.literal('goToImplementation'), filePath: filePathSchema, line: positionSchema, character: positionSchema }),
  z.object({ operation: z.literal('prepareCallHierarchy'), filePath: filePathSchema, line: positionSchema, character: positionSchema }),
  z.object({ operation: z.literal('incomingCalls'),     filePath: filePathSchema, line: positionSchema, character: positionSchema }),
  z.object({ operation: z.literal('outgoingCalls'),     filePath: filePathSchema, line: positionSchema, character: positionSchema }),
])

export function isValidLSPOperation(op: string): op is LSPOperation { ... }
```

虽然 9 个 schema 字段长得一样, 用 **discriminated union** 让 TS 类型推断准确, 之后 switch (input.operation) 每个分支自动窄化. 比 `z.object({ operation: z.enum([...]) })` 更类型安全.

注意: **LSPTool.inputSchema 用宽 schema** (tool registry 注册用), **validateInput 内部再用 lspToolInputSchema** 严格校验. 两份 schema 的原因是 tool 注册时 zod schema 要序列化成 JSON schema 发给 agent, discriminated union 在 JSON schema 表达成 `oneOf`, 有的 agent client 不支持; 用宽 schema 兼容性最好.

---

## 十三、`formatters.ts` · 输出格式 + URI 归一化

### 13.1 `formatUri(uri, cwd?)`

```ts
function formatUri(uri: string, cwd?: string): string {
  let p = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  try { p = decodeURIComponent(p) } catch {}
  p = p.replace(/\\/g, '/')  // ← 统一斜杠
  if (cwd) {
    const rel = path.relative(cwd, p).replace(/\\/g, '/')
    // 只在更短 AND 不是 ../../.. 时用相对路径
    if (rel.length < p.length && !rel.startsWith('../../')) {
      return rel
    }
  }
  return p
}
```

**`../../` 阈值**: 跨多层往上的相对路径反而难读, 此时 absolute 更直观.

### 13.2 `groupByFile<T>(items, getUri)`

```ts
function groupByFile<T>(items: T[], getUri: (t: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const item of items) {
    const uri = getUri(item)
    const arr = result.get(uri) ?? []
    arr.push(item)
    result.set(uri, arr)
  }
  return result
}
```

通用 helper. `Location[]` 和 `SymbolInformation[]` 都用它分组.

### 13.3 9 个 formatter

每个 formatter 共同特点:
- 检查 `result == null || (Array.isArray(result) && result.length === 0)` → `"no XX found"` 加帮助提示.
- 群组后按文件输出.
- 行号 +1 转回 1-based.
- 加 `${count} XX in ${fileCount} file(s)` 总结.

例如 `formatReferencesResult`:
```ts
function formatReferencesResult(result: Location[] | null, cwd: string): string {
  if (!result || result.length === 0) {
    return 'No references found. The symbol may not exist or no references in indexed files.'
  }
  const grouped = groupByFile(result, l => l.uri)
  const lines = [`${result.length} reference(s) in ${grouped.size} file(s):`]
  for (const [uri, locs] of grouped) {
    lines.push(`\n${formatUri(uri, cwd)}:`)
    for (const l of locs.sort((a, b) => a.range.start.line - b.range.start.line)) {
      lines.push(`  ${l.range.start.line + 1}:${l.range.start.character + 1}`)
    }
  }
  return lines.join('\n')
}
```

### 13.4 `formatDocumentSymbolResult` · 自动检测两种格式

LSP 规范 `textDocument/documentSymbol` 允许 server 返回 `DocumentSymbol[]` (有嵌套 children) **或** `SymbolInformation[]` (扁平). server 不一致, formatter 自动检测:

```ts
function formatDocumentSymbolResult(result: DocumentSymbol[] | SymbolInformation[] | null, ...): string {
  if (!result || result.length === 0) return 'No symbols.'
  const first = result[0]
  if ('location' in first) {
    // SymbolInformation 格式
    return formatWorkspaceSymbolResult(result as SymbolInformation[], cwd)
  }
  // DocumentSymbol 格式 — 嵌套
  const lines = []
  for (const sym of result as DocumentSymbol[]) {
    formatDocumentSymbolNode(sym, 0, lines)
  }
  return lines.join('\n')
}

function formatDocumentSymbolNode(sym: DocumentSymbol, indent: number, lines: string[]) {
  const kind = symbolKindToString(sym.kind)
  const range = sym.range
  lines.push(`${'  '.repeat(indent)}${kind} ${sym.name}  (${range.start.line + 1}:${range.start.character + 1})`)
  if (sym.children) {
    for (const child of sym.children) formatDocumentSymbolNode(child, indent + 1, lines)
  }
}
```

**duck typing `'location' in first`**: SymbolInformation 有 `location: Location`, DocumentSymbol 有 `range: Range`. 检测 `location` 字段是否存在判定.

### 13.5 `symbolKindToString` Record

```ts
const symbolKindToString: Record<SymbolKind, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package',
  5: 'Class', 6: 'Method', 7: 'Property', 8: 'Field',
  9: 'Constructor', 10: 'Enum', 11: 'Interface', 12: 'Function',
  13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
  17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key',
  21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event',
  25: 'Operator', 26: 'TypeParameter',
}
```

26 个 LSP SymbolKind 全覆盖.

### 13.6 call hierarchy formatters

`formatIncomingCallsResult` / `formatOutgoingCallsResult` 都把 calls 按调用者文件分组:
```
src/foo.ts:
  calls to bar [at 10:5, 15:8]  ← fromRanges
```

`fromRanges: Range[]` 是 LSP 给的 "在源文件里的哪些位置发生调用", 用 `[at L:C, ...]` 展示.

---

## 十四、`prompt.ts` · 给 agent 看的描述

```ts
// 文件: src/tools/LSPTool/prompt.ts
export const LSP_TOOL_NAME = 'LSP'
export const DESCRIPTION = `Query language server for code intelligence. Operations:
- goToDefinition: jump to symbol definition
- findReferences: find all usages
- hover: get type info / docs
- documentSymbol: list symbols in file
- workspaceSymbol: search symbols by name across project
- goToImplementation: find implementations of interface/abstract
- prepareCallHierarchy: prepare for call hierarchy queries
- incomingCalls: who calls this function
- outgoingCalls: what does this function call

Parameters:
- filePath: absolute path
- line: 1-based line number
- character: 1-based column number
`
```

22 行的极简描述. 不解释 LSP 是什么 (agent 自己懂), 只列操作和参数语义.

---

## 十五、`UI.tsx` · REPL 显示

### 15.1 `OPERATION_LABELS`

```ts
const OPERATION_LABELS: Record<LSPOperation, { singular: string, plural: string, special?: string }> = {
  goToDefinition: { singular: 'definition', plural: 'definitions' },
  findReferences: { singular: 'reference', plural: 'references' },
  hover: { singular: 'hover info', plural: 'hover info', special: 'available' },  // hover 没复数
  documentSymbol: { singular: 'symbol', plural: 'symbols' },
  workspaceSymbol: { singular: 'symbol', plural: 'symbols' },
  goToImplementation: { singular: 'implementation', plural: 'implementations' },
  prepareCallHierarchy: { singular: 'item', plural: 'items' },
  incomingCalls: { singular: 'incoming call', plural: 'incoming calls' },
  outgoingCalls: { singular: 'outgoing call', plural: 'outgoing calls' },
}
```

`special` 字段处理 hover 这种 "0 or 1" 而不是 "0 to N" 的情况.

### 15.2 `LSPResultSummary` 折叠/展开

```tsx
// 折叠态 (默认)
<MessageResponse height={1}>
  {resultText.split('\n')[0]}      // 只显示第一行
  {resultCount > 0 && <CtrlOToExpand />}  // 提示按 Ctrl+O 展开
</MessageResponse>

// 展开态
<Box flexDirection="column">
  <Text>⎿</Text>
  <Box marginLeft={2}>
    <Text>{resultText}</Text>     // 完整内容
  </Box>
</Box>
```

### 15.3 `renderToolUseMessage` · 用 symbolContext 提示

```tsx
function renderToolUseMessage({ operation, filePath, line, character }: any) {
  if (operation === 'documentSymbol' || operation === 'workspaceSymbol') {
    return `${operation}: "${filePath}"`
  }
  const symbol = getSymbolAtPosition(filePath, line - 1, character - 1)
  if (symbol) {
    return `${operation}: "${symbol}", in: "${path.basename(filePath)}"`
  }
  return `${operation}: "${filePath}":${line}:${character}`
}
```

**调 `getSymbolAtPosition` 显示符号名**, 让 user 一眼看到 agent 在查什么. fallback 到位置数字.

---

## 十六、`symbolContext.ts` · sync 读 64KB

### 16.1 设计

```ts
const MAX_READ_BYTES = 64 * 1024  // 64KB ≈ 1000 行典型代码

export function getSymbolAtPosition(filePath: string, line: number, character: number): string | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(MAX_READ_BYTES)
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_READ_BYTES, 0)
    fs.closeSync(fd)
    if (bytesRead === 0) return null
    const text = buffer.toString('utf-8', 0, bytesRead)
    const lines = text.split('\n')
    if (line >= lines.length) return null
    // 64KB 截断且光标在最后一行 → 那行可能不完整, 放弃
    if (bytesRead === MAX_READ_BYTES && line === lines.length - 1) return null
    const targetLine = lines[line]
    if (!targetLine || character > targetLine.length) return null
    // 找包含 character 位置的 symbol
    const re = /[\w!]+|[+\-*/%&|^~<>=]+/g
    let match: RegExpExecArray | null
    while ((match = re.exec(targetLine))) {
      if (match.index <= character && character <= match.index + match[0].length) {
        return match[0].slice(0, 30)  // truncate
      }
    }
    return null
  } catch {
    return null  // ← 任何错误返回 null, 让 UI fallback
  }
}
```

设计精髓:
- **sync read**: 这个函数从 sync React render 调, 不能 async.
- **64KB cap**: 不能整文件读, 否则巨文件卡 render.
- **末行截断检测**: `bytesRead === MAX_READ_BYTES && line === lines.length - 1` → 这行可能被切, 放弃.
- **正则 `/[\w!]+|[+\-*/%&|^~<>=]+/g`**: `\w+` 匹配标识符, `!` 包括 Rust 宏 `macro!`, `'a` Rust lifetime; 第二组匹配操作符. 覆盖 99% 用户感兴趣的符号.
- **30 char truncate**: 防超长 const 名撑爆显示.

---

## 十七、`LspRecommendationMenu.tsx` · 30s 自动消失

### 17.1 关键代码

```tsx
const AUTO_DISMISS_MS = 30_000

function LspRecommendationMenu({ pluginId, onResponse }: Props) {
  const onResponseRef = useRef(onResponse)
  onResponseRef.current = onResponse  // ← 跟最新 callback 同步

  useEffect(() => {
    const timer = setTimeout(() => {
      onResponseRef.current('no')  // ← 通过 ref 调最新版, timer 不重置
    }, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [])  // ← 空依赖! timer 只 set 一次

  return (
    <CustomSelect options={['yes', 'no', 'never', 'disable']} onSelect={onResponse} />
  )
}
```

**`onResponseRef` pattern**: 如果直接 `useEffect(() => setTimeout(...), [onResponse])`, callback 每次更新都重置 timer, 30s 永远到不了. 用 ref 让 effect 只依赖 mount, 但调 callback 时拿最新的.

### 17.2 4 个选项

- `yes`: 安装这个 plugin.
- `no`: 这次不装 (30s 后自动选). 用 `incrementIgnoredCount()` 计入"被忽略数".
- `never`: 这个 plugin 永远不推 (`addToNeverSuggest(pluginId)`).
- `disable`: 整个 LSP 推荐功能关掉 (`lspRecommendationDisabled: true` 写 globalConfig).

---

## 十八、`useLspPluginRecommendation.tsx` · 推荐策略

### 18.1 `TIMEOUT_THRESHOLD_MS = 28_000`

```tsx
const handleResponse = useCallback((response: 'yes'|'no'|'never'|'disable') => {
  if (response === 'no') {
    const elapsed = Date.now() - shownAtRef.current
    if (elapsed >= TIMEOUT_THRESHOLD_MS) {
      // 自动消失算 "timeout", 不算用户主动 dismiss
      incrementIgnoredCount()
    }
    // 用户在 28s 内主动选 no, 不计入 ignored
  } else if (response === 'never') {
    addToNeverSuggest(pluginId)
  } else if (response === 'disable') {
    saveGlobalConfig(prev => ({ ...prev, lspRecommendationDisabled: true }))
  } else if (response === 'yes') {
    installPluginAndNotify(pluginId)
    cacheAndRegisterPlugin(plugin)
    updateSettingsForSource('userSettings', {
      enabledPlugins: { ...settings?.enabledPlugins, [pluginId]: true }
    })
  }
}, [pluginId])
```

**28s vs 30s 阈值**: AUTO_DISMISS_MS = 30000, 30s timer fire 时调 `onResponse('no')`. 这边 28s 是宽容度, 让超时判断稳定 (timer 不一定 0 抖动).

### 18.2 session gate

```tsx
let hasShownThisSession = false
function hasShownLspRecommendationThisSession() { return hasShownThisSession }
```

模块级 boolean. 同一 session 最多推一次, 别 spam.

---

## 十九、`useLspInitializationNotification.tsx` · 5s 轮询

### 19.1 lazy useState 初始化

```tsx
// 文件: src/hooks/notifs/useLspInitializationNotification.tsx
const [debugFlag] = useState(() => isEnvTruthy('true'))
//                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// 必须用 callback 形式 — eager form `useState(isEnvTruthy('true'))`
// 会在每次 REPL render 重新执行 isEnvTruthy.
// 参考 PR #24498: PageUp spam 测试发现 isEnvTruthy 占 7.2s self-time.
```

精髓: **useState 初始值用 callback, 不用直接值**, 哪怕看起来差不多. React 文档明确说: 初始 value 即使 component 已 mount 也会重新算 (虽然不用), 浪费. callback 形式只第一次 mount 算一次.

### 19.2 主循环

```tsx
useEffect(() => {
  const POLL_MS = 5000
  const notifiedErrorsRef = useRef(new Set<string>())

  let stopped = false
  let timer: NodeJS.Timeout
  const poll = () => {
    if (stopped) return
    if (getIsRemoteMode() || getIsScrollDraining()) {
      timer = setTimeout(poll, POLL_MS)  // ← 跳过这些场景但仍调度下次
      return
    }
    const status = getInitializationStatus()
    if (status === 'failed') {
      const err = getInitializationError()
      const key = `init:${err?.message ?? 'unknown'}`
      if (!notifiedErrorsRef.current.has(key)) {
        notifiedErrorsRef.current.add(key)
        addNotification({ severity: 'error', text: `LSP init failed: ${err?.message}` })
        addPluginError('init', err?.message)  // ← /doctor 也能看到
      }
      return  // ← 不再 schedule, init failed 是 terminal
    }
    // running / pending: 继续检查 per-server errors
    const mgr = getLspManagerInstance()
    if (mgr) {
      for (const [name, server] of mgr.servers) {
        if (server.getState() === 'error') {
          const err = server.getLastError()
          const key = `server:${name}:${err?.message ?? 'unknown'}`
          if (!notifiedErrorsRef.current.has(key)) {
            notifiedErrorsRef.current.add(key)
            addNotification({ severity: 'warning', text: `LSP server ${name} errored: ${err?.message}` })
            addPluginError(`lsp:${name}`, err?.message)
          }
        }
      }
    }
    timer = setTimeout(poll, POLL_MS)
  }
  poll()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}, [])
```

设计精髓:
- **`notifiedErrorsRef`** Set dedup `${source}:${message}` — 同一错误不反复通知.
- **`status === 'failed'` terminal** — init 死了就不再轮询.
- **`running` 继续轮询** — 后续 server 崩了也能通知.
- **`getIsRemoteMode() / getIsScrollDraining()` 跳过** — 远程模式或者 UI 正在 scroll drain 时不打扰, 但仍调度下次.

---

## 二十、跨模块依赖图

```
┌────────────────────────────────────────────────────────┐
│                       M03 Plugin                       │
│   getAllRegisteredPlugins() → plugin objects           │
│   getPluginLspServers(plugin) → ScopedLspServerConfig  │
└──────────────┬─────────────────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────────┐
│                M09 LSP services/                       │
│   config.ts → manager.ts → LSPServerManager →          │
│       LSPServerInstance → LSPClient                    │
│                       │                                │
│                       ▼                                │
│   passiveFeedback registers publishDiagnostics         │
│   handler → LSPDiagnosticRegistry                      │
└──────┬────────────────────────┬────────────────────────┘
       │                        │
       │                        ▼
       │              ┌──────────────────────────┐
       │              │ M14 Attachment Pipeline  │
       │              │   checkForLSPDiagnostics │
       │              │   → DiagnosticFile[]     │
       │              │   → next user message    │
       │              └──────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────┐
│                  M09 LSPTool/                          │
│   LSPTool → manager.sendRequest → results              │
│   formatters → text → tool result                      │
└──────┬─────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────┐
│                   M11 Ink Layer                        │
│   LSPTool.UI.tsx → MessageResponse / CtrlOToExpand     │
│   LspRecommendationMenu → CustomSelect                 │
│   useLspInitializationNotification → addNotification   │
└────────────────────────────────────────────────────────┘

           ┌─── M16 graceful shutdown ─── shutdownLspServerManager()
           └─── M19 state ─── appState.plugins.errors, fileHistory.trackedFiles
```

---

## 二十一、待确认 (`?`) 项

1. `src/utils/plugins/lspPluginIntegration.ts` 未找到 — `getPluginLspServers` 来源待确认 (可能在 .d.ts 或 plugin module 内部).
2. `src/services/lsp/types.ts` 不存在 — `ScopedLspServerConfig`, `LspServerState` 类型定义来源待确认.
3. `LSPServerManager.ts:201` 附近注释提到 "first server wins, no priority" — TODO 是否有 PR 实现待确认.
4. `restartOnCrash` / `shutdownTimeout` 配置字段在 `LSPServerInstance.ts` 显式 throw "not yet implemented" — roadmap 待确认.

---

## 二十二、Agent 复用清单 (可直接抄)

### 22.1 架构层

1. **三层架构 Client / Instance / Manager**, 职责完全分离.
2. **单例 + 4 态 + generation 计数器**: 解决并发 init / reinit 时的"陈旧 instance"问题, 不需要 cancelToken.
3. **shouldDefer + isEnabled = isXxxConnected()**: tool registry 启动早, isEnabled 决定显示时机, 让懒加载子系统自然集成.
4. **lazy require 子模块**: `require('./LSPClient.js')` 在 createInstance 内, 没人用则不加载.
5. **factory + closure 替代 class**: DCE 友好, 跟 telemetry 一致.

### 22.2 状态机层

6. **stopped → starting → running → stopping → stopped + error**: 标准 5 态.
7. **crashRecoveryCount vs restartCount 双计数器**: 自动重启 cap 不阻塞手动 restart.
8. **isStopping flag** 抑制 spurious 错误日志.
9. **stop() 总在 finally 清理 connection/process** 防内存泄漏.
10. **pendingHandlers 队列**: onNotification 在 connection 创建前调用安全, 后置 flush.

### 22.3 协议层

11. **spawn-then-streams**: `await once('spawn'/'error')` 防 ENOENT unhandled rejection.
12. **`general.positionEncodings: ['utf-16']`** 显式声明编码, 避免 server 字节算位置.
13. **`workspace/configuration` handler 返回 `params.items.map(() => null)`** 协议合规但不实现.
14. **modern + deprecated init params 都发** (workspaceFolders + rootPath + rootUri), 兼容老 server.
15. **withTimeout `.finally(clearTimeout)`** 防孤儿 timer 锁 event loop.
16. **ContentModified retry 3 次 exponential** (500ms / 1s / 2s) 处理 server 索引中.
17. **error code duck typing `(error as { code?: number }).code`**: 多版本 jsonrpc 共存时 instanceof 不可靠.

### 22.4 文件管理层

18. **openedFiles map per server**: didOpen 幂等, 防 server 报 "already opened".
19. **changeFile fallback to openFile**: LSP 规范要先 didOpen.
20. **extensionMap 路由 + 第一个赢**: 多 server 同扩展时的简单策略 (TODO 加优先级).
21. **shutdown 用 Promise.allSettled + AggregateError**: 不让一个 server 失败拖死其他.

### 22.5 异步交付层

22. **pending Map + LRU 跨轮 dedup**: 同 telemetry 双层 dedup 思路.
23. **stable key = `JSON.stringify({fields})`**: 跨 attempt 一致.
24. **mark `attachmentSent=true` + delete 在 success 之后**: 失败不丢, 自动 retry.
25. **per-file cap (10) + total cap (30) + LRU files (500)**: 3 层防爆.
26. **severity sort then truncate**: Error 优先, 不让 Warning 挤掉 Error.
27. **clearForFile()** 让用户编辑后新诊断能再次通过 dedup.

### 22.6 集成层

28. **registerLSPNotificationHandlers per-server try/catch**: 一个 server bug 不废其他.
29. **diagnosticFailures counter, 3+ 才告警**: 抖动不打扰.
30. **handler 成功一次清失败 counter**: 不让旧失败永久告警.

### 22.7 Tool 层

31. **UNC 路径 (\\) 完全 skip**: 防 NTLM 凭证泄漏 (Windows 安全).
32. **MAX_LSP_FILE_SIZE_BYTES=10MB 上限**: 巨文件直接 skip.
33. **1-based → 0-based 在边界**: agent 看 1-based 符合人类直觉.
34. **callHierarchy 二段**: prepareCallHierarchy 第一段失败直接退, 不浪费第二个 RPC.
35. **filterGitIgnoredLocations batched 50 + 5s timeout**: ENAMETOOLONG 防御.
36. **discriminated union + wide schema**: tool registry 用宽 (JSON schema 兼容), validateInput 用窄 (类型安全).

### 22.8 输出格式层

37. **formatUri 相对路径阈值**: 只有更短 AND 不 `../../` 才用.
38. **groupByFile generic helper**: Location 和 SymbolInformation 复用.
39. **documentSymbol 自动检测两种格式** (`'location' in firstSymbol`).
40. **"no XX" hint 解释为什么没结果**: 提升 agent debug 效率.

### 22.9 UI 层

41. **sync 读 64KB + 末行截断检测**: getSymbolAtPosition 不阻塞 render.
42. **正则覆盖标识符 + Rust 宏 + lifetime + 操作符**: 覆盖 99% 用户场景.
43. **LSPResultSummary 折叠/展开**: 用 CtrlOToExpand 不撑屏.
44. **renderToolUseMessage 加 symbolContext**: agent 在查 "foo" 而不是 "12:34", 用户秒懂.

### 22.10 通知与推荐层

45. **30s 自动消失 + onResponseRef pattern**: useEffect 空依赖, ref 调最新 callback.
46. **TIMEOUT_THRESHOLD_MS=28_000 vs AUTO_DISMISS_MS=30_000**: 阈值留 2s 抖动空间.
47. **session gate (一次 session 最多推一次)**: 不 spam.
48. **lazy useState 初始化** (`useState(() => fn())` 不是 `useState(fn())`): 性能差 7s+.
49. **5s 轮询 + notifiedErrorsRef Set dedup**: 同一错误不反复通知.
50. **failed terminal 不再轮询, running 继续**: 状态机感知的轮询.

---

## 二十三、收尾

LSP 集成是"协议 + 子进程 + 多 server + 异步反馈 + UI 推荐"的综合体. M09 把这 5 件事拆得很干净:

- **协议层** (LSPClient) 只管 JSON-RPC.
- **状态机层** (LSPServerInstance) 只管单 server.
- **路由层** (LSPServerManager) 只管多 server + 文件.
- **单例层** (manager.ts) 只管全局生命周期.
- **配置层** (config.ts) 只管 plugin 拉取.
- **反馈层** (Registry + passiveFeedback) 只管诊断异步交付.
- **Tool 层** (LSPTool) 只管 agent 调用.
- **UI 层** (UI.tsx + 通知 + 推荐) 只管用户体验.

跟 M18 telemetry 的相似处:
- factory + closure 替代 class.
- pending Map + LRU dedup.
- partial-failure resilience (try/catch per item + 聚合 error).
- shutdown Promise.allSettled + finally cleanup.

跟 M11 Ink 的衔接:
- 折叠/展开 (CtrlOToExpand) + lazy useState 性能.
- 30s auto-dismiss + onResponseRef ref pattern.

最有"工程含量"的几个细节:
- **generation 计数器解决并发 reinit** — 比 cancelToken 优雅.
- **spawn-then-streams** — Node child_process 经典坑.
- **ContentModified retry + duck-type error code** — 跨 jsonrpc 版本兼容.
- **`general.positionEncodings: ['utf-16']`** — 编码声明小事却防字节错位 bug.
- **`workspace/configuration` 返回 null array** — 协议合规但不实现, 不让 server 等死.
- **UNC 路径 skip** — Windows 安全意识.
- **lazy useState 初始化** — 7.2s self-time 的实战教训.
- **onResponseRef pattern** — 30s timer 不被 callback 更新重置.

抄这章给 Agent 加 LSP 集成, 至少省 6 个月.

---

## 二十四、补读修正（13 个 LSP 文件 4065 行全部精读后）

> 把 `LSPClient.ts` 447 行 + `LSPServerInstance.ts` 511 行 + `LSPServerManager.ts` 420 行 + `LSPDiagnosticRegistry.ts` 386 行 + `passiveFeedback.ts` 328 行 + `manager.ts` 289 行 + `config.ts` 79 行 + `LSPTool.ts` 860 行 + `formatters.ts` 592 行 + `UI.tsx` 227 行 + `schemas.ts` 215 行 + `symbolContext.ts` 90 行 + `prompt.ts` 21 行 全部从头读完后，§1-§23 没覆盖、但对自建 Agent LSP 集成有价值的细节。每条带"为啥需要"与"启示"。

### 24.1 [新增] `isStopping` 标志位静音 shutdown 期间的假错误

`LSPClient.ts:62, 373-445`：正常 `shutdown → exit → dispose` 流程中 stdout/stdin 会触发 `close`/`error` 事件，**这些不是真错误**。stop() 入口设 `isStopping=true`，error handler 判断后静默。

**为啥**：用户每次切目录或退出都会走 shutdown 路径，不静音的话 console 充满"LSP server crashed"红字噪音，掩盖真实崩溃。

**启示**：**主动关闭和被动崩溃要靠 flag 区分**——不能靠"事件本身"判断（事件本身一模一样）。

### 24.2 [新增] Connection 的 error/close handler 必须在 `listen()` **之前**注册

`LSPClient.ts:185-207`：vscode-jsonrpc 一旦 `listen()`，第一条消息可能立刻触发 error（如服务器送了非 JSON）。如果 handler 没挂，会成为 unhandledRejection 让整个 Agent 崩溃。

**启示**：**任何"启动后立即可能触发事件"的接口，handler 必须在启动调用之前注册**。这是事件 API 通用约束。

### 24.3 [新增] `$/setTrace` 失败必须 catch

`LSPClient.ts:216-226`：LSP 3.16 才加 setTrace，老服务器（旧版 clangd）返回 method not found。这是诊断用的非关键操作，try/catch 包一层。

**启示**：**协议升级带来的新方法都要按"老服务器不一定支持"防御**——非关键就 catch 吞，关键就在 capabilities 协商时 gating。

### 24.4 [新增] 待请求/通知队列支持延迟初始化

`LSPClient.ts:64-71`：允许调用方在连接未完全 listen 之前就调用 `onRequest/onNotification`，缓存到内部数组，listen() 后批量绑定。

**启示**：**上层模块不应该被迫等"完全初始化"才能注册 handler**——内部缓冲让 API 更友好，避免到处出现 `if (initialized) {...}` 的丑陋写法。

### 24.5 [新增] stop() 保留 `startError/startFailed` 字段不清空

`LSPClient.ts:425-445`：退出之后用户查"为什么这台服务挂了"，仍能拿到原因。**删字段是新手错误**——清理状态时下意识全清，但诊断状态例外。

**启示**：**dispose 时区分"运行时状态"（清）vs "事后诊断状态"（保留）**。后者是 debug 命根子。

### 24.6 [新增] 崩溃恢复计数器与人工重启计数器分离

`LSPServerInstance.ts:117, 142-150`：`restartCount`（人工）和 `crashRestartCount`（崩溃自动恢复）分开计数，达到上限策略不同。

**为啥**：崩溃次数高代表服务器本身坏了，不应该用人工配额。用同一个计数器会让"用户手动重启 N 次后崩溃 1 次就放弃"，逻辑错误。

**启示**：**"主动调用"和"被动响应"的计数器必须分**——共用一个会出现语义混淆。

### 24.7 [新增] initialize 同时发 `workspaceFolders` + 老式 `rootPath`/`rootUri`

`LSPServerInstance.ts` initialize 段：三个一起发，谁认哪个谁就用。
- `workspaceFolders` 是 LSP 3.6+（Pyright/gopls 需要）
- `rootPath` 已废弃但 typescript-language-server 还要靠它认目录
- `rootUri` 也废弃但兼容需要

**启示**：**协议演进中，向前兼容的代价是"同时发新旧字段"**——不要因为协议规范说"x 已废弃" 就真的不发，老服务器还在用。

### 24.8 [新增] `positionEncoding` 只声明 UTF-16

initialize capabilities 段：LSP 3.17 加了 UTF-8/UTF-32 协商。明确声明只支持 UTF-16 避免某些服务器误判。代价：中文/emoji 转换位置时要按 UTF-16 surrogate pair 算。

**启示**：**协议协商字段宁可写死最保守的子集**——主动声明"我只会 UTF-16"比赌服务器选对编码更安全。

### 24.9 [新增] `publishDiagnostics.tagSupport` 声明 Unnecessary(1) + Deprecated(2)

initialize capabilities 段：让服务器返回"用不到"、"deprecated API"两类轻量标记。UI 可灰色/删除线显示。

**启示**：**capabilities 声明是"我能消化什么"的契约**——主动声明能解锁服务器更多功能。不声明的字段服务器不会送。

### 24.10 [新增] `hover` 声明同时支持 markdown + plaintext

initialize capabilities 段：某些老服务器（rust-analyzer 早期版）不支持 markdown，必须 plaintext 兜底。

**启示**：**输出格式偏好是数组而不是单值时，列出所有兼容格式**。

### 24.11 [新增] `withTimeout()` 在 finally 里清理 timer

`LSPServerInstance.ts:499-511`：否则即使主 Promise 已 resolve，setTimeout 仍持有 Node event loop 引用，进程退不掉。

**启示**：**任何 `setTimeout` 都要在 promise resolve/reject 时显式 `clearTimeout`**——Node 进程退不掉的常见原因。

### 24.12 [新增] `extensionMap` 的 key 必须 toLowerCase 归一化

extensionMap 初始化段：`.TS` 和 `.ts` 都得映射到 typescript。Windows 大小写不敏感文件系统下尤其重要。

**启示**：**所有"按文件扩展名 dispatch"的 map 都要 normalize key**——否则跨平台行为不一致。

### 24.13 [新增] `openedFiles: Map<URI, serverName>` 用于 didOpen 去重

LSP 规定：didOpen 一个文件后再 didOpen 同一个会未定义行为（gopls 会报 internal error）。靠这张表跨调用记忆。

**启示**：**协议有"幂等性失败"约束时，client 必须做去重簿记**——别指望 server 容错。

### 24.14 [新增] `changeFile()` 检测到未 didOpen 时自动补 didOpen

`LSPServerManager` changeFile 段：LSP 强制 didChange 前必须 didOpen。Tool 层可能直接调 changeFile，这里做兼容。

**启示**：**协议硬约束要在 client 层补全**——上层调用方不应被迫记住"先 open 才能 change"。

### 24.15 [新增] `closeFile` 留了 TODO 待整合 compact 流程

注释明说："integrate with compact"——压缩对话上下文时该不该关 LSP 文件？没解。

**启示**：**Claude Code 自己都没完美解决"什么时候关 LSP 文件"**——长会话里打开太多文件会撑爆 LSP 服务器内存，但不知道哪些 file 上下文还在被引用。这是 LSP 集成的开放难题，自建时一开始就要想策略。

### 24.16 [新增] shutdown 只筛 `running` / `error` 状态

`LSPServerManager.shutdown` 段：`starting`/`stopping` 状态的不重复操作——避免对正在握手的服务器发 shutdown 导致协议错乱。

**启示**：**对状态机做"批量动作"时，必须按当前状态过滤**——不是所有状态都能接受所有动作。

### 24.17 [新增] 三层诊断容量：单文件 10 / 单批 30 / LRU 500 文件

`LSPDiagnosticRegistry.ts`：`MAX_DIAGNOSTICS_PER_FILE=10`、`MAX_TOTAL_DIAGNOSTICS=30`、`MAX_DELIVERED_FILES=500`。前两个防止刷屏，第三个用 LRU 防止内存泄漏。

**启示**：**容量限制要在不同维度上独立设**——单 cap 顶不住所有 edge case。

### 24.18 [新增] LSP 严重程度数字小=严重，与人类直觉相反

severity 排序段：Error(1) < Warning(2) < Info(3) < Hint(4)。容量截断在排序**之后**做，保证 error 优先 warning。

**启示**：**违反人类直觉的数字约定要在代码里加注释**——否则 reviewer 会"修正"成错的。

### 24.19 [新增] UUID 作诊断 ID 不用自增计数器

`LSPDiagnosticRegistry.ts:73`：高频注册（每次保存触发）可能在同毫秒内产生多个，UUID 防冲突。

**启示**：**高频生成的 ID 用 UUID 而不是自增**——自增需要锁同步，UUID 无锁。

### 24.20 [新增] 跨轮去重 key = `message + severity + range + source + code` 5 字段

createDiagnosticKey：用 `jsonStringify` 序列化作 hash。同一条诊断 LSP 重复推送（每次 edit 都来），靠这个 key + LRU 实现"只投递一次到 Claude 上下文"。

**启示**：**dedup key 要选"语义相同就一定相同"的字段组合**——少一个字段就误命中（不同诊断当成同一条），多一个字段就漏命中（同一诊断被当成两条）。

### 24.21 [新增] `clearDeliveredDiagnosticsForFile()` 在 FileEdit/FileWrite/clear 时调

跨文件触发点：`FileEditTool.ts`、`FileWriteTool.ts`、`commands/clear/caches.ts`——语义是"用户主动改了这个文件，旧的去重记录失效，下次诊断要重新推给 Claude"。

**KEEP IN SYNC**：未来新增 NotebookEditTool/MultiEdit 等改文件工具，**必须补这一调用**，否则用户改了文件 LSP 重报诊断会被 dedup 吃掉。

### 24.22 [新增] 三层 try/catch 隔离 passive feedback handler 注册

`passiveFeedback.ts:140-296`：
- 外层：注册阶段（防一个服务器挂掉影响其它）
- 中层：handler 入口（防意外异常打断通知循环）
- 内层：注册诊断本身（拿到具体失败的服务器名）

每层都喂给 `logForDebugging + logError`。

**启示**：**多服务器场景的 try/catch 要分层**——一刀切的 try/catch 让你不知道"哪个 server 哪个阶段"挂了。

### 24.23 [新增] URI 既可能是 `file://` 也可能是裸路径

`passiveFeedback.ts:48-61`：某些社区 LSP 服务器（Lua/Bash）会送裸路径而不是标准 URI。`startsWith('file://')` 判断，否则当裸路径用，malformed URI 还有 fallback 直接用原值。

**启示**：**协议规范不等于实现现实**——LSP 规范说必须 file:// URI，但社区实现到处违规。client 必须容错。

### 24.24 [新增] 连续 3 次诊断失败软告警

`passiveFeedback.ts` `diagnosticFailures` Map：失败计数 ≥3 时日志打 `WARNING:`。成功一次清零。不停服务，给用户 hint。

**启示**：**软告警是介于"静默忽略"和"硬停"之间的实用模式**——给用户线索去查日志，不影响主流程。

### 24.25 [新增] 跳过空 diagnostics 数组的投递

`passiveFeedback.ts:196-205`："无错误"通知是有效信号（清除显示），但不投递到 Claude 上下文。

**启示**：**通知不等于推送**——LSP 协议层和 Agent 上下文层之间要做语义过滤。

### 24.26 [新增] 4 态状态机：not-started → pending → success/failed

`manager.ts` 初始化段：比"已初始化/未初始化"二态多了 pending（共享 Promise）和 failed（失败可重试）。

**启示**：**初始化状态机至少要有 4 态**——二态会导致并发调用方各自启动初始化、失败永久卡死等问题。

### 24.27 [新增] `initializationGeneration` 计数器使旧 promise 失效

`manager.ts:35`：插件热加载触发 `reinitializeLspServerManager()` 时，旧的 init promise 可能还在跑。生成号递增后，回调里检查"我这个 generation 还是当前的吗"，不是就丢弃结果。

**启示**：**经典 stale closure 防御**——比 AbortController/cancelToken 简单，适合"任何时刻只有一个 generation 算数"的场景。

### 24.28 [新增] issue #15521：plugin loader memoize 提前缓存空列表

`manager.ts reinitializeLspServerManager` 附近注释：`loadAllPlugins()` 被 memoize 后可能缓存到空列表（marketplaces 还没 reconcile 完就被调用）。所以 `refreshActivePlugins()` 之后必须显式 `reinitializeLspServerManager()`。

**启示**：**memoize 在"异步加载未完成"的快照上是坑**——memoize 函数要确保"调用时数据已就绪"，或者 cache invalidate 机制要存在。

### 24.29 [新增] UNC 路径直接安全跳过

`LSPTool.ts:171-173`：`\\server\share` 形式——Windows 上访问会触发 NTLM 凭证泄漏（恶意服务器可截获 hash）。LSP Tool 直接拒绝处理。

**启示**：**安全考量大于功能性**——某些路径形态直接拒，不去做"判断这条 UNC 安不安全"。

### 24.30 [新增] `MAX_LSP_FILE_SIZE_BYTES = 10MB` 上限

`LSPTool.ts`：大文件直接拒绝，因为 LSP 服务器通常会 OOM。用 `handle.stat()` 先查大小再决定 readFile，finally 关闭 handle。

**启示**：**所有传给外部进程的文件操作都要有大小上限**——LSP 服务器没有 OOM 防御，client 必须做。

### 24.31 [新增] `filterGitIgnoredLocations` 批量 50 + 5s timeout

`LSPTool.ts`：查找引用时排除 .gitignore 文件（如 node_modules 里的同名符号）。批量调用 git 命令，5 秒超时防卡死。

**启示**：**单次 spawn git 极慢，必须批量**——批量+超时是过滤大量路径的标准 pattern。

### 24.32 [新增] `uriToFilePath` 剥离 Windows 风格的 `/C:/` 前导斜杠

`LSPTool.ts`：LSP URI 规范是 `file:///C:/path`，转 fs path 时要去掉第一个 `/`，否则 `C:/path` 在 Node fs API 里能用但不规范，被各种工具误判。

**启示**：**URI ↔ Path 转换要按平台微调**——这是 4 处 URI 转换的共同坑（见跨文件不变量）。

### 24.33 [新增] Tool 元数据三件套：`shouldDefer:true, isConcurrencySafe:true, isReadOnly:true`

LSP Tool 元数据：可延迟（不影响其他工具）、可并发（多个 LSP 调用可同时发）、只读（不修改文件）。

**启示**：**Agent 调度器需要这套元数据**才能放心并行调用。设计 Tool 时元数据是"告诉调度器我什么样"的契约。

### 24.34 [新增] 调用层级两步走：prepareCallHierarchy → callHierarchy/incomingCalls

LSP 协议设计如此。Tool 内部封装成单次调用，让 Agent 调用方无感。

**启示**：**多步协议交互要在 Tool 层封成单次**——让 LLM 学一遍简单 API 比让它学多步协议靠谱。

### 24.35 [新增] 同步 fs 读取 + ESLint 豁免

`symbolContext.ts:34-37`：React 渲染函数必须同步，所以这里破例用 `fs.readSync`。规则注释解释了原因（防后续维护者改成 async）。只读首 64KB 防大文件卡 UI。

**启示**：**违反 lint 规则的地方要带注释解释"为什么不能改"**——否则下个维护者必改回来。

### 24.36 [新增] 符号正则同时支持标识符 / Rust lifetime / 宏 / 运算符

`symbolContext.ts:62`：`/[\w$'!]+|[+\-*/%&|^~<>=]+/g`——`'a`（lifetime）、`vec!`（macro）、`<=`（operator）全覆盖。truncate 到 30 字符防长泛型炸 UI。

**启示**：**多语言 symbol 提取的 regex 要覆盖各语言特殊形态**——单纯 `\w+` 漏掉 Rust 半数符号。

### 24.37 [新增] 检测文件被 64KB 截断的最后一行

`symbolContext.ts:46-48`：如果 `bytesRead === MAX_READ_BYTES` 且要查的 line 是 split 结果的最后一行，那行很可能被截断到一半，返回 null 让 UI 显示 `line:char` 兜底。

**启示**：**任何"按 size 截断 + 按 line 解析"的代码要检测最后一行可能被截断**——否则会返回半个 token 误导用户。

### 24.38 [新增] Hover 内容三种格式都要处理

`formatters.ts` Hover 段：`MarkupContent`（新）/ `MarkedString[]`（旧）/ `string`（最老）——LSP 向后兼容代价。

**启示**：**LSP 协议演进过的字段，formatter 要处理所有历史格式**——不能偷懒只处理最新的。

### 24.39 [新增] `documentSymbol` 检测到 `SymbolInformation[]` 老格式时降级

`formatters.ts` documentSymbol 段：LSP 3.10+ 用 `DocumentSymbol[]`（带 children 嵌套），老版本用扁平 `SymbolInformation[]`。formatter 自动识别格式。

**启示**：**结构差异大的版本兼容，formatter 内部 dispatch**——让 caller 无感。

### 24.40 [新增] `formatUri` 相对路径仅在更短且不以 `../..` 开头时才用

`formatters.ts formatUri`：否则展示一个 `../../../../../foo/bar.ts` 反而比绝对路径更难读。

**启示**：**"相对路径展示" 不是无脑转——要有可读性 heuristic**。

### 24.41 跨文件不变量（KEEP IN SYNC 列表）

6 条跨文件必须同步的不变量：

1. **LSP 位置 1-based ↔ 0-based 转换**：Tool 入口（`LSPTool.ts`）是 1-based、LSP 协议是 0-based、`formatters.ts` 输出又转回 1-based。任一层忘转就差 1。`prompt.ts:18-19` 明确约定输入是 1-based，是契约
2. **诊断 key 5 字段同步**：`createDiagnosticKey` 用 message+severity+range+source+code；`formatDiagnosticsForAttachment` 必须保留这 5 字段，否则 dedup 失效
3. **URI 规范化 4 处必须一致**：`passiveFeedback`（接收）、`LSPTool.uriToFilePath`（操作）、`formatters.formatUri`（展示）、`openedFiles` Map key——任一处 `/C:/` 没剥干净，去重就失效
4. **`clearDeliveredDiagnosticsForFile` 3 处触发**：FileEditTool / FileWriteTool / clear caches command——**新增改文件工具必须补**
5. **capabilities 与 handler 的对偶**：声明 `workspace.configuration=false` ↔ Manager 必须注册 `workspace/configuration` 返回 `null[]`——协议"谎言"的代价
6. **状态机迁移路径固定**：`stopped → starting → running/error`、`running → stopping → stopped`、`error → starting`。`shutdown` 只筛 running/error 是基于这个图。**新增状态时所有 manager 层筛选要审查**

### 24.42 补读后的新待确认问题

11 个新问题（原 §22 之外）：

1. `getPluginLspServers` 实现细节——多个插件提供同名扩展时的覆盖优先级？
2. `loadAllPluginsCacheOnly` 与 marketplace 同步细节——issue #15521 的精确 race condition 模式？
3. `types.ts` 文件不存在——`LspServerState` / `ScopedLspServerConfig` 字段是否真在 schema 里？
4. `closeFile` TODO 的具体方案——LRU、TTL 还是基于消息引用计数？
5. 诊断 LRU 500 容量的依据——monorepo 长会话够用吗？
6. Bare 模式判定逻辑——具体识别哪些场景（`-p`/`--print`/`--bare`？）
7. `crashRestartCount` 上限值——是否在 ScopedLspServerConfig 的 maxRestarts 里？
8. `restartOnCrash` / `shutdownTimeout` 字段——是"已声明未实现"的 TODO？
9. IDE 内嵌场景的 LSP 旁路——是否应让 IDE 内置 LSP 接管？没看到降级路径
10. 多 workspace folder 场景——`workspace/didChangeWorkspaceFolders` 通知好像没人发？
11. Telemetry/metrics——没发现 `telemetry/event` handler，Pyright 等的 telemetry 被忽略是有意还是遗漏？

---

**下一步**：M11 yoga-layout（`native-ts/yoga-layout/index.ts` 2578 行）。
