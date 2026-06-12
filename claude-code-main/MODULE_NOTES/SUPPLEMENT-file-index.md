# SUPPLEMENT — native-ts/file-index 子系统深读

> Pure-TypeScript 实现的模糊文件搜索引擎，是 Claude Code `@` 文件提及 / QuickOpen 对话框背后的核心检索层。  
> 范围：`src/native-ts/file-index/index.ts`（370 行）+ 主调用方 `src/hooks/fileSuggestions.ts`（811 行）  
> 总行数：约 1181 行构成完整子系统。

---

## 一、系统职责

FileIndex 的唯一职责是**对一组已知文件路径做高性能模糊匹配**，返回 Top-N 结果供 UI 即时展示。

具体场景：
1. **@-mention typeahead** — 用户在输入框输入 `@src/comp` 时实时返回匹配文件
2. **QuickOpen 对话框** — `ctrl+shift+p` 打开的 fuzzy file finder
3. **Unified suggestions** — 文件建议与 MCP resource / Agent 建议统一排序

它 **不做** 以下事情：
- 不负责文件发现（由 `git ls-files` 或 `ripgrep` 完成）
- 不做文件内容搜索（那是 GrepTool / ripgrep 的职责）
- 不做 glob 模式匹配（那是 GlobTool 的职责）

---

## 二、架构（调用方 → 本模块 → 底层依赖）

```
┌─ UI Layer ─────────────────────────────────────────────────┐
│  useTypeahead.tsx   QuickOpenDialog.tsx   unifiedSuggestions│
└───────────────────────────┬────────────────────────────────┘
                            │ generateFileSuggestions()
                            ▼
┌─ hooks/fileSuggestions.ts ─────────────────────────────────┐
│  - getPathsForSuggestions()   ← 数据收集 (git ls-files/rg) │
│  - startBackgroundCacheRefresh() ← 节流刷新               │
│  - mergeUntrackedIntoNormalizedCache() ← 增量合并         │
│  - findMatchingFiles()        ← 查询代理                  │
│  - pathListSignature()        ← FNV-1a 变更检测           │
└───────────────────────────┬────────────────────────────────┘
                            │ .loadFromFileListAsync() / .search()
                            ▼
┌─ native-ts/file-index/index.ts ───────────────────────────┐
│  class FileIndex                                           │
│    paths[], lowerPaths[], charBits[], pathLens[]           │
│    .loadFromFileList(sync)  / .loadFromFileListAsync()     │
│    .search(query, limit) → SearchResult[]                  │
└───────────────────────────┬────────────────────────────────┘
                            │ 底层依赖
                            ▼
          无外部依赖 — 纯算术 + TypedArray + setImmediate
```

**调用方清单：**
| 文件 | 用途 |
|------|------|
| `hooks/fileSuggestions.ts` | 唯一直接使用 FileIndex 类的地方 |
| `hooks/useTypeahead.tsx` | React hook，调用 `generateFileSuggestions` + 订阅 `onIndexBuildComplete` |
| `hooks/unifiedSuggestions.ts` | 统一建议排序，调用 `generateFileSuggestions` |
| `components/QuickOpenDialog.tsx` | Ctrl+Shift+P，调用 `generateFileSuggestions` |
| `commands/clear/caches.ts` | `/clear` 命令调用 `clearFileSuggestionCaches` 重置索引 |

---

## 三、关键设计决策（每个决策配代码片段）

### 决策 1：Pure-TS 替代 Rust NAPI

原模块 `vendor/file-index-src` 用 Rust 封装 nucleo（Helix 编辑器的 fuzzy matcher）。TS port 消除了 native 编译依赖，同时保持相同 API 和评分语义。

```typescript
/**
 * Pure-TypeScript port of vendor/file-index-src (Rust NAPI module).
 * The native module wraps nucleo (https://github.com/helix-editor/nucleo) for
 * high-performance fuzzy file searching. This port reimplements the same API
 * and scoring behavior without native dependencies.
 */
```

### 决策 2：Bitmap 预过滤（O(1) 拒绝）

每个路径预计算 26-bit 字母位图（a-z），查询时用位与一次性排除不含查询字母的路径。

```typescript
// Precompute: lowercase, a–z bitmap, length. Bitmap gives O(1) rejection
// of paths missing any needle letter (89% survival for broad queries like
// "test" → still a 10%+ free win; 90%+ rejection for rare chars).
private indexPath(i: number): void {
  const lp = this.paths[i]!.toLowerCase()
  this.lowerPaths[i] = lp
  let bits = 0
  for (let j = 0; j < lp.length; j++) {
    const c = lp.charCodeAt(j)
    if (c >= 97 && c <= 122) bits |= 1 << (c - 97)
  }
  this.charBits[i] = bits
}
```

查询端一行拒绝：
```typescript
// O(1) bitmap reject: path must contain every letter in the needle
if ((charBits[i]! & needleBitmap) !== needleBitmap) continue
```

### 决策 3：时间片异步构建（Progressive Queryable）

大型仓库（270k+ 文件）索引构建通过 `setImmediate` 按时间片 yield，**首批就绪后立即可查询**（partial results）。

```typescript
loadFromFileListAsync(fileList: string[]): {
  queryable: Promise<void>  // 首批 chunk 索引完毕
  done: Promise<void>       // 全量构建完毕
}
```

时间片阈值是 4ms（不是固定条数），自适应慢机器：
```typescript
const CHUNK_MS = 4
// ...
if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
  this.readyCount = i + 1
  if (firstChunk) { markQueryable(); firstChunk = false }
  await yieldToEventLoop()
  chunkStart = performance.now()
}
```

search() 只遍历 `readyCount` 前缀：
```typescript
const { paths, lowerPaths, charBits, pathLens, readyCount } = this
outer: for (let i = 0; i < readyCount; i++) { ... }
```

### 决策 4：Smart Case（自动大小写敏感）

查询全小写 → 大小写不敏感；含大写字母 → 大小写敏感。与 fzf/vim smartcase 一致。

```typescript
// Smart case: lowercase query → case-insensitive; any uppercase → case-sensitive
const caseSensitive = query !== query.toLowerCase()
const needle = caseSensitive ? query : query.toLowerCase()
```

### 决策 5：Test 文件降权

包含 "test" 的路径得分乘以 1.05 惩罚系数（仍被 1.0 封顶），让非测试文件排名略高。

```typescript
const finalScore = path.includes('test')
  ? Math.min(positionScore * 1.05, 1.0)
  : positionScore
```

### 决策 6：FNV-1a 采样签名跳过无变化重建

fileSuggestions.ts 用 strided FNV-1a 哈希检测文件列表是否变化，避免每次击键都重建索引：

```typescript
export function pathListSignature(paths: string[]): string {
  const n = paths.length
  const stride = Math.max(1, Math.floor(n / 500))
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < n; i += stride) {
    const p = paths[i]!
    for (let j = 0; j < p.length; j++) {
      h = ((h ^ p.charCodeAt(j)) * 0x01000193) | 0
    }
    h = (h * 0x01000193) | 0
  }
  // ...
  return `${n}:${(h >>> 0).toString(16)}`
}
```

### 决策 7：.git/index mtime 作为 tracked file 变更探针

用 `statSync(.git/index)` 的 mtime 判断 git 状态是否变化，避免每次击键 spawn `git ls-files`：

```typescript
function getGitIndexMtime(): number | null {
  const repoRoot = findGitRoot(getCwd())
  if (!repoRoot) return null
  try {
    return statSync(path.join(repoRoot, '.git', 'index')).mtimeMs
  } catch { return null }
}
```

---

## 四、核心算法/数据结构

### 4.1 索引数据结构

| 字段 | 类型 | 用途 |
|------|------|------|
| `paths` | `string[]` | 原始路径（保留大小写） |
| `lowerPaths` | `string[]` | 预计算小写版本 |
| `charBits` | `Int32Array` | 26-bit 字母位图 |
| `pathLens` | `Uint16Array` | 路径长度缓存 |
| `topLevelCache` | `SearchResult[]` | 空查询时的顶层目录快速返回 |
| `readyCount` | `number` | 异步构建进度指针 |

### 4.2 搜索算法（fused indexOf + boundary scoring）

1. **Bitmap 预筛** — `(charBits[i] & needleBitmap) !== needleBitmap` → skip
2. **Fused indexOf scan** — 贪心找每个 needle 字符的最早出现位置，同时累积 gap/consecutive 分
3. **Gap-bound 剪枝** — 如果最佳假设分（全 boundary bonus）减去已知 gap penalty 都打不过当前 top-k 阈值，跳过 boundary pass
4. **Boundary/CamelCase scoring** — 检查每个匹配位置前一个字符（`/`, `_`, `.` → boundary bonus; 前小后大 → camel bonus）
5. **Length bonus** — 短路径加分：`Math.max(0, 32 - (hLen >> 2))`
6. **Top-K 维护** — 升序数组 + 二分插入，避免对全部匹配做 O(n log n) 排序

评分常量（仿 nucleo/fzf-v2）：
```typescript
const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 6
const BONUS_CONSECUTIVE = 4
const BONUS_FIRST_CHAR = 8
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXTENSION = 1
```

### 4.3 Top-Level Cache

空查询（用户刚输入 `@`）直接返回预计算的顶层目录条目，按 (长度升序, 字母升序) 排列，最多 100 条。

```typescript
function computeTopLevelEntries(paths: string[], limit: number): SearchResult[]
```

### 4.4 文件列表获取策略（fileSuggestions.ts）

优先级：
1. `git ls-files --recurse-submodules`（从 repoRoot 执行，5s 超时）
2. 回退到 `ripgrep --files --follow --hidden`

增量机制：
- tracked files 立即返回
- untracked files 在后台异步获取，完成后 merge 进索引并 emit `indexBuildComplete` 信号
- UI 订阅该信号后重新执行最后一次搜索

---

## 五、「自己写 Agent」可直接抄的设计原则

### 5.1 渐进可用性（Progressive Queryable）

不要等全量数据就绪才响应用户。索引构建中 `readyCount` 允许部分查询，用户立刻看到结果而非等待——适用于任何"数据收集阶段长但 UI 需要即时反馈"的场景。

### 5.2 时间片 yield 优于固定计数 yield

```typescript
const CHUNK_MS = 4
if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
  await yieldToEventLoop()
}
```

M-series 上 5000 路径约 2ms，老旧 Windows 可能 15ms+。固定 chunk size 会导致慢机器卡顿或快机器过度 yield。

### 5.3 多级短路：bitmap → gap-bound → 详细评分

任何 O(n) 扫描都应先用最便宜的检查淘汰大量候选，再做昂贵评分。bitmap 是 1 条指令，能淘汰 10%-90% 路径。

### 5.4 Signature-based skip 而非 dirty flag

用内容指纹判断是否需要重建，比维护手动 dirty flag 更可靠。`pathListSignature` 的 strided 采样在 346k 路径上只哈希约 700 个样本。

### 5.5 mtime probe 代替昂贵的 subprocess

读 `.git/index` 的 mtime 只需一个 stat syscall（~0.1ms），而 `git ls-files` 要 spawn 进程 + IPC（~20-50ms）。当 mtime 未变，确定跳过。

### 5.6 分离 data collection 与 indexing

FileIndex 自身不关心文件从哪来——它只接受 `string[]`。文件发现（git/rg）、.ignore 过滤、路径规范化全在 fileSuggestions.ts 中完成。这使得 FileIndex 可以独立测试和复用。

### 5.7 Signal pattern for async completion notification

```typescript
const indexBuildComplete = createSignal()
export const onIndexBuildComplete = indexBuildComplete.subscribe
```

让 UI 层订阅"索引构建完毕"事件后重新查询，而非 polling 或 promise chaining。

---

## 六、与 MODULE_NOTES 其他章节的关联

| 相关章节 | 关联点 |
|----------|--------|
| **M07-fs-shell-git.md** | 文件发现依赖 `git ls-files` / `ripgrep`；`.ignore`/`.rgignore` pattern 加载 |
| **M11-ink-rendering.md** | typeahead suggestions 的 Ink 渲染（PromptInputFooterSuggestions） |
| **M13-input.md** | `useTypeahead` hook 触发搜索 + `@` 检测 + debounce 50ms |
| **M16-commands.md** | `/clear` 命令通过 `clearFileSuggestionCaches()` 重置索引 |
| **M01-bootstrap-lifecycle.md** | session resume 时清理缓存保证新鲜文件发现 |
| **M03-tool-system.md** | GlobTool/GrepTool 是 LLM 使用的工具，FileIndex 是人类用的 typeahead——两者互补不重叠 |

---

> **文件清单**
>
> - `src/native-ts/file-index/index.ts` — FileIndex 类、搜索算法、Top-Level cache
> - `src/hooks/fileSuggestions.ts` — 文件列表获取、索引生命周期管理、suggestion 生成
> - `src/hooks/useTypeahead.tsx` — React hook 集成（debounce + build-complete 重查）
> - `src/hooks/unifiedSuggestions.ts` — 统一排序（file + MCP + agent suggestions）
> - `src/components/QuickOpenDialog.tsx` — Ctrl+Shift+P fuzzy finder UI
> - `src/commands/clear/caches.ts` — 缓存清理入口
