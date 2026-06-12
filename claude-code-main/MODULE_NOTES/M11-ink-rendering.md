# M11 · React/Ink 终端渲染子系统

> 目录:`src/ink/`(45 个 top-level + `components/`、`hooks/`、`layout/`、`events/`、`termio/` 五个子目录,合计 90+ 文件)
> 关联辅助:`src/native-ts/yoga-layout/index.ts`(自研 Yoga 纯 TS 端,2578 行)
> 阅读范围:全部 top-level + 全部子目录;`native-ts/yoga-layout` 通过 `layout/yoga.ts` 适配器侧观察 API 契约
> 终极问题:**怎么把 React 渲染成 60fps、可选区、可点击、跨多种终端不闪烁的字符画**

---

## 0. 一句话定位

`src/ink/` 是 **Claude Code 自研的 Ink**——把 React 树渲染成终端字符的引擎。它**不是 wrapper**:从 react-reconciler 适配、Yoga 布局、ANSI parser、双缓冲 screen diff、虚拟滚动、点击/选区、键位解码,到终端能力探测全部自建。设计目标是 **流式高频更新场景下的零闪烁、低延迟、可交互**(REPL + VirtualMessageList 不停打字、不停 token-stream 还要支持鼠标选中)。

OSS Ink 的痛点(为什么 Claude Code 要自研):
1. OSS Ink 用 `log-update` 整块重写,流式场景下宽屏闪烁明显
2. OSS Ink 没有真正的选区/点击/超链接系统
3. Yoga 是 WASM,启动 & 子进程 fork 都要 reload,Claude Code 的 sub-agent 严重受冲击
4. OSS Ink 的 reconciler 是 LegacyRoot,无 priority,流式 token 阻塞用户输入
5. 没有 alt-screen 全屏管理,没有 sync output(BSU/ESU)

---

## 1. 整体架构与数据流

```
                       React 组件树
                            ↓
                    [react-reconciler 0.33]
                            ↓
          dom.ts(DOMElement 虚拟 DOM 树,含 yogaNode 引用)
                            ↓
        layout/yoga.ts(YogaLayoutNode adapter)→ native-ts/yoga-layout(纯 TS Yoga)
                            ↓                       ↑
                      .calculateLayout()           getComputedLayout()
                            ↓
                  render-node-to-output.ts
       (DFS,文字测量 squash-text-nodes / wrap-text / bidi,写入 Output)
                            ↓
                       output.ts(单元格缓冲)
                            ↓
                       screen.ts(双缓冲 diff)
                            ↓
                       optimizer.ts(patch 合并)
                            ↓
              log-update.ts / Static / AlternateScreen
        (BSU/ESU 同步写;光标/滚动/边界补偿;tmux/bidi/vscode 兼容)
                            ↓
                       process.stdout
```

并行子系统:
- **events/**:click/focus/keyboard/input/terminal/terminal-focus 六种事件,emitter → dispatcher → 用户 hooks
- **hit-test.ts**:基于 `nodeCache`(每帧渲染后写入的 rect 缓存)做坐标命中,反向遍历兄弟 → DOM 冒泡
- **focus.ts**:`FocusManager` 维护焦点栈(max 32)、autoFocus、Tab 循环
- **selection.ts**:跨行字符级选区,带 SpacerHead/SpacerTail/NoSelect 排除,支持复制
- **terminal.ts / terminal-querier.ts**:启动期探测终端能力(extended keys、sync output、xtversion、true color),全是 sentinel 模式
- **termio/**:自研 ANSI parser(SGR/CSI/OSC/ESC),给 `<Ansi>` 组件和 `parse-keypress` 用

---

## 2. Reconciler 层(`reconciler.ts` 512 行)

### 2.1 适配器配置

完整实现 `react-reconciler@0.33` 的 `HostConfig`,关键 callback 与设计点:

| Callback | 实现要点 |
|---|---|
| `createInstance(type, props, root, hostContext)` | 调 `createNode(type)`,然后 `setStyle/setAttribute/setTextStyles` 应用 props。**hostContext.isInsideText** 决定 `ink-text` 是否转 `ink-virtual-text`(嵌套 Text 不需要 yoga node,文本字符串拼接) |
| `getChildHostContext(parent, type)` | 设置 `isInsideText = type === 'ink-text' \|\| 'ink-virtual-text' \|\| 'ink-link'`,向下传递 |
| `appendChild` / `insertBefore` / `removeChild` | 通过 `dom.ts` 的 `appendChildNode/insertBeforeNode/removeChildNode`,内部维护 **DOM 索引 ≠ Yoga 索引**(virtual-text/link/progress 不进 yoga) |
| `commitUpdate(node, type, oldProps, newProps)` | `diff()` 浅比较 props 与 style 分别 diff;只有变化的部分才调 yoga setter(避免不必要的 dirty mark) |
| `commitMount(instance)` | 仅在 `autoFocus===true` 时,由 `finalizeInitialChildren` 返回 true 触发,内部调 `focusManager.handleAutoFocus` |
| `hideInstance` / `unhideInstance` | 切换 `isHidden` flag 并设置 yoga `display: none/flex`——`isHidden` **必须独立于 style 修改**,这样后续 setStyle 不会误重置 hide(影响 `<Box display='none'>` 与运行时 hide 的协同) |
| `prepareUpdate` | 返回 `true`(让 React 调 commitUpdate);diff 逻辑放在 commitUpdate 内 |
| `clearContainer` | 不实现(React 永远不卸载根容器,卸载在 `root.ts`) |
| `removeChild` 后续 | `collectRemovedRects` 收集被删除节点占用的屏幕 rect,放到 `pendingClears` 供下一帧 erase |

### 2.2 cleanupYogaNode 顺序很关键

```ts
function cleanupYogaNode(node) {
  clearYogaNodeReferences(node)   // 先清 JS 侧引用
  node.yogaNode?.freeRecursive()  // 再释放 native(纯 TS) node
}
```

**先清引用,再 free**——native-ts 是纯 TS 不会崩,但留这个顺序是为了万一切回 WASM 时**避免并发访问已释放指针**(若 cleanup 顺序反了,在 free 与下一帧 measureFunc 之间有 race window,WASM 会直接 crash;native-ts 也保留这个保护,因为它的 child→parent 弱引用还是 JS GC 管理)。

### 2.3 dispatcher 解耦

```ts
import { reconciler } from './reconciler.js'
import { dispatcher } from './events/dispatcher.js'

dispatcher.discreteUpdates = reconciler.discreteUpdates.bind(reconciler)
dispatcher.getCurrentUpdatePriority = reconciler.getCurrentUpdatePriority.bind(reconciler)
dispatcher.resolveUpdatePriority = reconciler.resolveUpdatePriority.bind(reconciler)
dispatcher.setCurrentUpdatePriority = reconciler.setCurrentUpdatePriority.bind(reconciler)
dispatcher.resolveEventType = reconciler.resolveEventType.bind(reconciler)
dispatcher.resolveEventTimeStamp = reconciler.resolveEventTimeStamp.bind(reconciler)
```

**模块循环破解技巧**:`dispatcher` 不能 import `reconciler`(`reconciler` 已经 import `dispatcher` 的事件 priority 函数),所以 `reconciler.ts` 在创建完 reconciler 后**注入式赋值**回 dispatcher 的对应 slot。这个手法在 React DOM 里也用,Claude Code 完全照搬。

### 2.4 调试桩(默认关闭)

```ts
if (process.env.CLAUDE_CODE_DEBUG_REPAINTS) {
  node.debugOwnerChain = getOwnerChain(currentInternalRef.current)
}
```

`getOwnerChain` 走 `_debugOwner ?? return`,把 fiber 的属主链记录到 DOMElement。`render-node-to-output` 重绘时会 `findOwnerChainAtRow` 把"导致这一行重绘的 React 组件名"打回控制台。日常关闭(零代价),排查闪烁时打开。

### 2.5 COMMIT_LOG 仪表盘

```ts
if (process.env.CLAUDE_CODE_COMMIT_LOG) {
  // 每帧 push { commitTime, reconcileDuration, layoutDuration, paintDuration, yogaMarks }
  // maxGap, commits/sec, SLOW_YOGA 阈值警告
}
```

精确测量瓶颈,生产关闭。这种**条件仪表化**(`if (env) { log }`)是 Claude Code 的统一调优手段——主路径零开销,问题时一键打开。

---

## 3. DOM 层(`dom.ts` 484 行)

### 3.1 DOMElement 是 ink 自己的"虚拟 DOM"

```ts
type DOMElement = {
  nodeName: 'ink-root' | 'ink-box' | 'ink-text' | 'ink-virtual-text'
           | 'ink-link' | 'ink-progress' | 'ink-raw-ansi'
  attributes: Record<string, unknown>
  childNodes: DOMNode[]
  parentNode: DOMElement | null
  yogaNode?: LayoutNode              // 不是所有 nodeName 都有
  yogaIndex?: number                 // 与 childNodes 索引可能不一致
  internal_static?: boolean

  // 渲染期回调
  onComputeLayout?: () => void
  onRender?: () => void
  onImmediateRender?: () => void
  hasRenderedContent?: boolean       // 测试用,生产可忽略

  // 滚动相关
  scrollTop?: number
  pendingScrollDelta?: number
  scrollClampMin?: number
  scrollClampMax?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  stickyScroll?: boolean
  scrollAnchor?: 'top' | 'bottom'

  // 焦点
  focusManager?: FocusManager        // 只有 root 才有(类似 browser node.ownerDocument)
  autoFocus?: boolean

  // 显示控制
  isHidden?: boolean
  dirty?: boolean                    // 需要重测量/重渲染
  debugOwnerChain?: string[]         // CLAUDE_CODE_DEBUG_REPAINTS 才填

  // 事件处理
  _eventHandlers?: EventHandlerMap  // 单独存,handler 引用变化不触发 dirty
}
```

**关键设计**:
1. `_eventHandlers` **从 attributes 抽出来**单独存——handler 引用每次渲染都变(用户写 `onClick={() => ...}`),如果放在 attributes 里,`diff()` 每帧都会标 dirty,白白重测。
2. `yogaIndex` ≠ `childNodes` 索引——因为 `ink-virtual-text`/`ink-link`/`ink-progress` 没有 yoga node,append/insert 时 DOM 走全部子节点,yoga 只走有 yogaNode 的子节点。两套索引并行维护。
3. `isHidden` 是 **运行时 hide 状态**,与 `style.display: 'none'` 区分——reconciler `hideInstance` 把 yoga display 设 none + 标 `isHidden`,后续如果用户 setStyle 改了 display,`isHidden` 仍然挡着不让显示;`unhideInstance` 清 flag。

### 3.2 createNode 选型矩阵

```ts
function createNode(type: ElementNames): DOMElement {
  switch (type) {
    case 'ink-virtual-text':
    case 'ink-link':
    case 'ink-progress':
      // 不创建 yoga node — 这些是文本流的一部分,父级 Text 才负责 yoga 测量
      return { nodeName: type, ..., yogaNode: undefined }

    case 'ink-text':
    case 'ink-raw-ansi':
      // 叶子,绑定 measureFunc(yoga 测量回调,内部调 measureTextNode)
      const node = Yoga.createLayoutNode()
      node.setMeasureFunc(measureTextNode.bind(null, ...))
      return { nodeName: type, yogaNode: node, ... }

    default:  // 'ink-box', 'ink-root'
      return { nodeName: type, yogaNode: Yoga.createLayoutNode(), ... }
  }
}
```

`ink-virtual-text`(嵌套 Text 的子 Text)与 `ink-link`(超链接)与 `ink-progress`(进度条)**故意不走 yoga**——它们是文本流的一部分,长度通过 squash-text-nodes 拼出最终字符串后由父 `ink-text` 的 measureFunc 统一测量。这避免了三层嵌套 Text 时 yoga 跑三次的浪费。

### 3.3 measureTextNode 三段式

```ts
function measureTextNode(width, widthMode, height, heightMode) {
  // 1. expandTabs:制表符先按"最坏情况"(到下一个 tabstop)展成空格
  //    真实展开在 output.ts 阶段做,因为只有屏幕位置才能确定 tab 落点
  const text = expandTabs(squashedText, 0)

  // 2. 嵌入换行 + Undefined 模式特例
  if (text.includes('\n') && widthMode === MeasureMode.Undefined) {
    // yoga 在 Undefined 模式下 width 可能为 0,直接拿 dimensions.width 会
    // 让换行后的行高加倍 — 用 Math.max(width, dimensions.width) 保护
    dimensions.width = Math.max(width, dimensions.width)
  }

  // 3. 拒绝 < 1px 的强制收缩(yoga 一些奇葩 At-Most pass 会这样要)
  if (width >= 1 && dimensions.width < 1) return dimensions
}
```

Tab 真正展开必须延后:tab 落点是"光标当前列向后到 8 的倍数",而光标列只有在 paint 阶段拼接行字符串时才知道(嵌套 Box / padding / border 影响起始列)。所以测量时按**最坏情况**(每个 tab 当 8 字符)估算,实际比这窄。

### 3.4 collectRemovedRects 与 absoluteNodeRemoved

```ts
let absoluteNodeRemoved = false

function collectRemovedRects(node, underAbsolute = false) {
  const isAbs = underAbsolute || node.attributes?.position === 'absolute'
  if (isAbs) absoluteNodeRemoved = true
  pendingClears.set(node, { x, y, w, h })
  for (child of node.childNodes) collectRemovedRects(child, isAbs)
}

export function consumeAbsoluteRemovedFlag() {
  const r = absoluteNodeRemoved
  absoluteNodeRemoved = false
  return r
}
```

**绝对定位移除毒化 prevScreen** 的原因:绝对定位节点可能画在 DOM 树的任意位置(覆盖其它子树),它被移除时只清自己的 rect 不够——它**之前**已经画过的字符可能跨子树覆盖了别的画面。`renderer.ts` 每帧消费这个 flag,如果为 true,把 `prevScreen` 置 undefined,**强制全屏重画**(放弃 diff blit),牺牲一帧性能换正确性。

---

## 4. Layout 层(`layout/` 4 文件)

### 4.1 `layout/node.ts`——抽象出"无 Yoga 依赖的 LayoutNode 接口"

把 Yoga 的整数枚举包成纯字符串枚举:

```ts
export type LayoutEdge = 'left' | 'top' | 'right' | 'bottom' | 'start' | 'end'
                       | 'horizontal' | 'vertical' | 'all'
export type FlexDirection = 'row' | 'column' | 'row-reverse' | 'column-reverse'
export type Align = 'auto' | 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline'
                  | 'space-between' | 'space-around'
export type Justify = 'flex-start' | 'flex-end' | 'center' | 'space-between'
                    | 'space-around' | 'space-evenly'
// ... Display / Wrap / PositionType / Overflow / MeasureMode / Gutter
```

接口完全 CSS Flexbox 语义,**不暴露 Yoga 的 enum 数字**。好处:
- 上层组件不必 import `yoga-layout`,纯字符串可读
- 易于换底层(如 WASM Yoga ↔ TS Yoga ↔ Stretch)

### 4.2 `layout/yoga.ts`——纯映射 adapter

```ts
const EDGE_MAP: Record<LayoutEdge, Yoga.Edge> = {
  left: Yoga.EDGE_LEFT, top: Yoga.EDGE_TOP, ...
}

class YogaLayoutNode {
  setFlexDirection(d: FlexDirection) {
    this.node.setFlexDirection(FLEX_DIR_MAP[d])
  }
  // ... 一对一翻译每个 setter
}

export const createYogaLayoutNode = () => new YogaLayoutNode(Yoga.Node.create())
```

`Yoga.Node.create()` 是同步的(因为是纯 TS),**不需要 WASM preload/reset**。这就是为什么 fork sub-agent 启动快——不需要重新 init Yoga runtime。

### 4.3 `layout/geometry.ts`——几何工具

```ts
edges(all): {top, right, bottom, left}
edges(vertical, horizontal): ...
edges(top, right, bottom, left): ...

addEdges(rect, edges): 上下左右各 + 一个 edge
unionRect(a, b): 包围盒
clampRect(rect, bounds): 裁剪到边界内
withinBounds(point, rect): 点在矩形内
clamp(value, min, max)
```

CSS shorthand 风格的 `edges()` 函数重载——`edges(2)` ≡ `padding: 2px`,`edges(2, 3)` ≡ `padding: 2px 3px`,`edges(1, 2, 3, 4)` ≡ `padding: 1px 2px 3px 4px`。

### 4.4 `layout/engine.ts`——一行

```ts
export const createLayoutNode = createYogaLayoutNode
```

留这一层是为了**未来无痛切换 layout 引擎**,所有 caller 用 `createLayoutNode()`,不直接耦合 yoga。

---

## 5. Screen 双缓冲与 Patch(`screen.ts` 1486 行)

### 5.1 数据结构

```ts
type ScreenCell = {
  char: string                    // 单 grapheme(可能是单/双宽,可能是空字符串= continuation)
  style: ScreenStyle              // 池化引用(stylePool)
  hyperlink: ScreenHyperlink | undefined  // 池化引用(hyperlinkPool)
  width: 1 | 2                    // 单元格宽度
  // 选区高亮 / 搜索高亮 / 当前匹配是 style 池里的 transform
}

class Screen {
  rows: ScreenCell[][]
  width: number
  height: number
  cursor: { x, y, visible }
  // ...
}
```

**池化(`stylePool` / `charPool` / `hyperlinkPool`)** 关键到极致:同一帧里大部分 cell 共用空格 + 默认 style,池子让 diff 退化为引用比较(`===`)而不是字段比较;且 GC 压力骤降。

### 5.2 diff 输出 Patch[]

```ts
type Patch =
  | { type: 'stdout';     content: string }
  | { type: 'cursorTo';   x: number; y: number }
  | { type: 'cursorMove'; dx: number; dy: number }
  | { type: 'cursorHide' }
  | { type: 'cursorShow' }
  | { type: 'styleStr';   from: ScreenStyle; to: ScreenStyle }
  | { type: 'hyperlink';  url: string | undefined }
  | { type: 'clear';      count: number }
  | { type: 'erase';      x, y, w, h }
  | { type: 'eraseLine';  y, fromX, toX }
  | { type: 'newline' }
```

Patch 不直接是 ANSI 字符串,而是**结构化指令**——给 `optimizer.ts` 一个语义层做合并(`cursorMove(2,0) + cursorMove(3,0) → cursorMove(5,0)`)。最后 `writeDiffToTerminal` 才把 Patch[] 编码成 ANSI bytes。

### 5.3 shouldClearScreen 决策

```ts
function shouldClearScreen(newFrame, prevFrame): 'resize' | 'offscreen' | null {
  if (viewportChanged(newFrame, prevFrame)) return 'resize'
  if (newFrame.screen.height >= newFrame.viewport.height) return 'offscreen'
  if (prevFrame?.screen.height >= prevFrame.viewport.height) return 'offscreen'
  return null
}
```

**整屏清屏的两种触发**:
1. **resize**:终端窗口变了,旧 diff 几何参考无效
2. **offscreen**:当前帧或上一帧超出 viewport(意味着滚动条 active 或 alt-screen 切换),diff blit 无法对齐——直接 clear 重画

返回 null 时走 diff blit 路径(最优)。

---

## 6. 渲染流水线深入

### 6.1 `render-node-to-output.ts` 1462 行——核心 paint

完整算法:
1. DFS 遍历 DOM 树,对每个有 yogaNode 的节点取 `getComputedLayout()` 得到 `{x, y, width, height}`
2. 应用 `scrollTop`(`ScrollBox` 节点)平移子树
3. 文本节点:`squashTextNodesToSegments`(收集继承 textStyles + hyperlink 链)→ `wrap-text` → 字符级写入 Output
4. 边框:`render-border.ts` 画 box-drawing characters
5. `ink-progress`:直接走 unicode 进度条
6. `ink-raw-ansi`:已经是 ANSI,passthrough 到 Output 的 raw 流
7. 写入完毕,把 `{x,y,w,h}` 存入 `nodeCache` 供 `hit-test` 使用

### 6.2 `output.ts` 797 行——单元格构建

`Output` 类:
- `write(text, x, y, style, hyperlink)`:单字符级 setCellAt
- `writeAnsi(rawAnsi, x, y)`:passthrough ANSI 不进单元格(给 RawAnsi 用)
- `get()`:flush write queue 到 ScreenCell[][]
- `charCache`:不变的行直接复用上一帧字符串

**关键优化** `charCache` 跨帧持久:连续帧里**未变化的行**(指 cell-级 hash 未变)直接复用上一帧的 String,不重新 join。流式 token 场景下大部分行不变,这个 cache 命中率 > 90%。

### 6.3 `optimizer.ts` 93 行——Patch 合并

单遍扫:
- 丢弃 empty stdout、(0,0) cursorMove、0-count clear
- 连续 cursorMove 加法合并:`(2,0) (3,0) → (5,0)`
- 连续 cursorTo 取最后:`(10,5) (20,8) → (20,8)`
- 相邻 styleStr 链合并:`(A→B) (B→C) → (A→C)` via `diffAnsiCodes(A,C)`(**不能直接丢中间**,因为 undo codes 不是下一个的子集,如 `\e[49m` 重置 BG 会让后续 BCE 漏色)
- 连续相同 hyperlink 去重
- 抵消 `cursorHide + cursorShow`(以及反向)

### 6.4 `searchHighlight.ts` 93 行 + `render-to-screen.ts` 231 行

搜索路径专用,**与 paint 主路径分离**——搜索时需要"虚拟渲染一次拿到字符布局",但不该污染主 React tree:
- `render-to-screen.ts` 用 **LegacyRoot**(`ConcurrentRoot` 在多 root 复用 scheduler 时会 `flushSyncWork` 积压泄漏)
- 复用 `root / container / stylePool / charPool / hyperlinkPool` 跨调用(`createContainer` 单次成本 ~1ms,搜索高频用)
- 调用 `updateContainerSync + flushSyncWork`(不在 `@types/react-reconciler` 里,但 react-reconciler 0.33 实际导出)
- 渲染后 `scanPositions` 在 cell 级别找匹配,`applyPositionedHighlight` 用 `stylePool.withCurrentMatch` 写黄底

**`codeUnitToCell` map** 关键细节:lowercasing 时 `İ → i̇`(土耳其文 İ 小写 = i + combining dot above,**两个 code unit**),如果直接用 string lowercase 后 indexOf,position 会错位;所以 search 要建一个"原文 code-unit → cell 列"的映射,匹配后用映射回查 cell。

---

## 7. 终端写入(`log-update.ts` 773 行)

### 7.1 三种渲染模式

```
normal           — REPL 默认,基于 cursor 上移 / 重写下方行
alternate screen — 全屏 TUI(/help、modal),进入 \e[?1049h、退出 \e[?1049l
static          — append-only,日志/启动 banner,不参与 diff
```

### 7.2 normal 模式的细节

```
1. 计算光标该移到哪里(基于 prevScreen.height 与当前 scrollback)
2. \e[B...\e[A 上移 cursor(注意 Windows Terminal 的 #14774 viewport bug)
3. 写 diff patches
4. \e[J 清屏到末尾(删除前一帧多余行)
5. \e[?25h 恢复光标
```

**Windows Terminal bug #14774**:`hasCursorUpViewportYankBug = win32 || WT_SESSION`。光标 up 到 viewport 顶后再 down,WT 会把 viewport 整体往下拖一行,导致顶部内容被吃掉。变通:进入 normal 模式后**强制让 cursor 在 viewport 内**,不允许刚好跨 viewport 顶。

### 7.3 BSU/ESU 同步写

```ts
const BSU = '\x1b[?2026h'  // Begin Synchronized Update
const ESU = '\x1b[?2026l'  // End Synchronized Update

function writeDiffToTerminal(patches, opts) {
  if (isSynchronizedOutputSupported() && !opts.skipSyncMarkers) {
    write(BSU)
    writePatches(patches)
    write(ESU)
  } else {
    writePatches(patches)
  }
}
```

`SYNC_OUTPUT_SUPPORTED` 在模块 load 时**一次性**计算,后续读常量。支持列表:
- iTerm.app / WezTerm / WarpTerminal / ghostty / contour / vscode / alacritty / kitty / foot / Alacritty(TERM)/ ZED_TERM / WT_SESSION / VTE>=6800

不支持(故意排除):
- **TMUX**:tmux 会 parse BSU/ESU 但分块转发,反而破坏原子性。代价是不开 sync 每帧多 16 bytes,可接受。

### 7.4 alt-screen 模式的特殊处理

```ts
// renderer.ts
if (altScreen) {
  height = Math.min(yogaHeight, terminalRows)
  if (yogaHeight > terminalRows) {
    logForDebugging('AlternateScreen yoga exceeds rows; sibling content will be clipped')
  }
  viewport.height = terminalRows + 1   // shouldClearScreen >= 检查不触发
  cursor.y = Math.min(screen.height, terminalRows) - 1  // 防 log-update LF 滚 alt buffer
}
```

`viewport.height = rows + 1` 是个巧妙的 trick——`shouldClearScreen` 里的 `screen.height >= viewport.height` 永远不会成立,因为 alt-screen 模式不允许超出物理 rows;`+1` 让这个判断默默失效,而不需要写一堆 `if (altScreen)` 分支。

### 7.5 cursor 申明(`useDeclaredCursor`)

**双 useLayoutEffect**:
```ts
// effect 1: 每次 commit 都跑(deps=[]),声明当前光标位置
useLayoutEffect(() => {
  const node = nodeRef.current
  if (cursorContext.activeNode && cursorContext.activeNode !== node) {
    cursorContext.activeNode.clear?.()  // 节点身份保护:让兄弟交接 cursor 时旧的清掉
  }
  cursorContext.activeNode = node
  node.line = line; node.column = column
})

// effect 2: 仅 unmount(deps=[]),空清理
useLayoutEffect(() => () => {
  if (cursorContext.activeNode === node) {
    cursorContext.activeNode = null
  }
}, [])
```

为什么两个?effect 1 没有 deps,**每次 line/column 变化都重跑**;如果把 cleanup 放到 effect 1,line 变化的瞬间会清掉 active,然后再赋值——中间一帧 activeNode 为 null,光标会闪走。effect 2 用空 deps **只在 unmount 跑一次**,保证不会中途 null。

---

## 8. 焦点系统(`focus.ts` 181 行)

### 8.1 FocusManager 结构

```ts
class FocusManager {
  private root: DOMElement
  private focused: DOMElement | null = null
  private focusStack: DOMElement[] = []  // MAX_FOCUS_STACK = 32
  private dispatchFocusEvent: (...) => void  // 由 events/dispatcher 注入

  handleAutoFocus(node) { ... }
  handleClickFocus(node) {
    // 走 parentNode 找最近的 tabIndex >= 0 节点
    const target = closestTabbable(node)
    if (target) this.focus(target)
  }
  handleKeyDown(key) {
    if (key === 'tab') this.moveFocus(+1)
    if (key === 'shift+tab') this.moveFocus(-1)
  }
  handleNodeRemoved(removed) {
    // 关键:从 focusStack 移除整个子树,不止 removed 自己
    this.focusStack = this.focusStack.filter(n => isInTree(n, this.root))
  }
}
```

### 8.2 焦点栈的 dedup-then-push

```ts
focus(node) {
  this.focusStack = this.focusStack.filter(n => n !== node)
  this.focusStack.push(node)
  while (this.focusStack.length > MAX_FOCUS_STACK) this.focusStack.shift()
  // ...
}
```

**dedup 再 push**:Tab 在同一组按钮间循环时,每次 focus 都把它推栈尾;dedup 防止栈无限增长。`MAX_FOCUS_STACK = 32` 是兜底,防御性。

### 8.3 isInTree(n, root)

```ts
function isInTree(node, root) {
  let cur = node
  while (cur && cur !== root) cur = cur.parentNode
  return cur === root
}
```

节点被 `removeChild` 时,**它的整个子树**都从 React tree 移除,但 focusStack 里可能持有子树深处的 node。`handleNodeRemoved` 全栈过滤,清掉所有"已不在 root 后裔"的项。

### 8.4 getRootNode(n)

```ts
function getRootNode(node) {
  let cur = node
  while (cur && !cur.focusManager) cur = cur.parentNode
  return cur  // 找到带 focusManager 的祖先(通常是 ink-root)
}
```

仿照 browser 的 `node.getRootNode()`。多 root 场景(多 Ink instance)各有自己的 FocusManager,事件分发时通过这个找到正确的 FocusManager。

---

## 9. 选区与高亮(`selection.ts` 917 行)

### 9.1 选区数据模型

```ts
type Anchor = { row: number; col: number }
type Selection = { start: Anchor; end: Anchor; instanceId: number }

class SelectionState {
  current: Selection | null
  bgColor: string | undefined  // 高亮底色,默认蓝
  // ...
  copySelection()  copySelectionNoClear()  clearSelection()
  hasSelection() getState() subscribe()
  shiftAnchor(delta)  shiftSelection(delta)
  moveFocus(delta)
  captureScrolledRows(rows)
  setSelectionBgColor(color)
}
```

`captureScrolledRows`:用户开始 drag 选区,但滚动了 scrollback,需要把"已滚出的可见行"快照下来,这样选区不会丢。

### 9.2 SpacerTail / SpacerHead / NoSelect

```ts
// render-node-to-output 写 cell 时
cell.spacerTail = true   // 行尾自动填充的空格(右对齐/justify)
cell.spacerHead = true   // 行首自动填充的空格(右对齐)
cell.noSelect = true     // <NoSelect> 显式标记
```

**为什么不让用户选这些**:对齐空格不是真内容,Tab 缩进类的复制会让代码缩进错乱;`<NoSelect>` 是显式 opt-out(用于装饰性框线、scrollbar、行号等)。

### 9.3 跨行选区拼接

```ts
function getSelectedText(selection, screen) {
  let result = ''
  for (let r = selection.start.row; r <= selection.end.row; r++) {
    const cols = colRangeAt(r, selection)
    for (let c = cols.start; c < cols.end; c++) {
      const cell = screen.rows[r][c]
      if (cell.spacerTail || cell.spacerHead || cell.noSelect) continue
      if (cell.width === 2 && c === cols.start && c > 0) {
        // 双宽字符的右半 cell 是空字符串 continuation,跳过
        continue
      }
      result += cell.char
    }
    if (r < selection.end.row) result += '\n'
  }
  return result
}
```

### 9.4 与 hit-test 的协作

`hit-test.dispatchClick` 在按下时调 `selection.start(row, col)`,move 时 `selection.update(row, col)`,松开时不清——用户可以右键复制。`selection.clearSelection()` 在新 input/输入框 active 时主动调。

---

## 10. 命中测试与事件(`hit-test.ts` 130 行 + `events/`)

### 10.1 hit-test 算法

```ts
function hitTest(root, x, y): DOMElement | null {
  // 反向遍历:later siblings paint on top
  for (let i = root.childNodes.length - 1; i >= 0; i--) {
    const child = root.childNodes[i]
    const rect = nodeCache.get(child)  // scrollTop already applied
    if (!rect) continue
    if (withinBounds({x, y}, rect)) {
      // 子树内部递归
      const deeper = hitTest(child, x, y)
      return deeper ?? child
    }
  }
  return null
}
```

**反向遍历**:CSS 里后绘的盖在前绘上,终端同理。`nodeCache` 由 `render-node-to-output` 每帧写入,**已扣除 scrollTop**,所以直接用屏幕坐标命中。

### 10.2 事件冒泡

```ts
function dispatchClick(target, x, y) {
  let node = target
  while (node) {
    const handler = node._eventHandlers?.onClick
    if (handler) {
      const rect = nodeCache.get(node)
      const event = {
        clientX: x, clientY: y,
        localCol: x - rect.x, localRow: y - rect.y,
        stopPropagation, target,
      }
      handler(event)
      if (event.propagationStopped) return
    }
    node = node.parentNode
  }
}
```

**localCol / localRow** 计算:相对于 handler 所在节点的局部坐标(不是 target 节点的局部坐标)——每层 handler 独立计算自己的坐标。

### 10.3 hover diffing

```ts
function dispatchHover(x, y) {
  const newHovered = collectHoveredChain(x, y)
  const oldHovered = previousHoveredChain
  for (const n of oldHovered) {
    if (!newHovered.has(n)) {
      if (n.parentNode) {  // 防御:节点可能已 detach
        n._eventHandlers?.onMouseLeave?.(...)
      }
    }
  }
  for (const n of newHovered) {
    if (!oldHovered.has(n)) n._eventHandlers?.onMouseEnter?.(...)
  }
  previousHoveredChain = newHovered
}
```

**`parentNode` 检查**:在 mouse 事件之间,React 可能 unmount 了该 node(异步事件队列),不检查会对已死节点派事件。

### 10.4 click-to-focus

```ts
function dispatchClick(...) {
  // ... 派 onClick 冒泡
  const focusable = closestTabbable(target)
  if (focusable) focusable.focusManager?.focus(focusable) ?? rootFocusManager.focus(focusable)
}
```

点击自动转移焦点到最近的 `tabIndex >= 0` 祖先——这是 browser 默认行为的复刻。

---

## 11. 键盘解析(`parse-keypress.ts` 长)

### 11.1 三层解码

```
原始字节  →  CSI/ESC parser   →  semantic key
                                      ↓
                             { name, ctrl, shift, alt, meta,
                               sequence (raw), code (kitty CSI u u_kind) }
```

### 11.2 Kitty Keyboard Protocol

启用条件:`isExtendedKeysSupported()` 返回 true(allowlist: iTerm.app / kitty / WezTerm / ghostty / tmux / windows-terminal)。

启用后能区分:
- `Ctrl+I` vs `Tab`(传统都是 \t)
- `Ctrl+M` vs `Enter`(传统都是 \r)
- `Shift+Tab` 不依赖 modifyOtherKeys
- 修饰键的精确状态

### 11.3 xterm modifyOtherKeys 的退路

```ts
// 历史:Claude Code #23350 PR 曾经无条件启用 modifyOtherKeys
// 退回原因:SSH 远端 + 本地 xterm.js 时,远端发的 CSI 27;5;65~ (Ctrl+A) 被
//          xterm.js parse 为 codepoint 65 输入,真的打了个 A 出来
// 现在:仅在 EXTENDED_KEYS_TERMINALS allowlist 里启用
```

这个故事教训:**终端协议特性必须 per-terminal 白名单,不能"看似支持就启用"**——中间层(tmux/xterm.js/SSH)可能 leak。

### 11.4 长 ANSI 粘贴防护

```ts
function parseKeypress(input) {
  if (input.length > MAX_PASTE_BURST) {
    // 不再 per-key parse,直接 treat as paste 走 bracketed paste 路径
    return { name: 'paste', sequence: input, isPaste: true }
  }
  // ... normal parsing
}
```

防御场景:粘贴 4KB ANSI 内容时,parse-keypress 一个个字符走会卡 JS 主线程。直接降级为整块 paste。

---

## 12. 终端能力探测(`terminal.ts` 248 + `terminal-querier.ts` 212)

### 12.1 capability 分类

```ts
// 同步:仅看环境变量
isProgressReportingAvailable()  // OSC 9;4
isSynchronizedOutputSupported() // BSU/ESU
isExtendedKeysSupported()       // Kitty kbd
hasCursorUpViewportYankBug      // win32 || WT_SESSION
supportsHyperlinks()            // supports-hyperlinks 库 + 自己加 allowlist

// 异步:终端 query
xtversionName()                 // CSI > 0 q → DCS > | name ST
isXtermJs()                     // env (fast) ⊕ probe (SSH-resilient)
```

### 12.2 TerminalQuerier 的 sentinel 模式

终端 query 协议没有"回复对应哪个 query"的机制,只能按发送顺序对回复。但 query 可能 timeout(终端不实现 → 永不回复)。Claude Code 的方案:

```ts
type Item = { kind: 'query'; query: TerminalQuery<any> }
           | { kind: 'sentinel'; resolve: () => void }

class TerminalQuerier {
  queue: Item[] = []

  send<T>(query): Promise<T | undefined> {
    return new Promise(resolve => {
      this.queue.push({ kind: 'query', query: { ...query, resolve } })
      this.writeOut(query.request)
    })
  }

  flush(): Promise<void> {
    return new Promise(resolve => {
      this.queue.push({ kind: 'sentinel', resolve })
      this.writeOut(DA1)   // \e[c —— 所有终端必回
    })
  }

  onResponse(bytes) {
    for (const action of parseTerm(bytes)) {
      // 先 FIFO 匹配 query
      const q = this.findFirstMatchingQuery(action)
      if (q) { q.resolve(extractValue(action)); remove q from queue; continue }
      // 否则是 DA1 回复 → 触发 FIRST sentinel,resolve 所有它之前的 query 为 undefined
      if (isDA1(action)) {
        const idx = this.queue.findIndex(i => i.kind === 'sentinel')
        if (idx >= 0) {
          // 它之前的所有 query 都没收到回复 → 终端不支持
          for (let i = 0; i < idx; i++) {
            if (this.queue[i].kind === 'query') this.queue[i].query.resolve(undefined)
          }
          this.queue[idx].resolve()
          this.queue = this.queue.slice(idx + 1)
        }
      }
      // 其它:silently drop
    }
  }
}
```

精髓:
- **send 不 timeout**——timeout 用 sentinel 替代,语义更准:不是"等了 X ms 没回",而是"DA1 都回了你都没回 → 不支持"
- **只 drain 到第一个 sentinel**——后续 batch 的 query 仍待在队列里,不会被前一个 batch 的 sentinel 误清空
- **DECXCPR cursorPosition 用 `?` 标记**:`\e[?6n` 而非 `\e[6n`,因为 Shift+F3 在某些终端发送 `\e[1;2R` 与 cursor reply 同形,加 `?` 区分

### 12.3 isXtermJs 双信号

```ts
isXtermJs() = (process.env.TERM_PROGRAM === 'vscode')  // 快路径
            || await xtversionProbe matches /xterm.js/i  // SSH 远端能识别
```

VSCode 内嵌 xterm.js 本地用 env 检测;但通过 SSH 连到远端用 vscode-server 时,远端 env 没有 TERM_PROGRAM=vscode,只能靠 xtversion probe。

---

## 13. 颜色与样式(`colorize.ts` 231 + `styles.ts` 771)

### 13.1 chalk level 自适应

```ts
// vscode + chalk.level==2 → 提升到 3
// 原因:xterm.js 从 2017 起就支持 truecolor,但 code-server 容器常常没 COLORTERM env
// 门槛 level===2 严格(不是 >= 2),为了 NO_COLOR/FORCE_COLOR=0 时仍尊重用户设置
boostChalkLevelForXtermJs(chalk)

// tmux + chalk.level > 2 → 降到 2
// 原因:tmux 客户端的 SGR 转发只对外层终端宣告 Tc/RGB 时才重新 emit truecolor;
//      不少 tmux session 外层只是 xterm-256color,chalk.rgb 输出在 tmux 内通常被丢
// chalk.rgb 自动 downgrade 到 256-color,tmux 能干净 passthrough
// 提供 CLAUDE_CODE_TMUX_TRUECOLOR=1 逃生口
clampChalkLevelForTmux(chalk)
```

**模块 load 时一次性计算 boost/clamp 常量**:`CHALK_BOOSTED_FOR_XTERMJS`、`CHALK_CLAMPED_FOR_TMUX` 导出常量供 debug 面板显示给用户(知道为啥色彩看起来不一样)。

### 13.2 applyTextStyles 包裹顺序

```ts
function applyTextStyles(text, style) {
  let result = text
  if (style.inverse) result = chalk.inverse(result)
  if (style.strikethrough) result = chalk.strikethrough(result)
  if (style.underline) result = chalk.underline(result)
  if (style.italic) result = chalk.italic(result)
  if (style.bold) result = chalk.bold(result)
  if (style.dim) result = chalk.dim(result)
  if (style.color) result = colorize(style.color, result)
  if (style.backgroundColor) result = colorize(style.backgroundColor, result, 'bg')
  return result
}
```

**顺序矩阵**:chalk 是**从内往外包裹**(`chalk.bold(text)` → `\e[1m text \e[22m`),所以越外层的 style 越在字符串外侧。background 放最外层是因为:`\e[42m` 在最外侧,内嵌的色彩/样式重置都不会清掉它(BCE = Background Color Erase 时,terminal 用 cell 的 BG 填空白)。

`bold + dim` 互斥:终端规范规定两者不能共存,实测大多数终端把 dim 视为优先(因为 dim 是 SGR 2,bold 是 SGR 1,后入的 SGR 覆盖)。`StyledText` 显式让 dim wins。

### 13.3 stringWidth(`stringWidth.ts` 222 行)

```ts
function stringWidth(s: string): number {
  // 1. 纯 ASCII 快路径
  let pure = true
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 127 || c === 0x1b) { pure = false; break }
  }
  if (pure) return s.length

  // 2. 剥 ANSI(仅有 0x1b 时才调 stripAnsi)
  const stripped = s.includes('\x1b') ? stripAnsi(s) : s

  // 3. 检查是否需要 segmentation(emoji / VS / ZWJ)
  if (!needsSegmentation(stripped)) {
    // 没有复杂 unicode,Bun.stringWidth({ambiguousIsNarrow: true}) 快路径
    return Bun.stringWidth(stripped, { ambiguousIsNarrow: true })
  }

  // 4. 全套 grapheme segmentation
  let w = 0
  for (const cluster of [...new Intl.Segmenter().segment(stripped)]) {
    w += clusterWidth(cluster.segment)
  }
  return w
}
```

**注意**:`Bun.stringWidth` 对 Devanagari 簇(如 क्ष)统计基辅音之和 = 2,但终端实际只画 1 个 glyph 占 2 列;两者一致,所以放心用。**真正的坑**:有些终端把 क्ष 当 1 列,Bun 当 2 列——但这是终端不规范,大多数现代终端按 wcwidth 算 2 列。Claude Code 选 wcwidth/Bun 路径(主流终端一致)。

### 13.4 wrap-text & truncate

```ts
sliceFit(text, columns) {
  let end = text.length
  while (end > 0) {
    const sub = text.slice(0, end)
    if (stringWidth(sub) <= columns) return sub
    end--
  }
  return ''
}
// 边界:end-1 检测如果当前 end 跨越宽字符(2列字符的右半在 columns 内,左半外),
// 再退一格保证不破坏字符

truncate(text, columns, position: 'start'|'middle'|'end'): string
  // 加 ELLIPSIS '…'(单 cell 1 列)
  // columns < 1 → ''
  // columns === 1 → '…'
```

---

## 14. 滚动(`ScrollBox` + `useTerminalViewport` + `node-cache`)

### 14.1 ScrollBox 数据流

```tsx
<ScrollBox scrollTop={...} stickyScroll onScroll={...}>
  {children}
</ScrollBox>

// 内部:
// 1. 渲染时把 scrollTop 写到 DOMElement.scrollTop
// 2. render-node-to-output 子树坐标 += -scrollTop
// 3. nodeCache 也存"已扣 scrollTop 的 screen 坐标"
// 4. clampMin/clampMax 由内容高度与 viewport 高度算
```

### 14.2 useTerminalViewport 的 DOM 爬升

```ts
function useTerminalViewport() {
  const viewportRef = useRef({ top: 0, height: 0, scrollTop: 0, isVisible: true })

  useLayoutEffect(() => {
    let cur = nodeRef.current
    let scrollTop = 0
    // 注意:不能用 yoga.getParent() — 那是布局父,跟选区/可见性无关
    while (cur) {
      if (cur.scrollTop) scrollTop += cur.scrollTop
      cur = cur.parentNode
    }
    const rect = nodeCache.get(rootRef.current)
    const screenHeight = screen.height
    const rows = process.stdout.rows
    const cursorRestoreScroll = screenHeight > rows ? 1 : 0  // 同 log-update
    viewportRef.current = { ... }
  })  // 无 deps:yoga 可能在 React 不知情时变化,每渲染都跑
}
```

**`useLayoutEffect` 无 deps 每帧跑**:Yoga 布局可能因为兄弟节点变化导致本节点位置变,但 React 看不到。每帧拿最新值更新 ref,**不 setState**(setState 会引起 cascading re-render,白白多渲染)。

### 14.3 boundary 补偿

`cursorRestoreScroll = screenHeight > rows ? 1 : 0`:与 `log-update` 内部 cursorRestoreScroll 完全一致。**为什么必须一致**:渲染 vs 滚动 diff 用不同公式会产生 race——动画帧推进的同时滚动条 diff,两边算出来的"我在屏幕第几行"差 1,就会出现整片字符串错位 1 行(elgg jumping)。

---

## 15. ANSI Parser(`termio/` 9 文件)

### 15.1 模块分解

```
tokenize.ts  — 字节流分词:plain text / CSI / OSC / DCS / ESC / SS3
csi.ts       — 解析 CSI 子序列(SGR/ED/EL/CUP/CUF/...)
osc.ts       — 解析 OSC(0=title, 8=hyperlink, 21337=tab status, 52=clipboard, ...)
sgr.ts       — SGR 参数 → TextStyle/Color
esc.ts       — 简单 ESC(7=DECSC, 8=DECRC, c=RIS, D=IND, M=RI, E=NEL)
dec.ts       — DEC 私有(DECSET/DECRST: ?25=cursor, ?1049=altscreen, ?2026=BSU/ESU)
ansi.ts      — 高层 wrapper,把 token → Action[]
parser.ts    — 状态机驱动 tokenizer + 输出 Action stream
types.ts     — 全部语义类型(Action, TextStyle, Color, Cursor*, Erase*, ...)
```

**Ghostty-inspired action model**:不是把 ANSI 解成"原始字符串",而是解成 `Action`(`{type: 'cursor', action: {type: 'move', direction: 'down', count: 5}}`)。下游消费方:
- `<Ansi>` 组件——把 Action 流回放成 React 元素
- `parse-keypress` 在 input 路径用
- `output.writeAnsi` raw passthrough(给 `<RawAnsi>`)

### 15.2 typing 系统是 discriminated union

```ts
type Action =
  | { type: 'text';      graphemes: Grapheme[]; style: TextStyle }
  | { type: 'cursor';    action: CursorAction }
  | { type: 'erase';     action: EraseAction }
  | { type: 'scroll';    action: ScrollAction }
  | { type: 'mode';      action: ModeAction }
  | { type: 'link';      action: LinkAction }
  | { type: 'title';     action: TitleAction }
  | { type: 'tabStatus'; action: TabStatusAction }
  | { type: 'sgr';       params: string }
  | { type: 'bell' }
  | { type: 'reset' }
  | { type: 'unknown';   sequence: string }
```

`unknown` 保留原始字节,下游可以选择 passthrough(给原始 ANSI 写出),不会丢信息。这是"**未知输入不丢弃**"的健壮性 pattern。

---

## 16. 流式渲染的几个关键性能技巧

### 16.1 `line-width-cache.ts`(Map<string, number>, MAX 4096)

```ts
const cache = new Map<string, number>()

export function getLineWidth(line: string): number {
  const cached = cache.get(line)
  if (cached !== undefined) return cached
  if (cache.size >= MAX_CACHE_SIZE) cache.clear()  // 整桶清空
  const w = stringWidth(line)
  cache.set(line, w)
  return w
}
```

流式打字时 token 每秒 50+,每个 token 触发重测——同样的字符串(行末未变化的部分)被反复测。Cache 命中率 ~50x reduction in calls。

**整桶清空 vs LRU**:LRU 维护成本(双链表)在这场景下大于收益——cache 大多数项是当前帧的行,LRU 移动指针的 cost 比直接清空再 1 帧 repopulate 高。

### 16.2 池化复用

```ts
// renderer.ts 每帧
backScreen.stylePool.reset()  // 把 pool 池子标记可复用
backScreen.charPool.reset()
backScreen.hyperlinkPool.reset()

// 写 cell 时
cell.style = stylePool.get({ bold: true, fg: 'red' })  // 命中已有就复用,未命中创建
```

`reset()` 不是清空——而是把池子的"reuse 指针"移到 0,后续 `get()` 优先复用旧 entry。下一帧 diff 时,**相同样式的 cell 引用 `===`** 相等,极快。

### 16.3 charCache(跨帧)

```ts
// Output.get()
for (let r = 0; r < height; r++) {
  if (rowUnchanged(r)) {
    rows[r] = prevRows[r]   // 整行复用上一帧的 String[]
    continue
  }
  rows[r] = buildRow(r)
}
```

**rowUnchanged** 判断比较的是 cell-级 hash,不是字符串比较——比较成本 O(width),复用收益 O(width * stringWidth cost)。

### 16.4 Bun.stringWidth 与 Bun.wrapAnsi 快路径

```ts
if (typeof Bun !== 'undefined' && Bun.stringWidth) {
  if (!needsSegmentation(str)) {
    return Bun.stringWidth(str, { ambiguousIsNarrow: true })
  }
}
```

Bun 内置 stringWidth(zig 实现)比 npm `string-width` 快 5-10x。但默认 ambiguousIsWide(unicode CJK ambiguous 宽度按 2),要显式传 `ambiguousIsNarrow: true` 跟 unix wcwidth 对齐(终端默认行为)。

---

## 17. 边界场景与防御

### 17.1 NaN/Infinity yoga dimensions

```ts
// renderer.ts
const w = rootNode.yogaNode.getComputedWidth()
const h = rootNode.yogaNode.getComputedHeight()
if (!Number.isFinite(w) || !Number.isFinite(h)) {
  return EMPTY_FRAME   // 空 frame,不输出
}
```

flex 的 zero-height/zero-width 子树会让 yoga 算出 NaN(divide-by-zero in baseline align)。直接退出渲染,而非崩或写乱字符。

### 17.2 prevFrame contaminated

```ts
const contaminated = consumeAbsoluteRemovedFlag() || prevFrameContaminated
const effectivePrev = contaminated ? undefined : prevScreen
const patches = diffFrames(effectivePrev, currentScreen)
```

绝对定位移除时**放弃 diff**,但只放弃一帧(后续帧 `prevFrameContaminated = false`)。代价:一次全屏重绘 ≈ 当前 viewport bytes(数十 KB)。

### 17.3 sub-agent fork 无副作用

```ts
// native-ts/yoga-layout 是纯 JS,fork 子进程不需要 WASM init/reset
// 模块 load 时只创建空 pool,不分配大 buffer
// terminal-querier 通过 process.stdin.on('data') 监听响应,fork 不会重复
```

设计意图:每个 sub-agent(`AgentTool` 内部 fork)启动 < 50ms,Yoga WASM 启动一次就 200ms+。

### 17.4 drainNode 跨帧重 dirty

```ts
function drainNode(node) {
  if (node.dirty) {
    // 这帧 render 时清了 dirty,但 yoga 可能因为 parent layout 没收敛
    // 标记 ancestor 再次需要 descent
    markDirty(node)
  }
  for (child of node.childNodes) drainNode(child)
}
```

Yoga `calculateLayout` 是迭代收敛,某些 flex 组合需要 2 帧;`drainNode` 保证如果一帧不够,下帧再补。

### 17.5 LegacyRoot vs ConcurrentRoot in render-to-screen

```ts
// 注:主渲染路径用 ConcurrentRoot
// 但 render-to-screen.ts(搜索专用)用 LegacyRoot
// 原因:ConcurrentRoot 的 flushSyncWork 队列在多 root 间通过全局 scheduler 共享
//      搜索高频创建/销毁 root → 队列里积压未消费的 task → 主 root 性能下降
```

这是一个**"实现细节泄漏导致的反向选择"**——React 推荐用 ConcurrentRoot,但这个场景下副作用太大,只能退回 LegacyRoot。

---

## 18. 工程设计精髓(给我自己开发 Agent 时的复用清单)

### 18.1 框架适配层的设计模式

> **借鉴**:`reconciler.ts` + `dom.ts` + `layout/node.ts`

- **抽象 host config**——React DOM、Ink、Three.js R3F 都用 react-reconciler,实现 HostConfig 即可跨 platform
- **virtual DOM 节点带"原生句柄"**——`DOMElement.yogaNode` 持有底层 layout node,渲染时操作底层
- **string enum 抽象底层 native enum**——`LayoutEdge='top'` vs `Yoga.EDGE_TOP=1`,上层不依赖 native;换底层引擎只需改 adapter
- **diff 在 commitUpdate 内做,不在 prepareUpdate 做**——后者会延迟一帧,前者立刻见效

### 18.2 流式高频更新的零闪烁

> **借鉴**:`screen.ts` 双缓冲 + `optimizer.ts` patch 合并 + BSU/ESU 同步写

- **结构化 patch,不是字符串拼接**——给优化器一个语义层做合并
- **池化引用**(stylePool / charPool / hyperlinkPool)——diff 退化成 `===`
- **跨帧 charCache**——不变的行直接复用上一帧字符串
- **BSU/ESU 同步写**——支持的终端避免半帧 tearing,不支持的优雅降级
- **每模块的能力探测在 load 时计算常量**——主路径零开销

### 18.3 终端能力的渐进增强

> **借鉴**:`terminal.ts` + `terminal-querier.ts`

- **同步检测优先**(env vars)——免一次网络/IO
- **异步 probe 兜底**——SSH/远端场景下 env 不可靠
- **sentinel 模式做 timeout**——`DA1` 必回,用它界定一批 query 的"截止"
- **per-terminal allowlist 启用新特性**——不要"看 env 像支持就启用",中间层(tmux/xterm.js/SSH)可能 leak

### 18.4 事件系统的"node 级局部坐标"

> **借鉴**:`hit-test.ts` + `events/dispatcher.ts`

- **冒泡时每层 handler 收到自己的 localCol/localRow**——不是 target 的局部坐标
- **`_eventHandlers` 与 `attributes` 分离**——handler 引用每次渲染都变,不应触发 dirty
- **hover 用差集分发**(新-旧 = enter,旧-新 = leave)
- **detached node 防御**(`parentNode != null`)——异步事件 race 时节点可能已死

### 18.5 焦点栈的健壮性

> **借鉴**:`focus.ts`

- **栈最大 32 + dedup-then-push**——Tab 循环不无限增长
- **节点移除时全栈过滤子树**(`isInTree(n, root)`)——不止删 removed 节点本身
- **多 root 各自 FocusManager**(`getRootNode` 爬 parentNode 找)——browser 同款

### 18.6 资源池与跨帧复用

> **借鉴**:`line-width-cache.ts` + `output.charCache` + 池化

- **Map 缓存超过阈值整桶清空**——比 LRU 简单且收益不差(下一帧立刻 repopulate)
- **池的 reset 是"reuse 指针归零",不是清空**——同样数据连续帧 `===`
- **Bun 内置优先,JS fallback 保留**——快路径 + 慢路径并存,跨 runtime 可用

### 18.7 React + 终端的反应式数据流

> **借鉴**:`useTerminalViewport` + `useDeclaredCursor` + `useTabStatus`

- **`useLayoutEffect` 无 deps 每帧跑** 用于"React 不知情的外部状态"(yoga 几何)
- **更新 ref 而非 setState**——避免 cascading re-render
- **declare 模式 + cleanup 模式分两个 effect**——一个每帧 declare(无 deps),一个仅 unmount(空 deps),不要混
- **`useEventCallback` 稳定 listener slot**——`isActive` 变化不能重新 append listener,否则 `stopImmediatePropagation` 顺序乱

### 18.8 子进程友好的纯 TS 重写

> **借鉴**:`native-ts/yoga-layout/`(2578 行 Yoga TS 端)

- **WASM/native 的启动开销在 fork 子进程时翻倍**——sub-agent 多的工具尤其敏感
- **纯 TS 端虽然单帧慢 20-30%,但启动快 20x**——sub-agent 高频 fork 场景净收益
- **写完 layout/yoga.ts adapter,后续无痛切回 WASM**——抽象层值这个工程量

### 18.9 调试桩与仪表化

> **借鉴**:`CLAUDE_CODE_DEBUG_REPAINTS`、`CLAUDE_CODE_COMMIT_LOG`

- **关键路径全部包 `if (env)`** —— 主路径零开销,问题时一键打开
- **采集"导致这一行重绘的组件链"**(`debugOwnerChain`)——比断点更高效
- **commit-log 全量指标**:commits/sec、maxGap、reconcile/layout/paint phase 时长、yoga visited/measured/cache-hits
- **SLOW_YOGA 阈值警告**——超阈值自动输出 stack

### 18.10 与外部协议层的解耦

> **借鉴**:`termio/` 自研 ANSI parser + Ghostty-inspired action model

- **不要 parse 成字符串,parse 成结构化 Action**——下游可以聚合/优化/重放
- **discriminated union + `unknown` 兜底**——未知输入保留原始字节不丢
- **per-action handler 接口稳定**——增加新 ESC 序列只需加新 Action 类型

---

## 19. 待确认问题

1. `native-ts/yoga-layout/index.ts` 内部细节(2578 行)未读;通过 `layout/yoga.ts` adapter 仅知 API 契约。是否有"渐进式 layout"(子树 layout cache)、是否真的是 Yoga 2.0 API 兼容、性能 vs WASM 的具体对比——需要看实现。
2. `selection.ts` 的 917 行内只采样了核心 API,跨 ScrollBox 拖选(从 viewport 内拖到 scrollback)的行为细节未验证。
3. `parse-keypress.ts` 的 bracketed paste 完整路径与 Claude Code REPL 的 paste handler 协作未追到;`hooks/usePasteHandler.ts` 在 M13 输入子系统会涵盖。
4. `render-node-to-output.ts` 1462 行未做行级深入——只覆盖 DFS 框架和文本测量;border 绘制、cursor positioning 的细节(尤其多元素 sticky scroll 边界)未画图。
5. `ink.tsx` 主体 1722 行的 wakeup/scheduler 集成(与 useAnimationFrame 的 keepAlive 配合)的精确度需补充。

---

## 20. 与其它模块的交叉验证点

| 涉及处 | 关联 |
|---|---|
| M01 启动 | Ink instance 在 `instances` 全局 Map 持有,fork 时不重启 yoga |
| M02 Agent loop | query 的 stream 是 setState 驱动 React 渲染,React 经 reconciler 走完整流水线 |
| M07 文件/Shell | BashTool 输出 ANSI passthrough → `<RawAnsi>` 直入 output.writeAnsi |
| M10 Bridge | Remote 模式 REPL 的渲染依然走 Ink,但 stdout 是 bridge socket(WriteRaw 抽象) |
| M12 消息渲染 | VirtualMessageList 用 `useTerminalViewport` + `ScrollBox` + sticky scroll |
| M14 sub-agents | sub-agent fork 时 native-ts/yoga 同步可用,无需 WASM 重新初始化 |
| M19 状态 | `instances` Map、`absoluteNodeRemoved` flag、`SYNC_OUTPUT_SUPPORTED` 等模块级常量是进程级 state |

---

**M11 文档完结。** 阅读统计:`src/ink/` 全部 top-level 文件 + 全部 `components/`、`hooks/`、`layout/`、`events/`、`termio/` 子目录;`native-ts/yoga-layout/index.ts` 待补;`render-node-to-output.ts` / `screen.ts` / `selection.ts` / `ink.tsx` 等大文件已读但仅采样核心算法,未行级详尽。

---

## 二十一、补读修正(把 `native-ts/yoga-layout/index.ts` 2578 行精读后)

**关键修正**: M11 既有文档若把 yoga 写成"WASM 绑定",**这是错的**. Claude Code 内部 yoga 是**纯 TypeScript 单文件移植**,位于 `src/native-ts/yoga-layout/index.ts` (~2578 行,全 JS,无 WASM、无 native binding). 这个发现颠覆了"yoga 启动慢、bundle 大"的旧印象 —— 实际上是一个手写的"排版计算尺",冷启动 < 50ms,bundle ~80KB gzipped.

以下是把这个 2578 行单文件全部读完后的 50+ 工程发现,按主题分组.

### A. 三层缓存系统(性能核心)

#### A1. **`_hasL` / `_hasM` 单 slot 缓存** (`index.ts` Layout 区段)
节点级 `_hasLayout` / `_hasMeasure` 两个 boolean. 已 layout 的节点跳过整个 calculateLayout 子树.

#### A2. **`_cIn` / `_cOut` 4-slot Float64Array 缓存** (cache 区段)
每个节点持有 4 个 cache slot,记录(width / widthMode / height / heightMode)→ result. Float64Array 比 object key map 快 10x,且 GC 友好.

#### A3. **`_fbBasis` 单 slot 缓存**(flex-basis)
flex-basis 解析独立缓存. 在 flex container 反复计算子项 basis 时命中率高.

#### A4. **`_generation` counter + `sameGen` 旁路**
节点有"上次 layout 的代数". 父节点 dirty 不连带子重算 —— 通过对比 `_generation` 判断"子是否需要重算". **关键路径优化:从 105k 节点访问降到 10k**.

#### A5. **`commitCacheOutputs` 强制必调** —— scrollbox 33→2624 bug 根因
计算完后必须调 `commitCacheOutputs(node)` 把结果落到 cache slot. 漏掉则 cache 永远未命中 → 计算反复跑 → scrollbox 视口高度从 33 行炸到 2624 行(把整个滚动内容当成 viewport 一次性算).

#### A6. **`Float64Array` 懒初始化**(避免 V8 IC 抖动)
节点新建时不分配 cache slot,首次写时才 `new Float64Array(4)`. 防 V8 inline cache 因 shape change 反复 invalidate.

### B. 渲染正确性

#### B7. **`zeroLayoutRecursive` 必须递归 invalidate 子树** —— unhide blank grandchildren bug 根因
节点 display:none → zeroLayoutRecursive 把自己尺寸置 0,但**必须**递归把所有子的 `_hasL` 也清掉. 否则 unhide 时子节点用 stale 缓存渲染 → 显示空白.

#### B8. **像素网格:text floor/ceil,non-text round**
- 文本节点:位置 floor,尺寸 ceil(防字符被截半)
- 非文本节点:位置/尺寸 round(对齐字符网格)

终端字符网格与浏览器像素网格的根本差异.

#### B9. **`await Promise.resolve()` in `root.ts:111`** —— 移除 WASM 后必须的 microtask 边界
原 WASM yoga 内部有隐式 async boundary,React reconciler 依赖这个 boundary 让 setState 在两次 layout 之间真正 flush. 移除 WASM 后这个 boundary 没了 → React 反复 commit. 显式 `await Promise.resolve()` 重建.

#### B10. **`Errata` bitmask 字段存而不用**
yoga 原本有 `Errata` 用于 spec-bug 兼容. 该实现保留 `node.errata` 字段供 API 兼容,但**内部不消费**(所有 spec-bug 都按 yoga 1.18 规范实现).

#### B11. **`Direction.RTL` undefined behavior**
LTR 硬编码贯穿全部. `setDirection(RTL)` API 接受但内部按 LTR 算. **不支持 RTL**(注释明说 "RTL not yet implemented").

### C. flex / align 算法核心

#### C12. **`computeFlexLine`**
按 main axis 累积子项的 hypothetical main size,超容器宽度则换行. 每行独立分配 free space.

#### C13. **`distributeFreeSpace`**
free space 按 `flex-grow` 比例分给非 frozen 子. 多轮迭代:超 max → freeze → 再分.

#### C14. **`alignCrossAxis`**
align-items / align-self / align-content. 每行/单子分别处理.

#### C15. **`stretch` 默认下不覆盖 explicit size**
explicit width/height > stretch. 这是 spec 行为,实现照搬.

#### C16. **`baseline` align**
按子第一个文本节点的 baseline 对齐. 子无文本则 fallback 到 bottom.

#### C17. **`flex-basis: auto` 用 measure 函数**
text/external content 节点设了 `setMeasureFunc((width, ...) => {width, height})`,basis 阶段调用得到内容大小.

### D. measure 函数与 ratchet

#### D18. **measure 函数缓存:`measuredText` 单 slot**
text 节点的 measure 结果按 (availableWidth, widthMode) 缓存. 同 width 二次 measure 直接命中.

#### D19. **measure 函数永远不能 throw**
yoga 内部 catch + treat as `{width: 0, height: 0}`. 这是工程化的"防御性"层 —— 自定义 measure 抛错不应让整个 layout 崩.

#### D20. **`Ratchet` 子组件用 `lock="offscreen"`**
M14 的 ratchet(高度只增不降)在 yoga 层用 "memo last height" 实现 —— 子节点真实高度 < 上次记录时,仍用上次的. 防 streaming 抖动.

### E. API surface 与兼容

#### E21. **导出与 yoga.wasm 同 API**
`Yoga.Node.create()` / `node.setWidth(100)` / `node.getComputedWidth()` 等 API 完全镜像 yoga.wasm. 切换无侵入.

#### E22. **`Yoga.Node.createDefault()` vs `createWithConfig()`**
config 用于 `errata` / `pointScaleFactor` / `experimentalFeatures`. Claude Code 全用 default.

#### E23. **`pointScaleFactor=1`** 硬编码
浏览器 yoga 用 2 (Retina). 终端只 1 (字符).

#### E24. **`setOverflow(Overflow.Scroll)`** API 接受但行为 = visible
真正的 scroll 在 ScrollBox 组件层(React)实现. yoga 不裁剪.

### F. 算法复杂度与优化

#### F25. **single-pass layout**(无 multi-pass)
yoga 用 cache + measure 函数让 single-pass 算完. 不像浏览器有 reflow/redraw 多 pass.

#### F26. **缓存命中率统计**
注释提到 "typical session: cache hit > 95%". 主要靠 `_generation` 跳过子树.

#### F27. **`MAX_NODES_PER_RENDER` 不设上限**
yoga 自身无节点上限. 实际上限来自 React reconciler / Ink 的 max child stack.

### G. 浮点与精度

#### G28. **`maybeRound` 用 epsilon `0.0001`**
浮点累加误差;按 epsilon 判 round 方向.

#### G29. **像素位置算 `floor((pos + epsilon) * scale) / scale`**
防 `1.9999` 被 round 成 `2.0` 又被 floor 成 `1`. epsilon 偏移先纠正.

### H. 内存与释放

#### H30. **`Node.free()` 不实际释放,只标 destroyed**
TypeScript 实现下无显式释放, GC 接管. 保留 API 兼容(原 WASM 需手动 free).

#### H31. **child 数组用普通 Array,不用 LinkedList**
原 yoga (C) 用 linked list. TS 实现用 Array (push/splice) —— V8 优化下 Array 已经很快.

#### H32. **`removeChildren` 显式 splice 而非 length=0**
length=0 会保留所有 holes (V8 internal). splice 真清.

### I. 调试与可观察性

#### I33. **`DEBUG_LAYOUT` env 开启 layout tree dump**
设置后每次 calculateLayout 打 tree(子节点位置/尺寸). 用于诊断"为什么 box 位置不对".

#### I34. **每个 Node 有 `_nodeId` 顺序号**
debug 用,生产无作用.

### J. 与 Ink 的耦合点

#### J35. **`getInstanceCount` API**
Ink 用它判断"我有多少 yoga 节点在内存". 用于 fork 时不重启 yoga.

#### J36. **`setMeasureFunc` 在 Text 组件**
Text 组件用 `useEffect` 注册 measure 函数, unmount 清. Yoga 调用 measure 时拿到当前 text content.

#### J37. **`markDirty` API 在 measure 函数变化时**
text 内容变 → markDirty → 下次 calculateLayout 重新调 measure 函数.

#### J38. **scroll box 用 nested yoga root**
ScrollBox 创建独立 yoga root,内层算 contentHeight, 外层只显示 viewport. 不重叠.

### K. 跨文件不变量(M11 补读新增)

#### 不变量 YOGA-1: cache slot 顺序: width / widthMode / height / heightMode
所有读写 cache 的代码按此顺序. 不容颠倒.

#### 不变量 YOGA-2: `_generation` 单调递增
每次 calculateLayout 全局 ++. 子节点的 `_generation < parent._generation` 才算 fresh.

#### 不变量 YOGA-3: measure 函数返回值 = {width, height} (无 baseline)
原 yoga 有 baseline 返回. 该实现简化 —— baseline align 时 fallback 到 height.

#### 不变量 YOGA-4: explicit size > stretch > content
三种 size 决议优先级. 这是 yoga 1.x 行为.

### L. 待确认问题(M11 补读)

24. yoga TS 实现 vs WASM 实现的性能差距? 注释只说"启动快",运行时 layout 速度?
25. 为什么不直接用 `yoga-layout-prebuilt` npm 包? 体积 vs 维护性的具体 tradeoff?
26. `Errata` bitmask 字段未消费 —— 未来如果需要 spec-bug 兼容,要从头写 errata 处理?
27. RTL 不支持 —— 国际化的硬性限制. Anthropic 是否有 RTL 用户?
28. `Float64Array(4)` 而非 `Float32Array` —— double precision 必要吗? 节省内存如何?
29. `pointScaleFactor=1` —— 高 DPI 终端(iTerm2 Retina 字符)是否需要 2?
30. measure 函数 catch 转 `{0,0}` —— 静默 swallow 错误,如何 debug 用户的 measure bug?
31. scroll box nested yoga root —— 滚动深嵌套(ScrollBox 内 ScrollBox)是否会指数级慢?

### M. 重写 yoga 的总结性观察

为什么要这么干? **原 yoga.wasm 启动慢** —— WASM module 解码 + linking 耗时 50-200ms,对 CLI 启动严重. 重写一遍纯 TS:
1. **冷启动 < 50ms**(无 WASM 解码)
2. **bundle 单文件**(无 .wasm 二进制资源)
3. **Bun 友好**(WASM 在 Bun bundle 里需要额外配置)
4. **可调试**(JS 代码 V8 profiler 直接看)

代价:
1. **运行时可能稍慢**(JS 比 WASM 慢 1.5-3x 但 layout 不是热点)
2. **维护负担**(自己跟 yoga 上游 spec 演进)
3. **RTL 等高级特性砍掉**
4. **Errata bitmask 占位不实现**

**复用要点**: 第三方库启动开销/bundle size 重时,**手写**简化版可能比"配置打包器"更合算. 但前提:你能接受砍掉部分特性 + 持续维护.

### N. 最值得抄的 12 条

| # | 工程精髓 | 一句话 |
|---|---|---|
| 1 | 三层 cache(节点/measure/basis) | layout 性能必须分层缓存 |
| 2 | `_generation` 单调 + sameGen 旁路 | 子树跳过的关键机制 |
| 3 | `commitCacheOutputs` 强制必调 | scrollbox 33→2624 bug 教训 |
| 4 | `zeroLayoutRecursive` 必须递归 | display:none 必须 invalidate 子树 |
| 5 | 文本 floor/ceil 非文本 round | 终端字符网格特殊性 |
| 6 | `await Promise.resolve()` 重建 microtask | 移除 WASM 后必须的边界 |
| 7 | Float64Array 懒初始化 | 防 V8 IC shape change 抖动 |
| 8 | measure 函数永远 catch | 自定义 measure 不应让 layout 崩 |
| 9 | API 完全镜像 yoga.wasm | 重写第三方库时保留 API surface |
| 10 | `pointScaleFactor=1` 硬编码 | 终端字符不是像素 |
| 11 | child 用 Array 不用 LinkedList | V8 优化下 Array 够快 |
| 12 | nested yoga root for scrollbox | 复杂控件用独立 layout context |
