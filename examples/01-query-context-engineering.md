# Example 1 — Query: "How does Claude Code compact long conversations?"

> You are building an Agent and want to add context compaction. You ask `query_architecture` in natural language; Oracle resolves your intent to **M06 (Context Engineering)** and returns the design with directly-copyable patterns.

## Tool call

```json
{
  "tool": "query_architecture",
  "arguments": {
    "query": "how to compact long conversation history to avoid token limit",
    "depth": "standard"
  }
}
```

**Latency:** 146 ms · **Response size:** 46,054 chars (showing first 6,000 chars)

## Response

```
# M03: Tool 系统

## 1. 模块定位

负责把"模型输出的 `tool_use` block"变成"已渲染的、可被附加到对话历史里的 `tool_result` block"。覆盖:
- **静态层**:Tool 接口定义、buildTool 默认值、Tool 注册表(动态拼装)
- **执行层**:`runToolUse` 单工具完整生命周期(校验 → 钩子 → 权限 → 调用 → 结果映射 → PostHook)
- **编排层**:`StreamingToolExecutor`(流式期间一边收 tool_use 一边并发执行)、`toolOrchestration` 的并发批分区
- **横切**:子代理 disallow/allow 名单、ToolSearch 延迟加载、tool result 大小持久化

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
│10. mapToolResultToToolResultBlockParam → 写到 resu

…(output truncated for display; full response is returned to the LLM)
```
