# SUPPLEMENT — Team Memory Sync 子系统深读

> 补充 M06/M17 中未涉及的团队记忆同步子系统。
> 范围：
> - `src/services/teamMemorySync/index.ts`（1,256 行）— 同步核心（pull/push/upload/delta/conflict）
> - `src/services/teamMemorySync/watcher.ts`（387 行）— 文件监视 + 去抖 push
> - `src/services/teamMemorySync/secretScanner.ts`（324 行）— 客户端密钥扫描（gitleaks 规则子集）
> - `src/services/teamMemorySync/teamMemSecretGuard.ts`（44 行）— 写工具密钥门禁
> - `src/services/teamMemorySync/types.ts`（156 行）— Zod schema + 类型定义
> - `src/memdir/teamMemPaths.ts`（293 行）— 路径验证 + 符号链接防逃逸
>
> 总计 2,460 行源码逐行通读。

---

## 一、系统概述：Per-Repo 团队记忆的双向同步

Team Memory 是 Claude Code 在组织级别共享知识的机制——同一 GitHub 仓库的所有认证成员共享一组 Markdown 文件（存储在 `~/.claude/projects/<project>/memory/team/`），通过 Anthropic 后端 API 实现双向同步。

### 架构总览

```
本地文件系统                          Anthropic API
~/.claude/.../memory/team/            /api/claude_code/team_memory?repo=owner/repo
├── MEMORY.md                         ├── GET  → TeamMemoryData (entries + checksums)
├── patterns.md                       ├── GET ?view=hashes → metadata only
└── ...                               └── PUT  → upsert entries (delta upload)
    ↑                                     ↑
    │  pullTeamMemory()                   │  pushTeamMemory()
    │  (server wins per-key)              │  (local wins per-key)
    └─── fs.watch(recursive:true) ────────┘
         2s debounce → delta push
```

**核心语义**：
- **Pull**：服务器内容覆盖本地（server wins per-key）
- **Push**：只上传 hash 不同的 key（delta upload），本地覆盖服务器同 key 内容（local wins on conflict）
- **删除不传播**：删除本地文件不会删除服务器上的 key，下次 pull 会恢复

---

## 二、`types.ts` — 数据契约（156 行）

### 2.1 核心 Schema

| Schema | 用途 |
|--------|------|
| `TeamMemoryContentSchema` | `entries: Record<string, string>` + 可选 `entryChecksums: Record<string, string>` |
| `TeamMemoryDataSchema` | `organizationId` + `repo` + `version` + `lastModified` + `checksum` + `content` |
| `TeamMemoryTooManyEntriesSchema` | 结构化 413 错误体（`error_code: 'team_memory_too_many_entries'` + `max_entries` + `received_entries`） |

### 2.2 结果类型

四种结果类型分别服务不同操作：

| 类型 | 操作 | 关键字段 |
|------|------|---------|
| `TeamMemorySyncFetchResult` | GET pull | `isEmpty`(404) / `notModified`(304) / `data` |
| `TeamMemoryHashesResult` | GET ?view=hashes | `entryChecksums`（轻量探针，无 body） |
| `TeamMemorySyncPushResult` | 完整 push 流程 | `filesUploaded` / `conflict`(412) / `skippedSecrets` |
| `TeamMemorySyncUploadResult` | 单次 PUT | `conflict` / `serverErrorCode` / `serverMaxEntries` |

---

## 三、`index.ts` — 同步核心（1,256 行）

### 3.1 SyncState：会话级可变状态

```ts
type SyncState = {
  lastKnownChecksum: string | null       // ETag，条件请求用
  serverChecksums: Map<string, string>   // per-key sha256，delta 计算用
  serverMaxEntries: number | null        // 从 413 学到的服务器上限
}
```

**设计亮点**：
- `serverMaxEntries` 初始为 null——客户端**不预设**条目上限，让服务器当权威（每个组织可 GB 调优）
- 只有收到结构化 413 后才学到并缓存限制值
- `serverChecksums` 在 pull 后从服务器 response 填充，push 成功后从本地 hash 更新

### 3.2 Delta Upload：只上传变化

```ts
// push 核心逻辑
const localHashes = new Map<string, string>()
for (const [key, content] of Object.entries(entries)) {
  localHashes.set(key, hashContent(content))  // sha256:<hex>
}

const delta: Record<string, string> = {}
for (const [key, localHash] of localHashes) {
  if (state.serverChecksums.get(key) !== localHash) {
    delta[key] = entries[key]!
  }
}
```

**hash 格式**：`sha256:<hex>`，与服务器 `entryChecksums` 格式一致，直接字符串比较。

### 3.3 PUT Body 分批：Gateway 限制应对

```ts
const MAX_PUT_BODY_BYTES = 200_000  // 200KB，低于 gateway 的 ~256-512KB 限制
const MAX_FILE_SIZE_BYTES = 250_000 // 单文件 250KB 上限

function batchDeltaByBytes(delta): Array<Record<string, string>> {
  // 贪心 bin-packing，key 排序保证确定性
  // 单个超大文件独占一个 batch
}
```

**工程背景**：PR #21969 移除了客户端条目数上限后，冷推送可达 300KB-1.4MB，触发了 API gateway（非应用层）的 body-size 限制。200KB 阈值留有余量。

**批次原子性**：每个 batch 是独立的 PUT（upsert 语义），batch N 失败时 batch 1..N-1 已提交。`serverChecksums` 在每个 batch 成功后更新，所以冲突重试时自然从未提交的尾部恢复。

### 3.4 412 冲突解决：Probe + Retry

```
push delta → 412 Precondition Failed
  ↓
GET ?view=hashes (轻量探针，只拿 checksums，不下载内容)
  ↓
刷新 serverChecksums
  ↓
重新计算 delta（队友推送的相同内容自然被排除）
  ↓
重试 push（最多 MAX_CONFLICT_RETRIES=2 次）
```

**关键设计决策**：
- **local-wins-on-conflict**：冲突时本地版本覆盖服务器同 key 内容，因为本地用户正在积极编辑
- **不做内容级合并**：同 key 双方都改了 → 本地版本直接覆盖，队友的编辑丢失——这是故意的 lesser evil
- **不重新读磁盘**：冲突解决时不从磁盘重新读取，因为 delta 计算基于 serverChecksums 刷新已自然排除了服务器来源的内容

### 3.5 Pull 流程

```ts
async function pullTeamMemory(state, options?): Promise<{
  success, filesWritten, entryCount, notModified?, error?
}> {
  // 1. 检查 OAuth + repo
  // 2. 条件 GET（ETag → 304 Not Modified → 跳过）
  // 3. 解析 TeamMemoryData
  // 4. 刷新 serverChecksums（从 entryChecksums）
  // 5. writeRemoteEntriesToLocal（并行写入，跳过未变化文件）
  // 6. 清除 memory file cache（如有文件写入）
}
```

**写入优化**：
- 并行处理所有 entry（`Promise.all`），p99 从串行 ~22s（50 entries）大幅降低
- 每个 entry 先读取现有内容比较——未变化则跳过（保持 mtime，不触发 watcher）

### 3.6 readLocalTeamMemory：本地文件读取 + 密钥扫描

```ts
async function readLocalTeamMemory(maxEntries): Promise<{
  entries: Record<string, string>
  skippedSecrets: SkippedSecretFile[]
}> {
  // 1. 递归遍历 team 目录
  // 2. 跳过 > 250KB 的文件
  // 3. scanForSecrets —— 检测到密钥的文件整个跳过
  // 4. maxEntries 截断（从 413 学到的上限，排序后截断保证确定性）
}
```

**确定性截断的重要性**：不排序就截断 → `Promise.all` 完成顺序不确定 → 每次 push 选取不同的 N 个文件 → `serverChecksums` 对不上 → delta 膨胀为接近全量快照。排序后截断确保相同的 N 个 key 一致参与比较。

---

## 四、`watcher.ts` — 文件监视（387 行）

### 4.1 启动流程

```ts
async function startTeamMemoryWatcher(): Promise<void> {
  // 门禁：feature('TEAMMEM') + isTeamMemoryEnabled() + isTeamMemorySyncAvailable()
  // 额外检查：必须有 github.com remote（非 github remote 永远无法同步）
  
  // 1. 初始 pull（在 watcher 启动前，避免自己的磁盘写触发 push）
  // 2. 启动 fs.watch（recursive: true）
  // 3. 记录遥测
}
```

**为什么总是启动 watcher？** 即使服务器无内容（fresh repo），也必须启动 watcher——否则 Claude 的首次 team memory 写入只能依赖 PostToolUse hook 的 `notifyTeamMemoryWrite`，而 Claude 的写入频率很低，新用户可能卡在 bootstrap dead zone 好几天。

### 4.2 fs.watch 选择

| 方案 | 问题 |
|------|------|
| chokidar 4+ | 不再用 fsevents，Bun 的 fallback 用 kqueue → 500+ 文件 = 500+ fd 长期占用 |
| `fs.watch(recursive: true)` | macOS 用 FSEvents（O(1) fd），Linux 用 inotify（O(subdirs) fd） |

选择 `fs.watch(recursive: true)`。验证结果：60 个文件 × 5 个子目录 = 仅 2 个 fd。

### 4.3 Debounce + Push 串行化

```ts
const DEBOUNCE_MS = 2000

function schedulePush(): void {
  if (pushSuppressedReason !== null) return
  hasPendingChanges = true
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    if (pushInProgress) {
      schedulePush()  // push 正在跑 → 重新 debounce
      return
    }
    currentPushPromise = executePush()
  }, DEBOUNCE_MS)
}
```

### 4.4 永久失败抑制

```ts
let pushSuppressedReason: string | null = null

function isPermanentFailure(r: TeamMemorySyncPushResult): boolean {
  if (r.errorType === 'no_oauth' || r.errorType === 'no_repo') return true
  if (r.httpStatus >= 400 && r.httpStatus < 500 
      && r.httpStatus !== 409 && r.httpStatus !== 429) return true
  return false
}
```

**真实事故驱动**：BQ Mar 14-16，一台无 OAuth 的设备 2.5 天内发出了 167K 次 push 事件，因为其他会话的写入触发了 watcher，每次都失败重试。

**恢复机制**：
- `no_oauth` → 抑制持续到会话重启（用户需要重新认证）
- `413 too_many_entries` → 用户删除文件时清除抑制（`fs.watch` 事件 + `stat` ENOENT → 识别为 unlink）
- `409`（冲突）和 `429`（限流）不算永久失败——会自动恢复

### 4.5 优雅关闭

```ts
async function stopTeamMemoryWatcher(): Promise<void> {
  // 1. 清除 debounce timer
  // 2. 关闭 watcher
  // 3. await 进行中的 push
  // 4. flush 待推送的变更（best-effort，2s 关闭预算内）
}
```

---

## 五、`secretScanner.ts` — 客户端密钥扫描（324 行）

### 5.1 设计目标

**密钥永远不离开用户的机器**——在 push 前扫描，检测到密钥的文件整个跳过。

### 5.2 规则来源

从 [gitleaks](https://github.com/gitleaks/gitleaks) 精选了 31 条高置信规则（近零误报率），覆盖：

| 类别 | 规则数 | 示例 |
|------|--------|------|
| 云厂商 | 5 | AWS Access Token, GCP API Key, Azure AD, DigitalOcean |
| AI API | 4 | Anthropic API Key, OpenAI API Key, HuggingFace |
| 版本控制 | 7 | GitHub PAT/Fine-grained/App/OAuth/Refresh, GitLab PAT/Deploy |
| 通信 | 4 | Slack Bot/User/App Token, Twilio, SendGrid |
| 开发工具 | 6 | NPM, PyPI, Databricks, HashiCorp TF, Pulumi, Postman |
| 可观测性 | 4 | Grafana API/Cloud/SA Token, Sentry User/Org Token |
| 支付 | 3 | Stripe, Shopify Access/Shared Secret |
| 加密 | 1 | Private Key (PEM) |

### 5.3 安全设计细节

**Anthropic API Key 前缀拼接**：
```ts
const ANT_KEY_PFX = ['sk', 'ant', 'api'].join('-')
// 运行时拼出 "sk-ant-api"，避免字面量出现在 bundle 中
// 绕过 excluded-strings 检查 + minifier 不会常量折叠 join()
```

**Go → JS 正则移植**：
- `(?i)` inline flag → 显式字符类 `[a-zA-Z0-9]` 或 `flags: 'i'`
- `(?-i:...)` mode group → 分段处理

**输出安全**：
- `scanForSecrets` 只返回 `ruleId` + `label`，**永不返回匹配到的密钥值**
- `redactSecrets` 用 `[REDACTED]` 替换捕获组（保留边界字符）

### 5.4 懒编译

```ts
let compiledRules: Array<{ id: string; re: RegExp }> | null = null

function getCompiledRules() {
  compiledRules ??= SECRET_RULES.map(r => ({
    id: r.id,
    re: new RegExp(r.source, r.flags),
  }))
  return compiledRules
}
```

首次扫描时编译所有正则，后续复用。

---

## 六、`teamMemSecretGuard.ts` — 写工具门禁（44 行）

```ts
export function checkTeamMemSecrets(filePath: string, content: string): string | null {
  if (feature('TEAMMEM')) {
    // 动态 require（tree-shaking 友好）
    if (!isTeamMemPath(filePath)) return null
    const matches = scanForSecrets(content)
    if (matches.length === 0) return null
    return `Content contains potential secrets (${labels}) and cannot be written to team memory.`
  }
  return null
}
```

**调用方**：`FileWriteTool.validateInput` 和 `FileEditTool.validateInput`——在 Claude 写入 team memory 文件时立即拦截，不等到 push 阶段。

**双层防御**：
1. **写入时**：`checkTeamMemSecrets` 阻止 Claude 把密钥写入 team memory 文件
2. **推送时**：`readLocalTeamMemory` 中的 `scanForSecrets` 再次检查（防止用户手动编辑引入密钥）

---

## 七、`teamMemPaths.ts` — 路径安全（293 行）

### 7.1 五层路径验证

```
sanitizePathKey(key)
  ↓ 1. null byte 检查
  ↓ 2. URL-encoded traversal (%2e%2e%2f = ../)
  ↓ 3. Unicode normalization (NFKC: ．．／ → ../)
  ↓ 4. 反斜杠检查（Windows 路径分隔符）
  ↓ 5. 绝对路径检查
  ↓
resolve() + startsWith(teamDir)
  ↓ 6. 字符串级容器检查（快速拒绝 .. 穿越）
  ↓
realpathDeepestExisting()
  ↓ 7. 符号链接解析（逐级上溯直到 realpath 成功）
  ↓ 8. 悬空符号链接检测（lstat 区分）
  ↓ 9. 符号链接循环检测（ELOOP）
  ↓
isRealPathWithinTeamDir()
  ↓ 10. 真实路径容器检查（防符号链接逃逸）
```

### 7.2 realpathDeepestExisting：安全的符号链接解析

**问题**：`path.resolve()` 不解析符号链接。攻击者可在 teamDir 内放一个符号链接指向 `~/.ssh/authorized_keys`，通过 resolve 检查但实际写入在目录外。

**解法**：从目标路径向上逐级尝试 `realpath()`，直到找到一个存在的祖先：
1. ENOENT → 可能是真不存在，也可能是悬空符号链接
2. 悬空符号链接 → `lstat()` 成功但 `isSymbolicLink()` → 拒绝
3. ELOOP → 符号链接循环 → 拒绝
4. 其他错误 → fail-closed（无法验证容器关系就拒绝）

---

## 八、跨文件汇总：「自己写 Agent」可直接抄的设计原则

### 8.1 Delta Upload + Content-Addressable 比较

不发全量快照，用 `sha256:<hex>` 标识每个 entry 的内容版本，只上传 hash 不同的 key。适用于任何需要增量同步的 Agent 状态管理场景。

### 8.2 乐观锁 + 轻量探针冲突解决

```
PUT with If-Match → 412 → GET ?view=hashes (不下载内容) → 刷新 checksums → 重算 delta → 重试
```

避免了全量 pull + merge + 全量 push 的重量级方案。`view=hashes` 端点的设计（只返回元数据，不返回 body）值得在自建 API 中复用。

### 8.3 客户端密钥扫描的安全分层

| 层 | 机制 | 防什么 |
|----|------|--------|
| 1 | `checkTeamMemSecrets`（写入时） | Claude 模型写入密钥 |
| 2 | `scanForSecrets`（推送时） | 用户手动编辑引入密钥 |
| 3 | 只返回 ruleId/label | 扫描结果本身不泄露密钥值 |
| 4 | `ANT_KEY_PFX` 拼接 | bundle 中不出现密钥前缀字面量 |

### 8.4 永久失败抑制防无限重试

Watcher 驱动的自动重试必须区分"重试可恢复"和"重试无意义"：
- `no_oauth` / `4xx`（非 409/429）→ 抑制到会话重启或用户修复动作
- `409`（冲突）/ `429`（限流）/ 网络错误 → 允许重试

实际事故：无抑制时一台设备 2.5 天产生 167K 次无效 push。

### 8.5 fs.watch 选型考量

| 需求 | 解法 |
|------|------|
| 500+ 文件不能 500+ fd | `fs.watch(recursive: true)` + FSEvents (macOS) |
| 区分 unlink vs write | `fs.watch` 不区分 → `stat()` ENOENT → 推断为 unlink |
| 子目录支持 | `recursive: true`（Linux inotify 每子目录一个 watch，可接受） |

### 8.6 符号链接防逃逸的完整防御

`path.resolve()` 只做字符串级别的 `..` 消除，不解析符号链接。任何涉及用户/服务器提供的路径写入的 Agent 都应做 `realpath` 级别的容器验证。

### 8.7 确定性截断

当需要限制上传条目数时，必须先排序再截断——否则并行文件遍历（`Promise.all`）的完成顺序不确定，导致每次选取不同子集，破坏增量计算的基础。

---

## 九、与 MODULE_NOTES 其他章节的关联

| 关联模块 | 关联点 |
|---------|--------|
| M06 context-engineering | `memdir/` 是 team memory 的存储层；pull 后调 `clearMemoryFileCaches()` 刷新内存文件缓存 |
| M07 fs-shell-git | `getGithubRepo()` 提取 git remote slug 用于 API 路由 |
| M04 permission-safety | `FileWriteTool`/`FileEditTool` 的 `validateInput` 调用 `checkTeamMemSecrets` |
| M05 api-streaming | `getRetryDelay()` 复用了 API 层的退避策略 |
| M17 config | OAuth token 管理（`getClaudeAIOAuthTokens`/`checkAndRefreshOAuthTokenIfNeeded`）支撑认证 |
| M18 telemetry | 多个 `tengu_team_mem_*` 事件用于监控同步健康度 |
| SUPPLEMENT-large-files | `bashSecurity.ts` 有类似的"多层验证 → fail-closed"安全模式 |

---

> 文件清单：
> - `src/services/teamMemorySync/index.ts`（1,256 行）
> - `src/services/teamMemorySync/watcher.ts`（387 行）
> - `src/services/teamMemorySync/secretScanner.ts`（324 行）
> - `src/services/teamMemorySync/teamMemSecretGuard.ts`（44 行）
> - `src/services/teamMemorySync/types.ts`（156 行）
> - `src/memdir/teamMemPaths.ts`（293 行）— 路径验证关联代码
