# M19 · 状态管理 (AppState + bootstrap/state.ts + 9 个 Context Provider)

> 范围: `src/state/store.ts` (34 行,createStore 原语),`src/state/AppStateStore.ts` (569 行,AppState 类型 + getDefaultAppState),`src/state/AppState.tsx` (199 行,AppStateProvider + useAppState/useSetAppState/useAppStateMaybeOutsideOfProvider),`src/state/onChangeAppState.ts` (171 行,CCR/SDK 外化 + settings persistence 单一 choke point),`src/state/selectors.ts` (76 行,纯派生选择器),`src/state/teammateViewHelpers.ts` (141 行,teammate view 状态转换),`src/bootstrap/state.ts` (1758 行,进程级 mutable 单例 + telemetry 计数器 + cost/duration accumulator + sticky beta header latches + scroll-drain debounce + sessionId atomic swap),`src/context/*.tsx` (9 个 context provider,共 ~1004 行).

---

## 一、设计哲学:三层状态分层

Claude Code 的"状态"并不是一个东西,而是**三层并存**:

| 层 | 持有者 | 生命周期 | 跨进程? | 谁能改 |
|----|--------|----------|---------|--------|
| `bootstrap/state.ts` 里的 `STATE` 单例 | Node 进程模块作用域 | 进程一辈子 | 否(每个进程独有) | 任意 setter 函数 |
| `AppState` (createStore + Provider) | React tree 顶层 | 一次 CLI 运行 | 否 | `useSetAppState` |
| 9 个 `src/context/*.tsx` Provider | 各自局部子树 | 子树挂载期间 | 否 | 各 hook |

为啥要分三层?**生命周期 + 关注点**:
- **bootstrap STATE**: 跟 React 无关的"早期就要有"的东西(cwd、sessionId、telemetry meter、cost 累计、auth token from fd、scroll-drain 标志). 在 React mount 之前的命令行解析阶段就要存在.
- **AppState**: 整个 UI 树需要订阅 + 响应的反应式状态(permission_mode、mainLoopModel、tasks、todos、speculation、replBridge 状态、notifications 队列、tool permission context...).
- **9 个 Context Provider**: 解决"特定子树的横切关注点",比如 mailbox 单例只在 AppStateProvider 内部可用,modal 子树需要知道自己被 FullscreenLayout modal slot 包围,stats reservoir 全局可读但只在 StatsProvider 内挂载, 等等.

这三层的设计精髓: **该 reactive 的进 AppState, 该 process-global 的进 bootstrap, 该子树局部的进 Context**. 一刀切都进 AppState → 早期模块依赖 React 启动; 一刀切都进 bootstrap STATE → UI 不会自动重渲. **错位会让冷启动 hang 或 UI 不响应**.

---

## 二、`store.ts` — 34 行的最小化 store 原语

整个反应式核心就 34 行:

```ts
// src/state/store.ts:4-34
export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return        // ★ 短路
      state = next
      onChange?.({ newState: next, oldState: prev })  // ★ 外化 hook
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)  // ★ 返回 unsubscribe
    },
  }
}
```

精髓:
1. **`Object.is` 短路**: 当 updater 返回原对象(常见 e.g. `prev => prev` 在条件不满足时)时,**整个通知链直接跳过** — 包括 onChange、所有订阅者. 这一行省下 N 次潜在 setState 引发的级联重渲.
2. **`onChange` hook 暴露 `{newState, oldState}` diff**: 而不是只给 newState. 这让 `onChangeAppState` 能跨 8+ 个 mutation path 集中处理"mode 从 X 变成 Y 时通知 CCR"这种 diff-based 逻辑 — 调用方零修改.
3. **`Set<Listener>`**: O(1) add/delete + 迭代,且天然去重.
4. **`subscribe` 返回 unsubscribe**: 与 React 19 的 `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)` 签名完全对齐 — 直接接进 React 不需要包装层.

这套 API 是 zustand/redux 的简化版,**没有 reducer、没有 middleware、没有 selector cache**. 不到 40 行,但跨整个 Claude Code 至少 4 个 store 复用(AppState、voice、stats 内部、speculation 内部).

---

## 三、`AppStateProvider` — 防嵌套 + 挂载竞态修正 + 设置同步 三件事

`src/state/AppState.tsx:37-110` (注意:dump 里是 React Compiler 编译过的版本,真实源码在末尾的 sourceMap 里恢复出来):

```tsx
const HasAppStateContext = React.createContext<boolean>(false)

export function AppStateProvider({ children, initialState, onChangeAppState }) {
  // 1. 防嵌套
  const hasAppStateContext = useContext(HasAppStateContext)
  if (hasAppStateContext) {
    throw new Error('AppStateProvider can not be nested within another AppStateProvider')
  }

  // 2. 单次 store 创建 (useState lazy init)
  const [store] = useState(() =>
    createStore<AppState>(
      initialState ?? getDefaultAppState(),
      onChangeAppState,
    ),
  )

  // 3. 挂载后竞态修正: 远程设置可能在 mount 之前就 load 完成,
  //    那时 settings 变更通知没人订阅, AppState 没及时收到. 这里补一次.
  useEffect(() => {
    const { toolPermissionContext } = store.getState()
    if (
      toolPermissionContext.isBypassPermissionsModeAvailable &&
      isBypassPermissionsModeDisabled()
    ) {
      logForDebugging('Disabling bypass permissions mode on mount (remote settings loaded before mount)')
      store.setState(prev => ({
        ...prev,
        toolPermissionContext: createDisabledBypassPermissionsContext(prev.toolPermissionContext),
      }))
    }
  }, [])

  // 4. 外部 settings 变化 → 同步进 AppState
  const onSettingsChange = useEffectEvent((source: SettingSource) =>
    applySettingsChange(source, store.setState),
  )
  useSettingsChange(onSettingsChange)

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        <MailboxProvider>
          <VoiceProvider>{children}</VoiceProvider>
        </MailboxProvider>
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}
```

设计精髓 4 条:

### 3.1 `HasAppStateContext` 防嵌套
**单独一个 boolean context** 而不是去看 `AppStoreContext` 是否为 null. 为什么?因为允许 store 为 null 的代码路径(`useAppStateMaybeOutsideOfProvider`)存在,如果用 AppStoreContext 的存在判定嵌套,会被这条路径混淆. 用一个**专门的 boolean** 干净.

### 3.2 store 单次创建
`useState(() => createStore(...))` 用 lazy initializer — 函数形式. **如果不是函数**,每次重渲都会调 `createStore(...)` 产生新 store(虽然只有第一次保留). 函数形式让 React 只在初次调用. 这是个常见 perf trap,Claude Code 主动规避.

### 3.3 挂载竞态修正
**这条最 subtle**. 注释解释:
> Check on mount if bypass mode should be disabled. This handles the race condition where remote settings load BEFORE this component mounts, meaning the settings change notification was sent when no listeners were subscribed. On subsequent sessions, the cached remote-settings.json is read during initial setup, but on the first session the remote fetch may complete before React mounts.

翻译: M17 的 RemoteManagedSettings 拉完远程 policy 后会 fire `notifyPermissionModeChanged` 之类的事件. 但**这个事件可能在 AppStateProvider mount 前就发生**(M17 的 `loadPolicyLimits` 后台跑). 那时 listener 集合还是空,事件没人收. mount 后补查一次"现在状态是不是该禁用 bypass" — 是就立即 setState 修正.

设计精髓: **任何"先发布,后订阅"的设计都要在订阅就位时主动补查一次源头状态**. 不能假设"事件触发时所有订阅者都已就位".

### 3.4 双向 settings 同步
`useSettingsChange` 是 M17 的 `settingsChangeDetector.notifyChange` 的 React hook 包装. 当 settings.json 在磁盘上被外部修改(file watcher 触发)或 settingsSync 下载完新远程,`onSettingsChange(source)` 被调,内部 `applySettingsChange(source, store.setState)` **从 settings 同步进 AppState**. 这一行解决 M17 → M19 的数据流贯通.

注意是 `useEffectEvent` 包的回调 — 这是 React 19 的新 hook,**回调始终 read 最新 props 但不进 dependency**. 避免每次 store/setState 变化重订阅 file watcher 这种昂贵副作用.

---

## 四、`useAppState(selector)` — Object.is + 选择器告警

```tsx
// src/state/AppState.tsx:142-163
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()
  const get = () => {
    const state = store.getState()
    const selected = selector(state)
    if (process.env.USER_TYPE === 'ant' && state === selected) {
      throw new Error(
        `Your selector in \`useAppState(${selector.toString()})\` returned the original state, ` +
        `which is not allowed. You must instead return a property for optimised rendering.`,
      )
    }
    return selected
  }
  return useSyncExternalStore(store.subscribe, get, get)
}
```

精髓:
1. **基于 `useSyncExternalStore`**: React 18+ 标准的外部 store 集成 API. 自动处理 tearing(并发模式下读到不一致的 snapshot).
2. **`state === selected` 抛错(ant only)**: 内部用户写 `useAppState(s => s)` 会立即抛错. 因为返回整个 state 失去 selector 优化 — 任何字段变都 re-render.
3. **JSDoc 警告"不要返回新对象"**: 见下方文档块原文:
```
Do NOT return new objects from the selector -- Object.is will always see
them as changed. Instead, select an existing sub-object reference:
  const { text, promptId } = useAppState(s => s.promptSuggestion) // good
```
**为啥?** 因为 `useSyncExternalStore` 默认用 `Object.is` 比较返回值. `s => ({foo: s.foo, bar: s.bar})` 每次 selector 跑都返回新对象,Object.is 总是 false → 永远 re-render. 取一个**已经存在的子对象引用**(`s => s.promptSuggestion`)就稳定,直到 setState 替换那个对象.

这条规则是 React 状态库使用的**普遍陷阱**,Claude Code 主动通过(1) JSDoc 警告 +(2) 内部用户抛错 双管齐下教育.

### 4.1 `useSetAppState` 稳定引用

```ts
export function useSetAppState() {
  return useAppStore().setState
}
```

注释明示: 返回**stable reference**, 永远不变. **只用这个 hook 的组件 — 一辈子不 re-render**(因为不订阅).

这是个常见 perf 优化点 — 表单/dialog 这种"只写不读"的组件用 useSetAppState 就够,不要 useAppState(s => s.foo) 然后扔掉 foo.

### 4.2 `useAppStateMaybeOutsideOfProvider` — NOOP_SUBSCRIBE

```ts
// src/state/AppState.tsx:180-199
const NOOP_SUBSCRIBE = () => () => {}

export function useAppStateMaybeOutsideOfProvider<T>(
  selector: (state: AppState) => T,
): T | undefined {
  const store = useContext(AppStoreContext)
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    () => store ? selector(store.getState()) : undefined,
  )
}
```

精髓: 用 `NOOP_SUBSCRIBE` 让 `useSyncExternalStore` 在 store 不存在时也合法运行(返回 undefined). 用途: **测试**(组件单独 mount 不带 Provider)和**孤立组件**(某些工具入口在 AppStateProvider 外部).

`NOOP_SUBSCRIBE` 必须返回**返回 unsubscribe 函数的函数** — useSyncExternalStore 期望 subscribe 总返回一个 unsubscribe. 这种细节没注意会引发 React 警告.

---

## 五、`AppState` 类型 — 80+ 字段 DeepImmutable + 函数字段碰头

`src/state/AppStateStore.ts:89-452` 是个**巨型 union type** — 上半部分 `DeepImmutable<{...}>` 包装,下半部分纯类型(不 immutable). 为啥分?

```ts
export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  // ... 30+ 纯数据字段 ...
  replBridgeError: string | undefined
  showRemoteCallout: boolean
}> & {
  // Unified task state - excluded from DeepImmutable because TaskState contains function types
  tasks: { [taskId: string]: TaskState }
  agentNameRegistry: Map<string, AgentId>
  // ...
  speculation: SpeculationState  // messagesRef: { current: Message[] } 内含 mutable ref
  // ...
  channelPermissionCallbacks?: ChannelPermissionCallbacks  // 内含 function
}
```

精髓: **DeepImmutable 用不上的字段单独列出**. 函数类型在 DeepImmutable 下会被强转成 readonly 函数,看似无害但会让 TypeScript 报错(`Type 'readonly Function' is not assignable to 'Function'`). 把这些字段**剥离出 DeepImmutable wrapper**, 编译干净.

### 5.1 `CompletionBoundary` 区分联合

```ts
export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | { type: 'denied_tool'; toolName: string; detail: string; completedAt: number }
```

每个 case 字段不一样 — 用 discriminated union 让消费方用 `switch (b.type)` 类型安全访问. 不是 `{type: string, command?: string, filePath?: string, ...}` 那种"什么都可能空"的 pseudo-union.

### 5.2 `SpeculationState` mutable ref 模式

```ts
export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      messagesRef: { current: Message[] }  // ★ 可变 ref
      writtenPathsRef: { current: Set<string> }
      contextRef: { current: REPLHookContext }
      // ...
    }
```

**为啥用 ref 而不是直接放数组?** Speculation 是后台运行的"预测下一个 turn",会**高频追加** messages. 如果直接 `Message[]` 放在 AppState,每次 push 都要:
1. 调 setState → updater 返回新 SpeculationState 对象 → 新 Messages 数组
2. 通知所有订阅者 → re-render

每条 message 都触发一次 cascade. **改成 `messagesRef.current = [...prev, newMsg]` 直接 mutate**,SpeculationState 对象引用不变, AppState 引用不变, **不触发 re-render**. 直到 speculation 完成需要"提交"时才一次 setState 切换到 idle 状态.

这是 React 状态库的高级用法 — **mutable ref escape hatch**. 但要小心:**任何读这些 ref 的组件必须有自己的 trigger 重渲机制**(比如订阅一个 status changes 字段). Claude Code 用 `messagesRef` 配合外部 timer/event 触发 UI 更新.

### 5.3 `IDLE_SPECULATION_STATE` 单例

```ts
export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }
```

为啥常量?**多次"恢复 idle"时复用同一个引用**, Object.is 短路. 否则每次 `setState(prev => ({...prev, speculation: {status: 'idle'}}))` 都是新对象, useAppState(s => s.speculation) 会假警报.

### 5.4 `getDefaultAppState` lazy require 破循环

```ts
export function getDefaultAppState(): AppState {
  // Use lazy require to avoid circular dependency with teammate.ts
  /* eslint-disable @typescript-eslint/no-require-imports */
  const teammateUtils = require('../utils/teammate.js') as typeof import('../utils/teammate.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired()
      ? 'plan'
      : 'default'
  return { /* ... 80+ 字段初始值 ... */ }
}
```

`teammate.ts` 反过来 import 一些 state 字段(它读 AppState 检测自己是不是 teammate). 顶层 import 会成循环 → eager 求值阶段 teammate.ts 拿到的 state exports 是空对象. lazy `require` 推迟到**第一次调用 `getDefaultAppState()`**(此时所有模块都已加载),避免循环.

跟 M17 SettingsSync 的"leaf 模块 + state 镜像"是不同的破循环手法 — 那个是**结构拆分**,这个是**调用时机推迟**. 哪个更优?**结构拆分更干净,但成本是新增模块**;lazy require **零结构改动但有运行时 require 开销**(每次调). Claude Code 在 AppStateStore 这个**只在启动调一次**的场景用 lazy require,在 settings 高频读的场景用结构拆分 — 选择由频率决定.

---

## 六、`onChangeAppState` — CCR/SDK 外化 + settings persistence 单一 choke point

`src/state/onChangeAppState.ts:43-171` 是整个 M19 最有工程价值的一块. 简化结构:

```ts
export function onChangeAppState({ newState, oldState }) {
  // 1. permission_mode 变化 → CCR + SDK 通知
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // 内部 mode (bubble, ungated auto) 外化成 'default' / 'plan' / ...
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // ultraplan 只在首次进 plan 时 true, 之后 null (RFC 7396 删除键)
      const isUltraplan =
        newExternal === 'plan' && newState.isUltraplanMode && !oldState.isUltraplanMode
          ? true : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newMode)  // SDK channel 拿原始 mode
  }

  // 2. mainLoopModel 变化 → 写 userSettings
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    if (newState.mainLoopModel === null) {
      updateSettingsForSource('userSettings', { model: undefined })
      setMainLoopModelOverride(null)
    } else {
      updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
      setMainLoopModelOverride(newState.mainLoopModel)
    }
  }

  // 3. expandedView → 旧字段 showExpandedTodos + showSpinnerTree
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(c => ({ ...c, showExpandedTodos, showSpinnerTree }))
    }
  }

  // 4. verbose 变化 → 写 globalConfig
  if (newState.verbose !== oldState.verbose && getGlobalConfig().verbose !== newState.verbose) {
    saveGlobalConfig(c => ({ ...c, verbose: newState.verbose }))
  }

  // 5. settings 变化 → 清 auth 缓存 + 重应用 env
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      clearAwsCredentialsCache()
      clearGcpCredentialsCache()
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
```

注释里写明这个 choke point 的来历:

> Prior to this block, mode changes were relayed to CCR by only 2 of 8+ mutation paths: a bespoke setAppState wrapper in print.ts (headless/SDK mode only) and a manual notify in the set_permission_mode handler. Every other path — Shift+Tab cycling, ExitPlanModePermissionRequest dialog options, the /plan slash command, rewind, the REPL bridge's onSetPermissionMode — mutated AppState without telling CCR, leaving external_metadata.permission_mode stale and the web UI out of sync with the CLI's actual mode.

这是一个**典型的"散点 mutation 漏更新"bug** 的彻底修复. 原本 mode 在 8+ 个地方被改,只有 2 个记得通知 CCR. 现在**把通知逻辑挪到 store 层的 diff 检测**, 任意 setState 改 mode 都自动通知,**调用方零修改**.

精髓: **跨多个 mutation path 的 side effect 应该放在 store 的 onChange 钩子里,而不是每个 mutation 现场调**. 这是 store 设计的"中心化 side effect"模式.

### 6.1 内部 mode 外化

```ts
const prevExternal = toExternalPermissionMode(prevMode)
const newExternal = toExternalPermissionMode(newMode)
if (prevExternal !== newExternal) { /* 通知 CCR */ }
```

内部 mode 有 `bubble`、`ungated auto` 这种内部状态,CCR 不该知道. 用 `toExternalPermissionMode` 把所有内部状态映射成外部公开的 `'default' | 'plan' | 'auto' | ...`. **如果外部 mode 没变**(比如 default → bubble → default 都映射成 'default')就**跳过 CCR 通知** — 不发噪声. 但 `notifyPermissionModeChanged(newMode)` 走 SDK channel 拿**原始 mode**(SDK consumer 可能想知道细粒度变化,自己 filter).

精髓: **每个出口的 audience 不同,各自决定 filter 粒度**. 不要在 store 层统一 filter — 那样 SDK consumer 就拿不到细节.

### 6.2 isUltraplan first-cycle gate

```ts
const isUltraplan =
  newExternal === 'plan' && newState.isUltraplanMode && !oldState.isUltraplanMode
    ? true : null
```

只在 isUltraplanMode 从 false → true 的**第一个 plan 转换**发 `true`. 后续 plan 周期 isUltraplanMode 仍 true 但 oldState 也是 true → 发 `null`(RFC 7396 JSON Merge Patch 里 null 表示"删除这个 key"). 这告诉 CCR external_metadata: 第一次进 ultraplan 时设标记,之后**不要在每个 plan 周期都重发**.

精髓: **状态转换通常关心 transition 边沿, 不是常态. 用 `(oldX && !newX) || (!oldX && newX)` 检测边沿, 不要每次状态都 fire**.

### 6.3 mainLoopModel 双向持久化

mode 改成 null → 从 userSettings 删 model 字段; mode 改成具体值 → 写 userSettings. **AppState 是 single source of truth, settings 是镜像**. 任何改 mainLoopModel 的代码不需要自己写 settings,store hook 自动持久化.

### 6.4 expandedView 拆成两个旧字段

```ts
const showExpandedTodos = newState.expandedView === 'tasks'
const showSpinnerTree = newState.expandedView === 'teammates'
```

旧版 config 有 `showExpandedTodos` 和 `showSpinnerTree` 两个布尔. 新版 AppState 统一成 `'none' | 'tasks' | 'teammates'` 一个枚举. 但**旧版 config 还要兼容**, 所以 store hook 把新枚举**拆成两个旧布尔写回 globalConfig**.

精髓: **重构内部表示时,外部表示(磁盘 schema)用 adapter 维持兼容**. 别贪图一次砍掉旧字段 — 用户的 settings.json 可能已经有旧字段,需要平滑过渡.

### 6.5 settings 变化 → auth 缓存失效

```ts
if (newState.settings !== oldState.settings) {
  clearApiKeyHelperCache()
  clearAwsCredentialsCache()
  clearGcpCredentialsCache()
  if (newState.settings.env !== oldState.settings.env) {
    applyConfigEnvironmentVariables()
  }
}
```

settings 里可能含 `apiKeyHelper` 命令、AWS 凭据路径、GCP 凭据路径 — 缓存这些的函数必须在 settings 变时清缓存, 下次重新计算. **如果不清,下一次 API 调用还用旧 key**.

`env` 单独再判: settings.env 是个 map,变化后要**重新应用到 process.env**(additive,不删现有 env). 这一条让 `/config` 修改 env 后**当场生效**而不需要重启.

精髓: **store 的 onChange 是清缓存的最佳位置** — 它是 "settings 真正变了" 的事件源, 不需要 file watcher、不需要订阅链.

### 6.6 `externalMetadataToAppState` 反向映射

```ts
// src/state/onChangeAppState.ts:24-41
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string' ? {
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: permissionModeFromString(metadata.permission_mode),
      },
    } : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean' ? {
      isUltraplanMode: metadata.is_ultraplan_mode,
    } : {}),
  })
}
```

CCR worker 重启或 SDK reconnect 时,从 CCR 拿回 external_metadata,**反向应用到 AppState**. 这是 outbound 通知(onChangeAppState)的对偶 — inbound restore. **两边对称**,保证 CLI ↔ CCR 双向同步.

精髓: **任何 outbound 通知都需要对应的 inbound restore**. 否则 worker 重启后状态不一致.

---

## 七、`selectors.ts` — 纯派生函数,不缓存

```ts
// src/state/selectors.ts:18-40
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const { viewingAgentTaskId, tasks } = appState
  if (!viewingAgentTaskId) return undefined
  const task = tasks[viewingAgentTaskId]
  if (!task) return undefined
  if (!isInProcessTeammateTask(task)) return undefined
  return task
}

// src/state/selectors.ts:46-76
export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

export function getActiveAgentForInput(appState: AppState): ActiveAgentForInput {
  const viewedTask = getViewedTeammateTask(appState)
  if (viewedTask) return { type: 'viewed', task: viewedTask }

  const { viewingAgentTaskId, tasks } = appState
  if (viewingAgentTaskId) {
    const task = tasks[viewingAgentTaskId]
    if (task?.type === 'local_agent') {
      return { type: 'named_agent', task }
    }
  }
  return { type: 'leader' }
}
```

精髓:
1. **纯函数,无副作用,无缓存**: 文件头部注释 "Keep selectors pure and simple - just data extraction, no side effects."
2. **`Pick<AppState, 'a' | 'b'>` 参数类型**: `getViewedTeammateTask` 只用两个字段,在签名里**明确声明**. 让测试可以传 `{viewingAgentTaskId, tasks}` 而不是构造整个 AppState. 这是 TypeScript "narrow your parameter type" 最佳实践.
3. **discriminated union 返回**: `ActiveAgentForInput` 三个 case 各带不同 payload — 消费方用 switch(r.type) 类型安全处理.

为啥不缓存?**selector 复杂度低 + AppState 不频繁变更** → 缓存反而徒增内存. reselect/zustand 风格的 memo selector 在这里是 over-engineering.

---

## 八、`teammateViewHelpers.ts` — 内联破循环 + retention 解绑

`src/state/teammateViewHelpers.ts:1-141`. 几个有意思的设计:

### 8.1 内联 `isLocalAgent` + 内联 `PANEL_GRACE_MS`

```ts
// src/state/teammateViewHelpers.ts (顶部)
const PANEL_GRACE_MS = 30_000

function isLocalAgent(task: TaskState): task is LocalAgentTaskState {
  return task.type === 'local_agent'
}
```

**为啥不 import 这两个?** 因为 `isLocalAgent` 在 `src/tasks/LocalAgentTask/LocalAgentTask.js`, `PANEL_GRACE_MS` 在 `src/components/BackgroundTasksDialog.tsx`. 这两个文件都 import 了 state/AppState — 反过来 import 它们会形成循环.

**精髓**: **小到一个 3 行函数和一个常量, 也值得 inline 复制以打破循环**. 不要为了"DRY 原则"硬拉 import 制造循环.

这跟 M17 SettingsSync 拆 4 文件破循环是同种思路的不同尺度.

### 8.2 `release(task)` retention 解绑

```ts
// src/state/teammateViewHelpers.ts
function release(task: TaskState): TaskState {
  if (!task.retain) return task

  const evictAfter =
    task.status === 'completed' || task.status === 'failed' || task.status === 'aborted'
      ? Date.now() + PANEL_GRACE_MS  // 终态 → 30s 宽限
      : task.evictAfter

  return {
    ...task,
    retain: false,
    messages: undefined,        // ★ 释放消息引用
    diskLoaded: false,
    evictAfter,
  }
}
```

teammate task 在用户**正在 view** 时 `retain: true`(不会被 background reclaim 进程释放). 用户切走时 `release(task)`:
- 把 `retain` 设 false → background reclaim 可以回收
- **设 `messages: undefined`** → 立即释放可能很大的消息数组(让 GC 收回)
- 终态 task 多给 30s 宽限期(`evictAfter = now + PANEL_GRACE_MS`) — 万一用户立刻切回还能恢复; 30s 后才彻底丢

精髓:
1. **`retain` 字段 + reclaim 进程** = 显式 reference counting. 比纯 GC 更可控.
2. **手动 `messages: undefined`** 是显式释放. 不依赖 React 卸载或 GC.
3. **30s 宽限** = "用户可能反悔" 的 UX 保留窗口. 比"切走立即丢"友好.

### 8.3 `enterTeammateView` / `exitTeammateView` / `stopOrDismissAgent`

三个高阶 helper 把"切换 teammate view"的复杂 setState 集中起来:

```ts
export function enterTeammateView(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  agentTaskId: string,
) {
  setAppState(prev => {
    // 从前一个 view 释放
    const prevId = prev.viewingAgentTaskId
    let tasks = prev.tasks
    if (prevId && prevId !== agentTaskId && tasks[prevId]) {
      tasks = { ...tasks, [prevId]: release(tasks[prevId]!) }
    }
    // 进入新的 view
    const newTask = tasks[agentTaskId]
    if (newTask) {
      tasks = { ...tasks, [agentTaskId]: { ...newTask, retain: true, evictAfter: undefined } }
    }
    return { ...prev, viewingAgentTaskId: agentTaskId, tasks }
  })
}

export function exitTeammateView(setAppState) {
  setAppState(prev => {
    const prevId = prev.viewingAgentTaskId
    if (!prevId) return prev  // ★ Object.is 短路
    let tasks = prev.tasks
    if (tasks[prevId]) {
      tasks = { ...tasks, [prevId]: release(tasks[prevId]!) }
    }
    return { ...prev, viewingAgentTaskId: undefined, tasks }
  })
}
```

精髓:
1. **释放旧 + 留住新** 单次 setState 原子完成. 不能拆成两个 setState — 中间 Render 会看到"两个 task 都 retain"或"都不 retain"的中间态.
2. **未 viewing 时 `exitTeammateView` 直接 return prev** → Object.is 短路.

`stopOrDismissAgent(setAppState, taskId)` 根据 task 状态选择行为:
- running → 调 task.abort() + 设状态 'aborted'
- terminal → 立即 evict (`evictAfter = 0`)

**上下文敏感的 X 按钮**: 同一个 X 键,根据 task 当前状态做完全不同的事. UX 自然.

---

## 九、`bootstrap/state.ts` — 1758 行的进程级单例

### 9.1 顶部三条警告

```ts
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE
// ALSO HERE - THINK THRICE BEFORE MODIFYING
// AND ESPECIALLY HERE
```

这种 gatekeeping comment **不是装饰** — 任何新增字段都要 reviewer 警惕. global state 是逐步腐烂的源头,Claude Code 用强制性注释维持纪律.

### 9.2 `State` 类型 — 60+ 字段

按主题分组(部分):

**身份**: `originalCwd / projectRoot / cwd, sessionId / parentSessionId`
**成本**: `totalCostUSD / totalAPIDuration / totalAPIDurationWithoutRetries / totalToolDuration / totalLinesAdded / totalLinesRemoved / lastTurnApiDurationMs / lastTurnApiDurationWithoutRetriesMs / lastTurnDurationMs / lastTurnStartedAt`(turn-scoped accumulators)
**Telemetry**: `meter / sessionCounter / locCounter / prCounter / commitCounter / costCounter / tokenCounter / codeEditToolDecisionCounter / activeTimeCounter / loggerProvider / eventLogger / meterProvider / tracerProvider`
**Model**: `modelUsage / mainLoopModelOverride / initialMainLoopModel / modelStrings`
**Client/Session**: `clientType / sessionSource / isInteractive / kairosActive / strictToolResultPairing`
**Settings sourcing**: `sessionIngressToken / oauthTokenFromFd / apiKeyFromFd / flagSettingsPath / flagSettingsInline / allowedSettingSources`
**Session-only flags**: `inlinePlugins / chromeFlagOverride / useCoworkPlugins / sessionBypassPermissionsMode / scheduledTasksEnabled / sessionCronTasks / sessionCreatedTeams / sessionTrustAccepted / sessionPersistenceDisabled / hasExitedPlanMode / needsPlanModeExitAttachment / needsAutoModeExitAttachment / lspRecommendationShownThisSession`
**Agent**: `agentColorMap / agentColorIndex / mainThreadAgentType`
**Bug-report buffer**: `lastAPIRequest / lastAPIRequestMessages / lastClassifierRequests`
**ClaudeMd cache**: `cachedClaudeMdContent`(注释解释 break yoloClassifier → claudemd → filesystem → permissions cycle)
**Error log**: `inMemoryErrorLog`(MAX 100, FIFO)
**SDK hooks**: `registeredHooks`
**Plan slug**: `planSlugCache: Map<string, string>`(per-session, 在 `regenerateSessionId` 时清当前 session 的)
**Teleport**: `teleportedSessionInfo`
**Skills**: `invokedSkills: Map<key, InvokedSkillInfo>`(key 是 `${agentId??''}:${skillName}` — 跨 agent 不串)
**Slow ops**: `slowOperations`(ant only, dev bar 用)
**Beta latches**: `afkModeHeaderLatched / fastModeHeaderLatched / cacheEditingHeaderLatched / thinkingClearLatched`(once true, 永远 true 不复位 — 防 prompt cache bust)
**Prompt cache**: `promptCache1hAllowlist / promptCache1hEligible`(latched on first eval)
**Channels**: `allowedChannels: ChannelEntry[] / hasDevChannels`
**Misc**: `additionalDirectoriesForClaudeMd, systemPromptSectionCache, lastEmittedDate, sessionProjectDir, promptId, lastMainRequestId, lastApiCompletionTimestamp, pendingPostCompaction, replBridgeActive?`

### 9.3 `getInitialState()` — cwd realpath + NFC + EPERM fallback

```ts
const rawCwd = process.cwd()
let resolvedCwd: string
try {
  resolvedCwd = realpathSync(rawCwd).normalize('NFC')
} catch (e: any) {
  if (e?.code === 'EPERM') {
    resolvedCwd = rawCwd.normalize('NFC')  // CloudStorage mount issue
  } else {
    throw e
  }
}
```

精髓:
1. **`realpathSync`**: 把 symlink 解析成真实路径. `~/.claude` 是 symlink 时拿真实路径.
2. **`.normalize('NFC')`**: Unicode 规范化. macOS 文件系统用 NFD(分解形式),`á` 存成 `a + ́` 两个 codepoint. NFC 把它合并成 `á` 一个. 没规范化会导致字符串比较失败、Map key 不命中.
3. **`EPERM` fallback**: 某些 CloudStorage mount(iCloud Drive 等)对 realpath 报权限错. 不能让 Claude Code 因为 cwd 在 iCloud 里就挂掉,**回退用 raw cwd**(只走 NFC 规范化).

```ts
sessionId: randomUUID() as SessionId,
// eslint-disable-next-line @typescript-eslint/no-restricted-paths
```

`sessionId` 由 `src/utils/crypto.js` 提供的 `randomUUID` 生成. **path-alias** 让 browser SDK 编译时通过 package.json 的 "browser" 字段 swap 成 `crypto.browser.ts`(用 webcrypto). eslint-disable 是因为 bootstrap 模块按规范不该 import application 层 utils — 这里手动豁免,因为 crypto 是孤立 leaf, 不会引发循环.

```ts
...(USER_TYPE === 'ant' ? { replBridgeActive: false } : {}),
```

**Spread injection**: USER_TYPE 是编译时常量,外部 binary 这一行被 dead-code 消除,**`replBridgeActive` 字段不存在于外部用户的 STATE 类型**. 跟 M17 第六章的 USER_TYPE gate 同套路.

### 9.4 `switchSession` 原子交换 — CC-34

```ts
const sessionSwitched = createSignal<{ from: SessionId; to: SessionId }>()
export const onSessionSwitch = sessionSwitched.subscribe

export function switchSession(sessionId: SessionId, projectDir: string | null = null) {
  const from = STATE.sessionId
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit({ from, to: sessionId })
}
```

注释明示: "there is no separate setter for either, so they cannot drift out of sync (CC-34)".

精髓: **必须一起变的两个字段绝不能有独立 setter**. 单一函数原子交换. CC-34 是个真实事故 — 早期 sessionId 和 projectDir 各有 setter,某次代码改动只调了 sessionId 的 setter, projectDir 错乱.

`sessionSwitched` 用 `createSignal`(M19 之外的小工具),让外部模块订阅. **bootstrap 不能直接 import listener**(DAG leaf 规则), 所以暴露 `onSessionSwitch = sessionSwitched.subscribe`, 调用方 register 进来. M01(concurrent sessions, 维护 PID 文件)就靠这个跟 `--resume` 同步.

### 9.5 `regenerateSessionId` — planSlugCache 边界清理

```ts
export function regenerateSessionId({ setCurrentAsParent }: { setCurrentAsParent: boolean }) {
  if (setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  // 清出 going 的 session 的 planSlugCache 条目,防 map 无限增长
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  sessionSwitched.emit({ from: prev, to: STATE.sessionId })
}
```

精髓: **Map 类 cache 在 key 不再使用时主动 delete**. 不然反复 `/resume` 会把 planSlugCache 堆成几 MB.

### 9.6 cwd setters — 全部 NFC normalize

```ts
export function setOriginalCwd(value: string): void { STATE.originalCwd = value.normalize('NFC') }
export function setProjectRoot(value: string): void { STATE.projectRoot = value.normalize('NFC') }
export function setCwdState(value: string): void { STATE.cwd = value.normalize('NFC') }
```

每个 setter 都规范化. **不能依赖 caller 记得 normalize** — 总会有人忘.

注意: `getProjectRoot()` 一旦在启动设定,**就不再变**, 即使用户在 session 中间用 EnterWorktreeTool 切了 worktree(`cwd` 会变, `projectRoot` 不变). 这让 skills 路径、history 路径**锚定在最初的 project**, 不受 mid-session 切换影响.

### 9.7 `updateLastInteractionTime` dirty-bit 批量化

```ts
let interactionTimeDirty = false

export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    STATE.lastInteractionTime = Date.now()
    interactionTimeDirty = false
  } else {
    interactionTimeDirty = true  // 标脏, 不立即 Date.now()
  }
}

export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    STATE.lastInteractionTime = Date.now()
    interactionTimeDirty = false
  }
}
```

`flushInteractionTime` 被 Ink renderer 在每帧渲染前调一次. 即使一秒内有 100 次按键,**Date.now() 只调一次**(每帧). 这是个 React/Ink 友好的"throttle to frame rate"模式.

`immediate=true` 用于 useEffect 之类的"已经过 render 循环"的回调 — 此时如果不立即写, dirty bit 在空闲期不会被 flush(没下一帧). 经典用例: permission dialog 等待用户输入时.

### 9.8 Scroll-drain hot-path — 模块作用域

```ts
let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | null = null
const SCROLL_DRAIN_IDLE_MS = 150

export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => { scrollDraining = false }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer?.unref?.()
}

export function getIsScrollDraining(): boolean { return scrollDraining }

export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    // eslint-disable-next-line no-restricted-imports
    await new Promise(r => setTimeout(r, 50))
  }
}
```

精髓:
1. **不进 STATE 而进模块作用域**: 这是个**高频读 + 高频写**的标志位. 进 STATE 会触发 STATE 类型膨胀且没有任何订阅价值. 模块作用域更轻.
2. **`unref?.()`**: timer 不阻止进程退出. 用户 Ctrl+C 时不用等 timer 触发.
3. **`waitForScrollIdle` 在网络/子进程调用前用**: 用户正在快速滚动 transcript 时, **不要发起新的 API call**(会卡 UI 重渲, 用户体验差). 调用方 `await waitForScrollIdle()` 让 IO 等 150ms idle.
4. **eslint-disable inline sleep**: bootstrap 模块按规范不能 import 共享 `sleep()` 工具(怕引入循环). 这里直接用裸 setTimeout, eslint 抗议但注释说明.

### 9.9 Turn budget continuation

```ts
let outputTokensAtTurnStart = 0
let currentTurnTokenBudget: number | null = null
let budgetContinuationCount = 0

export function snapshotOutputTokensForTurn(budget: number | null): void {
  outputTokensAtTurnStart = STATE.totalTurnOutputTokens
  currentTurnTokenBudget = budget
  budgetContinuationCount = 0
}
```

每个 turn 开始记下 baseline output tokens 数 + 预算上限. inference loop 跑到一半发现"我这个 turn 已经用 X tokens, 距上限 Y", 决定要不要 split 成下一个 turn. budgetContinuationCount 数当前 turn 已经触发过几次 continuation.

为啥不进 STATE? 同上 — 高频访问 + 无订阅需求 + turn-scoped, 模块作用域足够.

### 9.10 `markPostCompaction` / `consumePostCompaction` 单次 flag

```ts
let pendingPostCompaction = false

export function markPostCompaction(): void { pendingPostCompaction = true }

export function consumePostCompaction(): boolean {
  const v = pendingPostCompaction
  pendingPostCompaction = false
  return v
}
```

`/compact` 完成后调 mark. 下次 `logAPISuccess` 调 consume — 拿到 true 就知道"这次 API 调用前刚 compact 过, cache miss 是 compact 引起的, 不是 TTL 过期". 区分这两种 cache miss 让 telemetry 准确.

精髓: **one-shot flag 模式** = "标记 + 消费就清". 比 "ttl ms" 或 "时间戳" 简单得多, 适合"下一次某事件发生时检查"的场景.

### 9.11 Sticky beta header latches

```ts
export function getAfkModeHeaderLatched(): boolean | null { return STATE.afkModeHeaderLatched }
export function setAfkModeHeaderLatched(v: boolean): void { STATE.afkModeHeaderLatched = v }
// ... 类似 fastMode / cacheEditing / thinkingClear ...

export function clearBetaHeaderLatches(): void {  // /clear 和 /compact 调
  STATE.afkModeHeaderLatched = null
  STATE.fastModeHeaderLatched = null
  STATE.cacheEditingHeaderLatched = null
  STATE.thinkingClearLatched = null
}
```

精髓: **任何会进入 HTTP request 的字段, 一旦触发就 sticky on, 防止用户切换破坏 prompt cache**.

Prompt cache 命中需要 request 完全 deterministic. 如果 `anthropic-beta: afk-mode` header 在 turn 1 有, turn 2 没了, **整个 cache 就 bust** — 服务端会重新算所有 tokens. **latched 后**: 用户中途关 afk mode, header **仍然发**(直到 /clear 或 /compact 重置). 用户付出小代价(header 多发) 换 cache 命中(大代价节省).

`thinkingClearLatched` 特殊: 在距上次 API call > 1h 时 latch — 那时 prompt cache 已经因 TTL 过期, **再 latch 已经没用** ... 等等, 看代码似乎是反过来用: latched 时**主动发** `thinking-clear` header 告诉服务端"我知道 cache miss 了, 不要再尝试 cache". 待确认细节, 但概念清晰.

### 9.12 `invokedSkills` per-agent key

```ts
export function addInvokedSkill(skillName, skillPath, content, agentId = null) {
  const key = `${agentId ?? ''}:${skillName}`  // ★ 复合键
  STATE.invokedSkills.set(key, { skillName, skillPath, content, invokedAt: Date.now(), agentId })
}

export function getInvokedSkillsForAgent(agentId): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === normalizedId) filtered.set(key, skill)
  }
  return filtered
}
```

精髓: **多租户场景 Map key 必须含租户 ID**. 不然 leader 调用 skill X, teammate 也调用 skill X, 一个会覆盖另一个 → 各自看到对方的 invocation. Per-agent prefix 隔离.

`clearInvokedSkills(preservedAgentIds?)` 在 /compact 时调 — 保留指定 agent 的 skill 记录, 清其他. 没传 preservedAgentIds 就全清.

### 9.13 `getSlowOperations` 稳定引用

```ts
const EMPTY_SLOW_OPERATIONS: ReadonlyArray<...> = []

export function getSlowOperations(): ReadonlyArray<...> {
  if (STATE.slowOperations.length === 0) {
    return EMPTY_SLOW_OPERATIONS  // ★ stable empty
  }
  const now = Date.now()
  // 只在真有过期时才分配新数组
  if (STATE.slowOperations.some(op => now - op.timestamp >= SLOW_OPERATION_TTL_MS)) {
    STATE.slowOperations = STATE.slowOperations.filter(op => now - op.timestamp < SLOW_OPERATION_TTL_MS)
    if (STATE.slowOperations.length === 0) return EMPTY_SLOW_OPERATIONS
  }
  return STATE.slowOperations  // ★ 直接返回, addSlowOperation 不会 mutate
}
```

精髓:
1. **空数组用 singleton**: dev bar 2fps 轮询 — 不会因为"每次返回新空数组" → useState setState → 重渲. Object.is 短路.
2. **没过期时直接返回数组**: 不分配. 但 `addSlowOperation` 内部用 `STATE.slowOperations = [...STATE.slowOperations, newOp]` 而不是 `push`, 所以 React 持有的引用永远不被 mutate.

注释明确: "Safe to return directly: addSlowOperation() reassigns STATE.slowOperations before pushing, so the array held in React state is never mutated."

这是个**写时复制 + 读时直接返回**的常见 immutable-ish 模式. 优势: 读快(无分配), 写明确(每次都新数组).

---

## 十、9 个 Context Provider — 各自解决一个横切问题

| Provider 文件 | 解决的问题 | 关键设计 |
|---------------|-----------|---------|
| `mailbox.tsx` | 单例 mailbox 跨子树共享 | useMemo 创建一次, 嵌套时新建会被防 |
| `voice.tsx` | 语音状态 mirror store | 用 `createStore` 复用,DCE: VoiceProvider 在外部 binary 走 passthrough |
| `notifications.tsx` | 优先级 + 折叠 + 单 timeout | 4 级优先级队列, 同 key 折叠, immediate 抢占 |
| `overlayContext.tsx` | overlay 集合 + Escape key 协调 | Set-based, NON_MODAL_OVERLAYS={'autocomplete'} 例外, invalidatePrevFrame |
| `promptOverlayContext.tsx` | Portal: prompt 上方浮层 | data/setter 拆 context 避免写入引发读重渲, CC-668 origin |
| `modalContext.tsx` | modal 子树自我意识 | suppress Pane top divider, useModalOrTerminalSize fallback, useModalScrollRef Tab 切换重置 scroll |
| `stats.tsx` | metric 收集 | reservoir sampling Algorithm R (1024), `_count/_min/_max/_avg/_p50/_p95/_p99` 派生 |
| `QueuedMessageContext.tsx` | 消息缩进上下文 | useBriefLayout 时关 padding 避免 double-indent |
| `fpsMetrics.tsx` | FPS getter passthrough | 30 行 boilerplate |

### 10.1 `voice.tsx` — DCE pattern + getter sync read

```tsx
// 不在 AppStateStore 里因为 voice 是 ant-only feature
const voiceStore = createStore<VoiceState>(initialState)

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  return <VoiceContext.Provider value={voiceStore}>{children}</VoiceContext.Provider>
}

export function useVoiceState<T>(selector: (s: VoiceState) => T): T {
  const store = useContext(VoiceContext)
  if (!store) throw new Error('useVoiceState must be used within VoiceProvider')
  // ... useSyncExternalStore ...
}

export function useSetVoiceState(): (updater: ...) => void {
  const store = useContext(VoiceContext)
  if (!store) throw new Error(...)
  return store.setState
}

// 关键: 同 tick 内同步读
export function useGetVoiceState(): () => VoiceState {
  const store = useContext(VoiceContext)
  if (!store) throw new Error(...)
  return store.getState
}
```

`useGetVoiceState` 返回 getter 而不是值. 调用方在同一个 tick 内 setState 后立即想读最新 — `getValue()` 拿到刚 set 的. 用 `useVoiceState(s => s.x)` 会拿到旧值(React 还没重渲).

用例: `VoiceKeybindingHandler` 在按键 callback 里先 setVoiceState 后立即读决定下一步.

**为啥 voice 不进 AppStateStore?** Voice 是 ant-only feature, 在外部 binary 里完全不存在. 单独 store 让外部 DCE 干净.

AppState.tsx 的 VoiceProvider wrapping:
```ts
const VoiceProvider = feature('VOICE_MODE')
  ? require('../context/voice.js').VoiceProvider
  : ({ children }) => children
```
外部 build `feature('VOICE_MODE')` 编译时为 false → 整段 dead code 消除, voice.tsx 不进 bundle.

### 10.2 `notifications.tsx` — 4 级优先级 + 折叠

```ts
const PRIORITIES: Record<NotificationPriority, number> = {
  immediate: 0, high: 1, medium: 2, low: 3,
}
const DEFAULT_TIMEOUT_MS = 8000

let currentTimeoutId: ReturnType<typeof setTimeout> | null = null

function addNotification(store: AppStateStore, notification: Notification) {
  store.setState(prev => {
    if (notification.priority === 'immediate') {
      // 抢占当前 + 重新入队非 immediate
      if (currentTimeoutId) clearTimeout(currentTimeoutId)
      const requeue = prev.notifications.current && prev.notifications.current.priority !== 'immediate'
        ? [prev.notifications.current, ...prev.notifications.queue]
        : prev.notifications.queue
      return {
        ...prev,
        notifications: { current: notification, queue: requeue },
      }
    }
    // 同 key 折叠: 用 fold reducer
    let queue = prev.notifications.queue
    const idx = queue.findIndex(n => n.key === notification.key)
    if (idx >= 0) {
      queue = [...queue]
      queue[idx] = notification.fold ? notification.fold(queue[idx]!) : notification
    } else {
      queue = [...queue, notification]
    }
    return { ...prev, notifications: { ...prev.notifications, queue } }
  })
  scheduleNext(store)
}

function scheduleNext(store: AppStateStore) {
  const { current, queue } = store.getState().notifications
  if (current || queue.length === 0) return
  // 找最低优先级数字的 notification
  let bestIdx = 0
  for (let i = 1; i < queue.length; i++) {
    if (PRIORITIES[queue[i].priority] < PRIORITIES[queue[bestIdx].priority]) {
      bestIdx = i
    }
  }
  const picked = queue[bestIdx]
  const newQueue = queue.filter((_, i) => i !== bestIdx)
  store.setState(prev => ({
    ...prev,
    notifications: { current: picked, queue: newQueue },
  }))
  currentTimeoutId = setTimeout(() => dismissCurrent(store), picked.timeout ?? DEFAULT_TIMEOUT_MS)
  currentTimeoutId?.unref?.()
}
```

精髓:
1. **fold reducer**: 同 key notification 不 replace 而是 fold (e.g. "3 errors" → 来第四个 → "4 errors"). 用户少看到重复消息.
2. **immediate 抢占**: 当前如果非 immediate, 把它**塞回队首**, immediate 上位. 不丢消息.
3. **`PRIORITIES` 数字越小优先级越高**: scheduleNext 找最小. immediate=0 永远最优先.
4. **模块作用域 `currentTimeoutId`**: 不进 AppState — 单例 timeout 就行, 没必要订阅.
5. **mount 时 imperative read**: NotificationsProvider 用 `store.getState()` 而不是 `useAppState(s => s.notifications)`. 否则每次队列变都重渲 NotificationsProvider, 是性能灾难. 这是个 imperative escape hatch.

### 10.3 `overlayContext.tsx` — invalidatePrevFrame 黑魔法

```tsx
const NON_MODAL_OVERLAYS = new Set(['autocomplete'])  // 不算 modal 的 overlay

export function useRegisterOverlay(id: string, enabled = true): void {
  const store = useContext(AppStoreContext)
  React.useLayoutEffect(() => {
    if (!enabled || !store) return
    store.setState(prev => {
      if (prev.activeOverlays.has(id)) return prev
      const next = new Set(prev.activeOverlays); next.add(id)
      return { ...prev, activeOverlays: next }
    })
    return () => {  // ★ cleanup
      store.setState(prev => {
        if (!prev.activeOverlays.has(id)) return prev
        const next = new Set(prev.activeOverlays); next.delete(id)
        return { ...prev, activeOverlays: next }
      })
      // ★ 反 blit fast-path
      instances.get(process.stdout)?.invalidatePrevFrame()
    }
  }, [enabled, id, store])
}
```

精髓:
1. **AppState 里的 Set** 跟踪所有 active overlays. 让 Escape key handler 知道有 modal 时不要退出 REPL.
2. **NON_MODAL_OVERLAYS** 例外: autocomplete 显示但不该阻塞 TextInput 输入. 写进 Set 但 Escape handler 跳过.
3. **`invalidatePrevFrame()` 在 cleanup 调**: Ink 的 blit fast-path 会复用上一帧的 cell. 当一个 20 行 overlay 卸载后, 新一帧的内容比上一帧短, **下方的旧 cell 不会被新内容覆盖**(因为 blit 只画 diff). 显示残影. `invalidatePrevFrame()` 强制下一帧全画.

这是个**深入 Ink 内部**的 hack. 普通 React 用户遇不到, 但 terminal UI 必须处理.

4. **用 `useContext(AppStoreContext)` 直接拿 store 而不是 `useAppState`**: 没订阅, 写时不引发自身重渲. 测试场景 store 不在时 `if (!store) return` 安全 no-op.

### 10.4 `promptOverlayContext.tsx` — Portal + 写时不重渲

```tsx
type PromptOverlayData = { content: ReactNode; ... } | null
type PromptOverlayDialog = ReactNode | null

// 4 个 context: data + setData + dialog + setDialog
const PromptOverlayDataContext = createContext<PromptOverlayData>(null)
const SetPromptOverlayContext = createContext<(d: PromptOverlayData) => void>(() => {})
const PromptOverlayDialogContext = createContext<PromptOverlayDialog>(null)
const SetPromptOverlayDialogContext = createContext<(d: PromptOverlayDialog) => void>(() => {})
```

精髓:
1. **数据 context 和 setter context 拆开**: 只读组件订阅 PromptOverlayDataContext. 只写组件订阅 SetPromptOverlayContext — **永不重渲**(setter 引用稳定).
2. **写时不影响写者**: 触发器组件(写)和显示器组件(读)分离, 互不打扰.
3. **CC-668 origin**: 注释解释这个 portal 解决"FullscreenLayout 的 overflowY:hidden bottom-slot 把超长 paste 切掉"的 UI bug. 用 portal 让内容"escape"出去, 不被 layout clip.

### 10.5 `stats.tsx` — Reservoir Sampling Algorithm R

```ts
const RESERVOIR_SIZE = 1024

function observe(name: string, value: number) {
  const r = reservoirs.get(name) ?? { samples: [], count: 0 }
  r.count++
  if (r.samples.length < RESERVOIR_SIZE) {
    r.samples.push(value)
  } else {
    // Algorithm R: 随机选个位置替换
    const j = Math.floor(Math.random() * r.count)
    if (j < RESERVOIR_SIZE) r.samples[j] = value
  }
  reservoirs.set(name, r)
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = p / 100 * (sorted.length - 1)
  const lower = sorted[Math.floor(index)]
  const upper = sorted[Math.ceil(index)]
  const frac = index - Math.floor(index)
  return lower + frac * (upper - lower)
}
```

精髓:
1. **Reservoir Sampling Algorithm R**: 流式数据**保持均匀采样 K 个**, 不需要预先知道总数. 经典. 内存上限 RESERVOIR_SIZE=1024 不论观察多少次.
2. **线性插值的百分位估计**: 不是简单 `sorted[Math.floor(p * len)]` — 那个有不连续跳跃. 线性插值平滑.
3. **每个 histogram 派生 `_count / _min / _max / _avg / _p50 / _p95 / _p99`**: 7 个 metric. flush 时统一写.
4. **`process.on('exit', flush)`**: 进程退出时 dump 到 `lastSessionMetrics`(`saveCurrentProjectConfig`). 下次启动可读 — 用来在 dev bar 显示"上一 session p95 latency"之类.

---

## 十一、关键工程教训(给做 Agent 的你)

1. **三层状态分层** — Bootstrap STATE / AppState / Context Provider 各管一段, 由生命周期 + 关注点决定该进哪层. 错位 → 启动慢 / UI 不响应 / 测试难写.

2. **`createStore<T>` 33 行原语足够大多数场景** — Set<Listener> + Object.is 短路 + onChange diff hook. 不需要 redux/mobx/zustand 全套.

3. **`onChange({newState, oldState})` 是 store 设计精髓** — 让"diff-based side effect"集中在一处. 而不是每个 mutation 调用点重复.

4. **`useSyncExternalStore` 是 React 18+ 外部 store 标准 API** — tearing 安全, 不需要自己手写 useEffect+useState. 任何 createStore 出来的对象直接接.

5. **`useAppState(selector)` + Object.is 警告** — 内部用户跑到 `s => s`(返回整 state) 立即抛错. JSDoc 警告"不要返回新对象". 双管齐下教育.

6. **`useSetAppState` 返回稳定引用** — 只写不读的组件用这个, 一辈子不重渲.

7. **`useAppStateMaybeOutsideOfProvider` + NOOP_SUBSCRIBE** — 测试 / 孤立组件友好. NOOP_SUBSCRIBE 必须返回 unsubscribe 函数否则 React 警告.

8. **`HasAppStateContext` 单独 boolean** 检测嵌套, 比"看 store 是否非 null"干净 — 因为 store-可能-null 的合法路径存在.

9. **`useState(() => createStore(...))` lazy initializer** — 不要 `useState(createStore(...))`, 会每次渲染创建新 store(虽然只首次保留).

10. **挂载竞态修正**: 任何"先发布,后订阅"的设计都要在订阅就位时主动**补查源头状态**.

11. **`useEffectEvent` 包外部回调** — 让回调始终 read 最新 props 但不进 dep, 避免昂贵副作用重订阅.

12. **`DeepImmutable` 配合"非 immutable 字段单独列出"** — 函数字段在 DeepImmutable 下报错, 把它们剥离.

13. **discriminated union (`CompletionBoundary`, `SpeculationState`, `ActiveAgentForInput`)** — 不要 `{type, optional1?, optional2?}` 的伪 union, 用真正的 discriminated union 让 switch 类型安全.

14. **mutable ref 在 store 里** — 高频追加场景 (speculation messages) 用 `{current: T}` ref. 避免每次 push 触发 store-wide 重渲. 配合外部 trigger 决定何时 setState 切状态.

15. **`IDLE_SPECULATION_STATE` 单例** — 多次"恢复 idle"复用同引用, Object.is 短路.

16. **`getDefaultAppState` 用 lazy `require` 破循环** — 调用时机推迟. 适合启动只调一次的场景. 高频读用结构拆分(M17 leaf 模块).

17. **`onChangeAppState` 是 CCR/SDK 外化的单一 choke point** — 跨多个 mutation path 的 side effect 应该放 store 的 onChange, 不是每个 mutation 现场调.

18. **内部 mode 外化 + edge detection** — 每个出口 audience 不同, 各自 filter. 状态机用 `(oldX && !newX) || (!oldX && newX)` 检测 transition, 不要每次状态都 fire.

19. **`externalMetadataToAppState` 反向映射** — 任何 outbound 通知都需要对应的 inbound restore.

20. **settings 变化在 store hook 清 auth 缓存** — store onChange 是 cache invalidation 的最佳点, 不需要 file watcher.

21. **selectors 纯函数 + `Pick<>` 参数类型** — 不缓存(复杂度低 + AppState 不频繁变更). `Pick<AppState, 'a' | 'b'>` 让测试只构造必要字段.

22. **内联 3 行函数 + 常量打破循环** — 为了"DRY 原则"硬拉 import 制造循环不值得. 小到一个 isLocalAgent + PANEL_GRACE_MS, 内联复制可接受.

23. **`retain` + reclaim + `messages: undefined` 显式释放** — 比纯 GC 更可控. 30s 宽限期照顾"用户反悔"的 UX.

24. **多字段必须一起变 → 单一函数原子交换** — `switchSession` 防 CC-34 同款事故.

25. **`sessionSwitched` 信号 + bootstrap-friendly subscribe** — bootstrap 不能 import listener, 暴露 subscribe API 让 caller register.

26. **`planSlugCache.delete(STATE.sessionId)` 在 regenerateSessionId** — Map 类 cache 在 key 不再使用时主动 delete, 防无限增长.

27. **cwd setters 全部 `.normalize('NFC')`** — Unicode 规范化必须在 setter, 不能依赖 caller. macOS 文件系统 NFD/NFC 混用易出错.

28. **`getProjectRoot()` 启动后不变** — 即使 mid-session 切 worktree, projectRoot 锚定原始. skills/history 路径稳定.

29. **`updateLastInteractionTime` dirty-bit + flush per frame** — Ink renderer 每帧前 flush 一次, 把 N 次按键合成 1 次 Date.now(). immediate=true 用于已过 render cycle 的回调.

30. **scroll-drain 模块作用域 + `unref?.()`** — 高频读写无订阅需求的 flag 不要塞 STATE. timer unref 让进程能干净退出.

31. **`waitForScrollIdle` 配合 markScrollActivity** — 用户滚动时延迟网络/子进程, 减少 UI 卡顿.

32. **Turn budget continuation 模块作用域** — turn-scoped 高频访问无订阅, 模块作用域足够.

33. **`markPostCompaction` / `consumePostCompaction` 单次 flag** — 简单"标记 + 消费就清", 比 ttl 或时间戳干净.

34. **Sticky beta header latches** — 任何进入 HTTP request 的 toggle 一旦触发就 sticky on, 防止用户切换 break prompt cache. 用户付出小代价换 cache 命中.

35. **`invokedSkills` 复合 key `${agentId??''}:${name}`** — 多租户 Map 必须 prefix 隔离, 防覆盖.

36. **`getSlowOperations` 稳定空数组 + 写时复制** — 频繁轮询场景: 空数组用 singleton 让 Object.is 短路, 数组写时复制让读时可直接返回.

37. **9 个 context provider 各管一个横切关注点** — mailbox / voice / notifications / overlay / promptOverlay / modal / stats / queuedMessage / fps. 不要把它们全塞 AppState — 横切关注点的边界比"是否反应式"更重要.

38. **`voice.tsx` DCE pattern**: AppState.tsx 用 `feature('VOICE_MODE') ? require('../context/voice.js').VoiceProvider : passthrough` — 外部 binary 整个 voice.tsx 不进 bundle.

39. **`useGetVoiceState` 返回 getter** — 同 tick 内 setState 后立即读最新, useVoiceState 会拿旧. 给 callback 场景用.

40. **notifications fold reducer + immediate 抢占 + 模块作用域 timeout** — 同 key 折叠避免重复消息, immediate 抢占 + 重新入队不丢消息, 单例 timeout 不进 store.

41. **`invalidatePrevFrame()` 反 Ink blit 残影** — 高 overlay 卸载后用. 普通 React 遇不到, terminal UI 必须处理.

42. **`promptOverlayContext` data/setter 拆 context** — 只写组件订阅 setter context, 永不重渲. 经典 Provider perf 优化.

43. **`modalContext` 让 modal 子树自我意识** — 子组件不需要 prop drill 知道自己在 modal 里. context boolean / dim 信息隔层传.

44. **Reservoir Sampling Algorithm R (`stats.tsx`)** — 流式数据保持均匀采样, 内存上限固定. percentile 用线性插值. `process.on('exit', flush)` 写 `lastSessionMetrics`.

45. **`Pick<AppState, ...>` 参数类型给 selector 用** — 测试只构造必要字段. TypeScript "narrow your parameter type" 最佳实践.

---

## 十二、未读 / 待补

| 文件 | 大小 | 状态 |
|------|------|------|
| `src/state/AppStateStore.ts:457-569` | 113 行 | ✅ 已读 — `getDefaultAppState` 80+ 字段初值 |
| `src/state/teammateViewHelpers.ts:1-141` | 141 行 | ✅ 已读 |
| `src/bootstrap/state.ts:1-1758` | 1758 行 | ✅ 已读 |
| `src/context/*.tsx` × 9 | ~1004 行 | ✅ 已读 |
| `src/utils/settings/applySettingsChange.ts` | 未知 | **dump 缺失** — settings → AppState 同步细节, 但接口已从 AppState.tsx 推断 |
| `src/utils/sessionState.ts` (`notifyPermissionModeChanged`/`notifySessionMetadataChanged`) | 未知 | **dump 缺失** — 外化通知细节, 已从 onChangeAppState 推断行为 |
| `src/utils/permissions/PermissionMode.ts` (`toExternalPermissionMode`) | 未知 | **dump 缺失** — 已从注释 + 用法推断 (内部 bubble/ungated_auto → 'default') |

未读不阻塞 M19 架构理解. createStore 原语、Provider 装配、onChange 单一 choke point、9 context provider 各自职责、bootstrap STATE 60+ 字段 + module-scope 高频字段, 全部已掌握.

---

## 十三、小结

M19 解决的核心问题: **怎么把一个 CLI tool 的 80+ 反应式字段 + 60+ 进程级单例 + 9 个横切关注点子系统, 用极简的 33 行 store 原语 + 三层分层管理起来, 同时支持**:

- **CCR/SDK 双向外化** — 任意 mutation 自动通知, 调用方零修改 (`onChangeAppState`)
- **测试 / 孤立组件友好** — `useAppStateMaybeOutsideOfProvider` + NOOP_SUBSCRIBE
- **挂载竞态修正** — 远程 settings 在 mount 前到达也能补查
- **跨模块循环破除** — lazy require + 内联函数 + leaf 模块多种手段
- **高频字段不入 store** — scroll-drain / interactionTime dirty-bit / slowOperations 用模块作用域
- **Prompt cache 友好** — sticky beta header latches 防 toggle bust cache
- **多租户隔离** — `${agentId??''}:${skillName}` 复合 key
- **Unicode 安全** — cwd setter 全部 NFC normalize, EPERM fallback iCloud
- **Terminal UI 边角** — invalidatePrevFrame 反 blit 残影, getSlowOperations 稳定空数组
- **Reservoir sampling** — 流式 metric 收集内存上限

这套机制是 Claude Code 整个 UI/逻辑 backbone — 每个 React 组件读 / 写 AppState 都走这套, 每个 telemetry 计数都走 STATE, 每个 settings 变更都走 onChange hook. 它和:

- **M01 (启动)** 联动 — bootstrap STATE 在 React mount 前就要有 (sessionId, cwd, allowedSettingSources)
- **M17 (settings)** 联动 — `applySettingsChange` 把 settings 变化推进 AppState, `resetSettingsCache` 被 setUseCoworkPlugins 调
- **M16 (commands)** 联动 — `clearCommandsCache` 被 plugin 状态变触发
- **M10 (bridge)** 联动 — `replBridge*` 系列字段, `gh-23085` 早期 isBridgeEnabled 触发的合并缓存 poison
- **M15 (skills/plugins)** 联动 — invokedSkills Map, plugin needsRefresh, mcp.pluginReconnectKey

设计最精髓的几条:

- **store 33 行就够** — Object.is 短路 + onChange diff hook + Set<Listener>. 别上 redux 全套.
- **三层状态分层** — 该 reactive 进 AppState, 该 process-global 进 bootstrap, 该子树局部进 Context.
- **onChange 是 side effect 单一 choke point** — 跨多个 mutation 的通知 / 持久化集中在这里.
- **mutable ref escape hatch** — 高频追加 (speculation messages) 用 ref 避免 store-wide 重渲.
- **sticky latches for prompt cache** — 任何进 HTTP 的 toggle 一旦触发就 on, 防 cache bust.
- **9 context provider 各自管一个横切关注点** — 不要全塞 AppState, 关注点边界比"是否反应式"重要.

抄这章, 做 Agent 时能避免至少 3 类 P0 事故:
1. **多 mutation path 通知遗漏** — onChange 单一 choke point.
2. **冷启动慢 + 循环 import** — lazy require / 内联函数 / leaf 模块多种破除手段.
3. **Prompt cache 频繁 bust** — sticky beta header latches.
