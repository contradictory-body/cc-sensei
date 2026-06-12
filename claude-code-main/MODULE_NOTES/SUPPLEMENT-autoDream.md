# SUPPLEMENT — autoDream 子系统深读

> 补充 M14（subagent/tasks）中未展开的后台记忆巩固子系统。
> 范围：
> - `src/services/autoDream/autoDream.ts`（325 行）— 主调度与 fork 执行
> - `src/services/autoDream/config.ts`（22 行）— 开关读取（settings + GrowthBook）
> - `src/services/autoDream/consolidationLock.ts`（141 行）— 基于 lock-file mtime 的互斥 + 时间戳
> - `src/services/autoDream/consolidationPrompt.ts`（65 行）— 巩固 prompt 模板
> - `src/tasks/DreamTask/DreamTask.ts`（158 行）— Task 注册/状态机/UI surface
> - `src/components/tasks/DreamDetailDialog.tsx`（251 行）— 详情 Dialog（React/Ink）
>
> 总计约 960 行源码通读。

---

## 一、系统职责（"Dream" 概念解释）

"Dream" 借用人类睡眠时大脑整理记忆的隐喻：**当用户与 Claude Code 交互空闲期结束后**（不是正在交互时），系统自动 fork 一个子 agent 回顾近期 session transcript，把散落在对话中的知识**巩固（consolidate）到持久化的 memory 文件系统** (`~/.claude/projects/<path>/memory/`) 中。

核心价值：
- 每次对话只做增量 memory 提取（extractMemories），但随时间推移 memory 文件会膨胀、重复、过时
- Dream 定期做一次「反思性通读 + 合并 + 去重 + 修正」，保持 memory 目录精简且准确
- 类似数据库的 compaction / GC —— extractMemories 是 WAL append，dream 是 merge-compact

## 二、架构（触发 → 门控 → 锁 → 执行 → 巩固）

```
stopHooks.ts (每个 assistant turn 结束)
  └─ executeAutoDream(context, appendSystemMessage)     ← fire-and-forget
       │
       ├─ [Gate 0] isGateOpen()
       │     ├─ !KAIROS mode                            (KAIROS 有专属 disk-skill dream)
       │     ├─ !Remote mode
       │     ├─ isAutoMemoryEnabled()                   (auto-memory 总开关)
       │     └─ isAutoDreamEnabled()                    (config.ts: settings || GrowthBook)
       │
       ├─ [Gate 1] Time gate
       │     readLastConsolidatedAt() → lock file mtime
       │     hoursSince >= minHours (default 24h)
       │
       ├─ [Gate 2] Scan throttle
       │     lastSessionScanAt closure var
       │     10 min cooldown between session dir scans
       │
       ├─ [Gate 3] Session gate
       │     listSessionsTouchedSince(lastAt) → filter current session
       │     count >= minSessions (default 5)
       │
       ├─ [Gate 4] Lock acquire
       │     tryAcquireConsolidationLock() → PID + mtime CAS
       │     returns priorMtime or null
       │
       └─ [Execute] runForkedAgent({...})
             ├─ prompt: buildConsolidationPrompt()
             ├─ canUseTool: createAutoMemCanUseTool(memoryRoot)
             │     → Read/Grep/Glob: allow unrestricted
             │     → Bash: only isReadOnly commands
             │     → Edit/Write: only paths within memoryRoot
             ├─ onMessage: makeDreamProgressWatcher()
             │     → addDreamTurn(taskId, ...) → updates DreamTask UI state
             ├─ skipTranscript: true
             └─ querySource: 'auto_dream'

       On success:
         completeDreamTask(taskId) + appendSystemMessage("Improved N files")
       On failure:
         rollbackConsolidationLock(priorMtime) + failDreamTask()
       On user kill (abort):
         DreamTask.kill() → abortController.abort() + rollback lock
```

## 三、关键设计决策（每个决策配代码片段）

### 3.1 Lock = 时间戳：lock file 的 mtime 就是 lastConsolidatedAt

```typescript
// consolidationLock.ts:28-36
export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const s = await stat(lockPath())
    return s.mtimeMs
  } catch {
    return 0  // 文件不存在 = 从未巩固
  }
}
```

**决策理由：** 零额外状态文件。lock 成功获取 = `writeFile(path, PID)` = mtime 自动更新为 now。失败回滚 = `utimes(path, priorMtime)` 倒回。这个设计让 acquire + timestamp-advance 成为一个原子动作。

### 3.2 门控从廉价到昂贵排序（cost-ordered gating）

```typescript
// autoDream.ts:7-8 注释
// Gate order (cheapest first):
//   1. Time: hours since lastConsolidatedAt >= minHours (one stat)
//   2. Sessions: transcript count with mtime > lastConsolidatedAt >= minSessions
//   3. Lock: no other process mid-consolidation
```

每个 assistant turn 都会调用 `executeAutoDream`，所以必须极低开销短路。大多数 turn 在 Gate 1（一次 stat）就返回。只有过了 24h 才做 session dir scan，再之后才尝试 lock。

### 3.3 Scan throttle 防止无效重复扫描

```typescript
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000

// 时间门通过但 session 数不够时，lock mtime 不推进，
// 下一次 turn 时间门又会通过 → 如果不节流就每 turn 扫一次目录
if (!force && sinceScanMs < SESSION_SCAN_INTERVAL_MS) { return }
```

### 3.4 Closure-scoped state（测试友好）

```typescript
export function initAutoDream(): void {
  let lastSessionScanAt = 0       // ← closure variable
  runner = async function runAutoDream(...) { ... }
}
```

测试中 `beforeEach(() => initAutoDream())` 即可获得干净状态，无 module-level 副作用。与 `initExtractMemories` 同模式。

### 3.5 CAS-style lock（多进程安全）

```typescript
// 写 PID → 再读 → 验证是自己
await writeFile(path, String(process.pid))
let verify = await readFile(path, 'utf8')
if (parseInt(verify.trim(), 10) !== process.pid) return null
```

两个进程同时 reclaim 一个 dead-PID lock 时，后写者 PID 覆盖前写者。前写者 re-read 发现不是自己，主动让出。加上 `HOLDER_STALE_MS = 60min` 的 PID reuse guard。

### 3.6 Forked agent 共享 prompt cache

Dream 子 agent 使用 `createCacheSafeParams(context)` —— 与主对话共享 system prompt + tools 定义的 cache prefix，只是 context messages 不同（dream 只有一条 user message）。这使得 dream fork 的输入 token 几乎全部 cache hit。

### 3.7 Tool 权限沙箱

Dream agent 可以读任何文件（Grep/Glob/Read），Bash 只允许 read-only 命令（ls/find/grep/cat/stat 等），Edit/Write 只允许 memory 目录内的路径。这确保 dream 不会意外修改用户代码。

## 四、巩固（Consolidation）Prompt 分析

Prompt 结构是 4 阶段流水线：

| 阶段 | 任务 | 关键约束 |
|------|------|---------|
| Phase 1: Orient | ls memory dir + read MEMORY.md index + skim topic files | 不要创建重复文件 |
| Phase 2: Gather | 从 daily logs / existing memories / JSONL transcripts 收集新信号 | grep narrowly, don't read whole JSONL |
| Phase 3: Consolidate | 合并新信号到已有 topic files | 相对日期转绝对日期；删除矛盾事实 |
| Phase 4: Prune & Index | 更新 MEMORY.md 保持 <200 行 / <25KB | index 只存指针，不存内容 |

Prompt 中注入的 `extra` 段（仅 auto-dream 有，手动 /dream 没有）：
- Tool constraints 提示（Bash read-only）
- Session 列表（让 agent 知道哪些 session 需要回顾）

### 与手动 `/dream` 的关系

`consolidationPrompt.ts` 被 auto-dream 和 KAIROS 的 `/dream` skill 共享（`buildConsolidationPrompt` 是 exported）。手动 dream 不走 autoDream.ts 的门控/锁/DreamTask 注册，但调用 `recordConsolidation()` 来 stamp lock mtime（防止 auto 紧随其后重复触发）。

## 五、与 SessionMemory/extractMemories 的协作关系

```
用户交互 session
    │
    ├─ [每 turn 结束] extractMemories (stopHooks.ts)
    │     → 从当前 turn 提取新知识 → append 到 memory files
    │     → 增量写入，不回顾历史
    │
    └─ [每 24h + 5 sessions 后] autoDream (stopHooks.ts)
          → 回顾近期 sessions 的 transcripts + memory files
          → 合并/去重/修正/删除过时内容
          → 维护 MEMORY.md index 不超限
```

**分工类比：**
- extractMemories = append-only WAL（write-ahead log）
- autoDream = periodic compaction / merge-sort

两者共享：
- 同一个 `createAutoMemCanUseTool(memoryDir)` 权限函数
- 同一个 memory 目录 (`getAutoMemPath()`)
- 同一个 `appendSystemMessage` + `createMemorySavedMessage` UI 通知模式
- 都用 `runForkedAgent` + `skipTranscript: true` + prompt cache sharing

关键差异：

| 维度 | extractMemories | autoDream |
|------|----------------|-----------|
| 频率 | 每 turn | 每 24h（最快 10min 扫一次） |
| 输入 | 当前 session 的最后 N 条 message | 所有 session 的 JSONL transcript |
| 动作 | 只 append/create | 可 merge/edit/delete/reindex |
| 触发 | turn 结束即触发 | 需要满足 time+session+lock 三道门 |
| Task UI | 无（静默） | 有 DreamTask pill + detail dialog |

## 六、「自己写 Agent」可直接抄的设计原则

1. **Cost-ordered gating** — 后台任务必须在热路径上极低开销。用 stat > dir-scan > lock 的成本递增排列门控。

2. **Lock = timestamp trick** — 用 lock file 的 mtime 同时承载「上次完成时间」和「是否有人持锁」两个语义，减少 state files。

3. **CAS-style file lock** — 不用 flock（跨平台兼容），而用 write-PID + re-read-verify 实现 optimistic locking。加 stale timeout 防 PID reuse。

4. **Rollback-on-failure** — 锁获取时保存 priorMtime，失败/kill 时 utimes 倒回。确保失败不延迟下次触发。

5. **Closure-scoped init** — `initX()` 返回 runner closure 而非 module-level singleton，方便测试 `beforeEach` 重置。

6. **Fork 共享 cache** — `createCacheSafeParams` 让 fork 的 system prompt + tools 与主对话 cache 对齐，fork 只付增量 token 的钱。

7. **Fire-and-forget + appendSystemMessage** — 后台 fork 完成后通过 `appendSystemMessage` 在主对话中注入一条系统消息告知用户，不阻塞主循环。

8. **Task registry for UI visibility** — 用 `registerTask` / `updateTaskState` / `DreamTask` 让后台工作在 footer pill 和 Shift+Down dialog 中可见、可 kill。

9. **Phase detection from tool calls** — 不解析 agent 输出文本来判断阶段，而是用「首次 Edit/Write tool_use 出现」作为 starting→updating 的转换信号。简单且不脆弱。

10. **Prompt 与调度分离** — `consolidationPrompt.ts` 独立导出，供 auto-dream 和手动 /dream 共享。调度逻辑（门控/锁/task）在 `autoDream.ts`，互不耦合。

## 七、与 MODULE_NOTES 其他章节的关联

| 章节 | 关联点 |
|------|--------|
| M02 agent-loop | `runForkedAgent` 是 agent loop 的一个 fork 入口，dream 用它执行子 agent |
| M14 subagent-tasks | DreamTask 注册在全局 task registry，与 AgentTask 并列 |
| M17 config | `autoDreamEnabled` 是 `supportedSettings` 之一，可通过 `/config` 修改 |
| M18 telemetry | `tengu_auto_dream_fired/completed/failed` 事件；GrowthBook `tengu_onyx_plover` feature flag |
| SUPPLEMENT-AgentSummary-MagicDocs | 三者都用 `runForkedAgent` + `skipTranscript` 模式，但 dream 有独立 lock 机制（AgentSummary 用定时器，MagicDocs 用 file watcher） |

---

### 与 AgentSummary / MagicDocs 的异同

| 维度 | autoDream | AgentSummary | MagicDocs |
|------|-----------|--------------|-----------|
| 目的 | 巩固长期记忆 | 生成子 agent 进度摘要 | 同步外部 doc 到 context |
| 触发 | turn-end + 门控 | 30s 定时器 | file watcher |
| 并发控制 | file lock + PID CAS | 每个 agent 独立定时器 | 无锁（幂等更新） |
| 工具权限 | Read + ro-Bash + memdir-Write | deny all | Read + ro-Bash + Write |
| Task UI | DreamTask pill + dialog | AgentProgress | 无 |
| Cache 策略 | 共享主对话 cache prefix | 共享子 agent cache | 共享主对话 cache |

---

> **文件清单：**
> - `src/services/autoDream/autoDream.ts` — 主入口、门控、fork 执行
> - `src/services/autoDream/config.ts` — enabled 开关（settings + GrowthBook）
> - `src/services/autoDream/consolidationLock.ts` — lock file CAS + mtime-as-timestamp
> - `src/services/autoDream/consolidationPrompt.ts` — 4-phase consolidation prompt
> - `src/tasks/DreamTask/DreamTask.ts` — Task 状态机 + kill handler
> - `src/components/tasks/DreamDetailDialog.tsx` — UI detail view
> - `src/components/tasks/BackgroundTask.tsx:296` — pill label rendering
> - `src/components/memory/MemoryFileSelector.tsx` — auto-dream toggle UI
> - `src/query/stopHooks.ts:155` — 调用入口
> - `src/services/extractMemories/extractMemories.ts:171` — 共享 canUseTool
> - `src/tools/ConfigTool/supportedSettings.ts:64` — 配置项注册
