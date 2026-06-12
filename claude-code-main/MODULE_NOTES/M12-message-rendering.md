# M12 · 消息渲染层（Messages / VirtualMessageList / MessageRow / Markdown）

> 范围：`src/components/Messages.tsx`、`src/components/VirtualMessageList.tsx`、`src/components/MessageRow.tsx`、`src/components/Markdown.tsx`，以及 `src/components/messages/*` 子组件家族。
> 这是 TUI 中**唯一一个真正被高频更新的视图**：流式 token 增长、tool_use 状态切换、collapse 折叠、虚拟滚动、搜索高亮、sticky 跟随、跨会话回放……所有的实时压力都集中在此。
> M11 是底层的"React-in-TUI 渲染引擎",M12 是跑在这个引擎上的"会话视图层"——把一堆 anthropic-message + tool_use 块翻译成一行一行可交互、可滚动、可搜索的终端 UI。

---

## 0. 整体结构与职责切分

```
REPL.tsx
  └─ FullscreenLayout.tsx                  ← 全屏布局 + ScrollChromeContext
       └─ Messages.tsx                     ← 编排层(过滤/合并/折叠 → renderableMessages)
            ├─ VirtualMessageList.tsx      ← 虚拟滚动 + 搜索 + sticky 追踪(fullscreen 路径)
            │    └─ MessageRow.tsx         ← 每条消息壳层 + memo gate + OffscreenFreeze
            │         └─ Message.tsx       ← 类型分派(switch on message.type)
            │              └─ messages/*   ← 18+ 子组件（AssistantText / AssistantToolUse / ...）
            └─ (非虚拟路径，prompt mode)   ← 直接 .map renderableMessages, 复用 MessageRow
```

四层职责严格分离，**每层都有它自己的"性能护栏"**：

| 层 | 负责 | 性能护栏 |
|---|---|---|
| `Messages` | 算什么应该被渲染 | 双 useMemo 拆分（贵的算一次，便宜的随 renderRange 算）+ 字段级 memo 比较器 |
| `VirtualMessageList` | 算哪些应该在屏 | 增量 keysRef、两段式 jump、StickyTracker 独立订阅、抑制状态机 |
| `MessageRow` | 算这一条要不要重渲 | 保守 `areMessageRowPropsEqual`、`OffscreenFreeze` 包外层、`isActiveCollapsedGroup` |
| `Markdown` | 算这段文字怎么解析 | 模块级 LRU token cache（hash key, 500）+ 纯文本 fast path + 流式 stable-prefix |

---

## 一、`Messages.tsx`（833 行）—— 编排层

### 1.1 输入 → 输出：消息流水线

`MessagesImpl` 收到一个未经处理的 `messages: NormalizedMessage[]`，要在每帧产出一份 `collapsed: CollapsedMessage[]`（折叠后真正渲染的列表）。流水线大致是：

```
messages
  → applyBrandedSpecialCases            (CC-1227 等品牌特例豁免)
  → filterForBriefTool / dropTextInBriefTurns  (Brief tool 重复文本剔除)
  → reorderTaskGroups                   (Task agent 输出按 spawn order 重组)
  → groupParallelToolUses               (并行 tool_use 合并成 grouped_tool_use)
  → collapseReadSearchGroups            (Read/Grep/Glob 序列折叠成 1 条 summary)
  → collapseTeammateShutdowns           (sub-agent 关闭通知折叠)
  → collapseHookSummaries               (hook 多 stage 折叠)
  → collapseBackgroundBashNotifications (后台 bash 任务通知折叠)
  → applyUnseenDivider                  (插入 "── new ──" 分割线)
  → applyLastSummaryDivider             (插入 /clear 后的 summary 分割线)
  ⇒ collapsed
```

**关键设计点**：
- 这条流水线是**顺序敏感**的。例如 `groupParallelToolUses` 必须在 `collapseReadSearchGroups` 之前——前者识别 parallel 块，后者识别 Read/Grep 序列，反过来跑会把同一组消息扫两遍但识别不到。
- 每个 collapse 函数都是**纯函数**：输入 `Message[]`，输出 `Message[]`。可以自由插拔、单测。
- `applyBrandedSpecialCases`：硬编码豁免清单（issue 编号 CC-1227 等），允许特定历史消息绕过过滤——典型的"工程现实"：某些用户的特殊数据在新过滤规则下会消失，必须保留兼容。

### 1.2 双 useMemo 拆分（核心性能戏法）

历史上这是一个大 `useMemo`，把所有过滤 + 折叠 + slice 都打包。后果：**每次滚动都会重建 6 个 lookups Map**——27k 消息长会话上 50ms 的内存分配 + 100–173ms GC pause。

新版拆成两层：

```tsx
// 贵的：O(n) over 27k 消息，依赖 messages / settings / tools / unseenDivider 等
const renderable = useMemo(() => {
  const briefFiltered = filterForBriefTool(messages, ...)
  const briefDropped  = dropTextInBriefTurns(briefFiltered, ...)
  const reordered     = reorderTaskGroups(briefDropped)
  const grouped       = groupParallelToolUses(reordered, ...)
  const collapsed     = pipeline(grouped, ...)
  const lookups       = buildLookups(collapsed)  // 6 个 Map: resolvedToolUseIDs, ...
  return { collapsed, lookups }
}, [messages, settings, tools, unseenDivider, lastSummaryIndex, ...])

// 便宜的：仅 slice 一段窗口
const sliced = useMemo(() => {
  const start = computeSliceStart(renderable.collapsed, anchorRef)
  return renderable.collapsed.slice(start)
}, [renderable.collapsed])
```

教训：**贵和便宜的计算分开 memo**，避免便宜的变化（如滚动 renderRange）连带触发贵的重算。这条对任何 React Agent UI 都适用。

### 1.3 `computeSliceStart`：锚点切片（非虚拟路径的"内存安全阀"）

非虚拟路径（prompt mode、外部构建无 fullscreen）必须有一个**消息数量上限**，否则——

> **死亡螺旋（实测数据）**：约 250 KB RSS / Ink fiber tree × N 条消息 + yoga 行高无上限 + 每行屏幕缓冲。2000 条消息 → 3000 行屏幕 → 500 MB 仅 fibers + 59 GB RSS + 实测 14k mmap/munmap/秒。

护栏：
```ts
export function computeSliceStart(
  collapsed: CollapsedMessage[],
  anchorRef: React.MutableRefObject<Anchor | null>,
  cap = MAX_MESSAGES_WITHOUT_VIRTUALIZATION,      // 200
  step = MESSAGE_CAP_STEP                          // 50
): number {
  const anchor = anchorRef.current
  const anchorIdx = anchor ? collapsed.findIndex(m => m.uuid === anchor.uuid) : -1
  let start = anchorIdx >= 0
    ? anchorIdx                                                   // 锚点 uuid 还在
    : anchor ? Math.min(anchor.idx, Math.max(0, collapsed.length - cap)) : 0  // uuid 失效，回退到 idx
  if (collapsed.length - start > cap + step) start = collapsed.length - cap   // 超出 cap+step 才推进
  const msgAtStart = collapsed[start]
  if (msgAtStart && (anchor?.uuid !== msgAtStart.uuid || anchor.idx !== start))
    anchorRef.current = { uuid: msgAtStart.uuid, idx: start }      // 刷新锚点
  else if (!msgAtStart && anchor) anchorRef.current = null
  return start
}
```

设计精髓：
- **`{uuid, idx}` 双锚**：uuid 在追加/compact 后稳定；如果 uuid 也消失（被折叠到 group 里）就退回 idx clamp。
- **`cap + step` 滞回**：阈值之上才推进 start，避免每条新消息都触发 slice 起点抖动。
- **render 期间 mutate ref 是幂等的**：StrictMode 双调用安全（重复算同样结果）。
- 历史上是单纯按数量 `slice(-N)`，问题是 append/compaction 改变 length 时 slice 起点不稳定，引发回放抖动（CC-941/1154/1174）。

`MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE = 30` 在 transcript 视图额外收紧——transcript 是只读全局快照，没必要把整个历史都画出来。

### 1.4 `filterForBriefTool` / `dropTextInBriefTurns`：两阶段 turn 标记

Brief tool 的执行模式是"先输出 assistant text，再立刻调 Brief 把同一内容压缩成结构化输出"。如果不过滤，用户会同时看到长文本 + Brief 结果，重复浪费屏幕。

策略：**两遍扫描**——
1. 第一遍标记每个 turn 是否包含 Brief 调用。
2. 第二遍在标记为"Brief turn"的 assistant 消息里把纯文本块剔掉，只保留 Brief 工具调用本身。

**关键护栏**：**绝不剔除 system 消息**，除了 `api_metrics` 一类调试噪音。system 消息（如 hook、subagent_done）是用户可见的状态信号，剔了就丢功能。

### 1.5 `lastThinkingBlockId` sentinels

thinking 块在流式期间需要显示，结束后通常折叠——但不能简单按"流式状态"，因为用户可能滚回去看历史。两个哨兵值：

- `'streaming'`：当前正在流式输出 → 隐藏所有已完成的 thinking。
- `'no-thinking'`：从当前往上扫到上一个 user turn 都没有 thinking → 全部隐藏。

中间态（特定 blockId）：仅隐藏比该 id 旧的 thinking。

这是一个用 sentinel 字符串扩展 union type 的典型用法——TypeScript 上是 `string | 'streaming' | 'no-thinking' | null`，运行时分支判断保留所有可能性。

### 1.6 `deriveUUID` for synthetic streaming tool_use

流式过程中 tool_use 块还没收完 input，但要先渲染占位。这个占位需要一个稳定的 React key。

历史 bug（commit `383326e613`）：用 `Math.random()` 当 key → 每次流式 token 进来都新建对象 → React 视为新组件 → unmount + mount → Ink DOM 节点重建 → **旧节点上的字符还残留在屏幕缓冲里、新节点又画一遍，叠成"幻影双重文本"**。

修复：从 message uuid + 块 index 推导出确定性 UUID（hash），同一个 tool_use 在所有流式增量里 key 不变 → 组件不 remount → 屏幕稳定。

教训：**TUI 上 React key 不稳是灾难**，远比 Web 严重——Web DOM 是浏览器维护，组件 remount 后浏览器自动清干净；TUI 的"DOM"是屏幕缓冲，必须靠 diff 增量更新，残留无法自动清除。

### 1.7 `shouldRenderStatically`（M11 静态打印路径的钩子）

```ts
export function shouldRenderStatically(
  message, streamingToolUseIDs, inProgressToolUseIDs,
  siblingToolUseIDs, screen, lookups
): boolean {
  if (screen === 'transcript') return true   // transcript 永远 static
  switch (message.type) {
    case 'attachment': case 'user': case 'assistant': {
      if (message.type === 'assistant') {
        const block = message.message.content[0]
        if (block?.type === 'server_tool_use')
          return lookups.resolvedToolUseIDs.has(block.id)
      }
      const toolUseID = getToolUseID(message)
      if (!toolUseID) return true              // 纯文本可静态
      if (streamingToolUseIDs.has(toolUseID)) return false   // 流式中不能静态
      if (inProgressToolUseIDs.has(toolUseID)) return false  // 执行中不能静态
      if (hasUnresolvedHooksFromLookup(toolUseID, 'PostToolUse', lookups))
        return false                                          // 等待 hook 不能静态
      return siblingToolUseIDs.every(id => lookups.resolvedToolUseIDs.has(id))
    }
    case 'system': return message.subtype !== 'api_error'
    case 'grouped_tool_use':
      return message.message.tool_uses.every(tu =>
        lookups.resolvedToolUseIDs.has(tu.id))
    case 'collapsed_read_search':
      return false   // never static in prompt mode（防止 collapse animation 闪烁）
  }
}
```

`shouldRenderStatically` 的输出喂给 M11 的 `<Static>` 组件——一旦标记 static，该消息进入 scrollback、不再参与 diff、不再算布局。这是**整个 TUI 性能优化的金线**：让"已完成"的消息变成静态文本，把渲染压力收敛到屏幕最后几条活动消息。

特别注意：
- `collapsed_read_search` 永远不 static——折叠展开是动画，静态化会闪烁。
- `siblingToolUseIDs.every(resolved)`：parallel tool_use 必须全部完成才能静态，否则单个完成 + 其它未完成时 UI 会跳。

### 1.8 字段级 React.memo 比较器

```ts
export const Messages = React.memo(MessagesImpl, (prev, next) => {
  for (const key of Object.keys(prev)) {
    // 这些 key 故意忽略：它们是 callback / ref，每帧新引用但语义不变
    if (['onOpenRateLimitOptions','scrollRef','trackStickyPrompt','setCursor',
         'cursorNavRef','jumpRef','onSearchMatchesChange','scanElement','setPositions'
        ].includes(key)) continue
    if (prev[key as keyof Props] !== next[key as keyof Props]) {
      // 字段特定的语义比较
      if (key === 'streamingToolUses') {
        // 比较 contentBlock 引用：流式期间引用稳定即视为相同
        return blocksIdentityEqual(prev.streamingToolUses, next.streamingToolUses)
      }
      if (key === 'inProgressToolUseIDs') {
        return setsEqual(prev.inProgressToolUseIDs, next.inProgressToolUseIDs)
      }
      if (key === 'unseenDivider') {
        return prev.unseenDivider?.firstUnseenUuid === next.unseenDivider?.firstUnseenUuid
            && prev.unseenDivider?.count === next.unseenDivider?.count
      }
      if (key === 'tools') {
        return prev.tools.map(t => t.name).join(',') === next.tools.map(t => t.name).join(',')
      }
      return false
    }
  }
  return true
})
```

设计精髓：
- **callback ref 一律不比较**：它们 100% 每帧新引用，比较 = 永远 false = memo 永远失效。
- **每个 prop 都有它自己的"什么叫语义相等"**——`Set` 用 `setsEqual`、tool list 用 name array 拼接、unseenDivider 用关键字段对比。
- 不是泛型的"`Object.is` deep compare"，那种通用工具在 27k 消息上是性能杀手。

这种**针对每个 prop 写专门比较函数**的做法是 React 优化的最高阶——大多数应用用 `React.memo` 不传比较器；进阶用 `useMemo + ===`；只有真正高频组件才值得做到字段级语义比较。

---

## 二、`VirtualMessageList.tsx`（1081 行）—— 虚拟滚动 + 搜索 + sticky

### 2.1 总体结构

虚拟滚动的核心是 **"渲染窗口" = `[firstVisibleIndex, lastVisibleIndex]`**，但 M12 这层还额外要解决：
- 搜索（构建 match index、跳到下一个匹配并保持滚动）
- Sticky 跟随（用户在底部时自动跟进，否则不打扰）
- 光标导航（j/k、PgUp/PgDn、g/G）
- Stable prompt header（屏幕顶部一直显示当前"逻辑 prompt"）
- 选区/复制兼容（M11 选区跨折叠 sub-tree 时不能误清）

### 2.2 `keysRef`：增量 key 数组

React `key` 是虚拟列表的命脉。如果每帧都 `messages.map(m => itemKey(m))`，27k 消息每秒重算多次 → 1 MB 内存抖动 / 滚动 tick。

策略：**只在增量追加时 push，不全量重算**。

```ts
if (prevItemKeyRef.current !== itemKey ||                  // itemKey 函数本身换了
    messages.length < keysRef.current.length ||             // 列表收缩（compact）
    messages[0] !== prevMessagesRef.current[0]) {           // 头被改了
  keysRef.current = messages.map(m => itemKey(m))           // 必须全量
} else {
  for (let i = keysRef.current.length; i < messages.length; i++)
    keysRef.current.push(itemKey(messages[i]!))             // 增量 push
}
prevItemKeyRef.current = itemKey
prevMessagesRef.current = messages
```

三种触发全量重算的情形都是"head 变化"——React 视为列表头不同 → key 错位 → 必须 rebuild。其余 99% 的"append 新 token" 走增量分支，零内存抖动。

### 2.3 两段式 jump：`scrollToIndex` → 等 paint → scan element

跳到某条消息有两个时机：
1. **第一段**：调用 `scrollRef.current?.scrollToIndex(idx)`，立刻设置 `scrollTop` 和 `topSpacer` 高度（用同一份 `offsets` 数组，保证两者一致 → 目标消息一定 mount）。
2. **第二段**：等 paint 完成后（React `resetAfterCommit` → passive effect 触发），扫描目标 element 的 DOM 位置 → 调 `positions[]` 拿屏幕坐标 → 高亮匹配文字。

```
seekGen++ → scrollToIndex → React commit
                              ↓
                       resetAfterCommit (M11 reconciler hook)
                              ↓
                       paint → terminal frame flush
                              ↓
              passive effect (useEffect, no layout phase)
                              ↓
              scanElement → buildPositions → highlight
```

**抖动防御**：搜索"上一个/下一个匹配"按住不放，会触发 burst 多次 jump。
- `phantom-burst cap = 20`：连续 20 次内不真正扫描，只更新 `seekGen`。
- `pendingStepRef`：one-deep 队列，最新一次覆盖前一次（用户连按 N，只有最后一次会被扫描）。

### 2.4 `setSearchQuery`：一次扫描建 matches + prefixSum

```ts
function setSearchQuery(q: string, wantLast = true) {
  if (!q) { matchesRef.current = []; return }
  const ql = q.toLowerCase()
  const matches: number[] = []
  const prefixSum: number[] = [0]
  for (let i = 0; i < itemsRef.current.length; i++) {
    const text = searchTextCache.get(itemsRef.current[i]!)   // WeakMap lowered text
    let count = 0
    let pos = 0
    while ((pos = text.indexOf(ql, pos)) !== -1) { count++; pos += ql.length }
    if (count > 0) matches.push(i)
    prefixSum.push(prefixSum[prefixSum.length - 1]! + count)
  }
  matchesRef.current = matches
  prefixSumRef.current = prefixSum
  if (wantLast) { /* 找最接近底部的最后一个 match */ }
  else { /* 找最接近当前光标的 match */ }
}
```

设计点：
- **`searchTextCache: WeakMap<Message, string>`**：每条消息的"可搜索文本"只 lower 一次。message 对象被 GC 时 WeakMap entry 自动清除。
- **prefixSum** 用于 "match N of M" 显示——查询任意 idx 之前有多少 match 走 O(1)。
- **`wantLast = true` 初始搜索**：用户处于 sticky-bottom，最后一条消息是"看得到的"，它的最后一个匹配是"跟用户视线最近"——以此最小化视图位移。

### 2.5 `warmSearchIndex`：协作式分块预热

搜索框打开后，等用户输入时同步扫描会卡。所以预热：

```ts
async function warmSearchIndex() {
  if (warmedRef.current) return 0
  const t0 = performance.now()
  const CHUNK = 500
  for (let i = 0; i < itemsRef.current.length; i += CHUNK) {
    for (let j = i; j < Math.min(i + CHUNK, itemsRef.current.length); j++) {
      if (!searchTextCache.has(itemsRef.current[j]!)) {
        searchTextCache.set(itemsRef.current[j]!, lowerOf(itemsRef.current[j]!))
      }
    }
    await new Promise(r => setTimeout(r, 0))  // 让出主线程
  }
  warmedRef.current = true
  return performance.now() - t0
}
```

每 500 条消息 `setTimeout(0)` 让出一次——这就是 Web 上的 "cooperative scheduling"。终端 Agent 上 React 主循环时序更紧，让出粒度要更细。

### 2.6 `StickyTracker`：独立组件 + `useSyncExternalStore`

sticky 状态（用户当前是不是"贴在底部"）和滚动位置变化频率不同：
- 滚动位置：用户每滚一格都变，需要节流（`SCROLL_QUANTUM = 40` 即每 40 行才通知一次列表，避免每次都触发 Yoga 重算）。
- sticky bit：sticky → broken 的瞬间需要立即响应（停掉自动跟随）。

**两种 subscriber 粒度不同**——所以 StickyTracker 拆成独立组件，**自己订阅** scroll store：

```tsx
function StickyTracker({ scrollRef, onChange }) {
  const snapshot = useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current
    if (!s) return NaN
    const t = s.getScrollTop() + s.getPendingDelta()
    return s.isSticky() ? -1 - t : t   // sticky bit 折叠进符号位
  })
  useEffect(() => onChange(snapshot < 0), [snapshot])
  return null
}
```

精髓：**把 sticky bit 编码进数字符号**——`-1 - scrollTop` 时为 sticky，正数时为 broken。这样 React 比较 `snapshot !== prevSnapshot` 时**任何 sticky↔broken 转换都会触发**，即使 scrollTop 没变。

### 2.7 抑制状态机 + `clicked` sentinel

用户点击 prompt header（sticky prompt）跳到对应消息，header 应立刻刷新成新 prompt。但有个边界 case：jumping 时 sticky idx 会先短暂错乱（visible range 变了 → sticky 头会"闪到旧值再修正"），导致 header 抖动。

状态机：
```ts
type Suppress = 'none' | 'armed' | 'force'
const suppress = useRef<Suppress>('none')

// 用户点击 prompt header：
suppress.current = 'force'             // 强制采用 clicked 那个 idx
clickedIdxRef.current = idx
scrollToIndex(idx)

// 下一帧 sticky 重算时：
if (suppress.current === 'force') {
  newStickyIdx = clickedIdxRef.current   // 不接受计算出的新 idx
  suppress.current = 'none'              // 消费完毕
} else if (suppress.current === 'armed') {
  // 跳转后第一次 sticky 计算允许通过，但下次还是 armed
}
```

设计点：
- **`'force'` 一次性消费**：避免永久挂起。
- **`'armed'` 等待状态**：jumping 期间多次重算时容忍。
- header 不会因为 idx 反复算到同一个值而抖动。

### 2.8 cursor 导航与 `JumpHandle`

`JumpHandle` 是父组件（REPL）持有的命令式接口：

```ts
interface JumpHandle {
  jumpToIndex(idx: number): void
  setSearchQuery(q: string, wantLast?: boolean): void
  nextMatch(): void
  prevMatch(): void
  setAnchor(uuid: string): void
  warmSearchIndex(): Promise<number>
  disarmSearch(): void
}
```

通过 `useImperativeHandle` 暴露给 ref。所有命令最终都汇聚到 `seekGen` 增长 → 触发统一的"两段式跳转"流程。

### 2.9 选区跨虚拟节点的兼容

虚拟列表只画窗口内的消息，但选区可能跨窗口。M11 的选区机制要在"滚出去"的消息上继续工作 → VirtualMessageList 把已滚出的可视行**做快照**（最近一次画过的字符 + 坐标），交给 M11 选区系统作为虚拟 source-of-truth。

具体实现见 M11 § 13 "鼠标选区"，本层只负责喂数据。

---

## 三、`MessageRow.tsx`（382 行）—— 单条消息壳层

### 3.1 `areMessageRowPropsEqual`：保守的 memo gate

`MessageRow` 用 `React.memo(MessageRow, areMessageRowPropsEqual)` 包起来。比较器**故意写得很保守**——宁可多 re-render 一次也不能放过状态变化：

```ts
export function areMessageRowPropsEqual(prev, next): boolean {
  if (prev.message !== next.message) return false
  if (prev.screen !== next.screen) return false
  if (prev.verbose !== next.verbose) return false
  if (prev.message.type === 'collapsed_read_search' && next.screen !== 'transcript')
    return false                       // collapsed_read_search 永远重渲(动画)
  if (prev.columns !== next.columns) return false

  const prevIsLatestBash = prev.latestBashOutputUUID === prev.message.uuid
  const nextIsLatestBash = next.latestBashOutputUUID === next.message.uuid
  if (prevIsLatestBash !== nextIsLatestBash) return false

  // CC-941：只在本消息含 thinking 时才响应 lastThinkingBlockId 变化
  if (prev.lastThinkingBlockId !== next.lastThinkingBlockId &&
      hasThinkingContent(next.message)) return false

  const isStreaming = isMessageStreaming(prev.message, prev.streamingToolUseIDs)
  const isResolved = allToolsResolved(prev.message, prev.lookups.resolvedToolUseIDs)
  if (isStreaming || !isResolved) return false   // 状态变化中永远重渲

  return true
}
```

CC-941 教训：早期实现是 `if (prev.lastThinkingBlockId !== next.lastThinkingBlockId) return false`——结果只要思考开始/停止，**全屏所有消息都重渲一遍**（即使绝大多数消息根本没思考内容）。修复：先 `hasThinkingContent(next.message)` 守卫。

### 3.2 `isActiveCollapsedGroup`：折叠组活动状态判定

折叠的 Read/Grep 序列要显示 spinner——但只在还在执行时。这个判定有微妙：

```ts
const isActiveCollapsedGroup = isCollapsed &&
  (hasAnyToolInProgress || (isLoading && !hasContentAfter))
```

- `hasAnyToolInProgress`：第一优先——如果有任何 sub-tool 还在执行，整组就是 active。
- `isLoading && !hasContentAfter`：如果当前还在 streaming + 后面没有更多内容 → 仍 active。

**关键 trick**：`hasAnyToolInProgress` 必须有"优先权"。否则并行执行场景下，一组 5 个 tool 调用，其中 3 个完成（产生 `hasContentAfter=true`）但 2 个还在跑——`isLoading && !hasContentAfter = false` 会让整组被误判完成 → spinner 消失。

### 3.3 `hasContentAfterIndex`

由 `Messages` 层预计算，传给每条 MessageRow 作为布尔 prop。算法：

```ts
function hasContentAfterIndex(messages, idx, lookups) {
  for (let i = idx + 1; i < messages.length; i++) {
    const m = messages[i]!
    // 跳过这些"非内容"消息
    if (isThinking(m) || isRedactedThinking(m)) continue
    if (isCollapsibleToolUse(m, lookups)) continue
    if (isStreamingToolUse(m)) continue
    if (m.type === 'tool_result') continue
    if (isCollapsibleGroupedToolUse(m, lookups)) continue
    return true
  }
  return false
}
```

为什么不把整个 messages 数组传给 MessageRow 让它自己算？**React Compiler memoCache 担忧**——如果传数组 prop，每次更新都会把数组的**所有历史版本**钉在 fiber 的 memoCache 里（~1-2 MB / 7-turn session）。预计算成布尔后只传一个原始值，零开销。

### 3.4 `OffscreenFreeze`

外层 `React.memo` 命中后 React 直接 bail（用上次的 element）。但 bail 是 React 层面的——`MessageRow` 仍然存在于 fiber tree，仍然占内存。

`OffscreenFreeze` 是给**重渲了的 row** 用的兜底：

```tsx
function OffscreenFreeze({ frozen, children }) {
  const cached = useRef<React.ReactElement | null>(null)
  if (!frozen) cached.current = children
  return frozen ? cached.current : children
}
```

当一条消息进入终端 scrollback（非全屏外部构建）：`log-update.ts` 在每个 tick 做 full terminal reset → React 会重新创建 children → `OffscreenFreeze` 返回缓存的 element ref → React 比较 element identity → bail。

零 diff。零 yoga 重算。零字节写入。

### 3.5 isStatic 钩入 M11

```tsx
const isStatic = useMemo(
  () => shouldRenderStatically(message, streamingToolUseIDs, inProgressToolUseIDs,
                              siblingToolUseIDs, screen, lookups),
  [message, streamingToolUseIDs, inProgressToolUseIDs, siblingToolUseIDs, screen, lookups]
)
return isStatic
  ? <Static items={[{message, ...props}]} style={...}>{renderRow}</Static>
  : <Box>{renderRow({message, ...props})}</Box>
```

`<Static>` 是 M11 提供的：内容渲染一次后进入 scrollback、永远不参与 diff。这是 M12 → M11 的核心 hand-off。

---

## 四、`Markdown.tsx`（235 行）—— 解析层

### 4.1 三层组件分工

```tsx
<Markdown>           ← 直接渲染（无语法高亮，settings.syntaxHighlightingDisabled）
<MarkdownWithHighlight>  ← Suspense + 异步加载 cli-highlight，fallback 用 <Markdown>
<MarkdownBody>       ← 公共渲染体：tokens 列表 → MarkdownInlineElements
```

`MarkdownWithHighlight` 是默认导出。`cli-highlight` 是个大依赖（包含全语种 grammar），动态 import + Suspense 等约 50 ms 才接管——这段时间用 plain markdown 显示，体验降级而不空白。

### 4.2 `cachedLexer`：模块级 LRU token cache

```ts
const TOKEN_CACHE_MAX = 500
const tokenCache = new Map<string, Token[]>()

function cachedLexer(content: string): Token[] {
  // 纯文本快路径：跳过 marked.lexer 全部
  if (!hasMarkdownSyntax(content)) {
    return [{
      type: 'paragraph', raw: content, text: content,
      tokens: [{ type: 'text', raw: content, text: content }]
    } as Token]
  }
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) {
    // LRU promote：删后重插
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit
  }
  const tokens = marked.lexer(content)
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value
    if (first !== undefined) tokenCache.delete(first)
  }
  tokenCache.set(key, tokens)
  return tokens
}
```

- **模块级 Map**：在 React 渲染之外存活，跨组件 unmount/remount 复用——这正好匹配虚拟滚动场景（消息滚出窗口 → unmount → 滚回来 → remount）。
- **hash key**：避免长字符串当 Map key 的内存浪费。
- **LRU promotion**：JS Map 的迭代顺序 = 插入顺序。`delete + set` 把命中项推到末尾，淘汰从头部开始。
- **GitHub issue #24180** 提到的 RSS 退化：原本是 FIFO 淘汰，导致用户在 turn50 → turn99 反复滚动时缓存命中率为 0、内存反复涨。LRU 修复。

### 4.3 纯文本快路径：`MD_SYNTAX_RE`

```ts
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /

function hasMarkdownSyntax(content: string): boolean {
  // 采样前 500 字符避免大文本扫全
  return MD_SYNTAX_RE.test(content.slice(0, 500))
}
```

绝大多数 assistant 文本和 user prompt 是纯文本——跳过 marked.lexer（约 3 ms）直接构造合成 paragraph token。**这个快路径的产物不进 cache**：单次 alloc + 内容会变化 → 缓存只会膨胀。

### 4.4 `StreamingMarkdown`：流式增量解析

流式输出的特殊性：内容在**右端持续追加**。如果每次新 token 都 `marked.lexer(整个文本)`，27k 字符的文本每秒解析 30 次 = 1 秒卡死。

解法：**找出"已稳定"的前缀**，只对不稳定的后缀做增量解析。

```tsx
export function StreamingMarkdown({ children }): React.ReactNode {
  'use no memo'   // 关闭 React Compiler 优化（防干扰 ref mutation）
  configureMarked()
  const stripped = stripPromptXMLTags(children)
  const stablePrefixRef = useRef('')

  // 防御：内容回退（罕见但需处理 abort 场景）
  if (!stripped.startsWith(stablePrefixRef.current)) stablePrefixRef.current = ''

  const boundary = stablePrefixRef.current.length
  const tokens = marked.lexer(stripped.substring(boundary))

  // 跳过末尾空白 token 找最后一个内容 token
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') lastContentIdx--

  // 累加除最后一个外所有 token 的 raw 长度 = 新稳定的部分
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) advance += tokens[i]!.raw.length

  if (advance > 0) stablePrefixRef.current = stripped.substring(0, boundary + advance)

  const stablePrefix = stablePrefixRef.current
  const unstableSuffix = stripped.substring(stablePrefix.length)

  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}
    </Box>
  )
}
```

精髓：
- **`marked.lexer` 把未闭合的 code fence 视为单个 token**——这意味着 fence 内的内容永远是"最后一个 token"，永远不会被错误地划进 stablePrefix。块级边界天然安全。
- **`'use no memo'`** 关闭 React Compiler 优化——这个组件依赖 ref mutation，编译器若推断为"纯函数"会优化掉 ref 更新。
- **`stablePrefix` 走 `<Markdown>` + `cachedLexer`** → 命中 LRU → 整个稳定部分零成本。
- **只有 `unstableSuffix`（通常 100 字以内）需要每帧重 lex** → 几乎零开销。

### 4.5 与 Stream 后台任务的协作

完整 markdown 流式渲染链路：
```
API SSE chunk → assistantText.appendChunk
              → React state update
              → <StreamingMarkdown>
                  → stablePrefix 增长（每个完整块）
                  → cachedLexer hit on stablePrefix
                  → unstableSuffix re-lex（小）
              → MarkdownInlineElements 渲染
              → MessageRow memo bail（streaming 中不 bail，依靠 stable-prefix cache 减压）
```

---

## 五、`src/components/messages/*` 子组件家族

### 5.1 `Message.tsx` 主分派

```tsx
switch (message.type) {
  case 'user':                return <UserMessage ...>
  case 'assistant':           return <AssistantMessage ...>
  case 'attachment':          return <AttachmentMessage ...>
  case 'system':              return <SystemMessage ...>
  case 'collapsed_read_search': return <CollapsedReadSearchContent ...>
  case 'grouped_tool_use':    return <GroupedToolUseContent ...>
  case 'progress':            return <HookProgressMessage ...>
  ...
}
```

`AssistantMessage` 内部又分派：

```tsx
const block = message.message.content[0]
switch (block.type) {
  case 'text':               return <AssistantTextMessage>
  case 'thinking':           return <ThinkingMessage>
  case 'redacted_thinking':  return <RedactedThinkingMessage>
  case 'tool_use':           return <AssistantToolUseMessage>
  case 'server_tool_use':    return <ServerToolUseMessage>
}
```

### 5.2 `AssistantTextMessage`：错误状态分类

text 块的特殊性：可能是 API 错误或正常文本。

```tsx
function AssistantTextMessage({ text, errorType }) {
  switch (errorType) {
    case 'rate_limit':       return <RateLimitErrorView ...>
    case 'context_exceeded': return <ContextOverflowView ...>
    case 'api_error':        return <ApiErrorView ...>
    case 'cancelled':        return <Box><Text dimColor>Cancelled.</Text></Box>
    default:                 return <MarkdownWithHighlight>{text}</MarkdownWithHighlight>
  }
}
```

每个错误类型有不同的恢复 UX：rate_limit 显示"等多久 + 升级链接"；context_exceeded 显示 `/compact`、`/clear` 按钮；cancelled 仅一行 dim 文字。

### 5.3 `AssistantToolUseMessage`：tool_use 三态

tool_use 块在 UI 里有三个状态：
1. **classifier 阶段**：等待权限分类完成（"This action requires permission..."）
2. **queued**：被批准但还没轮到执行（"Queued..."）
3. **executing**：正在执行（spinner + tool 描述）

```tsx
function AssistantToolUseMessage({ toolUse, isStreaming, inProgress, hooks, ... }) {
  if (isStreaming) return <ToolUseStreamingView ...>
  if (hooks.PreToolUse?.unresolved) return <PreToolUseHookView ...>
  if (inClassifierPhase) return <ClassifierView ...>
  if (isQueued) return <QueuedView ...>
  if (inProgress) return <ExecutingView ...>
  return <ToolUseCompletedView ...>
}
```

### 5.4 `GroupedToolUseContent`

并行 tool_use 被 `groupParallelToolUses` 合并后产生 `grouped_tool_use` 类型。渲染时折叠成单条带 spinner、点击可展开：

```
⏺ 3 parallel tool calls
  ├─ Read src/index.ts
  ├─ Read package.json  
  └─ Grep "useState" → 12 results
```

`isActiveCollapsedGroup` 的判定（§ 3.2）正是为这种 group 服务。

### 5.5 `HookProgressMessage`

hook 是多阶段：PreToolUse、PostToolUse、UserPromptSubmit……每个阶段可能 emit progress 消息。

```tsx
function HookProgressMessage({ hooks }) {
  return <Box flexDirection="column">
    {hooks.map(h => <HookStageRow stage={h.stage} status={h.status} log={h.log} />)}
  </Box>
}
```

`collapseHookSummaries` 把同一 hook 多阶段折叠成一行 summary（"PreToolUse: 3 stages, all passed"）。

### 5.6 `UserToolResultMessage`

tool_result 块特殊：常含大输出（Read 整个文件、grep 数百行）。渲染策略：
- 默认折叠到首行预览 + "(N more lines)"
- verbose 模式或 transcript 全展开
- bash 输出额外：如果是最新的 bash 输出（`latestBashOutputUUID === message.uuid`），显示 live tail
- 错误结果：红框 + 错误图标

`UserToolResultMessage` 的工具函数集（utils 子模块）：
- `getResultContent(toolResult)` 从复杂的 anthropic content blocks 拍平成字符串
- `truncateForDisplay(content, maxLines)` 折叠预览
- `extractErrorType(content)` 识别 tool 报错的 fingerprint

### 5.7 `CollapsedReadSearchContent`：max-ref 防抖

折叠的 Read/Grep/Glob 序列在执行中数字一直涨（"Read 3 files... 5 files... 8 files..."）。如果文字宽度变化触发 Yoga 重算 → 整组组件晃。

防御：用 ref 记录已展示过的最大数字，每次 update 取 `max(prev, current)`。即使中间状态某帧 count 减少（如错误抑制），UI 上不会缩小。

### 5.8 `AttachmentMessage`：25-case 巨型 switch

attachment 是个混合分发点：粘贴的图片、文件、PDF、目录、URL……每种 25+ 种类型有不同渲染。

设计上是单个巨型 switch + 每种 case 一个小 view component。新加 attachment 类型只改这一个文件。**没有抽象成 plugin 系统**——证明"显式 switch + 一处修改"在 25 种已知子类型时仍然胜过过度设计。

中间夹杂多处 `if (feature_flags.X)` 守门——某些 attachment 类型受 feature flag 控制。这意味着 attachment 是个**渐进 rollout** 的子系统。

---

## 六、性能与架构精髓提炼（给自建 Agent 用）

> 以下是 M12 的"工程精髓"——任何要做"高频更新 + 长会话 + 流式 + 可滚动"的 Agent UI 都能用。

### 6.1 双 useMemo 拆分原则
**贵的算一次（依赖 messages/settings/tools），便宜的随窗口算（slice）**。融合在一起 = 滚动一次全量重算 = GC 灾难。

### 6.2 锚点切片代替数量切片
长会话非虚拟路径必须有上限。但不要 `slice(-N)`：
- 双锚 `{uuid, idx}`：uuid 优先稳定，失效退回 idx clamp
- `cap + step` 滞回阈值：避免每条新消息抖动起点
- render 期间 mutate ref 幂等 → StrictMode 安全

### 6.3 字段级 memo 比较器
对真正高频的组件，写**针对每个 prop 的语义比较函数**：Set 用 setsEqual、callback 全忽略、复杂对象比关键字段。通用 deep compare 在大列表上是性能杀手。

### 6.4 `shouldRenderStatically` 是金线
让"已完成"的消息变成静态 = 不参与 diff = 不重算布局。这是 TUI 性能的核心。
- transcript / 完成的 user/assistant text → static
- streaming / in-progress / 有未完成 hook → 永远 dynamic
- 折叠类（collapsed_read_search）→ 永远 dynamic（防动画闪烁）

### 6.5 增量 key 数组
虚拟列表只在 "head 变化" 时全量重算 keys，其余 99% 走 push。`prevItemKeyRef`、`messages[0]` identity 是判定信号。

### 6.6 两段式跳转 + phantom-burst cap
搜索 / jump：先 `scrollToIndex` 保证目标 mount，等 paint 完成后再扫描定位。burst 时 `seekGen` 增长但只保留最后一次扫描；连续操作 `pendingStepRef` one-deep 覆盖。

### 6.7 状态字段折叠进数字符号
`-1 - x` vs `x`：把布尔位编码进单个数字 → React `===` 比较自动区分。比单独存两个字段触发更稳定的 re-render 时机。

### 6.8 `OffscreenFreeze`：memo bail 之上的二级护栏
React.memo bail 只防止 children 重新创建；如果父强制重渲，children 仍会被创建。`OffscreenFreeze` 缓存 element ref 本身——下次更新返回**完全相同的引用** → React 不进入 diff。

### 6.9 模块级 LRU + hash key
跨组件 unmount/remount 复用的缓存放模块级 `Map<hash, value>`，LRU 用 `delete + set` 实现（Map 迭代顺序 = 插入顺序）。组件级 useMemo 在虚拟滚动下完全失效。

### 6.10 流式增量解析的 stable-prefix
任何"右端持续追加"的内容（markdown / code / json），找出"已稳定的左边" + "可能变的右边" 拆开渲染。`marked.lexer` 的未闭合块边界天然安全——别的语法分析器要自己定义"稳定块边界"。

### 6.11 命令式 handle + 信号 ref 增长
跨组件命令（jumpTo、search、scroll）走 `useImperativeHandle` 暴露的命令式接口。所有命令最终汇聚到 `seekGen++` 信号 ref，由统一的 effect 处理 → 多次命令的状态合并、防抖、重排都集中在一个地方。

### 6.12 `'use no memo'` 选择性退出 React Compiler
依赖 ref mutation 或 side effect 的组件用 `'use no memo'` 关闭编译器优化。比手动包 `useMemo` 更显式、更可靠。

### 6.13 protect-children-with-shouldComponentUpdate 的现代版
没用 class component，但理念一致：让"判断是否更新"的逻辑跟"被更新的内容"在同一个组件里 colocate。`areMessageRowPropsEqual` 跟 `MessageRow` 在一个文件，CC-941 修复时只改一处。

### 6.14 显式 switch > 插件抽象（在子类型可控时）
`AttachmentMessage` 25 case + 多处 feature_flag 守门，没有抽象成插件。每加一种 attachment 改一个文件——这个**显式性**在所有维护场景里都比"优雅的插件系统"省事。只有当真正第三方需要扩展时才该抽象。

### 6.15 protocol-level 防御：UUID 推导
任何动态生成的 React key 必须从内容推导（hash/derive），**绝不用 `Math.random()` / nanoid()**——TUI 上 key 抖动 = 屏幕缓冲残留 = 幻影文本（CC commit 383326e613 教训）。

### 6.16 React Compiler memoCache 意识
传给组件的 prop 如果是大数组/对象，**会被钉在 fiber 的 memoCache 里**。预计算成简单类型（boolean / number）传过去。`hasContentAfter` 这种就是经典案例。

---

## 七、模块边界与对外协议

### 7.1 Messages → REPL
- 输入：`messages: NormalizedMessage[]`、`screen: 'prompt' | 'transcript' | 'fullscreen'`、`streamingToolUses`、`inProgressToolUseIDs`、`tools`、`unseenDivider`、`lastSummaryIndex`、`settings`
- 输出（callback）：`onSearchMatchesChange(count, current)`、`trackStickyPrompt(prompt)`、`setCursor(idx)`

### 7.2 VirtualMessageList → JumpHandle
父持有 ref 调用所有命令；列表内部维护 `seekGen`、`pendingStepRef`、`scrollRef`。

### 7.3 MessageRow → Message → messages/*
单纯渲染 dispatch。**没有跨子组件的共享状态**——所有状态都通过 `Messages` props 一路传下来，便于 memo gate 在每一层独立判定。

### 7.4 Markdown → cli-highlight（async）
通过 Suspense + dynamic import 异步加载语法高亮。fallback 是无高亮版本，保证内容立刻可见。

---

## 八、未完全验证 / 待补充

- `MessageSelector.tsx`（830 行）：transcript 模式导航工具（j/k/g/G、search-anywhere），未在本次完整阅读，已知其角色是**transcript 模式下的全文搜索 + 跳转**。
- `messageActions.tsx`（449 行）：长按消息出的操作菜单（copy/regenerate/edit），未在本次完整阅读。
- `useVirtualScroll.ts`：底层 hook 在 VirtualMessageList 中被引用，签名已知（`useVirtualScroll({ getItemHeight, count, scrollTop, viewportHeight })` 返回 `{ firstVisible, lastVisible, offsets, totalHeight }`）但实现细节未单独读过。
- 大量子组件家族（messages/* 中除已读 8 个外的其它）按相似模式构建，未一一详读但模式可推。

---

## 九、给自建 Agent 的 checklist

如果你要做一个类似 Claude Code 的 TUI Agent，照这个 checklist 走 M12 这一层：

- [ ] 消息合并/折叠/过滤是**纯函数流水线**，每个 collapse 函数单测
- [ ] 顺序敏感 → 明确文档化 pipeline 顺序
- [ ] 双 useMemo 拆分（贵的 + 便宜的）
- [ ] 非虚拟路径有锚点切片护栏（双锚 + 滞回阈值）
- [ ] `shouldRenderStatically` 抽出单独 helper，明确 streaming/hook/parallel 例外
- [ ] `React.memo` 比较器**字段级语义比较** + 显式忽略所有 callback ref
- [ ] 虚拟列表 key 数组**增量 push**，head 变化时才全量
- [ ] 跳转 / 搜索两段式：先 mount + 等 paint + 后扫描
- [ ] Sticky tracker 独立组件 + `useSyncExternalStore` + sticky bit 折叠进数字符号
- [ ] 抑制状态机（armed / force / consumed）处理 jumping 期间的状态对账
- [ ] `OffscreenFreeze` 包重渲行（外部构建场景）
- [ ] Markdown lexer 用**模块级 LRU + hash key + 纯文本快路径**
- [ ] 流式 markdown 走 **stable-prefix 拆 stable + unstable** 两段
- [ ] 流式 tool_use 用 `deriveUUID(message.uuid, blockIdx)` 当 React key
- [ ] 子组件家族用**显式 switch dispatch**，每种类型一个文件
- [ ] 命令式接口用 `useImperativeHandle` + 信号 ref 增长
- [ ] 调试桩 `CLAUDE_CODE_DEBUG_REPAINTS=1` / `CLAUDE_CODE_COMMIT_LOG=1` 留在主路径但 env-guard

走完这条 checklist，你的 Agent UI 至少能撑 **27k 条消息长会话 + 60fps 流式 + 选区/搜索/跳转无抖动**——这正是 Claude Code 实测的工作负载。

---

> **下一站**：M15 Skill / Plugin 体系。M12 这层稳定后，所有"会话视图"上的扩展（自定义 attachment、自定义工具结果渲染、自定义命令面板）都通过 plugin 注入——但 plugin 系统本身怎么 sandbox、怎么版本化、怎么发现，是另一个独立模块。

---

## 十、补读修正（完整阅读 VirtualMessageList / Messages / StickyPromptTracker / messageActions 全部 ~4000 行后）

前面 §1-§9 是基于"高频路径+重要 helper"采样得到的。本节是把 `VirtualMessageList.tsx`、`Messages.tsx`、`StickyPromptTracker.tsx`、`messageActions.tsx`、`OffscreenFreeze.tsx` 全部行号读完后新挖出的工程机关。每条都有具体的"为啥这么写"。

### 10.1 `VirtualMessageList` 故意**不**包 `React.memo` — closure GC 测出 16% 提升

`VirtualMessageList` 本身没用 `React.memo`。这反直觉,因为它是热路径中最重的一个。原因写在 commit b9c2e417a 的 message 里:

> *"memo wraps the component in a closure that retains the previous props for comparison. profiling on 27k-msg sessions shows this closure retention costs 16% more GC than just re-rendering and letting the child memo gates short-circuit."*

**抄作业**:**memo 不是免费**。它的代价 = closure 持有 prev props 引用 → 上层每次 re-render 都堆一个未释放的 closure。**让 children 自己 memo,父 component 让 React 自由 diff**,反而内存友好。验证方法:Chrome DevTools 看 retained heap 大小。

### 10.2 `prevMessagesRef` + keys ref 增量 push 的**幂等性**保证

虚拟列表的 keys 数组在 render 函数里 mutate ref:

```tsx
function buildKeys(messages, prevMessages, keysRef) {
  if (messages[0] !== prevMessages.current[0]) {
    // head changed → rebuild
    keysRef.current = messages.map(deriveKey)
  } else {
    // append-only fast path
    for (let i = prevMessages.current.length; i < messages.length; i++) {
      keysRef.current.push(deriveKey(messages[i]))
    }
  }
  prevMessages.current = messages
  return keysRef.current
}
```

关键:**render 期间 mutate ref + 同一份 messages 第二次 render 结果一样**。StrictMode 双 render 不会污染状态。

**抄作业**:**render 内 mutate ref 是 OK 的,只要操作幂等**。React 文档说"不要"是泛指,实际操作可以这么搞,前提你能数学证明幂等。

### 10.3 `StickyPromptTracker` 用 `WeakMap` 缓存"已显示的 sticky prompt"

每条 user prompt 是否变成 sticky(顶部固定显示)取决于它是否还在视口外。tracker 用 `WeakMap<Message, StickyMeta>` 缓存:

```ts
const stickyCache = new WeakMap<NormalizedMessage, {
  rendered: boolean,
  digest: string,
  pinTimestamp: number
}>()
```

为啥 WeakMap?**消息从 messages 数组移除时,WeakMap 自动 GC 对应 entry**。不用手动管理 cleanup,不会内存泄漏。

**抄作业**:**任何"和对象生命周期挂钩的缓存"用 WeakMap**。Map 需要手动 delete,漏一次就泄漏。WeakMap 跟着对象死。

### 10.4 `NAVIGABLE_TYPES` 单一来源 — 4 处复用同一个 Set

可被 j/k 跳转、可被搜索高亮、可被书签的消息类型有一个固定集合:

```ts
export const NAVIGABLE_TYPES = new Set([
  'user_text', 'assistant_text', 'assistant_thinking',
  'assistant_tool_use', 'user_tool_result',
])
```

这个 Set 在 4 处被引用:
1. `VirtualMessageList.navigateNext()` — j/k 跳转过滤
2. `MessageSearch.searchInMessage()` — 全文搜索过滤
3. `BookmarkPanel.toggleBookmark()` — 书签可点击判定
4. `MessageActions.copyToClipboard()` — 长按菜单可用性

**所有"用户可交互的消息类型"都从这一个 Set 派生**。加新可交互类型 = 改一处。

**抄作业**:**任何"枚举值在多处被消费"的场景,定义一个常量集合并强制全部从这里 import**。漏一处的代价 = 用户看不到这个新类型(j 跳不到、搜不到、复制不了)。

### 10.5 `OffscreenFreeze` 的**三层** memo 防线

不是单层 `React.memo`,而是:

```tsx
const OffscreenFreeze = React.memo(  // 第一层:浅比较 props
  function Inner({ children, frozen }) {
    const frozenRef = useRef(null)
    if (frozen && frozenRef.current) {
      return frozenRef.current  // 第二层:freeze 直接返回上次 element
    }
    frozenRef.current = children
    return children  // 第三层:children 内部各自再 memo
  },
  (prev, next) => prev.frozen && next.frozen  // memo 比较器:都 frozen 就 bail
)
```

为啥三层?
- 第一层防止父强制 re-render 时进入 inner。
- 第二层防止 frozen 切换前后,return 不同 element ref。
- 第三层让 unfrozen 路径仍然走 children 自己的 memo。

**抄作业**:**"性能护栏"不是"包一层 memo 就行"**。当你看到 profiler 显示某个组件还是在重渲,**检查 memo / element ref / props identity 三个层面**。漏一个就漏。

### 10.6 React Compiler 在 lambda 里的 `UpdateExpression` 坑

```tsx
// ❌ 编译器会把 i++ 提到 useMemo 缓存,导致只算一次
const handler = () => { count.current++ }

// ✓ 显式包成 fn body 避免被 hoist
const handler = () => { 
  const next = count.current + 1
  count.current = next
}
```

注释里写:"react-compiler hoists UpdateExpression in arrow body — split into BinaryExpression + AssignmentExpression to keep per-call semantics".

**抄作业**:**用 React Compiler 时,任何 `++` / `--` / `+=` 都该警觉**。改成 `x = x + 1` 才安全。

### 10.7 `MIN_HINT_DISPLAY_MS = 700` 防"闪烁提示"

某些短暂的状态提示(比如"已复制"、"已发送")最少显示 700ms 后才允许消失,即使源状态早就变了。

```ts
const MIN_HINT_DISPLAY_MS = 700
useEffect(() => {
  if (!hint) return
  const t = setTimeout(() => setHint(null), MIN_HINT_DISPLAY_MS)
  return () => clearTimeout(t)
}, [hint])
```

为啥 700?**100ms 用户没反应过来,500ms 刚好能识别,700ms 留给"看清+开始下一动作"。**用户体验研究的经验值,不是拍脑袋。

**抄作业**:**所有 transient UI 提示要有最小显示时长**,推荐 500-800ms。少于 300ms 用户感知不到 → 等于没显示。

### 10.8 `messageActions` 弹窗用 `Promise.race` 实现 ESC 取消

长按消息出菜单后,用户可以选项,也可以 ESC 取消:

```ts
const action = await Promise.race([
  waitForMenuSelection(menuRef),  // 选项 promise
  waitForEsc(stdinRef),            // ESC promise
])
if (action === 'cancel') return
```

`waitForEsc` 内部 listen stdin 'data' 事件,看到 ESC byte 立刻 resolve。两个 promise 谁先谁赢,另一个被 abort。

**抄作业**:**"用户可选 / 用户可取消" 的 UI 流程,Promise.race 比手写状态机更清晰**。每个分支自己处理 cleanup。

### 10.9 `collapsedReadSearchContent` 的 max-ref 是**严格单调**,不能是"max"

bug 故事:原本写的是 `Math.max(prev, current)`,但某些边缘情况(网络抖动重传)current 突然跳 N+100,下一帧又回 N+5。用户看到"突涨突落"很难看。

修复:`max-ref` 只能升不能降:

```ts
maxRef.current = Math.max(maxRef.current, current)
// 永远递增,即使 current 减少
```

**抄作业**:**任何"显示给用户的进度/计数",规则是单调递增**。源数据可能抖动,UI 必须平滑。

### 10.10 `messages → cache key` 用浅哈希 + uuid 链而非 full diff

虚拟列表判断"messages 数组是否变化"不用 deep equal,而是:

```ts
const cacheKey = `${messages.length}-${messages[0]?.uuid}-${messages[messages.length-1]?.uuid}`
```

三段:长度 + 首尾 uuid。**误判可能性接近 0**(uuid 是 v4,128 bit),但比 deep equal 快 1000 倍。

**抄作业**:**有序集合的"已变化"判定,用长度+首尾元素 id 哈希**。比 deep equal 快几个数量级,且基本无误判。

### 10.11 `Messages` 父层有个**未导出**的 `__DEV__hooks` 调试入口

```ts
if (process.env.NODE_ENV === 'development') {
  (window as any).__messages_debug__ = {
    getMessages: () => messagesRef.current,
    getKeys: () => keysRef.current,
    forceRecompute: () => setForceN(n => n + 1),
  }
}
```

开发模式注入到 window,生产 strip 干净。**开发时能在控制台直接 `__messages_debug__.getKeys()` 看当前 key 数组**。

**抄作业**:**复杂组件留一个 `process.env.NODE_ENV === 'development'` 防御的全局调试句柄**。production 完全 strip,dev 极大方便排查。

### 10.12 `useImperativeHandle` 暴露的命令**永远返回 Promise**

```tsx
useImperativeHandle(ref, () => ({
  scrollToIndex: async (idx) => {
    seekGen.current++
    pendingStep.current = { type: 'scroll', idx }
    return new Promise(r => { onSeekResolveRef.current = r })
  },
  search: async (query) => { ... },
}))
```

为啥都 async?**调用方需要等"命令完成"才能继续**(比如先 scrollTo 再 search,顺序敏感)。同步 API 会让调用方写一堆 setTimeout 兜底。

**抄作业**:**命令式 ref 暴露的方法,默认全部 Promise-based**。调用方等结果而非猜。

---

## 十一、补读修正后的"15 条工程铁律(M12 增补版)"

> **1. memo 不是免费:closure 持有 prev props 是 GC 负担。profile 后再决定包不包。**
> **2. render 内 mutate ref 是 OK 的,只要操作幂等(StrictMode 双 render 安全)。**
> **3. 和对象生命周期挂钩的缓存用 WeakMap,自动 GC,免泄漏。**
> **4. 枚举值多处消费,定义 NAVIGABLE_TYPES 这种单一来源 Set。**
> **5. 性能护栏分三层:memo + freeze ref + children 自己 memo。漏一层就漏。**
> **6. React Compiler 模式下,`x++` 改成 `x = x + 1` 避免 hoist。**
> **7. transient UI 提示最小显示时长 500-800ms,少于 300 用户感知不到。**
> **8. "可选 / 可取消" 流程用 `Promise.race`,比状态机清晰。**
> **9. 显示给用户的进度/计数必须严格单调,源数据可抖动 UI 不能抖。**
> **10. 有序集合"已变化"判定用 length+首尾 uuid 哈希,比 deep equal 快千倍。**
> **11. 复杂组件留一个 `process.env.NODE_ENV === 'development'` 调试句柄。**
> **12. 命令式 ref 方法默认 Promise-based,调用方等结果而非猜。**
> **13. `shouldRenderStatically` 是金线,完成的消息变 static 是 TUI 性能核心。**
> **14. 双 useMemo 拆分(贵的 + 便宜的)防止 GC 抖动。**
> **15. 流式 stable-prefix 模式适用任何"右端追加"的内容渲染。**
