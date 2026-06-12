# M17 · 配置 / Settings / 迁移

> 范围: `src/migrations/*.ts` (11 个 sync 迁移函数), `src/main.tsx:323-352` (`runMigrations` 调用点), `src/services/policyLimits/index.ts` (664 行 + `types.ts`), `src/services/remoteManagedSettings/{index.ts 639, syncCache.ts 113, syncCacheState.ts 97, securityCheck.tsx 74, types.ts 32}`, `src/services/settingsSync/{index.ts 582, types.ts 68}`. 关键依赖 `src/utils/settings/*` (settings.ts、settingsCache.ts、changeDetector.ts、internalWrites.ts、types.ts、constants.ts、applySettingsChange.ts)、`src/utils/config.ts` (getGlobalConfig/saveGlobalConfig/getMemoryPath/getCurrentProjectConfig/...)、`src/utils/auth.ts` (getClaudeAIOAuthTokens/getAnthropicApiKeyWithSource/isMaxSubscriber/isProSubscriber/isTeamPremiumSubscriber/checkAndRefreshOAuthTokenIfNeeded) — **dump 缺**,从 import use-site 推断契约.

---

## 一、迁移系统的工程契约

### 1.1 `CURRENT_MIGRATION_VERSION` + `runMigrations()`

`src/main.tsx:325-347`:

```ts
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    migrateEnableAllProjectMcpServersToSettings();
    resetProToOpusDefault();
    migrateSonnet1mToSonnet45();
    migrateLegacyOpusToCurrent();
    migrateSonnet45ToSonnet46();
    migrateOpusToOpus1m();
    migrateReplBridgeEnabledToRemoteControlAtStartup();
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer();
    }
    if ("external" === 'ant') {  // 编译时常量
      migrateFennecToOpus();
    }
    saveGlobalConfig(prev => prev.migrationVersion === CURRENT_MIGRATION_VERSION ? prev : {
      ...prev, migrationVersion: CURRENT_MIGRATION_VERSION
    });
  }
  // Async migration - fire and forget
  migrateChangelogFromConfig().catch(() => { /* retry next startup */ });
}
```

**设计精髓**:
- **整数版本号 `migrationVersion`** 存进 `~/.claude.json` 的 GlobalConfig — 不是 schema 版本(那种是 zod 的事)而是"已经跑过的迁移批次号". 每次加新迁移,bump 1 + 把新函数 append 到 `if` 块.
- **整个块用单一 `if` 守住**: 哪怕用户没有任何东西要迁移,只要版本对得上,11 个函数一个都不调,**冷启动零开销**. 这是 Bumping-version 比"每个函数单独判断"高效的核心理由.
- **`saveGlobalConfig(prev => prev.migrationVersion === ... ? prev : {...})`** 内层再做 idempotent check — 防止两个并发实例同时跑 `runMigrations`,后写入的版本号比前者旧.
- **每个迁移函数本身也必须 idempotent**(后述). 因为如果中间任何一个 throw,版本号不写入,下次启动会**全部重跑**.

### 1.2 Async 迁移单独 fire-and-forget

`migrateChangelogFromConfig()` 不在 if 块里,**每次启动都跑**且 `.catch(() => {})`. 为什么?
- 它是 IO 密集(读旧 changelog 文件、解析、合并),不能阻塞主流程.
- 失败无所谓 — 下次启动自动重试.
- **不依赖版本号守卫**,因为它内部自己判断"如果 v2 文件已经存在就 return".

**反例教训**: 不要把所有迁移都塞进 `runMigrations`. 同步迁移走版本号、异步走自闭环 — 两套机制各管一段.

---

## 二、11 个迁移的 idempotence 策略分类

每个迁移文件 22-118 行不等. 按"如何防止重复执行"分成 **4 类策略**.

### 2.1 完成 flag 写进 globalConfig

`resetAutoModeOptInForDefaultOffer.ts:27-46`:

```ts
const config = getGlobalConfig()
if (config.hasResetAutoModeOptInForDefaultOffer) return  // ← flag 守卫
// ... 业务逻辑
saveGlobalConfig(c => {
  if (c.hasResetAutoModeOptInForDefaultOffer) return c
  return { ...c, hasResetAutoModeOptInForDefaultOffer: true }
})
```

也用 flag 的: `resetProToOpusDefault` (`opusProMigrationComplete`), `migrateSonnet45ToSonnet46` (写 `sonnet45To46MigrationTimestamp` 作通知 flag), `migrateLegacyOpusToCurrent` (`legacyOpusMigrationTimestamp`).

**为什么 flag 在 globalConfig 而不是 settings?** 注释直接说: "Guard lives in GlobalConfig (~/.claude.json), not settings.json, so it survives settings resets and doesn't re-arm itself". — 用户 `claude config reset` 后 settings 清空了,迁移 flag 不能被清,否则会再次跑.

### 2.2 自闭环 (Self-idempotent reads)

`migrateAutoUpdatesToSettings.ts:18-23`:

```ts
if (
  globalConfig.autoUpdates !== false ||
  globalConfig.autoUpdatesProtectedForNative === true
) {
  return  // 没有"用户主动设了 false"的状态,什么都不做
}
// ... 迁移完成后 saveGlobalConfig 把 autoUpdates 字段从 config 里删掉
saveGlobalConfig(current => {
  const { autoUpdates: _, autoUpdatesProtectedForNative: __, ...updatedConfig } = current
  return updatedConfig
})
```

迁移操作本身把"待迁移的输入条件"删掉了,**第二次调用时 `globalConfig.autoUpdates` 是 undefined,不满足 !== false,直接 return**.

也是自闭环的: `migrateBypassPermissionsAcceptedToSettings`、`migrateEnableAllProjectMcpServersToSettings` (从 projectConfig 移到 localSettings 后从 projectConfig 删除字段)、`migrateReplBridgeEnabledToRemoteControlAtStartup`、`migrateFennecToOpus`.

**精髓**: **删除源字段 = 自动 idempotent**. 不要"既写新地方又留旧字段"想"以后再说" — 留下就成了第二次迁移的歧义触发器.

### 2.3 USER_TYPE 编译时 gate

`migrateFennecToOpus` 在 `main.tsx:340` 被 `if ("external" === 'ant')` 守住. 这是个**编译时常量**: 外部用户的 binary 里整个 if 块被 dead-code 消除,内部用户的 binary 里 `"external" === 'ant'` 在编译前会被替换为 `"ant" === 'ant'`. 这就和 M16 节的 `if (feature(X)) { require(...) }` 一个套路,**编译时彻底剔除**.

`migrateLegacyOpusToCurrent.ts` 走另一种 gate — `getAPIProvider() !== 'firstParty'` 直接 return,只对 firstParty (claude.ai) 用户跑.

### 2.4 Feature flag gate

`resetAutoModeOptInForDefaultOffer.ts:26`: `if (feature('TRANSCRIPT_CLASSIFIER')) { ... }`. — 远程能关. 主调点 `main.tsx:337` 也加同样的 gate,**双保险**(因为内部函数 gate 在编译时,主调 gate 影响是否进函数).

---

## 三、Settings 读取的"只读 userSettings"原则

`migrateSonnet45ToSonnet46.ts:38`:

```ts
const model = getSettingsForSource('userSettings')?.model
```

注释明说: **"Reads userSettings specifically (not merged) so we only migrate what /model wrote — project/local pins are left alone."**

为什么?settings.ts 内有 `getSettings_DEPRECATED()` 返回 **merged** 结果(local > project > user > managed). 如果迁移函数读 merged 结果:
- 用户在 project settings 里写了 `model: 'claude-sonnet-4-5-20250929'`(团队共享).
- 迁移看到 merged result 是 `claude-sonnet-4-5-...`,把它当成 user 的 pin,改写 user settings 为 `sonnet`.
- 结果: **静默把 project 层覆盖到了 user 层**,团队配置被悄悄拿到这个用户身上.

**精髓**: **迁移操作必须按"来源逐层判读"**,不能用合并结果. `getSettingsForSource(source)` 明确返回该 source 自己写的内容.

---

## 四、Removed-from-type keys 的 untyped cast

`migrateReplBridgeEnabledToRemoteControlAtStartup.ts:13-19`:

```ts
saveGlobalConfig(prev => {
  // The old key is no longer in the GlobalConfig type, so access it via
  // an untyped cast.
  const oldValue = (prev as Record<string, unknown>)['replBridgeEnabled']
  if (oldValue === undefined) return prev
  if (prev.remoteControlAtStartup !== undefined) return prev
  const next = { ...prev, remoteControlAtStartup: Boolean(oldValue) }
  delete (next as Record<string, unknown>)['replBridgeEnabled']
  return next
})
```

**模式**: 当你把一个字段从 type 中移除,但磁盘上的旧 config 文件**还有这个字段**:
1. 不能直接 `prev.replBridgeEnabled` (TS 报错).
2. 不能在 type 里加回去 (污染类型).
3. **正确做法**: 在迁移函数内**临时用 `Record<string, unknown>` cast** 读取/删除. 类型纯净 + 运行时正确.

---

## 五、PolicyLimits 服务架构

`src/services/policyLimits/index.ts` (664 行).

### 5.1 缓存 + 后台 polling 机制

```ts
const CACHE_FILENAME = 'policy-limits.json'           // 在 getClaudeConfigHomeDir()/
const POLLING_INTERVAL_MS = 60 * 60 * 1000            // 1 小时
const FETCH_TIMEOUT_MS = 10000                        // 10 秒
const DEFAULT_MAX_RETRIES = 5
const LOADING_PROMISE_TIMEOUT_MS = 30000              // 30 秒 deadlock guard

let sessionCache: PolicyLimitsResponse['restrictions'] | null = null
let pollingIntervalId: ReturnType<typeof setInterval> | null = null
let loadingCompletePromise: Promise<void> | null = null
let loadingCompleteResolve: (() => void) | null = null
```

启动流程:
1. `initializePolicyLimitsLoadingPromise()` 在 init.ts 早期调用,**只在 eligible 用户**(`isPolicyLimitsEligible()`)上创建 Promise.
2. 主流程任意位置可以 `await waitForPolicyLimitsToLoad()` — 阻塞到 promise resolve.
3. **30 秒 timeout 是个防死锁**: 如果 `loadPolicyLimits()` 因某种原因未被调用(SDK 测试场景),30 秒后 promise 强制 resolve,避免永远等.

### 5.2 ETag 条件请求

服务端用 sha256:hex 做内容指纹. 客户端持有上次的 sha → If-None-Match. 服务端如果未变 → 204/304,客户端用本地缓存. 这样**99% 的轮询零网络成本**.

### 5.3 ESSENTIAL_TRAFFIC_DENY_ON_MISS — HIPAA 反向规则

普通 fail-open: 拉不到 policy 就什么都不限制,继续跑.

HIPAA 用户不同:**`isEssentialTrafficOnly()` 为 true 时,拉不到 policy → 直接 deny**(因为 HIPAA 客户的安全姿态是"宁可拒绝服务也不能漏限制").

**精髓**: **fail-open 是默认,但合规客户需要 fail-closed**. 把"客户类型→失败策略"的映射写进代码,而不是靠一个全局开关.

### 5.4 缓存文件的 0o600 写入

```ts
await writeFile(getCachePath(), JSON.stringify({...}), { mode: 0o600 })
```

mode 0o600 = owner-only read/write. 多用户机器上别人偷不到 policy(里头可能有"哪些 model 被允许"的敏感信息).

### 5.5 测试用的 sync 重置

```ts
export function _resetPolicyLimitsForTesting(): void {
  stopBackgroundPolling()
  sessionCache = null
  loadingCompletePromise = null
  loadingCompleteResolve = null
}
```

注释明说: **"clearPolicyLimitsCache() does file I/O and is too expensive for preload beforeEach; this only clears the module-level singleton."** — 区分"产品 API 清缓存(含磁盘)"和"测试 API 清单例(纯内存)",测试速度差异很大.

---

## 六、RemoteManagedSettings 的 4 文件循环破除

这是 M17 最有工程含金量的一节. 看四个文件的职责分工:

### 6.1 文件分工表

| 文件 | 行 | 职责 | 依赖谁 |
|------|----|------|--------|
| `index.ts` | 639 | fetch / refresh / 后台 polling / 安全检查 / notifyChange | auth, settings/{changeDetector,types}, syncCache, syncCacheState, securityCheck |
| `syncCache.ts` | 113 | `isRemoteManagedSettingsEligible` (动 auth) + 包装 reset | auth, providers, syncCacheState |
| `syncCacheState.ts` | 97 | cache 状态 + 读 cache 文件 + 不动 auth 的 reset | **只动 leaves** (path/envUtils/fileRead/jsonRead/settingsCache/types) |
| `securityCheck.tsx` | 74 | blocking Ink dialog + gracefulShutdownSync | components/auth/settings |
| `types.ts` | 32 | lazy zod schema | zod, lazySchema |

### 6.2 为啥要拆 4 个文件?

`syncCacheState.ts:2-22` 注释直接讲:

> Split from syncCache.ts to break the **settings.ts → syncCache.ts → auth.ts → settings.ts** cycle. auth.ts sits inside the large settings SCC; importing it from settings.ts's own dependency chain pulls hundreds of modules into the eagerly-evaluated SCC at startup.
>
> This module imports only leaves (path, envUtils, file, json, types, settings/settingsCache — also a leaf, only type-imports validation). settings.ts reads the cache from here. syncCache.ts keeps isRemoteManagedSettingsEligible (the auth-touching part) and re-exports everything from here for callers that don't care about the cycle.

**精髓**: **TypeScript 模块系统在循环 import 时会有部分初始化的窗口**,在 Bun 编译 binary 后整个 SCC (Strongly Connected Component) 都被 eager 评估. 一个无意的 auth → settings → auth 循环会把"上百个模块"在启动期同步初始化,**冷启动慢 100ms+**.

破除手段: **把不动 auth 的纯状态逻辑提到 leaf 模块**. settings.ts 直接 import leaf,不再经过 syncCache.ts.

### 6.3 Tri-state eligibility 镜像

`syncCacheState.ts:34-49`:

```ts
let eligible: boolean | undefined  // tri-state

export function setEligibility(v: boolean): boolean {
  eligible = v
  return v
}

export function getRemoteManagedSettingsSyncFromCache(): SettingsJson | null {
  if (eligible !== true) return null  // undefined(未决定) 或 false(不合格) 都 return null
  // ...
}
```

`syncCache.ts:49-112` 的 `isRemoteManagedSettingsEligible()` **算完后必须 `setEligibility(result)` 把结果镜像到 leaf 模块**. 这样 leaf 不需要 import auth,只看本地的 boolean.

**精髓**: **当一个 leaf 模块需要某个上层函数的结果但又不能 import 它,就让上层"主动通知"leaf**. 这是 dependency inversion 的微型例子.

### 6.4 `resetSettingsCache()` 一次性触发的 gh-23085 修复

`syncCacheState.ts:72-95` (含修复说明):

```ts
export function getRemoteManagedSettingsSyncFromCache(): SettingsJson | null {
  if (eligible !== true) return null
  if (sessionCache) return sessionCache
  const cachedSettings = loadSettings()
  if (cachedSettings) {
    sessionCache = cachedSettings
    // Remote settings just became available for the first time. Any merged
    // getSettings_DEPRECATED() result cached before this moment is missing
    // the policySettings layer (the `eligible !== true` guard above returned
    // null). Flush so the next merged read re-merges with this layer visible.
    //
    // gh-23085: isBridgeEnabled() at main.tsx Commander-definition time
    // (before preAction → init() → isRemoteManagedSettingsEligible()) reached
    // getSettings_DEPRECATED() at auth.ts:115. The try/catch in bridgeEnabled
    // swallowed the later getGlobalConfig() throw, but the merged settings
    // cache was already poisoned.
    resetSettingsCache()  // ← 一次性 flush
    return cachedSettings
  }
  return null
}
```

故事:
1. main.tsx 在 Commander 定义阶段(早于 preAction)调 `isBridgeEnabled()`.
2. 它走到 `getSettings_DEPRECATED()`,此时 `eligible` 还是 undefined,**policySettings 层返回 null**.
3. 合并结果被缓存,缺 policySettings.
4. 后续 `init()` 跑 `isRemoteManagedSettingsEligible()` → eligible=true,但**之前的合并缓存已经 poison**.
5. 修复: 第一次从 leaf 拿到 cache 时,**主动 `resetSettingsCache()` 让合并缓存重算**.

**精髓教训**: **"合并缓存 + 异步层加载"是 bug 易发组合**. 任何"某层晚到"的设计都必须在层就位的瞬间触发上层缓存失效.

### 6.5 安全检查 → blocking dialog → 拒绝 graceful shutdown

`securityCheck.tsx` (74 行) `checkManagedSettingsSecurity` 返回 `'approved' | 'rejected' | 'no_check_needed'`. 实现是 mount 一个 Ink dialog **同步阻塞 stdin**,用户选 yes/no.

`handleSecurityCheckResult` 在 rejected 时:

```ts
gracefulShutdownSync(1)  // exit 1,清理进程
```

**为什么不只是 throw?** 因为这是个**最高优先级的安全决策** — 用户拒绝 enterprise 推下来的"危险设置"(比如 disable 某安全 hook),应用必须立即退出,**不能继续以可能不安全的状态运行**.

`hasDangerousSettings` / `hasDangerousSettingsChanged` / `extractDangerousSettings` 这三个谓词决定"哪些字段算危险" — dump 在 utils/settings/ 缺,但语义清楚: hooks 配置变更、permissions defaultMode 改成 bypassPermissions、env 注入新变量 等.

### 6.6 Externally-injected tokens 的特殊宽容

`syncCache.ts:74-85`:

```ts
const tokens = getClaudeAIOAuthTokens()

// Externally-injected tokens (CCD via CLAUDE_CODE_OAUTH_TOKEN, CCR via
// CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, Agent SDK, CI) carry no
// subscriptionType metadata — getClaudeAIOAuthTokens() constructs them with
// subscriptionType: null. The token itself is valid; let the API decide.
// fetchRemoteManagedSettings handles 204/404 gracefully (returns {}), and
// settings.ts falls through to MDM/file when remote is empty, so ineligible
// orgs pay one round-trip and nothing else changes.
if (tokens?.accessToken && tokens.subscriptionType === null) {
  return (cached = setEligibility(true))
}
```

**设计哲学**: 当本地没法判断时,**赌一次 round-trip**. 服务端会返回空设置,客户端 fall through,代价是一次网络. 比起"本地一刀切排除"导致 CCR 用户拿不到 enterprise 设置,这个代价划算.

### 6.7 Cowork VM 排除

`syncCache.ts:66-68`:

```ts
if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') {
  return (cached = setEligibility(false))
}
```

Cowork VM (local-agent entrypoint) 用自己的 permission model,**server-managed settings 设计给 CLI/CCD 用,在 VM 里不适用**. 注释明确说"MDM/file-based managed settings 仍然生效" — 那些靠物理部署,IT intent 不同.

---

## 七、SettingsSync 上下行 + downloadPromise dedup

`src/services/settingsSync/index.ts` (582 行) — 用户的 settings.json + CLAUDE.md 跨设备同步.

### 7.1 上行(interactive) vs 下行(CCR)

```
uploadUserSettingsInBackground()         ← main.tsx preAction 调,只在 interactive
downloadUserSettings() / redownloadUserSettings() ← print.ts runHeadless 调
```

**精髓**: **两个方向的触发点完全分离**.
- 交互式启动 → 你"现场"使用 → 把你写的东西上传.
- CCR (Claude Code Runner) 非交互 → "我需要 plugin 配置" → 拉下来.

不上传 + 下载的场景: CI / SDK / 自动化 — 它们不该把临时配置上传.

### 7.2 `downloadPromise` 去重

```ts
let downloadPromise: Promise<boolean> | null = null

export function downloadUserSettings(): Promise<boolean> {
  if (downloadPromise) return downloadPromise  // ← join existing fetch
  downloadPromise = (async () => { ... })()
  return downloadPromise
}
```

注释解释:**"Cached so the fire-and-forget at runHeadless entry and the await in installPluginsAndApplyMcpInBackground share one fetch."** — 两处入口,一处先 fire-and-forget,另一处后 await,**共享同一个 Promise** 而不是各起一次请求.

### 7.3 `redownloadUserSettings` 用于 `/reload-plugins`

`/reload-plugins` 命令需要重新下载. 此时 `downloadPromise` 可能还指向上次的 promise. 解决: redownload 内部**先清 promise 再重发**,允许第二次走全流程.

### 7.4 SYNC_KEYS contract

`src/services/settingsSync/types.ts:61-67`:

```ts
export const SYNC_KEYS = {
  USER_SETTINGS: '~/.claude/settings.json',
  USER_MEMORY: '~/.claude/CLAUDE.md',
  projectSettings: (projectId: string) =>
    `projects/${projectId}/.claude/settings.local.json`,
  projectMemory: (projectId: string) => `projects/${projectId}/CLAUDE.local.md`,
} as const
```

**注意**: project 维度只同步 **`settings.local.json`(我自己在这项目里的偏好)和 `CLAUDE.local.md`(我自己的项目记忆)**. 不同步 `settings.json` 和 `CLAUDE.md` — 那些是团队共享的,应该走 git 而不是云同步.

`projectId` 用 `getRepoRemoteHash()` 算 — git remote origin URL 的 sha,**跨机器同一 repo 总是同一个 id**,跨 fork 不撞.

### 7.5 500KB 上限 + atomic write

```ts
const MAX_FILE_SIZE_BYTES = 500 * 1024  // 匹配 backend
```

每个 entry 超 500KB 直接跳过上传 — backend 服务端也是这个限制. 客户端做镜像校验避免无用请求.

写文件时:
```ts
const handle = await fs.open(path, 'w', 0o600)
await handle.writeFile(content)
await handle.datasync()  // 强制刷盘到设备
await handle.close()
```

**`datasync()` 比 `sync()` 轻** — 只同步数据 + 修改时间,不 sync inode 元数据. 但保证了"如果 datasync 返回成功,断电也不丢内容".

### 7.6 markInternalWrite 抑制 spurious notifyChange

`src/utils/settings/internalWrites.ts` (dump 缺,从 use-site 推断契约):

```ts
import { markInternalWrite } from '../../utils/settings/internalWrites.js'

// 下载后写本地文件前
markInternalWrite(path)  // 告诉 changeDetector: 这是我自己写的,不要触发 onChange
await writeFile(path, content, ...)
```

为什么?settingsSync 拉到远程内容后写本地 settings.json. 文件 watcher 会触发 `settingsChangeDetector.notifyChange('userSettings')`. 触发什么?**重新读取 + 重置 cache + 通知 UI**. 但这次写入是 settingsSync 自己干的,**不需要通知** — 它马上就要 reset cache + clearMemoryFileCaches.

**精髓**: 任何"watcher + 我自己也写"的设计都要有"标记内部写入"的机制. 否则会自激震荡(我写 → watcher 触发 → 重读 → 又触发 watcher).

### 7.7 settingsChangeDetector.notifyChange 热重载

`remoteManagedSettings/index.ts:27,40` 拿到远程 settings 后:

```ts
settingsChangeDetector.notifyChange('policySettings')
```

这是个发布订阅模式 — UI 层订阅了变更,会在下一次 frame 重新 query settings. 用户体验上: 管理员推了新策略 → 1 小时内拉到 → UI 自动更新,**无需重启**.

---

## 八、各处共同的 fail-open 哲学

PolicyLimits、RemoteManagedSettings、SettingsSync — 三个服务都遵守:

1. **网络失败** → 用 stale cache,不阻塞业务.
2. **JSON 解析失败** → return null,不抛.
3. **schema 校验失败** → return null,记 telemetry.
4. **意外异常** → catch + 记日志,继续.

**唯一例外**: HIPAA 用户的 PolicyLimits 缺失 → deny essential traffic.

**为什么 fail-open 是默认?** 因为这些是**辅助系统**(增强体验、推送策略),核心业务(模型调用)不依赖它们. 它们挂了 → 用户依然能用 Claude Code,只是少了某些限制/同步. 反过来,如果让它们挂了导致 Claude Code 启动失败,**用户体验灾难**.

**fail-closed 的合规客户是另一码事**: 他们的"安全姿态"是"宁可不能用也不能漏限制" — 合规优先于可用性.

---

## 九、给做 Agent 的工程教训

照抄这些,做 Agent 时少走半年弯路:

1. **整数 migrationVersion + 单一 if 块** — 比"每个迁移单独判断"省事且零成本(对不需要迁移的用户).
2. **每个迁移必须 idempotent**: 三选一 — 完成 flag / 自闭环(删源字段) / 读 source-specific 数据.
3. **完成 flag 写 globalConfig 而非 settings** — 防 settings reset 时 flag 也被清.
4. **迁移读 `getSettingsForSource(source)` 而非 merged** — 避免静默 source 提升.
5. **type 删除字段时用 `Record<string, unknown>` cast** — 类型纯净 + 运行时正确.
6. **USER_TYPE + feature flag 双 gate**(编译时 + 运行时).
7. **async 迁移 fire-and-forget 单独跑** — 不阻塞主迁移,失败下次重试.
8. **远程配置 ETag + 后台 polling** — 减少 99% 流量,1 小时内热更新.
9. **30 秒 LOADING_PROMISE_TIMEOUT_MS** — 防"等不到的 Promise"导致死锁(SDK/测试场景).
10. **fail-open + 合规客户 fail-closed** — 把客户类型→失败策略写进代码.
11. **cache 文件 0o600** — 多用户机器防偷看.
12. **`_resetForTesting` sync-only 单例清** — 区分产品 API(含磁盘)和测试 API(纯内存).
13. **循环 import 用"leaf 模块 + 镜像 state"破除** — 避免 SCC eager 评估慢启动.
14. **Tri-state(undefined/false/true)而非 boolean** — 区分"未决"和"已知 false".
15. **某层晚到 → 该层就位瞬间触发上层缓存失效** — 防合并缓存被早期 null 层 poison.
16. **危险设置变更 → blocking dialog → reject 即 `process.exit(1)`** — 安全决策不能延迟.
17. **Externally-injected tokens(subscriptionType=null)赌一次 round-trip** — 比本地一刀切排除更友好.
18. **CLAUDE_CODE_ENTRYPOINT 区分调用场景** — 不同 entrypoint 走不同 eligibility.
19. **upload(interactive) vs download(headless)分离** — 触发点完全分开.
20. **downloadPromise 去重** — 多处入口共享单次 fetch.
21. **per-file 大小限制对齐 backend** — 客户端先校验,避免无用请求.
22. **`fs.open + datasync + close + 0o600`** 比 `writeFile` 安全且原子.
23. **markInternalWrite 抑制 watcher 自激震荡** — 我自己写 → 不通知.
24. **settingsChangeDetector.notifyChange 发布订阅** → UI 热重载,无需重启.
25. **SYNC_KEYS 只同步 `*.local.{json,md}`** — 团队共享的走 git,个人偏好走云.
26. **`getRepoRemoteHash()` 做 projectId** — 跨机器同 repo 同 id.

---

## 十、未读源 / 待补

| 文件 | 状态 | 影响 |
|------|------|------|
| `src/utils/settings/{settings.ts, settingsCache.ts, changeDetector.ts, internalWrites.ts, applySettingsChange.ts, constants.ts, types.ts, lazySchema.ts}` | **dump 缺** | 4 文件 cycle 破除的精髓已抓住,但 `getSettingsForSource`/`updateSettingsForSource`/`getSettings_DEPRECATED`/`resetSettingsCache`/`settingsChangeDetector` 具体实现要靠 use-site 推断 |
| `src/utils/config.ts` | **dump 缺** | `getGlobalConfig`/`saveGlobalConfig`/`getMemoryPath`/`getCurrentProjectConfig`/`saveCurrentProjectConfig` 都从这,但语义清楚(JSON 持久到 `~/.claude.json` / `~/.claude/projects/<sha>/.json`) |
| `src/utils/auth.ts` | **dump 缺** | `getClaudeAIOAuthTokens`/`getAnthropicApiKeyWithSource`/`isMaxSubscriber`/`isProSubscriber`/`isTeamPremiumSubscriber`/`checkAndRefreshOAuthTokenIfNeeded` 都是黑盒 |
| `src/components/ManagedSettingsSecurityDialog/*` | 未读 | securityCheck.tsx 仅是入口包装,真正 UI 渲染细节 |
| `src/utils/managedEnv.ts` | 未读 | `applyConfigEnvironmentVariables` — 用 user/flag/policy settings 设置 process.env 的逻辑 |
| `src/services/policyLimits/types.ts` | 未读 | `PolicyLimitsResponse` 字段完整列表(本 note 只看到了主流程使用) |

这些不阻塞 M17 架构理解 — 迁移系统、远程配置三件套、双数据源 reconcile 的精髓已经完整提炼,以上空缺只是某些函数的 body 实现细节.

---

## 十一、小结

M17 解决的核心问题:**怎么把"用户本地 config"、"团队 project settings"、"个人 local 偏好"、"管理员推下来的 policy"、"远程同步的 user data"五种来源安全合并,且**:

- **版本化迁移** 不阻塞冷启动且 idempotent(整数 version + 单一 if 块).
- **远程配置** ETag 节流 + 后台 polling + fail-open(HIPAA 例外 fail-closed).
- **循环依赖** 用 leaf 模块 + state 镜像破除,防止 SCC eager 评估慢启动.
- **危险变更** blocking dialog → reject 即 graceful exit.
- **写文件** 0o600 + datasync + markInternalWrite 防 watcher 自激.
- **同步上下行** interactive upload / headless download 分离 + Promise 去重.

这套机制和 M01(启动)联动(`runMigrations` 在 main.tsx preAction),和 M15(plugin)联动(SettingsSync 含 plugin 配置),和 M19(state)联动(`settingsChangeDetector.notifyChange` 触发 UI 重读),和 M10(bridge)联动(bridgeEnabled 的早期 getSettings 调用是 gh-23085 的引子).

设计最精髓的几条:
- **迁移 idempotent 的三种策略明确化**(flag / 自闭环 / source-specific 读).
- **远程配置 fail-open 默认 + 合规客户 fail-closed** 把客户类型映射进代码.
- **leaf 模块 + state 镜像** 破除 settings ↔ auth 大循环.
- **markInternalWrite + notifyChange** 让"我自己写 + 别人写"两种触发清晰区分.

这就是"配置系统不只是读个 JSON" — 它在多源、多设备、多角色、多合规要求下要做权衡,每条规则都对应一个生产事故.
