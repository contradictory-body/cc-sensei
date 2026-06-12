# M03 Tool 系统(契约 / 注册表 / 执行管线 / 钩子)

> 范围:`src/Tool.ts`、`src/tools.ts`、`src/services/tools/{toolExecution,toolHooks,toolOrchestration,StreamingToolExecutor}.ts`、`src/constants/tools.ts`,以及对单个 tool(如 `FileReadTool`)的代表性观察。
> 本文不涉及具体工具实现细节(BashTool、AgentTool、FileEdit 等留到 M07/M14),只聚焦 **Tool 抽象本身的契约与执行管线**。

## 1. 模块定位

负责把"模型输出的 `tool_use` block"变成"已渲染的、可被附加到对话历史里的 `tool_result` block"。覆盖:
- **静态层**:Tool 接口定义、buildTool 默认值、Tool 注册表(动态拼装)
- **执行层**:`runToolUse` 单工具完整生命周期(校验 → 钩子 → 权限 → 调用 → 结果映射 → PostHook)
- **编排层**:`StreamingToolExecutor`(流式期间一边收 tool_use 一边并发执行)、`toolOrchestration` 的并发批分区
- **横切**:子代理 disallow/allow 名单、ToolSearch 延迟加载、tool result 大小持久化

## 2. 关键文件

### 2.1 接口与默认值

- `src/Tool.ts` (792 行) ⭐
  - **`Tool<Input, Output, P>`** 接口:30+ 个方法,大部分可选
  - **`ToolUseContext`** 类型:超过 50 个字段的"上下文盒子"(详见 §3.2)
  - **`ToolPermissionContext`** 类型:`DeepImmutable` 包裹的权限规则集合
  - **`ToolResult<T>`**:`{ data, newMessages?, contextModifier?, mcpMeta? }`
  - **`buildTool(def)`**:工厂函数,把 ToolDef → Tool,填入安全默认值
  - **`TOOL_DEFAULTS`**:fail-closed 默认值(isConcurrencySafe=false,isReadOnly=false,checkPermissions=allow)
  - **`findToolByName`** / **`toolMatchesName`**:按 name 或 alias 查找

- `src/tools.ts` (389 行) ⭐
  - **`getAllBaseTools()`**:**所有内置工具的全集**(条件 spread 的数组字面量)
  - **`getTools(permissionContext)`**:运行期过滤(deny rules + REPL hide + isEnabled)
  - **`assembleToolPool(permissionContext, mcpTools)`**:built-in + MCP 拼装并去重(name 优先 built-in)
  - **`getMergedTools()`**:无去重的合并,用于 token counting
  - **`filterToolsByDenyRules`**:按 `getDenyRuleForTool` 剔除
  - **`TOOL_PRESETS`**:目前只有 `'default'`
  - 顶部用 `feature()` 与 `process.env.USER_TYPE === 'ant'` 双 gate 加载实验性工具

- `src/constants/tools.ts` (113 行)
  - `ALL_AGENT_DISALLOWED_TOOLS`:子代理一律禁用(TaskOutput / EnterPlanMode / AskUserQuestion / TaskStop / Workflow…)
  - `ASYNC_AGENT_ALLOWED_TOOLS`:异步代理白名单(只允许文件读写 / web / shell / skill 等无 UI 工具)
  - `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS`:in-process teammate 额外允许(TaskCreate/Get/List/Update + SendMessage + Cron)
  - `COORDINATOR_MODE_ALLOWED_TOOLS`:协调者模式只能用 4 个(AgentTool / TaskStop / SendMessage / SyntheticOutput)

### 2.2 执行管线

- `src/services/tools/toolExecution.ts` (1745 行) ⭐⭐
  - **`runToolUse(toolUse, assistantMessage, canUseTool, ctx)`**:`AsyncGenerator<MessageUpdateLazy>`,单个工具的完整生命周期入口
  - **`streamedCheckPermissionsAndCallTool`**:把"进度回调 + 最终结果"用 `Stream<MessageUpdateLazy>` 合一为单个 async iterable(并发安全包装)
  - **`checkPermissionsAndCallTool`**:**核心管线**(10+ 阶段,见 §3.4)
  - **`classifyToolError`**:压缩混淆友好的错误分类(用于 telemetry,把 minified `nJT` 还原为 `Error:ENOENT`)
  - **`buildSchemaNotSentHint`**:延迟加载工具被调用但模型未走 ToolSearch 时的提示
  - **`MessageUpdateLazy`**:`{ message, contextModifier? }`,链路里的统一返回单元
  - **`McpServerType`** / **`findMcpServerConnection`**:MCP 服务器透传(stdio/sse/http/ws/sdk/sse-ide…)

- `src/services/tools/toolHooks.ts` (650 行) ⭐
  - **`runPreToolUseHooks`**:聚合 PreToolUse hook 流式产物为 7 种 `result.type`(message / hookPermissionResult / hookUpdatedInput / preventContinuation / stopReason / additionalContext / stop)
  - **`resolveHookPermissionDecision`**:**关键安全不变量** —— hook `allow` 不能绕过 settings.json 的 `deny`/`ask` 规则,仍要走 `checkRuleBasedPermissions`
  - **`runPostToolUseHooks`**:成功路径的 PostToolUse,可改写 MCP 工具 output(`updatedMCPToolOutput`)
  - **`runPostToolUseFailureHooks`**:失败路径(supports `isInterrupt` 区分用户中断 vs 工具错误)

- `src/services/tools/toolOrchestration.ts` (188 行)
  - **`runTools(toolUses, ...)`**:把多个 tool_use 调用按 `isConcurrencySafe` 分区,逐批执行
  - **`partitionToolCalls`**:按 isConcurrencySafe 切成 batch
  - **`runToolsConcurrently`**:用 `all(generators, maxConcurrency)`(默认 10,可被 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 覆盖)
  - **`runToolsSerially`**:不安全工具串行执行

- `src/services/tools/StreamingToolExecutor.ts` (530 行) ⭐
  - **流式期间**收 tool_use,一边收一边按并发约束执行
  - 状态:`queued / executing / completed / yielded`
  - **`siblingAbortController = createChildAbortController(parent)`**:Bash 错误时杀掉兄弟工具但不结束本轮
  - **`discard()`**:streaming fallback 时抛弃已收的工具
  - **`getCompletedResults` (sync)** vs **`getRemainingResults` (async)**:流式 yield 与最终 drain
  - 进度消息走单独路径,完成结果按到达顺序 yield

## 3. 核心抽象

### 3.1 Tool 接口契约(分组解读)

`Tool<Input extends AnyObject, Output, P extends ToolProgressData>` 把工具的全部职责拆成多个分组方法:

| 分组 | 必填 | 可选 | 职责 |
|---|---|---|---|
| **元信息** | `name`, `inputSchema`, `maxResultSizeChars` | `aliases`, `searchHint`, `inputJSONSchema`, `outputSchema`, `mcpInfo`, `isMcp`, `isLsp`, `shouldDefer`, `alwaysLoad`, `strict` | 注册、JSON Schema 给模型、MCP 元数据 |
| **能力位** | — | `isEnabled`, `isConcurrencySafe`, `isReadOnly`, `isDestructive`, `isOpenWorld`, `requiresUserInteraction` | 决定调度方式、UI 装饰、安全级别 |
| **生命周期** | `call(args, ctx, canUseTool, parentMsg, onProgress)` | `validateInput`, `checkPermissions`, `backfillObservableInput`, `preparePermissionMatcher`, `inputsEquivalent` | 真正执行 + 输入校验 + 权限自检 |
| **静态描述** | `description(input, opts)`, `prompt(opts)` | `getPath`, `getToolUseSummary`, `getActivityDescription`, `toAutoClassifierInput`, `userFacingName` | 给模型的提示文本 + 给用户/UI 的字符串 + 给 classifier 的脱敏摘要 |
| **结果映射** | `mapToolResultToToolResultBlockParam` | `extractSearchText`, `isResultTruncated`, `isSearchOrReadCommand`, `isTransparentWrapper` | tool result 序列化 + 转录搜索索引 + UI 折叠提示 |
| **渲染(Ink)** | `renderToolUseMessage` | `renderToolResultMessage`, `renderToolUseProgressMessage`, `renderToolUseQueuedMessage`, `renderToolUseRejectedMessage`, `renderToolUseErrorMessage`, `renderToolUseTag`, `renderGroupedToolUse`, `userFacingNameBackgroundColor` | 全部 React 节点 |
| **运行时行为** | — | `interruptBehavior()` returns `'cancel'\|'block'` | 用户新消息到来时本工具是否取消 |

> **设计观察**:接口异常宽,但是 `buildTool` 工厂(`Tool.ts:783`)用类型级 spread 给所有 *defaultable* 方法填默认实现,允许具体工具只声明它真正自定义的部分。这也是从 `satisfies Tool` 迁移到 `BuiltTool<D>` 的原因 —— 同一份 default 表既驱动运行期也驱动类型推断,**没有 `?.() ?? default` 散布在调用点**。

### 3.2 ToolUseContext —— 真正的"上下文胶囊"

`Tool.ts:158-300` 定义,**单个 50+ 字段的 object**,以下 6 类:

1. **静态选项**(`options`):commands / debug / mainLoopModel / verbose / tools / mcpClients / mcpResources / agentDefinitions / customSystemPrompt / appendSystemPrompt / refreshTools …
2. **取消/抗争**:`abortController` (主)、`agentId`(子代理标识)、`agentType`、`requireCanUseTool`(speculation 用)
3. **状态访问**:`getAppState()` / `setAppState()` / `setAppStateForTasks?`(给 detached subagent)
4. **UI 回调**(REPL only,SDK 模式 undefined):`setToolJSX`, `addNotification`, `appendSystemMessage`, `sendOSNotification`, `setStreamMode`, `openMessageSelector`, `requestPrompt`, `setHasInterruptibleToolInProgress`
5. **进度/计数**:`setInProgressToolUseIDs`, `setResponseLength`, `pushApiMetricsEntry`(ant only),`onCompactProgress`, `setSDKStatus`
6. **会话级累积**:`messages`, `readFileState`, `nestedMemoryAttachmentTriggers`, `loadedNestedMemoryPaths`, `dynamicSkillDirTriggers`, `discoveredSkillNames`, `toolDecisions`, `localDenialTracking`, `contentReplacementState`, `renderedSystemPrompt`, `queryTracking`, `criticalSystemReminder_EXPERIMENTAL`, `preserveToolUseResults`

> **设计观察**:这个胶囊**故意没拆开**。原因:
> - 每个工具调用都需要其中一部分,把它拆成多个参数会让 `tool.call()` 签名爆炸;
> - 用 spread 派生子上下文非常便利(`{ ...toolUseContext, abortController: childCtrl }`);
> - 子代理(`createSubagentContext`)只覆盖 4-5 个字段(agentId、setAppState 改 no-op、localDenialTracking 单独建);
> - 上下文修改器 `contextModifier(ctx) -> ctx` 仅作用于非并发工具(并发不安全)。

**关键约束**(注释里反复强调):
- `setAppState` 在 async subagent 是 no-op —— 用 `setAppStateForTasks` 才能登顶到根 store
- `loadedNestedMemoryPaths` 与 `readFileState` 必须分离 —— 后者是 LRU,会被驱逐;前者用于 dedup,永远不能丢
- `localDenialTracking` 给异步子代理,因为它的 setAppState 是 no-op,denial 计数器不能累计

### 3.3 Tool 注册表的层级过滤

```
getAllBaseTools()                        ← 全集(条件 spread,feature()/USER_TYPE/env 三类 gate)
  ↓ filterToolsByDenyRules
getTools(permissionContext)              ← 运行期过滤
  ↓ + mcp tools, sort, uniqBy('name')
assembleToolPool(perm, mcpTools)         ← 给模型的最终 tool list
                                            (built-in 在前,MCP 在后,各自字典序)
```

**为什么先按"分区"再各自字典序而不是整体字典序**(`tools.ts:357-365`):
- 服务器有个 `claude_code_system_cache_policy` 在最后一个 prefix-matched built-in 之后插入 cache breakpoint
- 整体字典序会让 MCP 工具穿插进 built-in,**每次新增 MCP 工具都失效缓存**
- 分区+各自排序保证 built-in 是连续前缀,MCP 添加只影响后缀

**子代理工具白名单**(`constants/tools.ts`):

| 名单 | 作用 | 关键禁用项 |
|---|---|---|
| `ALL_AGENT_DISALLOWED_TOOLS` | 通用子代理禁用 | TaskOutput(防递归)、EnterPlanMode、AskUserQuestion(无 UI)、TaskStop |
| `ASYNC_AGENT_ALLOWED_TOOLS` | 异步代理 explicit 白名单 | 只有文件读写/web/shell/skill |
| `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` | in-process teammate 额外开放 | TaskCreate/Get/List/Update + SendMessage + Cron |
| `COORDINATOR_MODE_ALLOWED_TOOLS` | 协调者只用 4 个 | Agent + TaskStop + SendMessage + SyntheticOutput |

### 3.4 单个 tool 的 11 阶段执行管线(`runToolUse` 内部)

`toolExecution.ts:599 checkPermissionsAndCallTool` 是真正的"全管线",从顶到底是:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 0. tool 查找(支持 alias 回退到 getAllBaseTools)                    │
│ 1. abort 早退(发出 CANCEL_MESSAGE)                                 │
│ 2. Zod schema.safeParse  →  失败:发 InputValidationError            │
│    └→ buildSchemaNotSentHint:延迟工具未走 ToolSearch 时附额外提示    │
│ 3. tool.validateInput?  →  failed:工具自定义校验失败                │
│ 4. 推测分类器预热(Bash only,见 §5)                                 │
│ 5. backfillObservableInput:对 *clone* 修改(原始保持以保 cache)     │
│ 6. PreToolUse hook 流  →  累积 hookPermissionResult / 修改 input     │
│    └→ slow-phase log(>2s 时打 debug 日志)                          │
│ 7. resolveHookPermissionDecision:聚合 hook 与 ask/deny rule          │
│ 8. permissionDecision.behavior !== 'allow'  →  发拒绝消息并退出     │
│    └→ 若是 classifier 拒绝,跑 PermissionDenied hook,可让模型重试   │
│ 9. tool.call(callInput, …)  →  得 ToolResult<Output>                 │
│    └→ OTel content event(file_path/diff/command 等敏感字段 opt-in) │
│10. mapToolResultToToolResultBlockParam → 写到 resultingMessages      │
│11. PostToolUse hook 流(MCP tools 可改 output)                      │
│    └→ catch:errorPath = log + PostToolUseFailure hook + tool_result │
└─────────────────────────────────────────────────────────────────────┘
```

**步骤 5 的精妙之处**(`toolExecution.ts:782-793`、`1186-1205`):
- 模型给 BashTool 的 `input.file_path` 是 `~/foo`,UI 想看到 `/Users/X/foo`,但 prompt cache 必须看到 `~/foo`(否则 cache miss)
- **解法**:对 `processedInput` 做 backfill 写入 clone,`callInput` 保留原值;在传给 `tool.call()` 时根据 hook 是否替换过决定哪一个走
- 如果 hook 返回 fresh input(经 inputSchema.parse),`file_path` 又退回到 backfill 的扩展路径 → 此时把它替换为模型原值,只让其他字段差分通过
- 这是为了 **transcript / VCR fixture hash 稳定** —— tool result 字符串通常包含 input 的 file_path,改了字符串就改了 hash

**步骤 7 的安全不变量**(`toolHooks.ts:332-433` `resolveHookPermissionDecision`):
- Hook `allow` **不能**绕过 settings.json 里的 `deny` / `ask` 规则
- 所以即便 hook allow,仍要 `checkRuleBasedPermissions(tool, hookInput, ctx)`,如果命中 deny → 用 deny;命中 ask → 弹 dialog
- 例外:hook 提供了 `updatedInput` 且工具 `requiresUserInteraction()` —— 视为"hook 就是用户交互",跳过 dialog
- 例外:`requireCanUseTool` 标记(speculation 走 overlay 文件路径重写时)— 强制走 canUseTool
- 这个不变量用单独函数封装,因为同一逻辑在 `toolExecution.ts`(主循环)和 `REPLTool/toolWrappers.ts`(REPL 内部嵌套调用)都要用

### 3.5 流式工具执行的并发模型(StreamingToolExecutor)

模型流式输出 tool_use 时,我们**不能**等所有 tool_use 都到齐再开始执行 —— 长 turn 可能有 10+ 个并发 read,等所有 yields 都到齐再跑会浪费几秒。`StreamingToolExecutor` 的设计:

```
模型 SSE → addTool(block) ────────┐
                                    ├─→ processQueue() 看是否能立即开跑
                                    │   • 如果当前没工具在跑 → 跑
                                    │   • 如果当前跑的全是 concurrency-safe 且本工具也是 → 跑
                                    │   • 否则:并发安全的留 queue;不安全的 break(保序)
                                    └─→ executeTool(tool)
                                        │
                                        ├─→ siblingAbortController(child of parent)
                                        ├─→ runToolUse(generator) 流式收
                                        │   ├─→ 进度消息 → tool.pendingProgress[]
                                        │   ├─→ 普通消息 → messages[]
                                        │   └─→ Bash 错误 → siblingAbortController.abort('sibling_error')
                                        └─→ 完成后 status='completed'

调用方 ←  getCompletedResults()  (sync gen,有就 yield,没有 break)
        │
        └─  getRemainingResults() (async gen,等到所有完成)
```

**4 个特别的设计点**:

1. **siblingAbortController 不是 parent**:`createChildAbortController` 是关键 —— 它继承 parent 的 abort,但反向不冒泡;Bash 失败 abort sibling 时,**主 query controller 不动**,所以 query loop 能继续到下一轮(让模型基于错误重试)。但如果是用户中断(reason !== 'sibling_error')就要冒泡。
2. **只 Bash 错误才取消兄弟**:Read / WebFetch 失败一个不影响其他;`if (tool.block.name === BASH_TOOL_NAME)` 才设 `hasErrored=true`(`StreamingToolExecutor.ts:359`)
3. **interruptBehavior 区分 cancel/block**:用户在工具运行中按 Esc → reason='interrupt' → 只取消 `interruptBehavior() === 'cancel'` 的工具(`block` 让用户消息排队,工具继续跑)
4. **discard() 与 streaming fallback**:模型流式失败回退到非流式时,所有已经在跑的工具都得"丢弃" —— 不是 abort,是把它们的结果塞个合成错误消息,以保证后续重发的非流式响应不会和已经跑过的工具产生重复 tool_result(`createSyntheticErrorMessage` 的 'streaming_fallback' 分支)

### 3.6 tool_result 的存储/截断契约

- **`tool.maxResultSizeChars`**:每个工具自定义。超过则结果被持久化到磁盘(`processToolResultBlock` / `processPreMappedToolResultBlock` 处理),模型只看到一段 preview + 一个文件 path
- **特殊值 `Infinity`**:Read 工具就是这样,因为 Read 自身已经按 token / size 限制;如果再持久化就会形成"Read → 文件 → Read"的死循环
- **MCP 工具特殊路径**:PostToolUse hook 可以修改 MCP tool 的 output(`updatedMCPToolOutput`),所以 MCP 的 mapping 推迟到 hook 后(`toolExecution.ts:1540 if (isMcpTool(tool)) await addToolResult(toolOutput)`),非 MCP 直接在 `1478 await addToolResult(toolOutput, mappedToolResultBlock)`

### 3.7 ToolSearch / 延迟加载机制

如果工具集太大(超过某个 token 阈值),Claude Code 把部分工具标记 `shouldDefer: true` —— 它们的 schema 不进 prompt,只留 `searchHint`,模型必须先调用 `ToolSearchTool` 拿到 schema 再调用真正的工具。

机制:
- `tool.shouldDefer`:布尔位,运行期判断
- `tool.alwaysLoad`:对抗 defer 的强制位(turn 1 就要看到完整 schema 的工具)
- `tool.searchHint`:3-10 字一句话能力描述,给 ToolSearch 关键字匹配
- `buildSchemaNotSentHint(tool, messages, tools)`(toolExecution.ts:578):**当模型直接调用了延迟工具但 ToolSearch 还没给出过这个工具时**,把 Zod 错误旁附一句:
  > "This tool's schema was not sent to the API … Load the tool first: call ToolSearch with query 'select:{name}', then retry."

这是**重要的工程信号**:延迟加载是个性能优化,但模型偶尔会忽略它直接调用 →  schema 解析失败 → 必须给一个明确的 recovery 指引,而不是只丢 Zod 错误。

### 3.8 telemetry 安全的错误分类(`classifyToolError`)

minified bundle 里 `error.constructor.name` 会变成 `nJT` / `Chq` 这类 3-4 字符的乱码,直接打到 telemetry 是无信息量的。`toolExecution.ts:150` 的策略:

1. 如果是 `TelemetrySafeError_*` → 用其 `telemetryMessage`(已审过)
2. 如果是 Node fs 错误(有 `code` 属性)→ `Error:ENOENT` / `Error:EACCES`
3. 如果是已知错误类(`name` 不为空且 ≠ 'Error' 且长度 > 3)→ 用 `error.name`(它在构造函数里被设置,minify 不影响)
4. 否则 → `'Error'`

> **可迁移设计**:**任何走 minified bundle 的代码做 telemetry 都需要这一层** —— 不然你 dashboard 上看到的 error 就是 `nJT: Cannot find module` 而不是 `MODULE_NOT_FOUND`。

## 4. 数据流 / 控制流

### 4.1 输入

- 模型流式输出的 `tool_use` block(`{ id, name, input }`)
- ToolUseContext(由 query loop 构造,见 M02)
- canUseTool 函数(由 useCanUseTool hook 提供,见 M04)

### 4.2 输出

- `MessageUpdateLazy[]` 流(`{ message, contextModifier? }`)
  - tool_result block 包在 user message 里
  - PreToolUse / PostToolUse hook 的 attachment messages
  - 进度消息(progress message,id 关联到 toolUseID)
  - 上下文修改器(只对非并发工具生效)

### 4.3 关键时序

```
单个工具:
  tool_use block 完整 → addTool(StreamingToolExecutor)
                       │
                       └─[concurrency check]─→ executeTool
                            │
                            └─→ runToolUse → checkPermissionsAndCallTool (11 阶段)
                                 │
                                 ├─→ runPreToolUseHooks (流式)
                                 ├─→ resolveHookPermissionDecision
                                 ├─→ canUseTool / 直接 allow
                                 ├─→ tool.call() 
                                 ├─→ mapToolResultToToolResultBlockParam → addToolResult
                                 └─→ runPostToolUseHooks (or runPostToolUseFailureHooks on catch)
                                 
本轮所有工具:
  query loop ─→ for each tool_use block: streamingToolExecutor.addTool
              ├─→ getCompletedResults (sync) — 边收边送
              └─→ 模型 stream 结束后 getRemainingResults (async drain)
                   ↓
                   [所有 tool_result 收齐] → query 进入下一轮
```

### 4.4 异步 / 并发 / 取消

- **每个工具有自己的 child AbortController**(`createChildAbortController(siblingAbortController)`),`siblingAbortController` 又是 parent 的 child
- **三层 AbortController**:
  1. **parent**(query controller):整轮 query 取消
  2. **siblingAbortController**(StreamingToolExecutor):Bash 错误时杀兄弟,反向不冒泡到 parent
  3. **per-tool**(toolAbortController):允许子进程(Bash spawn)单独被 sibling 取消;**唯一例外**:permission dialog 拒绝触发的 abort 必须 **bubble 到 parent**(否则 ExitPlanMode 的 "clear context + auto" 会发 REJECT_MESSAGE 给模型而非结束 turn —— 见 #21056 regression 注释)
- **进度消息独立通道**:`tool.pendingProgress[]` + `progressAvailableResolve` 信号,不阻塞 await 完成结果

### 4.5 错误处理

| 错误类型 | 处理 |
|---|---|
| 工具不存在 | "No such tool available: X" 错误 tool_result + telemetry |
| Zod schema 错误 | InputValidationError + 可能附 schemaNotSentHint |
| validateInput 错误 | tool 自定义错误消息(常见:文件不存在、命令禁用) |
| PreToolUse hook 阻塞 | hook_blocking_error attachment + tool_result deny |
| 权限拒绝 | tool_result is_error + acceptFeedback / contentBlocks(图片) |
| tool.call 抛错 | catch:logError + classify + PostToolUseFailure hook + tool_result is_error |
| **AbortError**(sibling 取消) | 不打 logError(避免噪音),发 cancel 合成消息 |
| **MCP auth 错误** | catch 内特殊处理:把 mcp client 改成 'needs-auth' 状态(setAppState),供 /mcp 显示 |

## 5. 工程设计精髓

### 原则 1:Tool 接口是契约,buildTool 是默认值的"单一来源"

- **体现**:`Tool.ts:757-792` 的 `TOOL_DEFAULTS` 与 `buildTool`,在类型层用 spread 合并,在运行时用 object spread 合并
- **代表文件**:`Tool.ts:783 export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D>`
- **为什么重要**:60+ 个工具如果每个都 `?.() ?? defaultValue`,任何 default 改动都得动 60 处;统一在 `TOOL_DEFAULTS` 后,一次改即可
- **fail-closed 默认**:`isConcurrencySafe=false`、`isReadOnly=false`、`checkPermissions=allow`(注释明确说"defer to general permission system,具体工具的安全级别由 settings.json 与 hooks 控制")
- **类型层精妙**:`BuiltTool<D>` = `{ ...TOOL_DEFAULTS, ...def }` 的类型级镜像,以前用 `satisfies Tool` 时各种 0-arg vs N-arg 不兼容,改成精细的 `[K in DefaultableToolKeys]-?` 后类型完全严丝合缝
- **复用方式**:任何"接口宽 + 大量 optional 方法 + 安全默认"的注册表模式都可以照搬

### 原则 2:ToolUseContext 是"一个胶囊穿全栈"

- **体现**:`Tool.ts:158` 的 50+ 字段都在一个 type 里
- **为什么不拆**:
  - 拆开后 `tool.call(args, ctx1, ctx2, ctx3, ctx4)` 签名爆炸
  - **派生子上下文极为常见**:`{ ...ctx, abortController: childCtrl }` / `{ ...ctx, agentId, toolDecisions }`
  - 子代理只需覆盖 4-5 字段,胶囊化让"差分注入"成本最低
- **复用方式**:对任何"上下文需要传到调用栈深处的场景"(权限、abort signal、UI 钩子、统计累积)都用单一胶囊
- **代价**:类型变得很大,IDE 提示偶尔笨重;字段命名与归类要靠注释维护
- **关键约束**:**setAppState in async subagent is no-op**;**setAppStateForTasks** 是补丁;**localDenialTracking** 是给 detached subagent 的 in-mem 替代

### 原则 3:Tool 注册表用"条件 spread + 双 gate"分层加载

- **体现**:`tools.ts:194-251 getAllBaseTools()` 把所有工具放在一个数组字面量,用 `...(condition ? [tool] : [])` 拼装
- **三类 gate**:
  1. **`process.env.USER_TYPE === 'ant'`**:运行期变量,Anthropic 内部用户能看到的 ConfigTool / TungstenTool / SuggestBackgroundPRTool
  2. **`feature(...)`**:`bun:bundle` 编译期常量,死码消除(WORKFLOW_SCRIPTS / KAIROS / AGENT_TRIGGERS / OVERFLOW_TEST_TOOL …)
  3. **`isXxxEnabled()` 函数**:运行期布尔(`isTodoV2Enabled` / `isAgentSwarmsEnabled` / `isWorktreeModeEnabled` / `isPowerShellToolEnabled`)
- **为什么三类共存**:tree shake、运行期 gating、prefer-test-deterministically 的需求各自不同
- **代表文件**:`tools.ts:14-156`(全是条件 require + feature gate 的洗牌)
- **复用方式**:对复杂工具集,用 const 数组 + `...(cond ? [x] : [])` 远比 if/push 易读;但 `feature()` 必须留 inline,不能抽函数(否则 DCE 失效)

### 原则 4:多层过滤(getAllBaseTools → getTools → assembleToolPool)

- **getAllBaseTools()**:全集 + 编译期 gate
- **getTools(ctx)**:运行期过滤(deny rules + REPL hide + isEnabled)
- **assembleToolPool(ctx, mcp)**:built-in + MCP + 去重 + 分区排序
- **getMergedTools(ctx, mcp)**:不去重的合并(给 token counting 用)
- **filterToolsForAgent(tools, agentDef)**:子代理白名单/黑名单(在 AgentTool 内,见 M14)
- **复用方式**:每层一个明确目的,不要把"运行期过滤"和"提示拼装"耦合;给单元测试留足边界

### 原则 5:**hook allow 不能绕过 deny/ask 规则**

- **体现**:`toolHooks.ts:332-433 resolveHookPermissionDecision`
- **场景**:开发者写了个 PreToolUse hook 自动 allow Bash,但管理员在 enterprise managed settings 里 deny `Bash(rm *)`。如果 hook allow 直接返回,deny 就被绕过了
- **解法**:hook allow 仅意味着"跳过交互式 dialog",仍走 `checkRuleBasedPermissions` ; deny 命中仍 deny,ask 命中仍弹 dialog
- **为什么重要**:**安全不变量必须在协议层,不能让 hook 写错就开后门**
- **复用方式**:任何"hook 修改决策"机制必须设计层级:hook 可以在 default-deny 之上加 allow,**但不能 override 显式 deny**
- **代价**:多写一段集成测试

### 原则 6:**backfill 写入 clone,不污染 prompt cache 输入**

- **体现**:`toolExecution.ts:782-793 backfillObservableInput on shallow clone`
- **场景**:模型给的 `file_path: '~/foo'`,UI / hook 想看到 `/Users/X/foo`(展开 ~);但 prompt cache 必须看到模型原始字符串(否则 cache miss)
- **解法**:`backfilledClone = { ...processedInput }`; `tool.backfillObservableInput!(backfilledClone)`; `processedInput = backfilledClone`(给 hooks/canUseTool 用);`callInput = processedInput` 但只在 hook 没替换的时候才传 backfill
- **复用方式**:任何"模型输入"和"运行期需要的输入"不一致的场景,都不要 mutate 原始,做 clone
- **代价**:多一份对象;hook 替换 input 后的"重新挑选哪个 file_path"逻辑略复杂(`toolExecution.ts:1188-1205`)

### 原则 7:**速度敏感路径上,把分类器/验证 speculate 起来**

- **体现**:`toolExecution.ts:740-752 startSpeculativeClassifierCheck`,在 PreToolUse hook 还没跑完就触发 Bash classifier
- **效果**:permission decision 时刻 classifier 已经 ready 了,合并下来比串行快几百 ms
- **关键**:**UI 不在 speculation 时刻设 "Running classifier" 标志** —— 因为大部分情况(prefix rules auto-allow)classifier 根本不会用到结果,提前显示会 flash
- **复用方式**:任何"概率上需要的高耗时检查"都可以 speculate,但 UI 显示要 lazy
- **代价**:浪费的 CPU 周期(classifier 没用到时)

### 原则 8:**MessageUpdateLazy{message, contextModifier} 是统一返回单元**

- **体现**:`toolExecution.ts:264 type MessageUpdateLazy<M> = { message: M; contextModifier?: { toolUseID; modifyContext } }`
- **为什么不直接返回 message**:某些工具会"修改上下文"(如 `EnterPlanModeTool` 改 permission mode、`EnterWorktreeTool` 改 cwd) —— 如果返回 message,query loop 还得另外判断"这条 message 是否带 contextModifier";包成 lazy update 后,query loop 一致处理
- **「lazy」语义**:contextModifier 仅在工具不并发安全时才会被应用(`StreamingToolExecutor.ts:391-395`),并发安全工具的 contextModifier 暂不支持(注释明说)
- **复用方式**:任何"工具执行可能改全局/上下文"的体系,都用同样的 wrapper

### 原则 9:**StreamingToolExecutor 的 sibling abort 不冒泡到 parent**

- **体现**:`StreamingToolExecutor.ts:59 siblingAbortController = createChildAbortController(toolUseContext.abortController)`
- **直觉错误**:Bash 失败,我把整个 query.abort() 不就行了?**错** —— 那样 query loop 也终止,模型没法基于错误重试
- **正确**:siblingAbortController 是 parent 的 child,`abort('sibling_error')` 杀子,**parent 不动**
- **唯一例外**:用户中断(`signal.reason === 'interrupt'`)从 parent 发起,会自动级联到所有 child;**但** permission dialog 拒绝(`PermissionContext.cancelAndAbort`)发起的 abort 必须**反向冒泡**到 parent —— 否则 ExitPlanMode 的 "clear context + auto" 会发 REJECT_MESSAGE 给模型而非结束 turn(注释 mention #21056 regression)
- **实现细节**:`StreamingToolExecutor.ts:304-318` 给 `toolAbortController` 加 abort listener,如果 reason ≠ 'sibling_error' 且 parent 没 abort,反向 abort parent
- **复用方式**:任何"兄弟任务取消但不影响整体"的场景都需要 child controller 模式
- **教训**:三级 AbortController 不是过度设计,是真实需求

### 原则 10:**只 Bash 错误才 cancel sibling**

- **体现**:`StreamingToolExecutor.ts:359 if (tool.block.name === BASH_TOOL_NAME)`
- **为什么**:Bash 命令往往有隐式依赖链(`mkdir foo && cd foo`),前者失败后续没意义;但 Read / WebFetch / Glob 是独立的,一个失败不该让其他全废
- **复用方式**:任何"批量执行"系统都要分 isolated vs chained,默认 isolated 安全

### 原则 11:**delete 派生工具用 `aliases` + 兜底回退到 base tools**

- **体现**:`toolExecution.ts:344-356 if (!tool) { fallbackTool = findToolByName(getAllBaseTools(), toolName); if (alias matched) tool = fallbackTool }`
- **场景**:旧 transcript 里调用 `KillShell`,新版本里这个工具被重命名为 `TaskStop`,`aliases: ['KillShell']`
- **关键**:**只在 alias 命中**时回退,primary name 不命中就报错(避免静默 fallback 误用)
- **复用方式**:工具重命名都用 alias,旧 transcript / VCR fixture 可以无伤迁移

### 原则 12:**maxResultSizeChars + 持久化预览**

- **体现**:`toolExecution.ts:1411 await processPreMappedToolResultBlock(preMappedBlock, tool.name, tool.maxResultSizeChars)`
- **效果**:工具返回 100KB → 写入 disk,模型只看到 "Output too long, persisted at /tmp/X.txt (preview: <500 chars>)"
- **特殊值 Infinity**:Read 工具(`readonly maxResultSizeChars: Infinity` 注释:"Read 自身已经按 token / size 限制;再持久化就会 Read→file→Read 循环")
- **复用方式**:任何"工具输出可能很大且模型不需要全部"的场景都要这个机制(stat 的可选 LRU、grep 的全量结果)

### 原则 13:**telemetry 错误分类要承受 minify**

- **体现**:`toolExecution.ts:150 classifyToolError`
- **为什么**:`error.constructor.name` 在 minified bundle 里变成 `nJT` / `Chq` —— dashboard 上一片乱码
- **解法优先级**:`TelemetrySafeError.telemetryMessage` > Node fs `errno` 码 > `error.name`(构造时设的 stable 名) > `'Error'`
- **复用方式**:任何 production-minified Node CLI / agent 的 telemetry 都要这层映射 —— 否则你的 error dashboard 是猜测游戏

### 原则 14:**deferred 工具的"找不到 schema"路径必须给明确指引**

- **体现**:`toolExecution.ts:578 buildSchemaNotSentHint`
- **场景**:模型直接调了 `WebFetch` 但 ToolSearch 还没 select 它 → schema 不在 prompt → Zod 解析"expected array, got string"
- **错误反馈**:不只是丢 Zod 错误,还附:"Load the tool first: call ToolSearch with query 'select:WebFetch'"
- **可观察性**:同时打 `tengu_deferred_tool_schema_not_sent` event,知道这事发生频次
- **复用方式**:任何延迟加载的接口失败都要给恢复路径,不能只给低层错误

### 原则 15:**MCP 工具的 PostToolUse 可改 output**

- **体现**:`toolExecution.ts:1494 if ('updatedMCPToolOutput' in hookResult) toolOutput = hookResult.updatedMCPToolOutput`
- **场景**:MCP tool 返回的内容可能含敏感信息,hook 可以脱敏后再让模型看
- **顺序**:非 MCP 工具结果先发(1478),再跑 hook;**MCP 工具反过来** —— hook 跑完才发结果(1540),否则就没机会改
- **复用方式**:第三方插件的工具输出走 hook 改写是常见需求

### 原则 16:**用户中断行为分两类:cancel vs block**

- **体现**:`Tool.ts:416 interruptBehavior?(): 'cancel' | 'block'`(默认 block)
- **'cancel'**:用户按 Esc → 工具被 abort,result 是 REJECT_MESSAGE("User rejected edit")
- **'block'**:工具继续跑,用户消息排队;典型如 Bash 跑 `npm install` 中途用户输入,不应该取消(已经修改了 node_modules 半截)
- **`StreamingToolExecutor.ts:233-241 getToolInterruptBehavior`**:try/catch 包裹默认 block(避免工具实现 throw 让交互卡死)
- **REPL UI 联动**:`setHasInterruptibleToolInProgress` 信号告诉 input 区域"现在按 Esc 真的会取消"(只在所有正在跑的工具都 cancel 时才 true)
- **复用方式**:任何"长任务可中断"的 UI/agent,interruptBehavior 二态比 boolean 更精确

## 6. 错误处理与边界条件

### 6.1 工具不存在的兜底链

```
findToolByName(toolUseContext.options.tools, toolName)  ← 模型当前可见的
  ↓ 找不到
findToolByName(getAllBaseTools(), toolName)             ← 全集
  ↓ 命中且 aliases.includes(toolName)                   ← 必须是 alias 命中
回退使用,但日志记录 deprecated
  ↓ 否则
"No such tool available: X" 错误 tool_result
```

### 6.2 多级超时 / 慢节点告警

- **PreToolUse hooks > 2000ms**:debug 日志("Slow PreToolUse hooks: …") + getStatsStore observe
- **permission decision > 2000ms in auto mode**:debug 日志(default mode 不记 —— 包含人类思考时间)
- **PostToolUse hooks > 2000ms**:同 PreToolUse
- **Hook timing summary inline**:大于 500ms 的 PreToolUse/PostToolUse(USER_TYPE=ant only)在 transcript 内联展示

### 6.3 进度消息保活

`StreamingToolExecutor.getRemainingResults` 内部有个细节:即使所有工具都没完成,只要有任一工具 push 了进度消息,`progressAvailableResolve` 信号会 unblock `Promise.race`,让进度立刻流出去 —— 否则用户看不到 spinner 更新。

### 6.4 边界:streaming fallback / discard 后的合成错误

- 流式失败回退到非流式时,主循环调 `streamingToolExecutor.discard()`
- 已经在跑的工具继续跑(没 abort,因为 abort 会让进程态错乱),但 collect 的 result 不再被 yield
- **新提交的非流式响应** 会重新生成 tool_use,query loop 用 `yieldMissingToolResultBlocks`(M02 §3.3)给每个 dangling toolUseID 合成 "Streaming fallback" 错误,保证 API 看到完整的 tool_use/tool_result 配对

## 7. 可迁移设计清单

| 设计 | 适用场景 | 复用方式 | 风险 / 代价 |
|---|---|---|---|
| **buildTool 工厂 + 默认值表** | 大量插件/工具的注册表 | 单一 `DEFAULTS` 常量 + spread | 类型层 spread 较复杂 |
| **ToolUseContext 胶囊** | 上下文要传到调用栈深处 | 单一 type,差分派生 | 字段太多需注释维护 |
| **条件 spread 注册** | feature flag + USER_TYPE 多 gate | `[...(cond ? [x] : [])]` | feature() 必须 inline |
| **多层过滤(全集 → 运行期 → 拼装)** | tool / plugin / command 注册表 | 每层独立函数 | 接口要稳 |
| **hook allow 不绕过 deny/ask** | 任何 hook + 规则的安全系统 | 协议层守恒 | 需要专门测试 |
| **backfill 写入 clone** | 模型 input vs 运行期 input 分歧 | shallow clone 后 mutate | hook 替换后的"挑选"逻辑 |
| **speculative 检查 + lazy UI 标记** | 概率性高耗时检查 | early start + UI lazy display | 偶尔浪费 CPU |
| **MessageUpdateLazy 包装** | 工具可能改上下文 | `{ message, contextModifier? }` | concurrency-safe 工具不支持 modifier |
| **三级 AbortController** | 兄弟任务/独立子任务取消 | parent → sibling → per-tool,反向冒泡限定 | 设计微妙,要测试 |
| **isolated vs chained 错误传播** | 批量执行系统 | 只对显式 chained(如 Bash)取消兄弟 | 工具默认 isolated |
| **alias + 兜底回退** | 工具重命名 / API 兼容 | aliases 字段 + alias-only 回退 | 不能盲目兜底 |
| **maxResultSizeChars + 持久化预览** | 工具输出大 | `processToolResultBlock` 抽象 | Infinity 处理读类工具循环 |
| **classifyToolError(minify-safe)** | minified production bundle | error.name + errno 码 + telemetrySafe | 需要审错误分类完整性 |
| **deferred 工具的 schemaNotSentHint** | 任何延迟加载的接口 | 错误 + 恢复指引并发 | 要 telemetry 监控 hint 触发率 |
| **interruptBehavior cancel vs block** | 长任务的中断 UX | 默认 block,显式 cancel | 工具实现要谨慎选 |
| **partition + sort by name(分区缓存友好)** | 任何会进 prompt cache 的列表 | 内置和外部分区,各自字典序 | 需理解上游缓存策略 |

## 8. 待确认问题

1. **`tool.toAutoClassifierInput` 的具体 classifier 协议** —— 注释说"返回给 auto-mode security classifier 的 transcript",但 classifier 实际怎么调用、用哪个模型,要等 M04 看 `bashSecurity.ts` 与 `bashPermissions.ts`(后者 2621 行)
2. **`renderGroupedToolUse` 的触发条件** —— 注释说 "non-verbose mode only",在哪决定?Messages.tsx?(留到 M12)
3. **`isMcpTool / mcpInfo` 的具体生成路径** —— MCP 工具如何从 server 注册成 Tool 实例?(留到 M08)
4. **`backfillObservableInput` 在哪些工具实现** —— 仅 SendMessage 与文件类工具?(实现细节)
5. **`structured_output` 在 ToolResult 上如何被 SDK 消费** —— `addAttachmentMessage('structured_output', data)` 之后 stream 出去给谁?(M05/SDK)
6. **`maxResultSizeChars: Infinity` 之外的"无限制"工具** —— 除了 Read,还有哪些?(枚举)
7. **`coordinatorMode` 与 `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` 的关系** —— teammate 是 coordinator 的 worker?(M14)
8. **`startSpeculativeClassifierCheck` 的 Promise 化与生命周期** —— 多次调用同 command 是否 dedup?(`bashPermissions.ts`)

## 9. 模块关系图

```
┌─────────────────────────────────────────────────────────────────┐
│                          M02 query loop                         │
│  yields tool_use blocks → StreamingToolExecutor (this module)   │
└────────────┬───────────────────────────────────┬────────────────┘
             │                                   │
             │ addTool() per block               │ canUseTool fn
             ▼                                   │
┌─────────────────────────────────────────┐      │
│  StreamingToolExecutor                  │      │
│  • queue/execute by isConcurrencySafe   │      │
│  • siblingAbortController (Bash kill)   │      │
│  • discard / interruptBehavior          │      │
└────────────┬────────────────────────────┘      │
             │ runToolUse(block, ctx)            │
             ▼                                   │
┌─────────────────────────────────────────┐      │
│  toolExecution.ts                       │      │
│  • runToolUse → checkPermissionsAndCall │      │
│  • 11 阶段管线                          │◀─────┘
└──┬──────────────────────────────────────┘
   │
   ├─→ Tool.ts 接口(每个工具的 .call / .description / .renderXxx)
   ├─→ tools.ts 注册表(getTools / assembleToolPool)
   ├─→ toolHooks.ts(Pre/Post hook + resolveHookPermissionDecision)
   ├─→ toolOrchestration.ts(批 partitionToolCalls + serially/concurrently)
   ├─→ M04 useCanUseTool / permissions(canUseTool 函数提供方)
   ├─→ M07 具体工具实现(Bash/File/Glob/Grep…)
   ├─→ M08 MCP client(MCP tools 来源)
   ├─→ M14 AgentTool / runAgent(子代理工具过滤)
   └─→ M15 Skill/Plugin(SkillTool 派生工具)
```

---

**下一步:** M04 Permission & safety,聚焦 `useCanUseTool.tsx`、`bashSecurity.ts`、`bashPermissions.ts`、`utils/permissions/*` 与 `interactiveHandler.ts`,看权限决策的完整机制(规则匹配、classifier、permission mode、auto-mode 安全分级)。
