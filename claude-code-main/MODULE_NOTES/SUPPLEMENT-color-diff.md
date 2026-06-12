# SUPPLEMENT — native-ts/color-diff 子系统深读

> 补充未被任何 MODULE_NOTES 覆盖的终端 diff 着色子系统。
> 范围：
> - `src/native-ts/color-diff/index.ts`（999 行）— 纯 TS diff 着色引擎
>
> 总计 999 行源码逐行通读。

---

## 一、系统职责

将 unified diff hunk 或源文件转换为**终端 ANSI 着色输出**——行号 + 增/删标记 + 语法高亮 + 词级 diff 高亮 + 自动换行。这是 Claude Code 的 `StructuredDiff` 组件的底层渲染引擎。

### 前身

原生 Rust 模块（`vendor/color-diff-src`）使用 syntect + bat + similar crate。本文件是其**纯 TS 移植**，API 签名完全一致（`ColorDiff` / `ColorFile` / `getSyntaxTheme`），使用 highlight.js 替代 syntect。

---

## 二、架构

```
StructuredDiff.tsx / HighlightedCode.tsx
  → colorDiff.ts (gateway: 检查模块可用性)
    → ColorDiff.render(themeName, width, dim) → string[]  (diff hunk 着色)
    → ColorFile.render(themeName, width, dim) → string[]  (整文件着色)

内部管线 (per-line transform pipeline):
  hunk.lines
    → parseMarker ('+'/'-'/' ')
    → highlightLine (highlight.js AST → Block[])
    → removeNewlines
    → applyBackground (词级 diff 背景)
    → wrapText (按终端宽度自动折行)
    → addMarker ('+'/'-' 前缀)
    → addLineNumber (行号前缀)
    → intoLines (Block[] → ANSI 转义字符串)
```

---

## 三、关键设计决策

### 3.1 highlight.js 懒加载

```ts
let cachedHljs: HLJSApi | null = null
function hljs(): HLJSApi {
  if (cachedHljs) return cachedHljs
  const mod = require('highlight.js')
  cachedHljs = 'default' in mod && mod.default ? mod.default : mod
  return cachedHljs!
}
```

highlight.js 注册 190+ 语言语法（~50MB），加载耗时 100-200ms。如果 top-level import，任何 import 链到达此模块的文件（包括测试）都要付出这个代价。Windows CI 因此导致 GC 暂停，触发测试超时（PR #24150）。

**模式**：与 NAPI wrapper 对 `dlopen` 的懒加载模式一致。

### 3.2 三色模式自适应

```ts
type ColorMode = 'truecolor' | 'color256' | 'ansi'
```

根据 `$COLORTERM` 环境变量自动选择：
- `truecolor`/`24bit` → 直接 RGB 输出
- 其他 → 降级为 xterm-256 调色板（ansi256FromRgb）
- 主题名含 `ansi` → 16 色 ANSI 模式

### 3.3 ansi256FromRgb — Rust crate 的 TS 移植

```ts
function ansi256FromRgb(r: number, g: number, b: number): number
```

将 RGB 近似到 xterm-256 调色板（6×6×6 cube + 24 灰阶）。逻辑移植自 Rust `ansi_colours` crate：
1. 量化 RGB 到最近 cube 坐标
2. 计算最近灰阶值
3. 比较欧氏距离，选更近的

### 3.4 主题系统：从 syntect 色值测量

三套 scope→color 映射表硬编码了从 Rust 模块输出中**实测**的色值：

| 主题 | 色值来源 |
|------|---------|
| `MONOKAI_SCOPES` | syntect Monokai Extended (dark) |
| `GITHUB_SCOPES` | syntect GitHub (light) |
| `ANSI_SCOPES` | 16 色 ANSI 调色板 |

**storage keyword 重分类**：highlight.js 把 `const`/`let`/`function` 等归为 `keyword`，但 syntect 将它们分到 `storage.type`。通过 `STORAGE_KEYWORDS` Set 在运行时重新分类，使 `const` 得到 cyan 而非 pink。

### 3.5 词级 diff（Word Diff）

```
findAdjacentPairs(markers) → 找出相邻 del/add 行对
  → wordDiffStrings(oldStr, newStr) → [Range[], Range[]]
    → tokenize() → 词/空白/标点 token 化
    → diffArrays(oldTokens, newTokens) → diff ops
    → 累积变更长度 / 总长度 > 0.4 阈值 → 放弃词级着色
    → 返回变更区间列表
```

**CHANGE_THRESHOLD = 0.4**：如果变化超过 40%，词级 diff 噪声太大，退化为整行着色。

**tokenize() 策略**：
- 连续 word 字符（`\p{L}\p{N}_`）→ 一个 token
- 连续空白 → 一个 token
- 单个标点/运算符 → 独立 token（含 surrogate pair 处理）

### 3.6 自动换行（wrapText）

按终端宽度（`effectiveWidth = width - lineNumber - marker`）对 Block[] 做字符级折行：
- 使用 `stringWidth()` 计算显示宽度（处理 CJK 宽字符、emoji）
- codepoint 级迭代（非 byte 级），正确处理 surrogate pair
- **防死循环保证**：如果一个字符比整行还宽，强制输出 1 个 codepoint

### 3.7 删除行不做语法高亮

```ts
const tokens: Block[] =
  marker === '-'
    ? [[defaultStyle(theme), code]]  // ← 纯前景色
    : highlightLine(hlState, code, theme)
```

删除行只用默认前景色渲染——与 syntect/bat 行为一致。原因：删除的代码不是"当前代码"，不值得高亮（也避免高亮与红色背景的对比度问题）。

### 3.8 Daltonized 色盲友好模式

主题名含 `daltonized` 时：
- 添加行：蓝色系（替代绿色）
- 删除行：红色系（不变）

### 3.9 API Parity: NativeModule 接口

```ts
export type NativeModule = {
  ColorDiff: typeof ColorDiff
  ColorFile: typeof ColorFile
  getSyntaxTheme: (themeName: string) => SyntaxTheme
}
```

`getNativeModule()` 返回与原生 Rust NAPI 模块完全相同的接口，调用方（`colorDiff.ts`）不区分 native vs TS 实现。

---

## 四、两个公开类的渲染管线对比

| 步骤 | ColorDiff (diff hunk) | ColorFile (整文件) |
|------|----------------------|-------------------|
| 输入 | `Hunk { oldStart, newStart, lines }` | `code: string, filePath: string` |
| 行号计算 | 按 marker 分别递增 oldLine/newLine | 简单递增 |
| 语法高亮 | `+` 和 ` ` 行高亮，`-` 行不高亮 | 所有行都高亮 |
| 词级 diff | 有（findAdjacentPairs → wordDiffStrings） | 无 |
| 背景色 | 按 marker 赋行背景 + 词级高亮背景 | 无背景 |
| 标记前缀 | `+`/`-`/` ` | 无 |
| ANSI 模式特殊处理 | `-` 行额外 dim | 无 |

---

## 五、「自己写 Agent」可直接抄的设计原则

### 5.1 重量级依赖懒加载模式

```ts
let cached: T | null = null
function get(): T {
  if (cached) return cached
  cached = require('heavy-module')
  return cached
}
```

避免模块评估时的加载开销。适用于所有大型 NLP/解析/渲染库。

### 5.2 纯用户态"替身"替代原生模块

当原生 Rust/C++ 模块不可用时（交叉编译、CI、WebAssembly 环境），提供 TS fallback：
- API 签名完全一致
- 色值从原生模块输出中实测，保证视觉一致
- `getNativeModule()` 做透明切换

### 5.3 Token 化 + diff + 阈值 → 自适应词级着色

词级 diff 不总是有意义——大量修改时（>40%）退化为整行着色。这种"阈值守卫"模式避免噪声。

### 5.4 Per-Line Transform Pipeline

每行经过固定阶段的转换管线（highlight → removeNewlines → applyBackground → wrapText → addMarker → addLineNumber → serialize）。每阶段只改变 `Highlight` 结构的一个方面，互不耦合。易于插入新阶段（如未来添加 git blame 标记）。

### 5.5 Color 类型的 alpha 通道复用

```ts
type Color = { r: number; g: number; b: number; a: number }
// a=255: 真 RGB
// a=0: r 编码调色板索引
// a=1: 终端默认色（sentinel）
```

单一 Color 类型通过 alpha 值区分三种语义，避免 union type 的分支代码。与 bat 的 ANSI theme 约定一致。

### 5.6 stringWidth 用于终端折行

终端中 CJK 字符占 2 列，emoji 可能 1-2 列。`stringWidth()` 是折行的基础——不能用 `text.length`。

---

## 六、已知局限性（原文件注释）

| 局限 | 原因 |
|------|------|
| 普通标识符和 `=` `:` 等运算符无高亮 | highlight.js 不为它们分配 scope |
| BAT_THEME 环境变量无效 | highlight.js 无 bat 主题加载机制 |
| 删除行无语法高亮 | 与 Rust 原生模块行为一致的设计决策 |
| 无 continuation state | highlight.js 的 `highlight()` 不跨行保持状态；syntect 可以 |

---

## 七、与 MODULE_NOTES 其他章节的关联

| 关联模块 | 关联点 |
|---------|--------|
| M11 Ink 渲染 | `stringWidth()` 来自 `ink/stringWidth.js`；输出直接用于 Ink Text 组件 |
| M12 消息渲染 | `StructuredDiff.tsx` + `HighlightedCode.tsx` 是 diff 输出的消费者 |
| M07 文件工具 | `FileEditTool` 的 `UI.tsx` 调用 `StructuredDiff` 渲染编辑 diff |
| SUPPLEMENT-large-files | Ink 的 `dom.ts` 引用 `ColorDiff`/`ColorFile` 类型 |

---

> 文件清单：
> - `src/native-ts/color-diff/index.ts`（999 行）
