# M08: MCP（Model Context Protocol）与外部协议

> 阅读范围:`src/services/mcp/` 22 文件 + `src/tools/MCPTool/` + `src/tools/McpAuthTool/` + `src/tools/ListMcpResourcesTool/` + `src/tools/ReadMcpResourceTool/`
>
> 不在范围:utils/* 不可见;CCR / claude.ai 后端接口约定通过被调用面推断

---

## 0. 模块定位

MCP(Model Context Protocol)是 Claude Code **接入外部能力**的统一边界:

- **输入侧**:用户在 `.mcp.json` / `settings.json` / 企业策略 / claude.ai 连接器 / 插件清单 中声明 server
- **输出侧**:每个 MCP server 发现的 tools / resources / prompts 被注入主 agent 上下文,可被模型调用
- **传输**:stdio(本地 spawn 子进程)、SSE(`new SSEClientTransport`)、Streamable HTTP、WebSocket、SDK in-process、claudeai-proxy
- **认证**:OAuth 2.0(标准 PKCE 流)、XAA(Cross-App Access RFC SEP-990 草案,基于 RFC 8693 token exchange + RFC 7523 jwt-bearer)
- **生命周期**:启动期串/并行连接 → onclose 重连(指数退避 capped at 30s,5 次后熔断) → cache invalidation

它是整个工具系统中**唯一一个动态扩展工具集合**的入口——其他工具(BashTool / FileReadTool 等)在编译期就在 `tools.ts` 注册表里;**MCP 工具在运行时按 server 连接成功后才出现在 prompt 里**。

代码规模:
- `client.ts` 3348 行(client 类 + 协议封装)
- `auth.ts` 2466 行(OAuth + 凭证存储 + 撤销 + 刷新)
- `config.ts` 1578 行(7 类 scope 合并 + dedup + 策略门禁)
- `useManageMCPConnections.ts` 1141 行(React hook,连接编排)
- `xaa.ts` 511 行 + `xaaIdpLogin.ts` 487 行(RFC 8693 跨应用访问)
- + 若干 schema / registry / settings / store / oauthErrors / 其它辅助

---

## 1. 配置系统:7 类 scope 与合并规则

### 1.1 七类 scope

| Scope | 来源 | 持久化 | 优先级 |
|---|---|---|---|
| **enterprise** | `${managedFilePath}/managed-mcp.json` | 系统级文件 | 最高;存在时**排他**(其它 scope 全禁) |
| **local** | 当前项目 `.claude/settings.local.json` | 项目目录 | 高 |
| **project** | 路径向上找的 `.mcp.json` | 项目目录 | 中(根目录覆盖子目录) |
| **user** | 用户全局 config | `~/.claude/config.json` | 低 |
| **dynamic** | 命令行 `--mcp-config` / 插件激活 | 内存 | 由调用方决定 |
| **claudeai** | claude.ai 连接器(用户开启) | 远端 | 与上面合并 |
| **managed** | MDM 远程下发 | 通过 `remoteManagedSettings` | 在 user 中合并 |

文件:`config.ts:getMcpConfigsByScope` / `getMcpConfigByName` / `getProjectMcpConfigsFromCwd`。

**enterprise 短路逻辑**(`doesEnterpriseMcpConfigExist` memoized):管理员部署了 `managed-mcp.json` → 用户无法添加任何自己的 MCP。

例外:`areMcpConfigsAllowedWithEnterpriseMcpConfig` 给 `claude-vscode`(SDK type)开了口子——为了 VSCode 扩展不破。引用来源:Anthropic 内部 Slack `anthropic.slack.com/archives/C093UA0KLD7/p1764975463670109`(注释里直接放了)。

### 1.2 项目 scope 的"根目录覆盖子目录"

`getMcpConfigsByScope(scope='project')` 不是从 cwd 取 `.mcp.json`,而是**从根目录向下**遍历每一级 `.mcp.json`,后加载的覆盖先加载的。

这跟 git 配置的"就近覆盖"相反——MCP 的设计是**项目根的 server 是"项目级真相",子目录的同名 server 可以特化覆盖**。

### 1.3 原子写文件(`writeMcpjsonFile`)

```
stat existingPath → existingMode
open temp `${path}.tmp.${pid}.${Date.now()}` → writeFile jsonStringify(config, null, 2)
→ datasync (POSIX fdatasync) → close → chmod existingMode → rename
catch → unlink temp
```

**关键设计**:
1. **mode 保留**:`stat` 拿到原文件 mode,renaming 前 `chmod` 回去——否则新文件继承 umask 默认,可能从 0600 变成 0644(凭证泄露)
2. **temp 名带 pid + timestamp**:多个 Claude Code 实例同时写不冲突
3. **fdatasync**:确保数据真的落盘再 rename(防 crash 半新半旧)
4. **rename 是原子的**(POSIX 同 filesystem 内 atomic)

> 启示:**任何修改用户配置文件的写操作都要走"temp+rename+chmod"原子模式**,直接 writeFile 在 crash 时会写出半截 JSON。

### 1.4 dedup:三套去重机制

MCP server 来源有 7 个 scope + plugin 还可能定义重名 server——必须去重避免连两次 / 浪费 token。

**机制 1:server signature**(`getMcpServerSignature`)
- stdio → `stdio:${jsonStringify([command, ...args])}`
- url → `url:${unwrapCcrProxyUrl(url)}`(CCR 代理 URL 解包后再签)
- sdk type → `null`(in-process,无 process/connection 可去重)

**机制 2:CCR proxy URL 去重**(`CCR_PROXY_PATH_MARKERS` + `unwrapCcrProxyUrl`)

CCR(Claude Code Relay)代理把真实 MCP URL 包装成 `https://ccr.example.com/v2/session_ingress/shttp/mcp/?mcp_url=https%3A%2F%2Fslack.com%2Fmcp` 这种形式。直接对比 URL 会判定不同——所以解包后再签。

**机制 3:asymmetric plugin/claudeai dedup**

```ts
// dedupPluginMcpServers
const manualSigs = new Map<string, string>()  // sig → manualName
for (manual of enabledManualServers) {        // 注意:只有 enabled 才算去重目标
  manualSigs.set(sig, name)
}
for (plugin of pluginServers) {
  if (manualSigs.has(plugin.sig)) {
    suppressed.push({plugin, reason: 'manual_wins'})
    continue
  }
  if (seenPluginSig.has(plugin.sig)) {
    suppressed.push({plugin, reason: 'first_plugin_wins'})
    continue
  }
}
```

**关键不对称**:disabled 的 manual server **不**算去重目标。
- 原因:如果一个用户禁用了某 manual server,plugin 还提供同名的——应该让 plugin 那个跑起来。不然两个都不跑。
- 注释引述:"a disabled manual server mustn't suppress its connector twin, or neither runs"

类似的 claudeai 连接器 dedup:`dedupClaudeAiMcpServers` 同样只把 ENABLED manual 当 dedup 目标——而且 name 永远不冲突(`slack` vs `claude.ai Slack`)所以必须按 URL signature 比对,否则每轮主对话多耗 ~600 字符的重复 tool listing。

### 1.5 策略门禁(`isMcpServerAllowedByPolicy`)

```
1. 先看 deny:
   - 名字 deny → 拒
   - stdio command deny → 拒
   - URL pattern deny(`urlPatternToRegex`,只 escape 除 * 外的正则元字符)→ 拒
2. 再看 allow:
   - 空 allowlist → 全拒(默认拒)
   - **command-entries-required 模式**:allowlist 里出现过任何 command entry → 所有 stdio 必须命中某 command entry
   - **URL-entries-required 模式**:出现过任何 URL entry → 所有 remote 必须命中
   - 否则按名字匹配
```

**denylist 是绝对的**:`allowManagedMcpServersOnly` 时 policySettings 排他控制 allow,但 deny **永远合并所有源**——管理员设了 deny,用户自己也禁,用户也可以**额外加自己的 deny**。

**SDK type 豁免**:`filterMcpServersByPolicy` 早期 return,sdk type 不进 allowlist 校验。原因:CLI 从不为 sdk 类型 spawn process 或开 connection——allowlist 里的 "URL/command" 对它无意义。如果按名字 gate,`installPluginsAndApplyMcpInBackground` 在 sdk carry-forward 时会被静默 drop。

### 1.6 Windows npx wrapper warning

`parseMcpConfig` 检查 stdio 配置:`command === 'npx'` 或 `endsWith('\\npx')` / `endsWith('/npx')` → 给用户提示:

> Detected `npx` in MCP server config. On Windows CMD, use `cmd /c npx ...` instead — `npx` itself is a `.cmd` file and CMD needs an explicit interpreter.

### 1.7 builtin server 的两套语义

```ts
// CHICAGO_MCP(Computer Use)默认 disabled,要走 enabledMcpServers 显式开启
const DEFAULT_DISABLED_BUILTIN = isChicago ? COMPUTER_USE_MCP_SERVER_NAME : null
function isMcpServerDisabled(name) {
  if (name === DEFAULT_DISABLED_BUILTIN) {
    // opt-in: 不在 enabledMcpServers 里 → disabled
    return !enabledMcpServers.includes(name)
  }
  // opt-out: 在 disabledMcpServers 里 → disabled
  return disabledMcpServers.includes(name)
}
```

> 启示:**默认值反转**——大多数 server "默认 enabled,允许 opt-out";高风险 server "默认 disabled,必须 opt-in"。

---

## 2. 连接编排(`useManageMCPConnections`)

这是个 React hook,但其实是一个**有状态的连接编排器**——把 N 个 server 的连接 / 重连 / cache 失效 / 通知订阅全部处理掉。

### 2.1 状态机

每个 server 在 AppState.mcpClients 中是以下之一:

```
pending(连接中) → connected(可用)
                ↘ needs-auth(待 OAuth) ← 失败时可能转这里
                ↘ failed(连接失败)
                ↘ disabled(用户禁用)
                ↘ rejected-by-policy(策略拒)
```

通过 `updateServer(name, updater)` 应用更新,内部用**时间片批处理**:

```ts
const MCP_BATCH_FLUSH_MS = 16
pendingUpdatesRef.current.set(name, updater)
if (!flushTimerRef.current) {
  flushTimerRef.current = setTimeout(flushPendingUpdates, MCP_BATCH_FLUSH_MS)
}
```

**为什么用 setTimeout 16ms 而不是 queueMicrotask**?
- 注释直接说明:network I/O 在 `setImmediate` 之后才 schedule,microtask 早就 drain 完了
- 16ms ≈ 一帧,batch 多个 server 的状态更新到一次 React render

### 2.2 重连与熔断

```ts
const MAX_RECONNECT_ATTEMPTS = 5
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

function reconnectWithBackoff(name, attempt) {
  if (attempt >= MAX_RECONNECT_ATTEMPTS) {
    updateServer(name, s => ({...s, type: 'failed'}))
    return
  }
  const delay = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  const timer = setTimeout(() => { ... connect again ...}, delay)
  reconnectTimersRef.current.set(name, timer)  // 可以从 toggleMcpServer 取消
}
```

**stdio / sdk 不重连**——stdio 子进程 crash 通常意味着配置坏了 / 命令丢了,重连只会再 crash 一次。

### 2.3 onclose handler 的"磁盘状态优先"

```ts
client.onclose = () => {
  if (isMcpServerDisabled(name)) {  // ← 读磁盘 settings
    return  // 用户刚禁用了它,别重连
  }
  reconnectWithBackoff(name, 0)
}
```

为什么要读磁盘而不是 AppState?
- 注释:**AppState 可能是 stale 的**——toggleMcpServer 先写磁盘,clearServerCache → close → onclose 触发时,React 可能还没来得及 update AppState
- 解决:在 onclose 里直接读磁盘 truth

**对应的 toggleMcpServer 顺序**:
```ts
function toggleMcpServer(name, enabled) {
  setMcpServerEnabled(name, enabled)  // 1. 先写磁盘
  clearServerCache(name)              // 2. 再断连接(触发 onclose,会读磁盘)
}
```

顺序反了就会:close → onclose → 读磁盘看到 enabled=true → reconnect → 然后才 setMcpServerEnabled(false) → cycle 浪费一次。

### 2.4 excludeStalePluginClients:3 重清理

`/reload-plugins` 后,plugin server 列表变了。已经存在的 client 怎么办?

```ts
function excludeStalePluginClients(state, freshConfigs) {
  for (client of state.mcpClients) {
    if (client.source !== 'plugin') continue
    if (clientStillInFreshConfigs(client)) continue

    // 这个 client 是 stale plugin → 清理
    if (client.type === 'connected') {
      // 1. 取消 pending reconnect timer
      reconnectTimersRef.current.get(client.name)?.clear()

      // 2. 清掉 onclose handler 闭包(它持有 OLD config)
      //    否则 close 后 reconnectWithBackoff(OLD) 跑起来,跟 fresh connection 抢
      //    last updateServer wins,可能旧的覆盖新的
      client.client.onclose = undefined

      // 3. clearServerCache → connectToServer 是 memoized
      //    对从未 connected 的 server,cache 为空 → real connect attempt
      //    spawn 子进程 / 开 OAuth 只为了 kill,完全浪费
      //    所以只清理 connected 的
      clearServerCache(client.name)
    }
  }
}
```

**3 个隐患都不是想当然能想到的**:
1. **pending reconnect timer 用 OLD config 触发**
2. **onclose 闭包 race 新 connection**
3. **clearServerCache 对 never-connected server 会 spawn 然后立刻杀**

> 启示:任何"对正在运行的对象做 hot reload"的清理,要枚举所有"持有旧引用的隐含路径"(timers / handlers / memo caches)而不是只 close。

### 2.5 channelPermCallbacksRef:hook + interactiveHandler 桥

MCP 支持 server **主动推送权限请求**(`ChannelPermissionNotificationSchema`)——例如 GitHub server 想发评论,主动发 prompt 给用户。

但 `useManageMCPConnections` hook 和 `useCanUseTool` interactiveHandler **是不同的 React 子树**——hook 跑在 root, interactiveHandler 跑在权限对话框组件树里。

桥接方式:**把 callback Map 放到 AppState 作为 stable ref**。

```ts
const channelPermCallbacksRef = useRef<Map<string, ChannelPermCallback>>()

useEffect(() => {
  if (!channelPermCallbacksRef.current) {
    channelPermCallbacksRef.current = new Map()
    setAppState(s => ({...s, _channelPermCallbacks: channelPermCallbacksRef.current}))
  }
  return () => {
    setAppState(s => ({...s, _channelPermCallbacks: undefined}))
  }
}, [])  // 一次性挂上 + cleanup
```

interactiveHandler 通过 `ctx.toolUseContext.getAppState()._channelPermCallbacks` 拿到 Map,subscribe / unsubscribe。

**反直觉点**:pending Map **不在 module-level**(避免跨 session 泄露),**也不在 AppState**(functions-in-state brittle for serialization),**在 closure 里**。AppState 里只放对 Map 的 ref。

### 2.6 gateChannelServer:7 类 skip_kinds

不是所有 channel 通知都该被处理——`gateChannelServer` 检查每个 server 是否允许 channel 推送:

```
disabled    → skip + 一次性 toast (用户主动禁用)
auth        → skip + 一次性 toast (OAuth 未完成)
policy      → skip + 一次性 toast (策略拒)
marketplace → skip + 一次性 toast (server 不在市场白名单)
allowlist   → skip + 一次性 toast (用户配置 allowlist 缺它)
capability  → skip,DEBUG only(server 没声明 channel capability)
session     → skip,DEBUG only(本 session 没接受 channel)
```

**一次性 toast** 通过 `channelWarnedKindsRef`(per-kind Set)dedup——每个 kind 只 toast 一次,不刷屏。

### 2.7 register vs skip 的 idempotent teardown

`gateChannelServer` 可能这次返回 `register`,下次因为 user revoke 返回 `skip`。

切换时:
- register → 装上 ChannelMessageNotificationSchema + ChannelPermissionNotificationSchema handler
- skip → **必须 idempotent teardown**——用 `removeNotificationHandler` 移除

否则:之前 register 留下的 handler 还在,channel 推送照样进——绕过 gate。

### 2.8 两阶段 loadAndConnectMcpConfigs

```ts
useEffect(async () => {
  // Phase 1: Claude Code 本地 configs(快)
  const ccConfigs = await getClaudeCodeMcpConfigs(dynamicConfig)

  // 同时 kick off claudeai 拉取(慢,网络)
  const claudeaiPromise = getClaudeAiMcpConfigs()  // memoized

  initializeServersAsPending(ccConfigs)
  ccConfigs.forEach(connect)  // 先连本地的

  // Phase 2: 等 claudeai 返回
  const claudeaiConfigs = await claudeaiPromise
  initializeServersAsPending([...ccConfigs, ...claudeaiConfigs])
  claudeaiConfigs.forEach(connect)
}, [_authVersion, _pluginReconnectKey])
```

**为什么两阶段**?
- 用户启动 Claude Code 时,本地 stdio server 几十毫秒就能连上
- claude.ai 连接器需要 API 调用(几百毫秒到几秒)
- 不等 claudeai 就能让本地工具先可用,用户感知更快

`getAllMcpConfigs` 内部也是同样设计:claudeai 用 memoized promise,跨调用 share。

### 2.9 tengu_mcp_servers analytics

启动后会埋点上报:

```ts
{
  enterprise_count, global_count, project_count, user_count,
  plugin_count, claudeai_count,
  // ant-only(仅 Anthropic 内部用户):
  stdio_commands: ['rust-analyzer', 'pyright-langserver', ...]
}
```

ant-only 字段记录 stdio command 的 basename——用于 RSS / FPS 退化相关性分析(rust-analyzer 著名内存大户)。

---

## 3. OAuth:标准流 + XAA(Cross-App Access)

### 3.1 标准 OAuth(`auth.ts` 2466 行)

非 XAA 路径:`performMCPOAuthFlow` → discoverOAuthClientMetadata → startAuthorization PKCE → waitForCallback(本地 HTTP 服务器) → exchangeAuthorization → 存 access_token + refresh_token + discoveryState 到 secureStorage。

刷新:`_doRefresh` → 用 refresh_token POST 到 `discoveryState.tokenEndpoint`。

撤销:`revokeServerTokens` → POST 到 `discoveryState.revocationEndpoint`。

### 3.2 XAA(`xaa.ts` 511 行 + `xaaIdpLogin.ts` 487 行)

Cross-App Access(SEP-990 草案)解决的问题:用户已经用某 IdP(Okta)登录了 → MCP server 用同一个 IdP → 不用再让用户登录第二次。

流程:
```
1. discoverProtectedResource(serverUrl)
   → 拉 /.well-known/oauth-protected-resource(RFC 9728)
   → 验证 resource 字段 == serverUrl(防 mix-up)
   → 拿到 authorization_servers[] 列表
2. for asUrl of authorization_servers:
     discoverAuthorizationServer(asUrl)
     → 拉 /.well-known/oauth-authorization-server(RFC 8414)
     → 验证 issuer == asUrl(防 mix-up)
     → 验证 token_endpoint 是 HTTPS
     → 看 grant_types_supported——如果显式列出但不含 jwt-bearer,skip
3. acquireIdpIdToken(asMeta.issuer)
   → 从缓存取 id_token(JWT exp 检查 + 60s buffer)
   → 没缓存:discoverOidc(issuer) → 用 PKCE 跑一次 OAuth 拿 id_token → 缓存
4. requestJwtAuthorizationGrant(asMeta, idToken, clientId)
   → POST token_endpoint:
     grant_type=urn:ietf:params:oauth:grant-type:token-exchange
     subject_token=idToken
     subject_token_type=urn:ietf:params:oauth:token-type:id_token
     requested_token_type=urn:ietf:params:oauth:token-type:id-jag
     audience=serverUrl
   → 验证 issued_token_type == ID_JAG_TOKEN_TYPE
   → 拿到 ID-JAG
5. exchangeJwtAuthGrant(asMeta, idJag, clientId, clientSecret?)
   → POST token_endpoint:
     grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
     assertion=idJag
   → 拿到 access_token / refresh_token / expires_in
6. 返回 {...tokens, authorizationServerUrl: asMeta.issuer}
   → 调用方持久化为 discoveryState.authorizationServerUrl
   → 后续 _doRefresh / revokeServerTokens 用它找 token/revocation endpoints
```

### 3.3 XAA 的关键工程细节

**makeXaaFetch + AbortSignal.any**
```ts
function makeXaaFetch(abortSignal?: AbortSignal) {
  return (url, init) => fetch(url, {
    ...init,
    signal: AbortSignal.any([
      abortSignal ?? new AbortController().signal,
      AbortSignal.timeout(XAA_REQUEST_TIMEOUT_MS),  // 30s
    ]),
  })
}
```

`AbortSignal.any` 组合多 signal——任意一个 abort 都立即取消。**用户取消** + **超时** 一起监控。

**XaaTokenExchangeError.shouldClearIdToken**

不是简单 substring 判断,而是按 OAuth 语义:

```ts
const shouldClearIdToken = (() => {
  if (statusCode >= 500) return false                 // IdP outage,可能 token 还有效
  if (statusCode === 200 && !validShape) return true  // 协议违反,id_token 可疑
  if (errorCode === 'invalid_grant') return true      // id_token 真无效
  if (errorCode === 'invalid_token') return true      // 同上
  if (statusCode >= 400 && statusCode < 500) return true  // 4xx 客户端错
  if (!parsedJson) return false                       // captive portal HTML
  return false  // 默认保守
})()
```

> 启示:**错误恢复决策不能靠"包含某个字符串"**——要按协议语义分类。

**redactTokens on raw text() bodies**

```ts
const SENSITIVE_TOKEN_RE = /(access_token|refresh_token|id_token|assertion|subject_token|client_secret)["\s:=]+[^,"\s}]+/gi

function redactTokens(input) {
  return input.replace(SENSITIVE_TOKEN_RE, '$1: <redacted>')
}
```

**关键点**:redact 不只对 parsed-then-stringified 用,**对原始 `res.text()` body 也用**——错误响应可能是 HTML 或畸形 JSON,parsing 失败前就要 redact 才不会进 debug log。

**Schema 鲁棒性**

```ts
const TokenExchangeResponseSchema = z.object({
  access_token: z.string(),
  issued_token_type: z.string(),
  // expires_in 用 z.coerce.number() 因为 PHP-backed IdPs 发字符串
  expires_in: z.coerce.number().optional(),
  ...
})

const JwtBearerResponseSchema = z.object({
  access_token: z.string(),
  // token_type default='Bearer' 因为很多 AS 忽略发送
  token_type: z.string().default('Bearer'),
  refresh_token: z.string().optional(),
  ...
})
```

> 启示:任何 OAuth schema 都要 coerce + default,RFC 不等于现实。

**RFC mismatch 校验**(三个)

1. **RFC 9728 §3.3**:PRM `resource` 必须 == serverUrl(防 mix-up,server A 把 PRM 指向 server B 的 AS)
2. **RFC 8414 §3.3**:AS metadata `issuer` 必须 == asUrl
3. **HTTPS-only token_endpoint**:RFC 8414 §3.3 / RFC 9728 §3 都要求 HTTPS——避免 PRM 通告 http:// AS 然后 self-consistent 假的 http:// issuer 通过校验,Claude 然后明文 POST id_token + client_secret

**client_secret_basic 默认 + post 后备**

```ts
const authMethod = (() => {
  const methods = asMeta.token_endpoint_auth_methods_supported
  if (!methods) return 'client_secret_basic'  // 默认(SEP-990 期望)
  if (methods.includes('client_secret_basic')) return 'client_secret_basic'
  if (methods.includes('client_secret_post')) return 'client_secret_post'
  return 'client_secret_basic'  // 没声明 basic 但也没 post,默认 basic
})()

if (authMethod === 'client_secret_basic') {
  headers['Authorization'] = 'Basic ' + base64(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)
}
```

**只在 AS metadata 明确声明 post 但没声明 basic 时**用 post——保守。

### 3.4 IdP login(`xaaIdpLogin.ts`)

**discoverOidc 的"trailing-slash 陷阱"**:

错误写法:
```ts
const oidcUrl = new URL('/.well-known/openid-configuration', issuer)
// issuer = 'https://login.microsoftonline.com/{tenant}/v2.0'
// oidcUrl = 'https://login.microsoftonline.com/.well-known/openid-configuration'  ← 丢了 path!
```

WHATWG URL 规则:相对路径以 `/` 开头是 absolute-path reference,会替换 base 的 pathname。

正确写法:
```ts
const baseWithSlash = issuer.endsWith('/') ? issuer : issuer + '/'
const oidcUrl = new URL('.well-known/openid-configuration', baseWithSlash)
// oidcUrl = 'https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration'  ← 对了
```

影响:Azure AD(tenant-scoped)、Okta custom auth servers、Keycloak realms。

**captive portal HTML 200 catch**:

`res.json()` 在 body 是 HTML(WiFi 登录页)时**抛 raw SyntaxError**,Zod safeParse 来不及给好错。

```ts
let json
try {
  json = await res.json()
} catch (e) {
  if (e instanceof SyntaxError) {
    throw new Error('OIDC discovery returned non-JSON (possible captive portal)')
  }
  throw e
}
const parsed = OidcMetadataSchema.safeParse(json)
```

**jwtExp 签名-less decode**:

为了 cache TTL,decode JWT 看 `exp`——**故意不验证签名**。

注释(SEP-990 rationale):
> id_token 是 RFC 8693 subject_token,IdP 在 token exchange 时自己验证它。攻击者要骗过 IdP 而不只是骗 Claude——客户端验签只增加代码不增加安全。

**waitForCallback 细节**:

```ts
const server = http.createServer((req, res) => { ... })
const port = await findAvailablePort()
server.listen(port, () => {
  onListening?.()  // ← defer browser-open 到这里
})
server.unref()                            // ← 不 pin event loop
const timeoutId = setTimeout(reject, IDP_LOGIN_TIMEOUT_MS)
timeoutId.unref()                         // ← 同上

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    const findCmd = process.platform === 'win32'
      ? `netstat -ano | findstr :${port}`
      : `lsof -ti:${port} -sTCP:LISTEN`
    reject(new Error(`Port ${port} busy. Find process: ${findCmd}`))
  }
})
```

- `server.unref() + timeoutId.unref()`:event loop 不会被它们 pin 住,用户 Ctrl-C 立刻退
- `onListening` defer browser-open:避免 EADDRINUSE 之前已经开了浏览器 tab(spurious)
- 平台特定 findCmd:Windows / Mac / Linux 各自的"找占用端口"命令

**saveIdpClientSecret 返回 {success, warning}**

```ts
async function saveIdpClientSecret(issuer, secret): Promise<{success: boolean, warning?: string}> {
  try {
    await keychainSet(`mcpXaaIdpConfig:${issuerKey(issuer)}`, secret)
    return {success: true}
  } catch (e) {
    return {success: false, warning: `Keychain failed: ${e.message}. Token exchange will fail with invalid_client.`}
  }
}
```

调用方拿到 warning 可以 surface 给用户——不是 silently drop。否则 keychain 锁了/挂了的用户后面拿 `invalid_client` 完全不知道为啥。

**issuerKey normalization**:

```ts
function issuerKey(issuer) {
  const url = new URL(issuer)
  url.host = url.host.toLowerCase()
  let key = url.toString()
  if (key.endsWith('/')) key = key.slice(0, -1)
  return key
}
```

同一个 IdP 可能在 config 里是 `https://Login.Microsoftonline.com/foo/` 在 OIDC discovery 是 `https://login.microsoftonline.com/foo`——必须 normalize 到同一个 cache slot。

---

## 4. MCPTool 系列工具

### 4.1 MCPTool(主 stub)

`src/tools/MCPTool/MCPTool.ts` 78 行——是个 **stub**:

```ts
{
  isMcp: true,
  name: 'mcp',
  maxResultSizeChars: 100_000,
  isOpenWorld: () => false,
  checkPermissions: () => ({behavior: 'passthrough', message: 'MCPTool requires permission.'}),
  // 其它方法都被 client.ts 的 fetchToolsForClient 覆盖
}
```

实际的 name / description / inputSchema / call 在每个 MCP server 连接后,**由 `client.ts:fetchToolsForClient` 嫁接**——把 server 返回的 tools list 嫁接到 stub 上,生成 `mcp__${server}__${toolName}` 形式的工具。

> 启示:**stub + graft 模式** 适合"动态工具集合"——主体只声明骨架,运行时填血肉。

### 4.2 McpAuthTool(needs-auth 状态的伪工具)

当某 MCP server 处于 `needs-auth` 状态时(OAuth 未完成),`createMcpAuthTool` 创建一个伪工具 `mcp__${server}__authenticate` 暴露给模型——**替代**该 server 的真实工具列表。

```ts
{
  name: `mcp__${server}__authenticate`,
  description: 'Call this tool to start OAuth flow for MCP server X.',
  checkPermissions: () => ({behavior: 'allow', updatedInput: input}),  // 永远批准
  call: async () => {
    if (config.type === 'claudeai-proxy') return {status: 'unsupported', message: 'Use /mcp'}
    if (!['sse', 'http'].includes(config.type)) return {status: 'unsupported'}

    // 开启 OAuth
    let resolveAuthUrl
    const authUrlPromise = new Promise(r => { resolveAuthUrl = r })

    const oauthPromise = performMCPOAuthFlow({
      ...config,
      skipBrowserOpen: true,  // 不自动开浏览器(模型在用)
      onAuthorizationUrl: u => resolveAuthUrl(u),
    })

    // 谁先返回?XAA 静默可能直接 oauthPromise 先 resolve(没 URL)
    const result = await Promise.race([authUrlPromise, oauthPromise.then(() => null)])

    if (result === null) {
      // XAA 静默成功
      await clearMcpAuthCache(serverName)
      await reconnectMcpServerImpl(serverName)
      // 替换 AppState 里这个 server 的 tools(prefix-based reject)
      setAppState(s => ({
        ...s,
        tools: [...s.tools.filter(t => !t.name.startsWith(`mcp__${serverName}__`)), ...newTools],
        commands: [...s.commands.filter(...), ...newCommands],
        resources: [...s.resources.filter(...), ...newResources],
      }))
      return {status: 'authenticated', message: '...'}
    }
    // 否则给 URL 让用户开浏览器
    return {status: 'needs-browser', authUrl: result, message: `Open ${result} to authenticate.`}
  },
}
```

**精妙之处**:
1. **替换而不是新增**——auth 完成后,真实 tools 进入 AppState,这个 authenticate 伪工具被 prefix filter 移除
2. **race XAA silent-auth vs interactive**——XAA 可能直接成功,oauthPromise 早 resolve,不返回 URL
3. **checkPermissions 永远 allow**——模型可以无障碍调用启动 OAuth

### 4.3 ListMcpResourcesTool / ReadMcpResourceTool

```ts
{
  isConcurrencySafe: true,   // 读类,可并发
  isReadOnly: true,
  shouldDefer: true,         // LSP-style 延迟加载——避免启动期就把全部 resources 拉过来
  searchHint: 'list resources from connected MCP servers',
  maxResultSizeChars: 100_000,
}
```

`ListMcpResourcesTool.call`:
- 可选 server filter,过滤后只查那个 server
- 对每个 client 用 try/catch 包——**一个 server reconnect 失败不会让整个 list 失败**
- 用 `ensureConnectedClient`(memoized no-op when healthy,fresh after onclose)+ `fetchResourcesForClient`(LRU cached,onclose / resources/list_changed 时失效)

`ReadMcpResourceTool.call`:
- `connectedClient.client.request({method: 'resources/read', params: {uri}}, ReadResourceResultSchema)`
- text content passthrough
- blob content:Buffer.from(base64) → persistBinaryContent → getBinaryBlobSavedMessage,带 prefix `[Resource from ${serverName} at ${c.uri}] `
- persistId 格式:`mcp-resource-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`

### 4.4 classifyForCollapse:600+ 行硬编码 allowlist

`MCPTool/classifyForCollapse.ts` 604 行,其中 ~135 个 SEARCH_TOOLS 条目 + 类似数量的 READ_TOOLS——所有名字都 normalize 到 snake_case:

```ts
function normalize(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase → camel_Case
    .replace(/-/g, '_')                    // kebab-case → kebab_case
    .toLowerCase()                         // → camel_case / kebab_case
}
```

覆盖 30+ MCP server family:Slack / GitHub / Linear / Datadog / Sentry / Notion / Gmail / Google Drive / Google Calendar / Atlassian/Jira / community Atlassian / Asana / Filesystem / Memory / Postgres / SQLite / Git / Grafana / PagerDuty / Supabase / Stripe / PubMed / BigQuery / Firecrawl / Exa / Perplexity / Tavily / Obsidian / Figma / Playwright / Puppeteer / MongoDB / Neo4j / Elasticsearch / Airtable / Todoist / AWS / Kubernetes。

**用途**:Messages 渲染时,连续的 SEARCH 类工具调用 + READ 类工具调用会被折叠成一行——减少视觉噪音。

**保守原则**:**未知名字不 collapse**——宁可不折叠也不误折叠。

> 启示:**白名单分类**适合"动态生态 + 有限关键类"——比训练分类器轻、比 LLM 判定准、比正则灵活。代价是手工维护。

### 4.5 UI.tsx 渲染:三种策略

```ts
// MCPTool/UI.tsx 的 MCPTextOutput
function MCPTextOutput({content, verbose}) {
  // 策略 1:unwrap dominant text payload
  // e.g. Slack 返回 {"messages":"line1\nline2..."}
  const unwrapped = tryUnwrapTextPayload(content)
  if (unwrapped) return <MessageResponse>...{unwrapped.body}...</MessageResponse>

  // 策略 2:flat k:v 表(小 JSON 对象)
  const flat = tryFlattenJson(content)
  if (flat) return <MessageResponse>{padded key: value}</MessageResponse>

  // 策略 3:fallback to OutputLine(pretty print + truncate)
  return <OutputLine content={content} ... />
}
```

**关键阈值**:
- `MAX_INPUT_VALUE_CHARS = 80`(单个 input value 显示上限)
- `MAX_FLAT_JSON_KEYS = 12`(超过 12 key 就 fallback 到 raw JSON)
- `MAX_FLAT_JSON_CHARS = 5_000`
- `MAX_JSON_PARSE_CHARS = 200_000`(perf safety)
- `UNWRAP_MIN_STRING_LEN = 200`(string 长度阈值,判定 dominant)
- `MCP_OUTPUT_WARNING_THRESHOLD_TOKENS = 10_000`(>10K token 显示警告"会填满 context")

**trySlackSendCompact**:专门检测 Slack send-message 结果——

```ts
output 是 [{type:'text', text:'{"ok":true,"message_link":"https://workspace.slack.com/archives/C123/p456"}'}]
↓
parse JSON → find message_link → match SLACK_ARCHIVES_RE
↓
渲染 "Sent a message to #channel-name"(URL hyperlink)
```

**两层匹配**(hosted Slack MCP + community Slack MCP 都返回 `message_link`)。

> 启示:**rich output 的优雅降级路径**:特定 server 特定结果格式 → 通用 unwrap → 通用 flat → fallback raw。每层判断要短路且安全(parse 失败 return null)。

---

## 5. 22 个 MCP 服务文件清单

| 文件 | 职责 |
|---|---|
| `client.ts`(3348 行) | MCP client 类 + 协议封装 + tools/resources/prompts fetch + 缓存 |
| `auth.ts`(2465 行) | 标准 OAuth 2.0 + 凭证存储 + 刷新 + 撤销 |
| `config.ts`(1578 行) | 7 类 scope + atomic write + dedup + policy gate |
| `useManageMCPConnections.ts`(1141 行) | React hook 编排连接 / 重连 / cache invalidation |
| `xaa.ts`(511 行) | Cross-App Access RFC 8693/7523 layer 2+3 |
| `xaaIdpLogin.ts`(487 行) | XAA IdP-side OIDC discovery + id_token 缓存 |
| `types.ts` | 共享类型(server config / client / status) |
| `officialRegistry.ts` | 官方 server 注册表(claude.ai 连接器) |
| `mcpInstallation.ts` | install 流程 |
| `clientNotifications.ts` | tools/resources/prompts list-changed |
| `mcpToolHelpers.ts` | tool name 拼接 / 解析 |
| `oauthErrors.ts` | OAuth 错误分类 |
| `secureStorage.ts` | 凭证读写 keychain |
| `mcpSettings.ts` | settings 读写 |
| `gateChannelServer.ts` | channel 推送 7 类 gate |
| `xaaConformance.ts` | XAA 协议合规测试入口 |
| `mcpStore.ts` | client 全局 store |
| `connectionFactory.ts` | transport 创建(stdio/sse/http/ws/sdk/claudeai-proxy) |
| `elicitation.ts` | elicitation handler(server 请求用户输入) |
| `claudeAiBackedServers.ts` | claudeai 连接器列表与签名 |
| `pluginMcpServers.ts` | plugin 提供的 MCP server |
| `cwdMcpAccess.ts` | 项目目录批准状态 |

---

## 6. 抄回去的 22 招

| # | 工程精髓 | 一句话 |
|---|---|---|
| 1 | **7 scope 合并 + 优先级** | enterprise 排他、其它合并并按优先级覆盖 |
| 2 | **atomic write**(temp + datasync + chmod + rename) | crash 不写出半截 JSON;mode 保留防权限漂移 |
| 3 | **CCR proxy URL 解包后再签** | 代理 URL 不同但底层 server 相同,要解包 dedup |
| 4 | **asymmetric dedup**(disabled manual 不算去重目标) | 禁用 manual 不能 suppress 同名 plugin,否则双双不跑 |
| 5 | **policy denylist 永远合并,allowlist 看模式** | 用户始终可以为自己加 deny;allow 由企业策略主导 |
| 6 | **builtin server 默认值反转**(opt-in vs opt-out) | 高风险用 enabledMcpServers;普通用 disabledMcpServers |
| 7 | **disk-state-first toggleMcpServer** | 写盘 → 断连;onclose 读盘判断,避 React state stale |
| 8 | **excludeStalePluginClients 3 重清理** | timer + onclose 闭包 + memo cache 都要清理 |
| 9 | **MCP_BATCH_FLUSH_MS=16 时间片批处理** | 网络 I/O 不在 microtask,要用 setTimeout 凑帧 |
| 10 | **指数退避 + 熔断**(5 次 / cap 30s) | 不要无限重试,防雪崩 |
| 11 | **channelPermCallbacksRef stable 桥** | hook 和远树组件通过 AppState 里的 ref 通信 |
| 12 | **gate skip 7 类 + 一次性 toast** | per-kind dedup 避免刷屏,不同类不同 copy |
| 13 | **register / skip idempotent teardown** | gate 状态切换要 removeNotificationHandler 不然绕过 |
| 14 | **两阶段 connection load** | 本地快 / 远程慢,本地先可用 |
| 15 | **stub + graft 工具模型** | 主体声明骨架,运行时 fetchToolsForClient 嫁接 |
| 16 | **needs-auth 伪工具替换真工具** | OAuth 完成后 prefix-filter 自动移除伪工具 |
| 17 | **race silent-auth vs interactive** | XAA 可能直接成功,Promise.race 兼容 |
| 18 | **三种 RFC mismatch 校验**(resource/issuer/HTTPS) | 防 PRM mix-up + 防明文 token exchange |
| 19 | **shouldClearIdToken 按 OAuth 语义** | 5xx 保留(可能 IdP 短时挂);4xx 清;200 bad shape 清;非 JSON 保留 |
| 20 | **redactTokens on raw text() body** | error envelope 可能畸形 JSON,parse 前要先 redact |
| 21 | **discoverOidc trailing-slash fix** | new URL('/.well-known/...', issuer) 会丢 issuer 的 pathname |
| 22 | **classifyForCollapse 硬编码白名单** | 动态生态用白名单 + 保守不匹配不折叠 |

---

## 7. 待确认

1. `tools/ToolSearchTool` 未读——M03 提到过 ToolSearchTool 延迟暴露 tools,与 MCP 的"shouldDefer"模型相关,可能在另一个独立模块
2. `client.ts` 的具体 fetchToolsForClient 实现细节未深入(只知道是 graft 模式)
3. `cwdMcpAccess.ts` 的项目目录批准与 TrustDialog 的耦合未交叉验证

---

## 8. 与其它模块的接口

- **M03 Tool 系统**:fetchToolsForClient → AppState.tools 注入;`isConcurrencySafe`/`shouldDefer`/`isReadOnly` flag 走通用 orchestration
- **M04 权限**:MCPTool checkPermissions 默认 passthrough(走 ask),user/server 级 settings 可批量批准
- **M06 上下文**:postCompactCleanup 后,MCP tools 不应该被 evict(保留连接)
- **M19 State**:mcpClients / channelPermCallbacks 都在 AppState
- **M10 Bridge**:remote session 不直接管理 MCP client,通过 bridge 转发 invocation

---

> 下一步:M10 Bridge / M11 Ink / M12 Messages / M15 Skills / M16 Commands / M17 Config / M19 State,然后 Phase 4 大文件深入。
