# SUPPLEMENT — native-ts/yoga-layout 子系统深读

> Facebook Yoga (flexbox 布局引擎) 的纯 TypeScript 移植，用于 Claude Code 终端 UI (Ink) 的布局计算。
> 范围：`src/native-ts/yoga-layout/` 目录下 2 文件 (index.ts + enums.ts)，合计 2,712 行。
> 无任何外部依赖，零 native binding。

---

## 一、系统职责

yoga-layout 子系统是 Claude Code 终端 UI 的**布局引擎核心**。它接收一棵由 Ink DOM 节点构成的样式树（每个节点携带 flexbox 属性），计算出每个节点的 (left, top, width, height) 绝对坐标，供渲染器将文本/边框 blit 到终端字符网格。

核心职责：
1. **Flexbox 布局计算** — 支持 flex-direction/grow/shrink/basis/wrap/align/justify 全套
2. **增量布局 (dirty tracking)** — 只有脏子树重新计算，干净节点命中缓存直接返回
3. **像素对齐 (pixel rounding)** — 终端是字符网格，需要整数坐标对齐（roundLayout）
4. **性能计数器** — 暴露 visited/measured/cacheHits/live 给上层做慢布局诊断

## 二、架构（文件结构 -> 核心类 -> 布局算法）

### 文件结构

```
src/native-ts/yoga-layout/
  enums.ts   (134 行) — 所有 Yoga 枚举的 const object 定义
  index.ts   (2578 行) — 完整实现：Value/Style/Layout/Node 类 + flexbox 算法
```

### 核心类型/类

| 类型 | 职责 |
|------|------|
| `Value` | `{unit, value}` — 4 种单位 (Undefined/Point/Percent/Auto) |
| `Style` | 节点输入属性集合（flex、margin、padding 等） |
| `Layout` | 节点计算结果 (left/top/width/height + 4 边 border/padding/margin) |
| `Node` (class) | 布局树节点，包含 style、layout、children、measureFunc、缓存 |
| `Config` | 全局配置 (pointScaleFactor、errata)，实际只用 pointScaleFactor=1 |
| `Yoga` (type) | 匹配 `yoga-layout/load` API 的工厂对象 (Config.create + Node.create) |

### 调用链

```
Ink reconciler commit
  → rootNode.onComputeLayout()
    → rootNode.yogaNode.calculateLayout(terminalColumns)
      → layoutNode(root, w, h, Exactly, Exactly, ...)
        → 对每个子节点递归 layoutNode / computeFlexBasis
```

### 模块出口

- `loadYoga(): Promise<Yoga>` — 返回 `Promise.resolve(YOGA_INSTANCE)`（同步，零 async 开销）
- `default` — 同一 YOGA_INSTANCE 对象
- `getYogaCounters()` — 暴露当次 calculateLayout 的性能指标
- 所有枚举 re-export (Align, Display, Edge, FlexDirection 等)

## 三、关键设计决策（为什么用纯 TS 重写 Yoga？）

### 3.1 为什么不用原生 yoga-layout NAPI？

yoga-layout npm 包 (yoga-layout-prebuilt / yoga-layout) 是 C++ NAPI binding：

1. **跨平台分发痛点** — Claude Code 需要支持 macOS/Linux/Windows + arm64/x64，NAPI binding 需要预编译 6+ 个平台的 .node 文件；用户环境可能缺少编译工具链
2. **启动时 WASM/native 加载开销** — 原版 `yoga-layout/load` 是 async (加载 .wasm 或 .node)，纯 TS 版 `loadYoga()` 返回 `Promise.resolve()`，零 I/O
3. **包体积** — yoga-layout WASM 约 200KB，native binding 更大；纯 TS 版 ~70KB 源码(压缩后更小)
4. **调试透明** — 布局 bug 可直接在 TS 层断点、打日志；C++/WASM 不透明
5. **可定制优化** — 针对终端场景(只有 LTR、不需要 RTL/aspect-ratio)做裁剪和 hot-path 优化

### 3.2 与 color-diff 的 fallback 模式对比

`native-ts/` 目录下三个模块都是同一模式：**用纯 TS 替代原来的 native Rust/C++ NAPI module**

| 模块 | 原版 | 纯 TS 版策略 |
|------|------|-------------|
| yoga-layout | C++ (Meta) → WASM/NAPI | 完整 flexbox 子集重写，API-compatible |
| color-diff | Rust (syntect + bat) NAPI | 用 highlight.js 替代 syntect，API 相同 |
| file-index | Rust (nucleo) NAPI | 纯 TS fuzzy search，简化评分 |

共同特征：**API 签名完全匹配原版**，调用方无需改一行代码。

## 四、Flexbox 布局算法核心（计算流程）

### 完整移植 vs 子集？

**子集，但覆盖 Ink 实际使用的全部特性 + 部分 spec parity 扩展。**

已实现（Ink 使用）：
- flex-direction (row/column + reverse)
- flex-grow / flex-shrink / flex-basis
- align-items / align-self (stretch, flex-start, center, flex-end)
- justify-content (6 种全部)
- margin / padding / border / gap
- width / height / min / max (point, percent, auto)
- position: relative / absolute
- display: flex / none
- measure functions (文本节点)

额外实现（spec parity，Ink 未使用）：
- margin: auto
- multi-pass flex clamping (min/max violations)
- flex-wrap: wrap / wrap-reverse + align-content
- display: contents
- baseline alignment

未实现：
- aspect-ratio
- box-sizing: content-box
- RTL direction（Ink 总是 LTR）

### 计算流程（layoutNode 函数，核心 ~850 行）

```
layoutNode(node, availW, availH, wMode, hMode, ownerW, ownerH, performLayout):

  CACHE CHECK — dirty-flag + 双槽缓存 + 4-slot LRU 缓存
    ↓ (cache miss)
  RESOLVE EDGES — padding/border/margin 4 边解析 (resolveEdges4Into)
  RESOLVE DIMENSIONS — style width/height → ownerSize → boundAxis(min/max)
    ↓
  IF measure-func leaf → 调用 measureFunc → 记录 layout.width/height → return
  IF empty leaf → paddingBorder 即为尺寸 → return
    ↓
  CONTAINER (有子节点):
  
  STEP 1: computeFlexBasis for each flow child + break into lines (wrap)
  STEP 2+3: resolveFlexibleLengths per line (multi-pass §9.7)
           + layoutNode each child to measure cross size
  STEP 4: Determine container final dimensions
  STEP 5: Position lines (align-content) + position children
           (justify-content + align-items + auto margins + relative offsets)
  STEP 6: layoutAbsoluteChild for each absolute-positioned child
```

### resolveFlexibleLengths (CSS Flexbox Spec §9.7)

完整实现多轮分配：
1. 冻结 inflexible 项（grow=0 or shrink=0）
2. 迭代分配剩余空间 → 检测 min/max violations → 冻结违规者 → 重新分配
3. 支持 partial flex（sum < 1 时按比例缩小分配量）

## 五、与 Ink 渲染器的集成方式

### 分层架构

```
┌─────────────────────────────────────────────────┐
│  src/ink/dom.ts  (DOM 树)                        │
│    每个 DOMElement 持有 yogaNode?: LayoutNode    │
└────────────────────┬────────────────────────────┘
                     │ uses interface
┌────────────────────▼────────────────────────────┐
│  src/ink/layout/node.ts  (LayoutNode 接口)       │
│    纯类型定义，string-enum 风格的属性名          │
└────────────────────┬────────────────────────────┘
                     │ implements
┌────────────────────▼────────────────────────────┐
│  src/ink/layout/yoga.ts  (YogaLayoutNode adapter)│
│    将 LayoutNode string-API 映射到 Yoga number-API│
└────────────────────┬────────────────────────────┘
                     │ delegates to
┌────────────────────▼────────────────────────────┐
│  src/native-ts/yoga-layout/index.ts  (纯 TS Yoga)│
│    Node class + layoutNode 算法                  │
└─────────────────────────────────────────────────┘
```

### 接口契约

`LayoutNode` (node.ts) 定义了**渲染器 → 布局引擎的全部契约**：
- Tree: insertChild / removeChild / getChildCount / getParent
- Compute: calculateLayout / setMeasureFunc / markDirty
- Read: getComputedLeft/Top/Width/Height/Border/Padding
- Style setters: setWidth/Height/Flex*/Align*/Justify*/Display/Position*/Overflow/Margin/Padding/Border/Gap

`YogaLayoutNode` (yoga.ts) 是适配器，做两件事：
1. string-enum → number-enum 映射（`'flex-start'` → `Justify.FlexStart`）
2. 委托到 `Yoga.Node` 实例

### 直接 vs 间接使用

- **dom.ts** — 通过 `LayoutNode` 接口操作（类型安全）
- **render-node-to-output.ts** — 通过 `node.yogaNode.getComputedLeft()` 等读取计算结果
- **render-border.ts** — 同上，读取宽高绘制边框
- **ink.tsx / reconciler.ts** — 调用 `calculateLayout()` 触发计算 + 读取 `getYogaCounters()` 做性能监控

### measure function 机制

文本节点（`#text`/`ink-raw-ansi`）通过 `setMeasureFunc` 注册测量函数。当 Yoga 遍历到叶节点时，不递归子节点，而是调用 measureFunc 获取内容尺寸。Ink 的 `measureTextNode` 函数计算文本在给定宽度下 wrap 后的行数 × 字符宽度。

## 六、「自己写 Agent」可直接抄的设计原则

### 6.1 纯 TS 替代 native = 最佳可移植性策略

- **原则**: 如果 native 模块只是为了性能，且终端 UI 场景数据量小（<10K 节点），纯 TS 重写是更优解
- **判断标准**: native 模块是否在用户 CI/CD 和多平台部署中造成摩擦 > 性能收益？

### 6.2 接口隔离 (LayoutNode) + 适配器模式

- 渲染器只依赖 `LayoutNode` 接口，不直接依赖 Yoga
- 未来可替换为其他布局引擎（甚至简化版 grid layout）而不改渲染层
- 适配器层做 string ↔ number 转换，两侧类型独立演化

### 6.3 多层缓存设计

纯 TS Yoga 的缓存策略是极致实用主义：

| 缓存层 | 机制 | 场景 |
|--------|------|------|
| isDirty_ flag | 脏标记上冒泡 | 未变化子树直接跳过 |
| 双槽缓存 (_hasL / _hasM) | measure pass + layout pass 各一个 | 同一 calculateLayout 内的两次调用 |
| 4-slot LRU (_cIn/_cOut) | Float64Array 紧凑存储 | 脏祖先对干净子节点用不同参数重复调用 |
| flex-basis 缓存 (_fbBasis) | generation stamp | 避免 2^depth 指数膨胀 |

### 6.4 性能 instrumentation 内嵌

`getYogaCounters()` 暴露 visited/measured/cacheHits/live — 上层可以在 slow commit 时记录日志，精确定位是布局爆炸还是测量函数慢。

### 6.5 fast-path flags 避免 hot-loop 开销

- `_hasAutoMargin` / `_hasPosition` / `_hasPadding` / `_hasBorder` / `_hasMargin`
- 样式 setter 时计算并缓存 boolean flag
- 布局循环中一个 `if (!flag)` 跳过 20+ 属性读取 + 15+ 比较
- **教训**: 在终端 1000+ 节点 60fps 刷新场景，micro-optimization 真的有效

### 6.6 generation-based cache invalidation

`_generation` 在每次 `calculateLayout()` 自增。缓存条目带 `_cGen`/`_fbGen` 戳：
- 同代 (sameGen) 条目无条件新鲜 — 即使 isDirty_（本次计算中的中间结果）
- 跨代条目需要 `!isDirty_` 才能命中 — 脏节点的旧缓存不可信

这避免了"先 dirty 再 clean"时残留旧数据的 subtle bug。

## 七、与 MODULE_NOTES 其他章节的关联

| 章节 | 关联点 |
|------|--------|
| M11-ink-rendering | yoga-layout 是 Ink 布局计算的底层引擎；M11 描述的渲染流水线中 "layout pass" 由此模块执行 |
| M13-input | 输入处理触发 re-render → reconciler commit → calculateLayout；yoga 的增量缓存直接决定按键响应延迟 |
| M01-bootstrap-lifecycle | yoga-layout 是同步 import（`loadYoga` 返回 resolved Promise），不参与异步启动序列 |
| SUPPLEMENT-color-diff | 同为 `native-ts/` 下的纯 TS 替代方案，设计哲学一致（API-compatible、零 native dep） |

---

> **文件清单**
>
> | 文件 | 行数 | 职责 |
> |------|------|------|
> | `src/native-ts/yoga-layout/enums.ts` | 134 | Yoga 枚举定义 (Align/Display/Edge/FlexDirection...) |
> | `src/native-ts/yoga-layout/index.ts` | 2578 | Node 类 + 完整 flexbox 算法 + 缓存 + API surface |
> | `src/ink/layout/node.ts` | 153 | LayoutNode 接口定义（渲染器侧契约） |
> | `src/ink/layout/yoga.ts` | 309 | YogaLayoutNode 适配器 (string→number enum 映射) |
> | `src/ink/layout/engine.ts` | 7 | 工厂函数 createLayoutNode() |
> | `src/ink/layout/geometry.ts` | 98 | 几何工具类型 (Point/Size/Rectangle/Edges) |
