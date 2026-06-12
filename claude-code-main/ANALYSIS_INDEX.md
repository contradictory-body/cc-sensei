# Claude Code 源码工程分析索引

> 目标:系统性吸收 Claude Code 的工程设计精髓,用于指导自研 Agent 开发。
> 状态:活文档,随阅读推进持续更新。

---

## 0. 关键事实(对全局判断有用)

### 0.1 仓库元信息
- **来源**: 2026-03-31 通过 npm `.map` 文件泄露的 Anthropic Claude Code 源码
- **语言**: TypeScript (strict)
- **运行时**: Bun (`bun:bundle` 提供编译期 `feature()` flag,死码消除)
- **UI 渲染**: React + Ink(终端的 React) + 自研 ink 实现 (`src/ink/`)
- **CLI 解析**: Commander.js extra-typings
- **校验**: Zod v4
- **代码搜索**: ripgrep (通过 GrepTool)
- **协议**: MCP SDK, LSP
- **规模(本仓库实际可见)**: 1268 文件, ~318,361 行 TS/TSX (README 说 1900 文件 / 512K 行,差异为 utils/ 缺失)

### 0.2 重要差异:src/utils 未在本次泄露中
- 全仓库所有模块大量 `import from './utils/...'` 都指向不存在的目录
- 仅 `src/components/mcp/utils/` 1 个 utils 子目录存在
- 影响:配置(config.ts)、消息(messages.ts)、工具历史(fileHistory.ts)、权限(permissions/...)、设置(settings/...)等基础工具的具体实现不可见
- **分析策略**: 从导入语句推断 utils/ 提供的契约,不假设其内部实现

### 0.3 顶层结构(src/)
```
src/
├── main.tsx (4683 行)        # 主入口 - Commander.js + Ink 启动
├── QueryEngine.ts (1295 行)  # API 调用引擎(模型流式调用)
├── query.ts (1729 行)        # 多轮查询循环(主 Agent loop)
├── Tool.ts (792 行)          # Tool 接口与权限上下文类型
├── tools.ts (389 行)         # Tool 注册表
├── commands.ts (754 行)      # 斜杠命令注册表
├── context.ts                # 系统/用户上下文采集
├── cost-tracker.ts           # token / 成本统计
├── history.ts                # 输入历史
├── interactiveHelpers.tsx    # 渲染入口/启动屏幕
├── replLauncher.tsx          # REPL 启动
├── setup.ts                  # 进程级初始化
├── tasks.ts                  # 任务模型(顶层引用)
├── Task.ts                   # 任务类型
│
├── tools/         # 25+ 工具,每个一个目录
├── commands/      # ~80 斜杠命令
├── components/    # 144 Ink 组件
├── hooks/         # 85 React hooks
├── services/      # 21 子模块(api, mcp, oauth, lsp, compact...)
├── screens/       # Doctor/REPL/ResumeConversation 三大全屏
├── ink/           # 自研 Ink 实现(Yoga 布局/reconciler/screen)
├── bridge/        # IDE bridge & 远程会话
├── coordinator/   # 多 agent 协调
├── tasks/         # Task 实现(LocalAgent/RemoteAgent/Shell/Dream)
├── plugins/       # 插件系统
├── skills/        # Skill 系统
├── memdir/        # 持久记忆
├── keybindings/   # 键位绑定
├── state/         # 全局状态(AppState)
├── bootstrap/     # 启动期间持有的进程级状态
├── entrypoints/   # SDK / CLI 入口与控制 schema
├── cli/           # 非交互 CLI(--print 等)
├── constants/     # 提示词、字符、URL、错误码
├── context/       # React Context(notifications/modal/voice/stats)
├── schemas/       # Zod schemas
├── migrations/    # 配置迁移
├── outputStyles/  # 输出风格目录加载
├── remote/        # 远程会话管理
├── server/        # direct-connect 服务端
├── native-ts/     # 自研 Yoga 布局 + color-diff + file-index
├── moreright/     # "more right" 浮层(easter egg-ish)
├── buddy/         # 伙伴动画(easter egg)
├── assistant/     # Kairos(assistant 模式)
├── query/         # 查询配置/依赖/停止 hooks
└── ...
```

### 0.4 技术栈(从导入语句推断)

| 维度 | 技术/库 |
|---|---|
| Anthropic API | `@anthropic-ai/sdk` (含 beta messages, streaming) |
| MCP | `@modelcontextprotocol/sdk` |
| CLI | `@commander-js/extra-typings` |
| UI | 自研 `ink` (React + react-reconciler + Yoga 布局) |
| 异步流 | AsyncGenerator 大量使用 |
| 进程间 | 自研 bridge (`src/bridge/`)、WebSocket、SSE |
| OAuth | 自研 (`src/services/oauth/`) |
| Telemetry | OpenTelemetry + gRPC + datadog + 自研 firstPartyEventLogger |
| 特性开关 | GrowthBook + `bun:bundle` `feature()` |
| Auth | OAuth 2.0 / JWT / macOS Keychain |
| 配置校验 | Zod v4 |
| Lodash | lodash-es 大量子包 import (memoize/throttle/uniqBy/sumBy/...) |
| 自研 Yoga | `src/native-ts/yoga-layout/` (2578 行,纯 TS Yoga 重写) |

---

## 1. 文件规模 TOP 30(按行数)

| 行数 | 文件 | 推断职责 |
|---|---|---|
| 5594 | `cli/print.ts` | 非交互 CLI 模式(--print)的主流程 |
| 5005 | `screens/REPL.tsx` | 交互式 REPL 全屏 |
| 4683 | `main.tsx` | CLI 解析与启动 |
| 3419 | `services/api/claude.ts` | Anthropic API 调用封装 |
| 3348 | `services/mcp/client.ts` | MCP 客户端 |
| 3200 | `commands/insights.ts` | 使用洞察命令 |
| 2999 | `bridge/bridgeMain.ts` | Bridge 主循环(IDE 集成) |
| 2621 | `tools/BashTool/bashPermissions.ts` | Bash 权限规则 |
| 2592 | `tools/BashTool/bashSecurity.ts` | Bash 安全防护(命令分类) |
| 2578 | `native-ts/yoga-layout/index.ts` | 自研 Yoga 布局 |
| 2465 | `services/mcp/auth.ts` | MCP OAuth |
| 2406 | `bridge/replBridge.ts` | REPL ↔ Bridge 适配 |
| 2338 | `components/PromptInput/PromptInput.tsx` | 输入框 |
| 2214 | `commands/plugin/ManagePlugins.tsx` | 插件管理 UI |
| 2049 | `tools/PowerShellTool/pathValidation.ts` | 路径合法性校验 |
| 1990 | `tools/BashTool/readOnlyValidation.ts` | 只读模式校验 |
| 1889 | `entrypoints/sdk/coreSchemas.ts` | SDK 核心 Zod schema |
| 1823 | `tools/PowerShellTool/readOnlyValidation.ts` | PS 只读校验 |
| 1821 | `components/Settings/Config.tsx` | 配置 UI |
| 1758 | `bootstrap/state.ts` | 全局可变进程态 |
| 1745 | `services/tools/toolExecution.ts` | 单 tool 执行(yield 流) |
| 1729 | `query.ts` | 主 Agent loop |
| 1722 | `ink/ink.tsx` | Ink 渲染器主体 |
| 1705 | `services/compact/compact.ts` | 上下文压缩 |
| 1648 | `tools/PowerShellTool/powershellPermissions.ts` | PS 权限 |
| 1578 | `services/mcp/config.ts` | MCP 配置 |
| 1574 | `components/LogSelector.tsx` | 日志选择器 |
| 1486 | `ink/screen.ts` | 终端屏幕缓冲 |
| 1462 | `ink/render-node-to-output.ts` | DOM → 输出 |
| 1397 | `tools/AgentTool/AgentTool.tsx` | Sub-agent 工具 |

**观察**:
- 顶端是"必要的复杂度":CLI 主流程、Agent loop、API 客户端、IDE bridge
- 安全/权限相关代码(BashTool 仅安全相关 4600+ 行)是显著的复杂度池
- 输入(PromptInput) / 屏幕(REPL.tsx)的 UI 复杂度大头与流式渲染有关

---

## 2. 入口点识别

### 2.1 进程入口
- **`src/entrypoints/cli.tsx`**:实际 main 函数(动态 import 全部模块)
- **`src/entrypoints/init.ts`**:重启动逻辑、信号注册
- **`src/main.tsx`**:Commander.js 命令树定义、最终 `renderAndRun` 调用

### 2.2 启动期 side effect 的有意排序
`main.tsx` 顶部前 30 行强制按以下顺序触发副作用:
1. `profileCheckpoint('main_tsx_entry')` — 启动 profiler
2. `startMdmRawRead()` — 提前 fork 子进程读 MDM(并行)
3. `startKeychainPrefetch()` — 提前并行读 keychain(OAuth + legacy)

⇒ 设计意图:**用并行 IO 抵消启动期的同步导入开销**。
导入顺序 = 性能契约,这点会反复出现。

### 2.3 SDK 入口
- `src/entrypoints/sdk/coreSchemas.ts` (1889 行) — Anthropic 公开的 Agent SDK 的输入/输出/控制协议
- `src/entrypoints/sdk/controlSchemas.ts` — 控制协议
- `src/entrypoints/agentSdkTypes.ts` — SDK 共享类型

### 2.4 UI 入口
- `src/screens/REPL.tsx` — 交互式 TUI 主屏(5005 行)
- `src/cli/print.ts` — 非交互模式(5594 行)
- `src/replLauncher.tsx` — REPL 启动器
- `src/interactiveHelpers.tsx` — 启动屏 / setup 流程

### 2.5 Agent loop 入口
- **`src/query.ts`** (1729 行) — `query()` AsyncGenerator,核心多轮循环
- `src/QueryEngine.ts` (1295 行) — `QueryEngine` 类,持有运行时状态
- `src/services/api/claude.ts` (3419 行) — 模型 streaming API 调用
- `src/services/tools/toolOrchestration.ts` — `runTools` AsyncGenerator(并发分组)
- `src/services/tools/toolExecution.ts` (1745 行) — `runToolUse` 单工具执行

### 2.6 Tool 调用入口
- `src/Tool.ts` — `Tool` interface、`ToolUseContext`、`PermissionResult` 等
- `src/tools.ts` — `getTools()` 注册表
- `src/hooks/useCanUseTool.tsx` — 权限决策入口
- `src/hooks/toolPermission/handlers/*` — interactive / coordinator / swarm 三套

### 2.7 配置加载
- `src/utils/config.ts` (不可见,但是被广泛 import 的 `getGlobalConfig` 等)
- `src/utils/settings/*` (不可见)
- `src/utils/managedEnv.js` `applyConfigEnvironmentVariables`
- `src/migrations/*` 11 个迁移函数
- `src/services/remoteManagedSettings/` MDM 远程下发设置

### 2.8 Bridge 入口
- `src/bridge/bridgeMain.ts` — IDE 端长连接主循环
- `src/bridge/replBridge.ts` — REPL 对 bridge 的适配
- `src/hooks/useReplBridge.tsx` — REPL 内消费 bridge 的 hook

---

## 3. 初步模块地图(M-Map)

下面每条以 `Mxx` 编号,后续 MODULE_NOTES 文件名一一对应。

### M01 进程启动与生命周期
- 目录:`src/main.tsx`、`src/entrypoints/`、`src/bootstrap/state.ts`、`src/setup.ts`、`src/migrations/`
- 关键文件:`main.tsx`、`entrypoints/cli.tsx`、`entrypoints/init.ts`、`bootstrap/state.ts`、`setup.ts`
- 职责:CLI 解析 → init() → 设置屏幕(setup screens) → render REPL or print
- 后续重点:启动期并行预取的设计;feature flag DCE;migration 表
- 阅读顺序优先级:🥇

### M02 Agent 主循环
- 目录:根 `query.ts`、`QueryEngine.ts`、`query/`
- 关键文件:`query.ts`、`QueryEngine.ts`、`query/config.ts`、`query/deps.ts`、`query/stopHooks.ts`、`query/tokenBudget.ts`
- 职责:把"用户输入 → 模型流 → tool calls → 模型流 → 终止"做成 AsyncGenerator
- 后续重点:循环终止条件;stopHooks;token budget;auto-compact;reactive-compact
- 阅读顺序优先级:🥇

### M03 Tool 系统(类型与注册)
- 目录:根 `Tool.ts`、`tools.ts`、`tools/`(25 个)
- 关键文件:`Tool.ts`、`tools.ts`、`services/tools/toolExecution.ts`、`services/tools/toolOrchestration.ts`、`services/tools/StreamingToolExecutor.ts`、`services/tools/toolHooks.ts`
- 职责:Tool 接口契约、并发分组、执行流水线、结果回填
- 后续重点:`isConcurrencySafe`(只读并行);Generator-based tool API;contextModifier;resultBudget
- 阅读顺序优先级:🥇

### M04 权限与安全
- 目录:`src/hooks/useCanUseTool.tsx`、`src/hooks/toolPermission/`、`src/components/permissions/`、`src/tools/BashTool/bashPermissions.ts` `bashSecurity.ts`、`tools/PowerShellTool/*`
- 关键文件:`useCanUseTool.tsx`、`toolPermission/handlers/*`、`bashSecurity.ts`、`bashPermissions.ts`、`tools/BashTool/destructiveCommandWarning.ts`、`shouldUseSandbox.ts`、`commandSemantics.ts`
- 职责:permission mode、规则匹配、危险命令分类、沙箱抉择、UI 弹窗、ANT 内部 classifier
- 后续重点:三类 handler 分层(interactive/coordinator/swarm);speculative classifier;deny rules;auto mode
- 阅读顺序优先级:🥇

### M05 模型 API 与流式
- 目录:`src/services/api/`
- 关键文件:`services/api/claude.ts`(3419 行)、`client.ts`、`bootstrap.ts`、`errors.ts`、`withRetry.ts`、`logging.ts`、`promptCacheBreakDetection.ts`、`firstTokenDate.ts`、`overageCreditGrant.ts`、`grove.ts`、`usage.ts`
- 职责:统一前端 SDK,处理 retry、cache break、token usage、provider 选择
- 后续重点:retry 策略;prompt cache 命中检测;usage 累加;fallback model
- 阅读顺序优先级:🥈

### M06 上下文工程
- 目录:`src/context.ts`、`src/services/compact/`、`src/memdir/`、`src/utils/api/*`(不可见)、`src/utils/attachments.js`(不可见)
- 关键文件:`context.ts`、`services/compact/compact.ts` `autoCompact.ts` `microCompact.ts` `apiMicrocompact.ts` `postCompactCleanup.ts` `prompt.ts`、`memdir/memdir.ts`、`memdir/findRelevantMemories.ts`、`history.ts`
- 职责:系统 prompt 拼装、自动/反应式压缩、微压缩、记忆检索、消息标准化
- 后续重点:四种压缩(auto/micro/reactive/api micro);compact boundary 消息;memdir 检索算法
- 阅读顺序优先级:🥇

### M07 文件系统/Shell/Git
- 目录:`tools/FileReadTool/`、`tools/FileEditTool/`、`tools/FileWriteTool/`、`tools/BashTool/`、`tools/PowerShellTool/`、`tools/GlobTool/`、`tools/GrepTool/`、`tools/NotebookEditTool/`
- 关键文件:`FileEditTool.ts`、`FileReadTool.ts`、`BashTool.tsx`、`PowerShellTool.tsx`、`bashSecurity.ts`(命令分类)、`bashPermissions.ts`、`pathValidation.ts`、`readOnlyValidation.ts`、`destructiveCommandWarning.ts`、`sedEditParser.ts`、`commandSemantics.ts`、`shouldUseSandbox.ts`
- 职责:具体的文件/Shell 工具实现;命令语义解析;沙箱判断
- 后续重点:命令的 AST 级别解析与分类;只读路径推断;sed-as-edit 检测
- 阅读顺序优先级:🥈

### M08 MCP 与外部协议
- 目录:`src/services/mcp/`、`tools/MCPTool/`、`tools/McpAuthTool/`、`tools/ListMcpResourcesTool/`、`tools/ReadMcpResourceTool/`、`tools/ToolSearchTool/`
- 关键文件:`services/mcp/client.ts`、`config.ts`、`auth.ts`、`types.ts`、`officialRegistry.ts`、`MCPTool.ts`、`classifyForCollapse.ts`
- 职责:动态 tool 发现、stdio/SSE/HTTP transport、OAuth、ToolSearchTool 延迟加载
- 后续重点:**ToolSearchTool 延迟暴露 tools**(避免上下文爆炸)
- 阅读顺序优先级:🥈

### M09 LSP 集成
- 目录:`src/services/lsp/`、`tools/LSPTool/`
- 关键文件:`services/lsp/LSPClient.ts`、`LSPServerInstance.ts`、`LSPServerManager.ts`、`manager.ts`、`config.ts`、`passiveFeedback.ts`、`tools/LSPTool/LSPTool.ts`、`formatters.ts`
- 职责:LSP server 进程管理;诊断聚合;passive feedback
- 阅读顺序优先级:🥉

### M10 Bridge / IDE / 远程会话
- 目录:`src/bridge/`、`src/cli/transports/`、`src/remote/`、`src/server/`
- 关键文件:`bridge/bridgeMain.ts`、`replBridge.ts`、`bridgeMessaging.ts`、`bridgePermissionCallbacks.ts`、`jwtUtils.ts`、`sessionRunner.ts`、`createSession.ts`、`bridgeApi.ts`、`replBridgeTransport.ts`、`hooks/useReplBridge.tsx`、`remote/RemoteSessionManager.ts`、`remote/SessionsWebSocket.ts`、`server/directConnectManager.ts`
- 职责:JWT 认证 + WebSocket/HTTP 长轮询 + 消息路由 + 工作秘密(workSecret) + IDE 端 REPL 镜像
- 后续重点:bridge 协议帧;remote 与 main process 状态同步;permission 桥接
- 阅读顺序优先级:🥇

### M11 React/Ink UI 渲染
- 目录:`src/ink/`、`src/components/`、`src/hooks/`
- 关键文件:`ink/ink.tsx`、`reconciler.ts`、`renderer.ts`、`screen.ts`、`render-node-to-output.ts`、`render-to-screen.ts`、`render-border.ts`、`hit-test.ts`、`focus.ts`、`selection.ts`、`squash-text-nodes.ts`、`optimizer.ts`、`parse-keypress.ts`、`measure-text.ts`、`wrap-text.ts`、`native-ts/yoga-layout/index.ts`
- 职责:自研 Ink(替代 OSS Ink);流式 diff 输出;选区/超链接/键盘;Yoga 布局
- 后续重点:reconciler.ts;screen 双缓冲;hit-test;键盘解析(超长 ANSI 处理)
- 阅读顺序优先级:🥈

### M12 消息渲染(Messages/VirtualMessageList)
- 目录:`src/components/Messages.tsx`、`VirtualMessageList.tsx`、`MessageRow.tsx`、`MessageSelector.tsx`、`messageActions.ts`、`messages/`、`Markdown.tsx`、`StreamingMarkdown`
- 关键文件:`Messages.tsx`(147K 字节)、`VirtualMessageList.tsx`(149K 字节)、`MessageRow.tsx`、`Markdown.tsx`、`MessageSelector.tsx`、`hooks/useVirtualScroll.ts`
- 职责:大量消息的虚拟化、流式 markdown、tool 折叠、跳转锚点、选择高亮
- 后续重点:`useVirtualScroll`;`useSyncExternalStore`;collapse* utilities;sticky prompt
- 阅读顺序优先级:🥇

### M13 输入(Prompt/Typeahead/Vim)
- 目录:`src/components/PromptInput/`、`hooks/useTypeahead.tsx`、`hooks/useTextInput.ts`、`vim/`(待确认)、`hooks/useVimInput.ts`、`hooks/useArrowKeyHistory.tsx`、`hooks/useInputBuffer.ts`、`hooks/useCommandQueue.ts`、`hooks/useQueueProcessor.ts`、`hooks/usePasteHandler.ts`
- 关键文件:`PromptInput.tsx`(2338 行)、`useTypeahead.tsx`(212K 字节)、`useTextInput.ts`、`useVimInput.ts`
- 职责:命令提示;@ 提及;粘贴 image;斜杠命令;vim 模式
- 阅读顺序优先级:🥈

### M14 Sub-agents / 任务系统
- 目录:`src/tools/AgentTool/`、`src/tasks/`、`src/coordinator/`、`tools/SendMessageTool/`、`tools/TeamCreateTool/`、`tools/TeamDeleteTool/`、`tools/TaskCreateTool/`、`tools/TaskUpdateTool/`、`tools/TaskGetTool/`、`tools/TaskListTool/`、`tools/TaskOutputTool/`、`tools/TaskStopTool/`
- 关键文件:`AgentTool/AgentTool.tsx`(1397 行)、`forkSubagent.ts`、`runAgent.ts`、`resumeAgent.ts`、`agentMemory.ts`、`agentColorManager.ts`、`agentDisplay.ts`、`builtInAgents.ts`、`loadAgentsDir.ts`、`prompt.ts`、`tasks/LocalAgentTask/LocalAgentTask.tsx`、`RemoteAgentTask/RemoteAgentTask.tsx`、`LocalShellTask/LocalShellTask.tsx`、`InProcessTeammateTask/InProcessTeammateTask.tsx`、`DreamTask/DreamTask.ts`、`coordinator/coordinatorMode.ts`
- 职责:**异步 Sub-agent**(后台任务) + **同步 Sub-agent**(阻塞返回);TaskOutput 与 SendMessage;远程/本地任务;agent fork & resume
- 后续重点:任务状态机;agent 记忆持久化;tasks/types.ts
- 阅读顺序优先级:🥇

### M15 Skill / Plugin / Agent 定义
- 目录:`src/skills/`、`src/plugins/`、`tools/SkillTool/`、`commands/plugin/`
- 关键文件:`skills/loadSkillsDir.ts`、`bundledSkills.ts`、`mcpSkillBuilders.ts`、`plugins/builtinPlugins.ts`、`plugins/bundled/index.ts`、`tools/SkillTool/`、`commands/plugin/ManagePlugins.tsx`、`BrowseMarketplace.tsx`、`PluginSettings.tsx`、`ManageMarketplaces.tsx`、`services/plugins/PluginInstallationManager.ts`、`pluginCliCommands.ts`、`pluginOperations.ts`
- 职责:动态可加载用户/打包能力;市场;hooks/keybindings/agents/skills 注入
- 阅读顺序优先级:🥉

### M16 命令系统(slash)
- 目录:`src/commands.ts`、`src/commands/`(80+ 命令)、`src/cli/handlers/`
- 关键文件:`commands.ts`、`commands/createMovedToPluginCommand.ts`、若干代表性命令(`init.ts`、`compact/index`、`commit.ts`、`config/index`、`tasks/index`、`memory/index`、`resume/index`、`mcp/index`、`doctor/index`)
- 职责:统一抽象斜杠命令;动态 import;远程模式 filter
- 阅读顺序优先级:🥈

### M17 配置 / Settings / 迁移
- 目录:`src/migrations/`、`src/services/remoteManagedSettings/`、`src/services/policyLimits/`、`src/services/settingsSync/`、`src/schemas/`、`utils/settings/`(不可见)、`utils/config.ts`(不可见)
- 关键文件:`migrations/migrate*.ts`、`services/remoteManagedSettings/index.ts`、`syncCache.ts`、`syncCacheState.ts`、`services/policyLimits/index.ts`、`services/settingsSync/index.ts`、`schemas/hooks.ts`
- 职责:多源 settings 合并(MDM/远程/项目/全局);版本迁移;hook 配置 schema
- 阅读顺序优先级:🥉

### M18 Telemetry / Analytics / 日志
- 目录:`src/services/analytics/`、`src/cli/transports/`、`src/services/internalLogging.ts`、`utils/log.ts`(不可见)、`utils/debug.ts`(不可见)
- 关键文件:`analytics/index.ts`、`metadata.ts`、`growthbook.ts`、`firstPartyEventLogger.ts`、`firstPartyEventLoggingExporter.ts`、`datadog.ts`、`sink.ts`、`sinkKillswitch.ts`、`config.ts`(analytics)、`cli/transports/SerialBatchEventUploader.ts`、`HybridTransport.ts`、`SSETransport.ts`、`WebSocketTransport.ts`、`WorkerStateUploader.ts`
- 职责:埋点协议保密;feature flag 联动;批量上传;离线缓冲
- 阅读顺序优先级:🥉

### M19 状态管理(AppState / context)
- 目录:`src/state/`、`src/context/`、`src/bootstrap/state.ts`
- 关键文件:`state/AppState.tsx`、`AppStateStore.ts`、`onChangeAppState.ts`、`selectors.ts`、`store.ts`、`teammateViewHelpers.ts`、`bootstrap/state.ts`(1758 行)、`context/QueuedMessageContext.tsx`、`mailbox.tsx`、`modalContext.tsx`、`notifications.tsx`、`overlayContext.tsx`、`promptOverlayContext.tsx`、`stats.tsx`
- 职责:**进程级单例 state(bootstrap/state)** vs **React 渲染级 state(state/, context/)**;两层有意分离
- 后续重点:为什么允许"进程级可变 state";如何与 hooks 通信
- 阅读顺序优先级:🥈

### M20 键位 / Vim / 焦点
- 目录:`src/keybindings/`、`src/ink/focus.ts`、`hooks/useGlobalKeybindings.tsx`、`hooks/useKeybinding.ts`、`hooks/useVimInput.ts`、`hooks/useExitOnCtrlCD*.ts`、`hooks/useCommandKeybindings.tsx`
- 关键文件:`keybindings/KeybindingContext.tsx`、`KeybindingProviderSetup.tsx`、`defaultBindings.ts`、`loadUserBindings.ts`、`match.ts`、`parser.ts`、`reservedShortcuts.ts`、`resolver.ts`、`schema.ts`、`shortcutFormat.ts`、`template.ts`、`useKeybinding.ts`、`validate.ts`
- 职责:多层键位优先级;chord;reserved shortcuts;模板与冲突检测
- 阅读顺序优先级:🥉

### M21 Voice / Buddy / Easter Egg
- 目录:`src/buddy/`、`hooks/useVoice.ts`、`hooks/useVoiceIntegration.tsx`、`services/voice.ts`、`services/voiceStreamSTT.ts`、`services/voiceKeyterms.ts`、`commands/voice/`、`moreright/useMoreRight.tsx`
- 阅读顺序优先级:🥉

### M22 测试与可测性
- 当前未在仓库中找到 `*.test.ts` 文件(待确认是否被剥离)
- 但是看到许多 `__mocks__` 模式 / hookable 设计 / VCR 服务(`services/vcr.ts`)
- 阅读顺序优先级:🥉

---

## 4. 阅读计划与优先级

### 4.1 阶段 3 模块阅读顺序(从架构骨架到表层)

**第 1 批:架构骨架** 🥇
1. M01 进程启动与生命周期
2. M02 Agent 主循环
3. M03 Tool 系统
4. M04 权限与安全
5. M14 Sub-agents / 任务系统
6. M06 上下文工程

**第 2 批:外部能力与边界** 🥈
7. M05 模型 API
8. M07 文件/Shell/Git
9. M08 MCP
10. M19 状态管理

**第 3 批:UI 与交互** 🥈
11. M11 React/Ink 渲染
12. M12 消息渲染(对应阶段 4 大文件之一)
13. M13 输入

**第 4 批:集成与扩展** 🥈
14. M10 Bridge / IDE / 远程
15. M16 命令系统
16. M15 Skill / Plugin

**第 5 批:支撑层** 🥉
17. M09 LSP
18. M17 配置 / 迁移
19. M18 Telemetry
20. M20 键位
21. M21 Voice / Buddy
22. M22 测试

### 4.2 每模块共同分析问题
1. 这个模块解决什么工程问题?
2. 模块边界是什么?
3. 核心抽象是什么?
4. 数据如何流入、流出?
5. 错误如何处理?
6. 异步、并发、取消、重试如何设计?
7. 哪些设计值得我开发 Agent 时复用?
8. 哪些设计可能是历史包袱或复杂度代价?

---

## 5. 阶段 4 超大文件清单(实际验证后)

| 文件 | 行数 | 字节 | 重点观察方向 |
|---|---|---|---|
| `screens/REPL.tsx` | 5005 | 896K | TUI 主屏 - 状态机 / 模态 / 输入 / 渲染调度 |
| `main.tsx` | 4683 | 804K | 启动 - CLI 解析 / 并行 prefetch / 子命令 |
| `cli/print.ts` | 5594 | 213K | 非交互模式 - SDK message stream 协议 |
| `services/api/claude.ts` | 3419 | 126K | API 客户端 - retry / streaming / fallback |
| `bridge/bridgeMain.ts` | 2999 | n/a | Bridge 主循环 - JWT / pollConfig / 重连 |
| `components/Messages.tsx` | n/a | 147K | 消息列表渲染 - 折叠 / 反思 / 流式 |
| `components/VirtualMessageList.tsx` | n/a | 149K | 虚拟化 - useSyncExternalStore + scrollBox |
| `query.ts` | 1729 | 67K | Agent loop - generator / compact / hooks |
| `Tool.ts` | 792 | 29K | 工具契约 - PermissionContext / progress |

⇒ 阶段 4 选 4 个最具代表性:
- `main.tsx`(进程入口)
- `query.ts`(Agent loop) — 比 `QueryEngine.ts` 更接近循环本身
- `components/Messages.tsx`(消息渲染)
- `components/VirtualMessageList.tsx`(虚拟列表)
- `bridge/bridgeMain.ts`(IDE bridge,题目要求)
- `screens/REPL.tsx`(必读,虽不在题目要求,但代表 TUI 全屏)

---

## 6. 进度追踪表

| 模块 | 状态 | 已读关键文件 | 待读文件 | 初步结论 |
|---|---|---|---|---|
| Phase 1 全局侦察 | 完成 | README、Tool.ts header、main.tsx top、QueryEngine.ts top、query.ts top、tools.ts top、commands.ts top、context.ts top、setup.ts top、bootstrap/state.ts top、bridge/bridgeMain.ts top、ink.tsx top、claude.ts top、tool execution / orchestration top、useCanUseTool top、Messages.tsx top、VirtualMessageList.tsx top、REPL.tsx top、compact.ts top、mcp client top | — | 已建立模块地图与阅读计划 |
| M01 启动 | 完成 | main.tsx 关键区段, entrypoints/cli.tsx, bootstrap/state.ts, setup.ts, init.ts | - | 见 MODULE_NOTES/M01-bootstrap-lifecycle.md |
| M02 Agent loop | 完成 | query.ts 全局结构, QueryEngine.ts 关键区段 | - | 见 MODULE_NOTES/M02-agent-loop.md |
| M03 Tool 系统 | 完成 | Tool.ts, tools.ts, toolExecution.ts, toolOrchestration.ts, StreamingToolExecutor.ts, FileEditTool, FileReadTool, GrepTool | - | 见 MODULE_NOTES/M03-tool-system.md |
| M04 权限与安全 | ✅ 完成 | useCanUseTool.tsx, toolPermission/{PermissionContext,handlers/{interactive,coordinator,swarmWorker}Handler,permissionLogging}.ts, components/permissions/{PermissionRequest,PermissionPrompt,hooks}.tsx, bashPermissions.ts (1700+ 关键行), modeValidation, shouldUseSandbox, readOnlyValidation/checkReadOnlyConstraints, pathValidation/checkPathConstraints, TrustDialog 主流程, BypassPermissionsModeDialog | utils/permissions/* 缺失;bashSecurity.ts 全文未读;PowerShellTool 未读 | 见 MODULE_NOTES/M04-permission-safety.md |
| M05 Model API 客户端 | ✅ 完成 | services/api/claude.ts (全), withRetry.ts (全), errors.ts (1-1199), errorUtils.ts (全), promptCacheBreakDetection.ts (全), client.ts (全), bootstrap.ts (全), logging.ts (全), usage.ts (全), firstTokenDate.ts (全) | sessionIngress.ts (17K) / grove.ts / filesApi.ts 未读;utils/{auth,http,model,quota,telemetry,agentContext}.ts 不可见 | 见 MODULE_NOTES/M05-api-streaming.md |
| M06 上下文工程 | ✅ 完成 | services/compact/{compact, autoCompact, microCompact, sessionMemoryCompact}.ts, memdir/*, history.ts | apiMicrocompact / cachedMicrocompact / postCompactCleanup / prompt.ts 仅在交叉验证中扫到 | 见 MODULE_NOTES/M06-context-engineering.md |
| M07 文件/Shell/Git | ✅ 完成 | FileEditTool/FileReadTool/FileWriteTool/NotebookEditTool 主路径, GrepTool/GlobTool 全, BashTool (1700+ 关键行 across bashPermissions/bashSecurity/readOnlyValidation), PowerShellTool 全 (powershellPermissions/powershellSecurity/pathValidation/readOnlyValidation), commandSemantics, sedEditParser, destructiveCommandWarning, shouldUseSandbox | - | 见 MODULE_NOTES/M07-fs-shell-git.md (+ 人话版) |
| M08 MCP | ✅ 完成 | services/mcp/{client.ts (3348 行), auth.ts (2465 行), config.ts (1578 行), useManageMCPConnections.ts (1141 行), xaa.ts (511 行), xaaIdpLogin.ts (487 行), types.ts, officialRegistry.ts, gateChannelServer.ts, secureStorage.ts, oauthErrors.ts, connectionFactory.ts, elicitation.ts, claudeAiBackedServers.ts, pluginMcpServers.ts, cwdMcpAccess.ts}, MCPTool/{MCPTool.ts, prompt.ts, UI.tsx, classifyForCollapse.ts (604 行)}, McpAuthTool/McpAuthTool.ts, ListMcpResourcesTool/{prompt.ts, UI.tsx}, ReadMcpResourceTool/{prompt.ts, UI.tsx} | ToolSearchTool 未读;client.ts fetchToolsForClient 实现细节;cwdMcpAccess 与 TrustDialog 交叉验证 | 见 MODULE_NOTES/M08-mcp.md (+ 人话版) |
| M09 LSP | ✅ 完成 | services/lsp/{config.ts (79 全), manager.ts (289 全), LSPClient.ts (447 全), LSPServerManager.ts (420 全), LSPServerInstance.ts (511 全), LSPDiagnosticRegistry.ts (386 全), passiveFeedback.ts (328 全)}, tools/LSPTool/{LSPTool.ts (860 全), schemas.ts (215 全), formatters.ts (592 全), prompt.ts (22 全), UI.tsx (228 全), symbolContext.ts (90 全)}, components/LspRecommendation/LspRecommendationMenu.tsx (87 全), hooks/useLspPluginRecommendation.tsx (193 全), hooks/notifs/useLspInitializationNotification.tsx (142 全) | utils/plugins/lspPluginIntegration.ts (getPluginLspServers 来源)、services/lsp/types.ts (类型定义) 未找到 — 推断在 .d.ts 或 plugin 模块内部 | 见 MODULE_NOTES/M09-lsp.md (+ 人话版) |
| M10 Bridge / IDE / 远程 | ✅ 完成 | bridge/{bridgeMain.ts (2999 行), replBridge.ts (2406 行), bridgeApi.ts, jwtUtils.ts, sessionRunner.ts, replBridgeTransport.ts, remoteBridgeCore.ts, envLessBridgeConfig.ts, bridgeMessaging.ts, bridgePermissionCallbacks.ts, bridgePointer.ts, flushGate.ts, inboundAttachments.ts, inboundMessages.ts, bridgeStatusUtil.ts, bridgeUI.ts, types.ts, trustedDevice.ts, bridgeEnabled.ts, bridgeDebug.ts, debugUtils.ts, createSession.ts, cseShimGate.ts, archiveSession.ts 等 31 文件全}, remote/{RemoteSessionManager.ts, SessionsWebSocket.ts, sdkMessageAdapter.ts, remotePermissionBridge.ts}, server/{createDirectConnectSession.ts, directConnectManager.ts, types.ts} | - | 见 MODULE_NOTES/M10-bridge-ipc.md (+ 人话版) |
| M11 React/Ink 渲染 | ✅ 完成 | ink.tsx, reconciler.ts (全), dom.ts (全), screen.ts, render-node-to-output.ts, render-to-screen.ts, render-border.ts, renderer.ts, output.ts, optimizer.ts, searchHighlight.ts, squash-text-nodes.ts, log-update.ts, selection.ts, parse-keypress.ts, styles.ts, Ansi.tsx, terminal.ts, terminal-querier.ts, terminal-focus-state.ts, useTerminalNotification.ts, focus.ts, hit-test.ts, bidi.ts, colorize.ts, stringWidth.ts, wrap-text.ts, wrapAnsi.ts, widest-line.ts, measure-text.ts, measure-element.ts, get-max-width.ts, line-width-cache.ts, tabstops.ts, clearTerminal.ts, supports-hyperlinks.ts, node-cache.ts, instances.ts, constants.ts, root.ts, frame.ts, warn.ts, termio.ts (façade), components/* (18 files), hooks/* (12 files), layout/* (4 files), events/* (10 files), termio/* (9 files) | native-ts/yoga-layout/index.ts (2578 行) 仅通过 layout/yoga.ts adapter 旁观;大文件深入采样核心算法,未行级穷尽 | 见 MODULE_NOTES/M11-ink-rendering.md (+ 人话版) |
| M12 消息渲染 | ✅ 完成 | Messages.tsx (833 行 全), VirtualMessageList.tsx (1081 行 全), MessageRow.tsx (382 行 全), Markdown.tsx (235 行 全), messages/{AssistantTextMessage, AssistantToolUseMessage, GroupedToolUseContent, HookProgressMessage, UserToolResultMessage + utils, CollapsedReadSearchContent, AttachmentMessage} | MessageSelector.tsx (830 行), messageActions.tsx (449 行), useVirtualScroll.ts 实现细节未深读;messages/* 剩余子组件按相似模式推断 | 见 MODULE_NOTES/M12-message-rendering.md (+ 人话版) |
| M13 输入 | ✅ 完成 | PromptInput.tsx (2338 全), 13 个 sub-component 全 (Notifications 332/PromptInputFooter 191/PromptInputFooterLeftSide 87KB 全/PromptInputFooterSuggestions 34KB 全/PromptInputHelpMenu 33KB 全/ShimmeredInput 143/PromptInputQueuedCommands 117/VoiceIndicator 136/useSwarmBanner 156/PromptInputModeIndicator 92/SandboxPromptFooterHint 63/HistorySearchInput 51/PromptInputStashNotice 24/IssueFlagBanner 11), 9 个 hook (useTextInput, useInputBuffer, useArrowKeyHistory, useHistorySearch, useVimInput, usePasteHandler, usePromptSuggestion, useSearchInput, useShowFastIconHint) | utils.ts / inputModes.ts / inputPaste.ts / useMaybeTruncateInput.ts / usePromptInputPlaceholder.ts 已采样, 未行级穷尽 | 见 MODULE_NOTES/M13-input.md (+ 人话版) |
| M14 Sub-agents / 任务 | ✅ 完成 | AgentTool.tsx (1397 行 全), runAgent.ts (全), resumeAgent.ts (全), agentMemory.ts (全), agentColorManager.ts (全), agentDisplay.ts (全), builtInAgents.ts (全), loadAgentsDir.ts (全), prompt.ts (全), tasks/types.ts, LocalAgentTask.tsx (全), RemoteAgentTask.tsx (1-300), LocalShellTask.tsx (全), LocalMainSessionTask.ts (全), DreamTask.ts (全), InProcessTeammateTask.tsx (全), pillLabel.ts (全), guards.ts, killShellTasks.ts, coordinator/coordinatorMode.ts, SendMessageTool.tsx (全) | RemoteAgentTask 300-855, forkSubagent.ts, AgentTool/UI.tsx 待补 | 见 MODULE_NOTES/M14-subagent-tasks.md |
| M15 Skill / Plugin | ✅ 完成 | bundledSkills.ts (220 全), bundled/index.ts (79 全), mcpSkillBuilders.ts (44 全), builtinPlugins.ts (159 全), plugins/bundled/index.ts (23 全), loadSkillsDir.ts (1086 全), pluginOperations.ts (1088 全), PluginInstallationManager.ts (184 全), pluginCliCommands.ts (344 全), bundled/{loop.ts 92, remember.ts 82, batch.ts 124, skillify.ts 197}, SkillsMenu.tsx (236 全), SkillPermissionRequest.tsx (368 全), commands/{skills,plugin}/*.tsx | ManagePlugins.tsx (2214 行) + useManagePlugins.ts 未读;dump 缺 marketplaceManager/pluginLoader/installedPluginsManager/pluginInstallationHelpers/reconciler;其余 ~10 bundled skill 按模式推断 | 见 MODULE_NOTES/M15-skills-plugins.md (+ 人话版) |
| M16 命令系统 | ✅ 完成 | commands.ts (754 全), createMovedToPluginCommand.ts (65 全), version.ts, commit.ts (93 全), review.ts (58 全), help/index.ts + help.tsx, exit/index.ts, clear/{index.ts, clear.ts, conversation.ts (252 全)}, compact/{index.ts, compact.ts (288)}, model/index.ts, config/index.ts, init.ts (257 全), add-dir/index.ts, branch/index.ts, agents/index.ts, permissions/index.ts, advisor.ts (109 全), security-review.ts (244), login/index.ts, statusline.tsx, dialogLaunchers.tsx (80) | dump 缺 src/types/command.ts 与 src/utils/processUserInput/processUserInput.ts;commands/insights.ts (113KB)、install.tsx (39KB)、ultraplan.tsx (66KB)、interactiveHelpers.tsx (57KB) 未读 (不阻塞架构理解) | 见 MODULE_NOTES/M16-commands.md (+ 人话版) |
| M17 配置 / 迁移 | ✅ 完成 | migrations/{migrateAutoUpdatesToSettings, migrateBypassPermissionsAcceptedToSettings, migrateEnableAllProjectMcpServersToSettings, migrateFennecToOpus, migrateLegacyOpusToCurrent, migrateOpusToOpus1m, migrateReplBridgeEnabledToRemoteControlAtStartup, migrateSonnet1mToSonnet45, migrateSonnet45ToSonnet46, resetAutoModeOptInForDefaultOffer, resetProToOpusDefault} 全 11 个迁移, main.tsx:323-352 runMigrations + CURRENT_MIGRATION_VERSION=11, services/policyLimits/index.ts (664 全) + types.ts, services/remoteManagedSettings/{index.ts 639, syncCache.ts 113, syncCacheState.ts 97, securityCheck.tsx 74, types.ts 32} 全, services/settingsSync/{index.ts 582, types.ts 68} 全 | utils/settings/* (settings.ts, settingsCache.ts, changeDetector.ts, internalWrites.ts, applySettingsChange.ts, constants.ts, types.ts, lazySchema.ts), utils/config.ts, utils/auth.ts, components/ManagedSettingsSecurityDialog/*, utils/managedEnv.ts 均 dump 缺,从 use-site 推断契约 | 见 MODULE_NOTES/M17-config.md (+ 人话版) |
| M18 Telemetry / Analytics / Transports | ✅ 完成 | services/analytics/{index.ts 174, sink.ts 115, sinkKillswitch.ts 25, config.ts 38, datadog.ts 307, firstPartyEventLogger.ts 449, firstPartyEventLoggingExporter.ts 806, growthbook.ts 1155, metadata.ts 973} 全 9 文件, services/internalLogging.ts (90 全), cli/transports/{transportUtils.ts 45, WebSocketTransport.ts 800, HybridTransport.ts 282, SSETransport.ts 711, SerialBatchEventUploader.ts 275, WorkerStateUploader.ts 131, ccrClient.ts 998} 全 7 文件 | 共 17 文件 7372 行全读 | 见 MODULE_NOTES/M18-telemetry.md (+ 人话版) |
| M19 状态管理 | ✅ 完成 | state/{store.ts (34 全), AppState.tsx (199 全), AppStateStore.ts (569 全), onChangeAppState.ts (171 全), selectors.ts (76 全), teammateViewHelpers.ts (141 全)}, bootstrap/state.ts (1758 全), context/{mailbox.tsx, voice.tsx, notifications.tsx, overlayContext.tsx, promptOverlayContext.tsx, modalContext.tsx, stats.tsx, QueuedMessageContext.tsx, fpsMetrics.tsx} 9 个 provider 全 | utils/settings/applySettingsChange.ts / utils/sessionState.ts (notifyPermissionModeChanged/notifySessionMetadataChanged) / utils/permissions/PermissionMode.ts (toExternalPermissionMode) — dump 缺,从 use-site + 注释推断契约 | 见 MODULE_NOTES/M19-state.md (+ 人话版) |
| M20 键位 | 跳过 | - | - | - |
| M21 Voice/Buddy | 跳过 | - | - | - |
| M22 测试 | 跳过 | - | - | 仓库无测试文件,通过架构隔离推断可测性 |

---

## 7. 待确认问题

1. **utils/ 目录的具体结构**:无法直接读;阅读时通过 import 名拼出契约。
2. **是否有源码外的 binary/打包脚本**:仅 src/ 在仓库里,无 package.json / bunfig.toml。
3. **是否有 test 文件**:目前查找未见,可能与 utils/ 一同被剥离。
4. **`feature()` 内部实现**:`bun:bundle` 的 `feature` 是 Bun 编译期常量,运行时不可见。
5. **bashSecurity.ts 的具体分类规则**:文件非常大,需分块读。
6. **CLI handlers 与 main.tsx 的关系**:`cli/handlers/` 提供命令的非交互处理 ⇒ `main.tsx` 通过 Commander.js 路由
7. **tasks 子系统与 Sub-agent 的关系**:tasks/ 提供物理任务;AgentTool/ 提供 sub-agent 的 LLM 行为

---

## 8. 文档计划

| 文档 | 状态 | 路径 |
|---|---|---|
| 本索引 | ✅ 阶段 1+2 完成 | `ANALYSIS_INDEX.md` |
| 模块笔记 M01-M21 | 阶段 3 推进中 | `MODULE_NOTES/M*.md` |
| 大文件深入(4 个) | 阶段 4 待开始 | `MODULE_NOTES/big_*.md` |
| 交叉主题 | 阶段 5 待开始 | `MODULE_NOTES/cross_cutting_concerns.md` |
| 最终总结 | 阶段 6 待开始 | `CLAUDE_CODE_ENGINEERING_SUMMARY.md` |
