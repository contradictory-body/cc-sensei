# M04 权限决策与安全(Permission & Safety)

> 范围:`src/hooks/useCanUseTool.tsx`、`src/hooks/toolPermission/{PermissionContext,handlers/*,permissionLogging}.ts`、`src/components/permissions/{PermissionRequest,PermissionPrompt,hooks}.tsx`、`src/components/{TrustDialog/*,BypassPermissionsModeDialog}.tsx`、`src/tools/BashTool/{bashPermissions,bashSecurity,readOnlyValidation,pathValidation,modeValidation,shouldUseSandbox,sedValidation}.ts`,以及 `commands/permissions/*`(允许规则编辑 UI)。
>
> ⚠️ **重大注意**:整个 `src/utils/` 目录在本次泄露中**完全缺失**。所有 `../../utils/permissions/*`、`../../utils/bash/*`、`../../utils/sandbox/*`、`../../utils/messages.js`、`../../utils/log.js`、`../../utils/errors.js`、`../../utils/cwd.js`、`../../utils/config.js`、`../../utils/settings/*` 等关键模块**只能从调用方推断行为**。具体缺失:`hasPermissionsToUseTool` / `checkRuleBasedPermissions` / `getDenyRuleForTool` / `PermissionResult.ts` / `PermissionUpdate.ts` / `PermissionRule.ts` / `bashClassifier.ts` / `permissionRuleParser.ts` / `permissions.ts` / `bash/{ast,commands,parser,shellQuote}.ts` / `sandbox/sandbox-adapter.ts` / `autoModeDenials.ts` / `classifierApprovals.ts`。下文标注 **(待确认)** 处即推断结论。

## 1. 模块定位

负责把"模型请求调用一个 tool"变成"yes/no/ask 的最终决策",并在 ask 路径下管理与用户、hook、classifier、bridge、channel 五方的并发对话。覆盖:
- **3 种决策流**:交互模式(主代理)、协调者模式(自动化前置检查)、Swarm worker(转发到 leader)
- **5 路 race**:user / hook / classifier / bridge (CCR/claude.ai) / channel (KAIROS Telegram/iMessage)
- **Bash 命令的多层规则匹配**:精确 / 前缀 / 通配符 / classifier 描述匹配 / 路径约束 / sed 约束 / 模式特殊处理 / read-only / sandbox auto-allow
- **AST 优先的命令解析**(tree-sitter):取代 regex-based 的合法性检查
- **Trust 对话框**:目录可信任前置门禁
- **Bypass 模式**:跳过权限提示的明确同意
- **Auto-mode 分类器**(待确认):基于 prompt 的 deny/ask/allow 描述匹配
- **Sandbox**:辅助一些命令在受限环境下自动 allow
- **Permission rule 编辑器** UI(`commands/permissions/`)

## 2. 关键文件

### 2.1 React 决策层

- `src/hooks/useCanUseTool.tsx` (203 行) ⭐⭐
  - **`CanUseToolFn`**:`(tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision?) => Promise<PermissionDecision<Input>>`
  - **`useCanUseTool`** hook:返回的 `canUseTool` 函数被 `runToolUse` 调用
  - 关键流程:先 `hasPermissionsToUseTool`(调用 utils,缺失);若 'ask',按顺序尝试 coordinator → swarm → speculative classifier → interactive dialog
  - **`forceDecision`** 旁路:由 ResumePermission(plan mode 退出后)快速恢复

- `src/hooks/toolPermission/PermissionContext.ts` (388 行) ⭐⭐
  - **`PermissionContext`**:**冻结的"决策上下文胶囊"** —— 在 `useCanUseTool` 入口构造,所有 handler 共享
  - 关键字段:`logDecision` / `runHooks` / `tryClassifier` / `buildAllow` / `buildDeny` / `cancelAndAbort` / `handleUserAllow` / `handleHookAllow` / `persistPermissions` / `queueOps`
  - **`createResolveOnce<T>()`**:返回 `{ resolve, isResolved, claim }` —— `claim()` 是**原子化"先 mark 再 do"**(关闭 isResolved + resolve 两步之间的并发窗口)
  - **`cancelAndAbort`**:返回 'ask' 决策,但只在 `isAbort || (!feedback && !contentBlocks?.length && !sub)` 时才真正 abort controller(避免误终止后续动作)

- `src/hooks/toolPermission/handlers/interactiveHandler.ts` (536 行) ⭐⭐⭐
  - **5 路 race**:user 输入(对话框)/ hook(异步 PreToolUseHook)/ classifier(2s speculative)/ bridge(CCR 远程批准)/ channel(IM 通知 + 回复)
  - **`GRACE_PERIOD_MS = 200`**:防止"用户刚开对话框还没反应过来,classifier 就把它撤掉"造成的 flicker —— classifier 决策需在 grace 后才生效
  - **Checkmark 显示**:终端聚焦显示 3000ms,失焦显示 1000ms,允许 Esc dismiss
  - **`bridgeCallbacks.{sendRequest,onResponse,cancelRequest}`**:跨进程批准
  - **Channel 通知**:`notification(CHANNEL_PERMISSION_REQUEST_METHOD)` 推到所有标签为 KAIROS_CHANNELS 的 MCP 客户端
  - **classifier auto-approve**:`setTimeout(... GRACE_PERIOD_MS)` 后 fire `checkmarkAbortHandler`

- `src/hooks/toolPermission/handlers/coordinatorHandler.ts` (65 行)
  - **协调者(coordinator)模式**:由 swarm leader 跑,**不能弹对话框**(用户不在那个会话里)
  - 顺序:`ctx.runHooks` → `ctx.tryClassifier` → fall through to dialog (实际不会到对话框,因为 coordinator 会有 fallback)

- `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts` (159 行)
  - **swarm worker → leader 转发**:`isAgentSwarmsEnabled() && isSwarmWorker()` 两个 gate 都成立才进入
  - **`sendPermissionRequestViaMailbox`** + **`registerPermissionCallback`** 把请求"邮箱化"传到 leader
  - **回调注册必须先于发送**:防止 leader 秒回但回调还没装上的 race
  - **`pendingWorkerRequest`** app state:UI 上显示"在等领导审批"指示器

- `src/hooks/toolPermission/permissionLogging.ts` (238 行)
  - **`PermissionApprovalSource`**:`'hook' | 'user' | 'classifier'` 判别联合
  - **`PermissionRejectionSource`**:`'hook' | 'user_abort' | 'user_reject'`
  - **`logApprovalEvent`** / **`logRejectionEvent`**:对应 5 个区分事件名:`tengu_tool_use_granted_in_config` / `_by_classifier` / `_in_prompt_permanent` / `_in_prompt_temporary` / `_by_permission_hook`
  - **`CODE_EDITING_TOOLS = ['Edit', 'Write', 'NotebookEdit']`**:特别的 OTel `code_editing.lines_added/removed` counter,带语言属性
  - **`toolUseContext.toolDecisions.set(toolUseID, {source, decision, timestamp})`**:跨 turn 持久(供后续工具看历史决策)

### 2.2 React UI 层

- `src/components/permissions/PermissionRequest.tsx` (216 行) ⭐
  - **`permissionComponentForTool`**:Tool name → React 组件的 switch
  - **14 个 per-tool dialog**:Bash / Edit / Write / NotebookEdit / FileRead / Glob / Grep / Agent / WebFetch / WebSearch / TodoWrite / NotebookRead / ExitPlanMode / SuggestBackgroundPR
  - **`FilesystemPermissionRequest`**:Read 类工具(Glob/Grep/FileRead)的统一对话框
  - **`FallbackPermissionRequest`**:其他/MCP 工具的兜底
  - **`ToolUseConfirm`** props:`{onUserInteraction, onAbort, onDismissCheckmark, onAllow, onReject, recheckPermission, ...}`
  - **`setStickyFooter`**:fullscreen 对话框(用于 ExitPlanModePermissionRequest)

- `src/components/permissions/PermissionPrompt.tsx` (335 行) ⭐
  - **共享 accept/reject + Tab 切换 feedback 输入**
  - **`DEFAULT_PLACEHOLDERS`**:`{accept: 'tell Claude what to do next', reject: 'tell Claude what to do differently'}`
  - **Tab 切换**:fire `tengu_accept/reject_feedback_mode_entered/collapsed/submitted` 事件
  - **`escapeCount`**:跟踪 Esc 按键次数,影响 `tengu_double_escape_pressed` attribution

- `src/components/permissions/hooks.ts` (209 行) ⭐
  - **`usePermissionRequestLogging`**:**用 `loggedToolUseID` ref 去重** —— 防止 React StrictMode 或 re-render 触发的反复 logEvent 造成 100% CPU + 500MB/min 内存泄漏(注释里明确提到这次事故)
  - **`decisionReasonToString`**:8 种 reason type:classifier / rule / mode / subcommandResults / permissionPromptTool / hook / workingDir / safetyCheck / other
  - **ant-only Bash 'ask' 特别打点**:`tengu_internal_tool_use_permission_request_no_always_allow` + `tengu_internal_bash_tool_use_permission_request`(带分割后的命令 —— 因为是 ant-only 才允许带 code/filepaths)

- `src/components/permissions/PermissionDialog.tsx`(待确认,从 import 推断):shared dialog frame
- `src/components/permissions/{ExitPlan,Bash,Edit,...}PermissionRequest.tsx`:14 个 per-tool 实现

### 2.3 Bash 工具规则栈(M04 的"重头戏")

- `src/tools/BashTool/bashPermissions.ts` (2621 行,98756 字节) ⭐⭐⭐
  - **`bashToolHasPermission(input, context)`** (line 1663-2557):**THE 主入口**(从缺失的 `hasPermissionsToUseTool` 透传)
    - 0. AST 解析:tree-sitter 三态 `parse-unavailable | simple | too-complex`
    - 1. shadow mode 记录(对比 tree-sitter vs splitCommand 的差异)
    - 2. `too-complex` → `checkEarlyExitDeny` → 否则 'ask' + pendingClassifierCheck
    - 3. `simple` + `checkSemantics` 失败 → `checkSemanticsDeny` → 否则 'ask'
    - 4. Sandbox auto-allow(若 `SandboxManager.isSandboxingEnabled()` && auto-allow enabled)
    - 5. 精确匹配 deny → 立即返回
    - 6. **deny + ask classifier 并行**(若 `isClassifierPermissionsEnabled()` 且非 auto 模式):各自 `classifyBashCommand(...)`,`Promise.all`,deny 优先
    - 7. **operator 检查**(管道、`&&`、`;`、`>`、`>>`)→ `checkCommandOperatorPermissions`
    - 8. 分割成 subcommand 数组(优先 AST,否则 `splitCommand_DEPRECATED`)
    - 9. **`MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50`** cap(超过则 'ask',防 REPL 100% CPU 卡死)
    - 10. 多个 cd → 'ask'
    - 11. **cd + git 复合 → 'ask'**(防 bare-repo RCE: `cd /evil/repo && git status` 触发 fsmonitor)
    - 12. 每个 subcommand 跑 `bashToolCheckPermission`(并行)
    - 13. 任一 subcommand 'deny' → 整体 'deny'
    - 14. 整命令上的 `checkPathConstraints`(redirections 单独验证)
    - 15. `askSubresult` + `nonAllowCount === 1` → 短路返回
    - 16. 全 allow + 无 injection → 'allow'
    - 17. 单 subcommand → `checkCommandAndSuggestRules`
    - 18. 多 subcommand:逐个跑 `checkCommandAndSuggestRules`,合并 `collectedRules`(去重 + cap MAX_SUGGESTED_RULES_FOR_COMPOUND=5)
    - **`pendingClassifierCheck`**:在 'ask'/'passthrough' 分支总是带上(用于 interactive 路径的 2s 速度跑)

  - **`bashToolCheckExactMatchPermission`** (line 991): exact-match deny/ask/allow 顺序
  - **`bashToolCheckPermission`** (line 1050): 单 subcommand 的层叠:exactMatch → prefix → path constraints → exactMatch allow → prefix allow → sed → mode → read-only → passthrough
  - **`checkCommandAndSuggestRules`** (line 1183): 加上 prefix 建议、command-injection check 的版本
  - **`stripSafeWrappers`** (line 524): 去 timeout/nice/nohup/stdbuf/time/comments,**两阶段**(先 env vars + 注释,后 wrappers + 注释)—— wrapper 后的 VAR=val 是 `execvp` 的参数不是 env var
  - **`stripWrappersFromArgv`** (line 678): argv 级别同步版本(KEEP IN SYNC 注释明确警告)
  - **`stripAllLeadingEnvVars`** (line 733): 用于 deny rule(更宽松,因为 deny 必须比 allow 更难绕过)
  - **`SAFE_ENV_VARS`** (line 378): 27 个仅可"控制行为不可执行代码"的 env var(NODE_ENV / RUST_LOG / LANG / TERM / TZ ...)
  - **`ANT_ONLY_SAFE_ENV_VARS`** (line 447): 只在 `USER_TYPE === 'ant'` 才放开的 27 个(KUBECONFIG / DOCKER_HOST / AWS_PROFILE / GH_TOKEN / PGPASSWORD ...)—— 注释明确说**绝不能 ship 给外部用户**
  - **`peekSpeculativeClassifierCheck` / `startSpeculativeClassifierCheck` / `consumeSpeculativeClassifierCheck` / `clearSpeculativeChecks`** (line 1483-1545):**预投机的 classifier 检查 Map**,在 hooks/setup 期就 fire,interactive 时 consume(节省 ~1s 等待时间)
  - **`awaitClassifierAutoApproval`** (line 1555):swarm 用 —— 先跑 classifier,只有 high-confidence 才转给 leader,否则不转(避免吵 leader)
  - **`executeAsyncClassifierCheck`** (line 1605):interactive 用 —— 在对话框已展示后 background 跑,callback `shouldContinue` + `onAllow` 实现"用户没动我就替他点 yes"
  - **`isNormalizedGitCommand`** / **`isNormalizedCdCommand`** / **`commandHasAnyCd`** (line 2567-2617):规范化检测(剥 wrapper 后再判断)
  - **`MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50`** (line 103):防御 ReDoS 类爆炸
  - **`MAX_SUGGESTED_RULES_FOR_COMPOUND = 5`** (line 110):UI 噪声 cap
  - **`BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/`** (line 708):严禁列入 SAFE_ENV_VARS

- `src/tools/BashTool/bashSecurity.ts` (2592 行,102561 字节) ⭐⭐
  - **`bashCommandIsSafeAsync_DEPRECATED`** / **`bashCommandIsSafe_DEPRECATED`**:legacy regex-based 安全检查(20+ patterns)
  - **`stripSafeHeredocSubstitutions`** (line 521):`$(cat <<'EOF'\n...\nEOF)` 这类安全 heredoc 不算 command substitution
  - **`hasSafeHeredocSubstitution`** (line 581)
  - 注释链注:legacy 路径只在 tree-sitter 不可用时进入;新路径(astResult.kind === 'simple' 或 'too-complex')完全跳过

- `src/tools/BashTool/pathValidation.ts` (1700+ 行,43679 字节) ⭐
  - **`checkPathConstraints`** (line 1013):入口,检查路径命令(cd/cp/mv/ls/cat/...)与 redirections(`>`、`>>`、`>|`、`&>`)
  - **`PATH_EXTRACTORS`** (line 190):每个路径命令的 argv → 路径列表的提取器(支持 mv 的 src/dst、cp 的多源、find 的 path arg、xargs 等)
  - **`COMMAND_OPERATION_TYPE`** (line 552):路径命令到操作类型(`read | write | search | other`)的 map
  - **`createPathChecker`** (line 703):工厂(`isAllowedPath` 闭包)
  - **过程替代检测**:`/>>\s*>\s*\(|>\s*>\s*\(|<\s*\(/`(tree-sitter 路径已经在 too-complex 阶段拦截)
  - **shell expansion in target**:`$VAR` / `%VAR%` → 'ask'(target 不可静态验证)
  - **`stripWrappersFromArgv`** (line 1263):**canonical 版本**(bashPermissions.ts 里有过时副本不能删,因 Bun feature() DCE 复杂度阈值)

- `src/tools/BashTool/readOnlyValidation.ts` (1990 行,68322 字节) ⭐
  - **`checkReadOnlyConstraints(input, compoundCommandHasCd)`** (line 1876):是否所有 subcommand 都是 read-only
  - **`isCommandSafeViaFlagParsing`** (line 1246):用 flag 解析 + 命令名查表确认是否只读
  - **多个安全 gate**:cd+git → not read-only;bare git repo cwd → not read-only;sandbox + cwd 漂移 → not read-only;git internal write → not read-only

- `src/tools/BashTool/modeValidation.ts` (116 行)
  - **`checkPermissionMode`** (line 72):仅 `acceptEdits` 模式下,`ACCEPT_EDITS_ALLOWED_COMMANDS = ['mkdir','touch','rm','rmdir','mv','cp','sed']` 自动 allow
  - bypassPermissions / dontAsk → passthrough(主流程兜底)

- `src/tools/BashTool/shouldUseSandbox.ts` (154 行)
  - **`shouldUseSandbox(input)`**:启用 sandbox 且未显式 disable 且非 excluded 时为 true
  - **`containsExcludedCommand`**:检查 `settings.sandbox.excludedCommands` —— 支持 `prefix` / `exact` / `wildcard` 三种规则,迭代 fixpoint(env 剥 + wrapper 剥的所有 candidate 都要试)
  - **`tengu_sandbox_disabled_commands`** GrowthBook 配置(ant only):动态命令/子串排除
  - **NOTE**:excludedCommands 不是安全边界,permission prompt 才是(注释明确说)

- `src/tools/BashTool/sedValidation.ts` (~300 行,21518 字节)
  - **`checkSedConstraints`**:专门给 sed 的 in-place(`-i`)模式做路径约束(防 `sed -i '' /etc/passwd`)

- `src/tools/BashTool/bashCommandHelpers.ts` (~250 行,8589 字节)
  - **`checkCommandOperatorPermissions`**:管道 `|`、`&&`、`||`、`;` 等"非 subcommand 算子"的处理(每段递归调 bashToolHasPermission)

- `src/tools/BashTool/destructiveCommandWarning.ts` (~100 行,2935 字节)
  - 红色警告 banner 的内容生成(rm -rf 等)

### 2.4 PowerShell 工具栈

- `src/tools/PowerShellTool/powershellPermissions.ts` (1648 行)
- `src/tools/PowerShellTool/pathValidation.ts` (2049 行)
- `src/tools/PowerShellTool/readOnlyValidation.ts` (1823 行)
- 与 Bash 几乎对称,但增加 Windows 特定路径规范化(`windowsPathToPosixPath`)、UNC 路径检测、PowerShell cmdlet 与 alias 表

### 2.5 Trust / Bypass 启动期对话框

- `src/components/TrustDialog/TrustDialog.tsx` (1065 行,32481 字节) ⭐
  - 列出当前 cwd 配置中所有"危险能力"来源:bash 权限规则、hooks、MCP servers、apiKeyHelper、awsAuthRefresh、gcpAuthRefresh、otelHeadersHelper、dangerous env vars、slash command bash 调用、skills bash 调用
  - 选项 onChange:
    - `'exit'` → `gracefulShutdownSync(1)`
    - `homedir() === getCwd()` → `setSessionTrustAccepted(true)`(仅本会话信任 home 目录,不持久化)
    - 否则 → `saveCurrentProjectConfig({hasTrustDialogAccepted: true})`(持久化到 `.claude/`)
  - 用 React Compiler 编译过(可见 `_c` cache 调用)

- `src/components/TrustDialog/utils.ts` (208 行)
  - 7 个 `getXxxSources()` 探测器(hooks / bashPermission / apiKeyHelper / awsCommands / gcpCommands / otelHeadersHelper / dangerousEnvVars)
  - **`hasDangerousEnvVars`**:`Object.keys(env).some(key => !SAFE_ENV_VARS.has(key.toUpperCase()))` —— 任何不在 SAFE_ENV_VARS(在 utils/managedEnvConstants.js 里,缺失)中的 key

- `src/components/BypassPermissionsModeDialog.tsx` (87 行)
  - 选项 `'accept'` → `updateSettingsForSource('userSettings', {skipDangerousModePermissionPrompt: true})` + `onAccept()`
  - 选项 `'decline'` / Esc → `gracefulShutdownSync(1)` / `gracefulShutdownSync(0)`
  - 标题:"WARNING: Claude Code running in Bypass Permissions mode" 红色 dialog
  - logEvent:`tengu_bypass_permissions_mode_dialog_{shown,accept}`

### 2.6 命令型 UI(权限规则编辑器)

- `src/commands/permissions/*`(从 import 推断):用户 UI 编辑 allow/deny/ask 规则,类型 `PermissionUpdate`(在缺失的 PermissionUpdate.ts)

## 3. 核心抽象

### 3.1 三层决策(由 useCanUseTool 派发)

```
useCanUseTool(tool, input, ctx, msg, toolUseID, forceDecision?)
   │
   ├── hasPermissionsToUseTool(...)      ← utils 缺失,推断:rule + auto-mode + tool-specific check
   │     → 'allow' / 'deny' / 'ask'
   │
   ├── if 'allow' or 'deny': return early (logged via permissionLogging)
   │
   └── if 'ask':
         ├── coordinatorHandler  ← swarm leader / coordinator 进程
         │      runHooks → tryClassifier → null (no dialog)
         │
         ├── swarmWorkerHandler  ← swarm worker 进程
         │      mailbox forward → leader → callback resolve
         │
         └── interactiveHandler  ← 主代理(默认)
                5-way race:
                  (a) user: dialog (Yes / Yes don't ask / No / Tab feedback)
                  (b) hook: PreToolUseHook("allow"/"deny" decision)
                  (c) classifier: 2s speculative auto-approve (BASH_CLASSIFIER)
                  (d) bridge: claude.ai / CCR remote approval
                  (e) channel: KAIROS Telegram/iMessage relay
```

### 3.2 PermissionContext 与 ResolveOnce.claim() 原子守护

```ts
// 文件:hooks/toolPermission/PermissionContext.ts
function createResolveOnce<T>() {
  let resolved = false
  let resolver: (v: T) => void
  const promise = new Promise<T>((r) => (resolver = r))
  return {
    resolve: (v: T) => { if (!resolved) { resolved = true; resolver(v) } },
    isResolved: () => resolved,
    // claim() 是原子的"先 mark 再让 caller 异步做事":
    // - 如果还没 resolved,标记为 resolved,返回 true
    // - 否则返回 false
    // 这样并发的 racer 都跑 if (!claim()) return; 就只有一个能进入临界区
    claim: () => { if (resolved) return false; resolved = true; return true }
  }
}
```

**为什么不用普通 `isResolved + resolve`?** 因为 5 个 racer 都做:
```ts
// 危险:check 和 resolve 之间有 await,期间另一个 racer 可能也通过了 check
if (!gate.isResolved()) {
  await someAsyncWork()
  gate.resolve(...)  // 第二个 racer 也到这里 → 状态污染
}
```
`claim()` 把 check + mark 合一,只有一个能进:
```ts
// 安全:claim 一旦返回 true,后续全部异步动作都"独占"
if (!gate.claim()) return
await someAsyncWork()
gate.resolve(...)  // 不会被其他 racer 覆盖
```

### 3.3 Speculative Classifier:跨边界的并行(节省 ~1s)

```
       T=0ms                    T=200~500ms            T=2000ms
hooks   ├──────hook ABC ────────┤
classifier ├── speculative classifier (in parallel) ──┤   stored in Map
                                                       │
T=250ms (hooks done) ─────────────────────────────────►├──── interactive renders dialog
                                                                  │
                                            ▲                     │
                                            │  consume(command) ◄─┘
                                            │  (already done!)
```

**关键 API**:
- `startSpeculativeClassifierCheck(command, ctx, signal, isNonInteractive)` — 在 hooks 之前 fire,Map 暂存 promise
- `peekSpeculativeClassifierCheck(command)` — 检查是否存在(不消费)
- `consumeSpeculativeClassifierCheck(command)` — 取出并删除
- `clearSpeculativeChecks()` — 全清

**意图**:在 React 还没渲染对话框、hooks 还在跑的时候,allow classifier 已经开始算了。等真要决策时,要么已经返回(直接拿结果),要么至少进度过半。

### 3.4 BashTool 的"AST 三态"分支(tree-sitter rollout)

```
parseCommandRaw(cmd)  ← tree-sitter WASM(可能未加载)
   │
   ▼
parseForSecurityFromAst → ParseForSecurityResult
   ├── 'parse-unavailable' → 走 legacy splitCommand + bashCommandIsSafe_DEPRECATED
   │                        (regex-based,有已知 bug 但被多年加固)
   │
   ├── 'too-complex'  → checkEarlyExitDeny → 否则 'ask' + classifier
   │   (含 process substitution、command substitution、控制流、parser 差异)
   │
   └── 'simple' → SimpleCommand[]
                  ├── checkSemantics 失败(zsh builtins、eval) → checkSemanticsDeny → 'ask'
                  └── checkSemantics ok:
                        - astSubcommands = c.text 数组
                        - astRedirects = c.redirects 平展
                        - astCommands = SimpleCommand[](原始)
                        → 进入主流程,但跳过 legacy gate
```

**Shadow mode**(`feature('TREE_SITTER_BASH_SHADOW')`):tree-sitter 跑了,但**强制丢弃结果**(`astResult = { kind: 'parse-unavailable' }`),只 logEvent `tengu_tree_sitter_shadow` 记录差异。这是把"风险大且无回滚"的解析器替换转为"先观察一周再切换"的安全 rollout。

### 3.5 BashTool 的命令规范化策略(env vars + wrappers)

```
原始:    NO_COLOR=1 timeout 5 nice -n 10 docker ps -a
                         ↓ stripSafeWrappers
allow check 用:           docker ps -a              (匹配 Bash(docker ps:*))

deny check 用:    stripAllLeadingEnvVars(原始)
              =   timeout 5 nice -n 10 docker ps -a   (env 全剥,wrapper 不剥)
              这样 deny rule 更难绕过(攻击者塞 timeout 不能跳过 deny)
```

**为什么 allow 用窄规则、deny 用宽规则?** **不对称失败模式**:
- allow 错放 → 安全事故(执行了不该执行的)
- deny 错过 → 安全事故(没拦住)

两边都是"宁严勿松"的方向但具体规则不同:
- allow 仅剥**白名单**内的 env / wrapper(防 `DOCKER_HOST=evil docker ps` 自动批)
- deny 剥**所有**安全 env(防 `FOO=bar denied_cmd` 绕过)

### 3.6 BashTool 的多层"加固关卡"(从松到紧)

| 关卡 | 触发 | 行为 |
|------|------|------|
| Process substitution | `>(...)` / `<(...)` | 'ask'(不可静态分析) |
| Shell 扩展 in redirect | `> $TARGET` | 'ask' |
| 多个 cd | 任意输入 `cd` 出现 ≥ 2 次 | 'ask' |
| cd + git 复合 | cd 与 git 都在子命令中 | 'ask'(防 bare-repo RCE) |
| bare git repo cwd | cwd 看着像 .git 内容 | not read-only |
| Sandbox + cwd 漂移 | sandbox enabled 且 getCwd ≠ getOriginalCwd | not read-only(竞态保护) |
| Subcommand 数量 > 50 | splitCommand fanout 爆炸 | 'ask'(REPL 100% CPU 防御) |
| AST too-complex | command/process substitution 等 | 'ask' + classifier |

### 3.7 Permission Decision Reason 类型(8 种)

```ts
// 推断自缺失的 PermissionResult.ts,从 callers 还原
type PermissionDecisionReason =
  | { type: 'classifier'; classifier: 'bash_allow' | 'bash_ask' | 'bash_deny'; reason: string }
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'mode'; mode: 'acceptEdits' | 'auto' | 'bypassPermissions' | ... }
  | { type: 'subcommandResults'; reasons: Map<string, PermissionResult> }
  | { type: 'permissionPromptTool' }   // 用户 ApprovedTool
  | { type: 'hook' }                    // PreToolUseHook
  | { type: 'workingDir' }              // path constraint 来源
  | { type: 'safetyCheck' }             // bashCommandIsSafe 等
  | { type: 'other'; reason: string }
```

### 3.8 Channel 通知格式(KAIROS_CHANNELS)

`interactiveHandler.ts` 中:
```
notification(CHANNEL_PERMISSION_REQUEST_METHOD, {
  toolName, toolInput, ...
})
```
派发到所有 tag 含 `KAIROS` / `KAIROS_CHANNELS` 的 MCP client。MCP server 端各自把 payload 渲染成各平台格式(Telegram inline keyboard / iMessage 短信)。

### 3.9 Bun feature() DCE 复杂度阈值(ENGINEERING TRAP)

`bashToolHasPermission` **正好顶在 Bun feature() 评估器的复杂度预算上限**:
```ts
// bashPermissions.ts:81-89 注释:
// DCE cliff: Bun's feature() evaluator has a per-function complexity budget.
// bashToolHasPermission is right at the limit. `import { X as Y }` aliases
// inside the import block count toward this budget; when they push it over
// the threshold Bun can no longer prove feature('BASH_CLASSIFIER') is a
// constant and silently evaluates the ternaries to `false`, dropping every
// pendingClassifierCheck spread.
const bashCommandIsSafeAsync = bashCommandIsSafeAsync_DEPRECATED
const splitCommand = splitCommand_DEPRECATED
```
导致一系列防御:
- 重命名 import 必须用 **顶层 const rebinding**(不是 `import { X as Y }`)
- 提取 `checkEarlyExitDeny` / `checkSemanticsDeny` / `skipTimeoutFlags` 到独立函数(不能 inline)
- `pathValidation.ts:1262` 注释:bashPermissions.ts 里的 `stripWrappersFromArgv` 是死代码但**不能删**(删了 ~80 行就会 silently 让 `feature('BASH_CLASSIFIER')` 评估为 false,30/30 测试 → 22/30 失败)

**这是一个非常稀有的"工具链限制反向塑造代码结构"的实例**。

## 4. 数据流 / 控制流

### 4.1 输入

- 模型的 `tool_use` block(name + input + id)
- 历史 `toolUseContext.toolDecisions`(影响 dedupe)
- 当前会话状态 `appState.toolPermissionContext`(rules + mode + approvedDirectories)
- 模型 prompt 中的 allow/deny/ask 描述(ant only,passed to classifier)
- Hook 输出(`runPreToolUseHooks` 结果)
- Speculative classifier Map(命令级缓存)

### 4.2 输出

- `PermissionDecision<Input>`:`{ behavior, updatedInput?, decisionReason, suggestions? }`
- 副作用:
  - logEvent(`tengu_tool_use_*`)
  - OTel `code_editing.lines_*` counter(Edit/Write/NotebookEdit)
  - `toolUseContext.toolDecisions.set(toolUseID, ...)`
  - `appState.pendingWorkerRequest` set/clear(swarm worker UI)
  - bridge response forwarded
  - channel notification fired

### 4.3 关键时序(interactive 流)

```
T=0     useCanUseTool 入口,构造 PermissionContext + gate
T=0+δ   hasPermissionsToUseTool 调用(纯同步规则匹配 + 异步 classifier)
T=ε     若 ask:startSpeculativeClassifierCheck(允许并行)
T=ε     React 渲染 PermissionRequest → PermissionDialog
T=200   GRACE_PERIOD_MS:classifier 可以开始"打勾"(避免 flicker)
T=ε..2s 用户 / hook / classifier / bridge / channel 五方race
T=结果  gate.claim() 决出唯一胜者:
        ├── user accept   → 'allow' + sticky rule? log granted_in_prompt
        ├── user reject   → 'deny' + feedback log rejected_in_prompt
        ├── hook allow    → 仍走 checkRuleBasedPermissions
        ├── hook deny     → 'deny' immediately
        ├── classifier high → 'allow' + log granted_by_classifier
        └── bridge / channel → 透传响应
T=结果+ 显示 checkmark(终端聚焦 3000ms,失焦 1000ms)
T=结果+ logApprovalEvent / logRejectionEvent
T=结果+ persistPermissions("Yes don't ask" 路径写规则)
T=结果+ unmount dialog
```

### 4.4 异步 / 并发 / 取消

- **`AbortSignal`** 贯穿:context.abortController.signal
- **5 路 race** 共享 `controller`,任何一方 abort 其他方都收到
- **`cancelAndAbort`** 不**总是** abort:只在 (`isAbort` || (没 feedback && 没 contentBlocks && 不是 sub)) 时
- **classifier abort**:`APIUserAbortError` / `AbortError` 被 catch 并 callback.onComplete(不上抛)

### 4.5 错误处理

- `bashCommandIsSafeAsync` throw → 转 'ask' with safetyCheck reason
- tree-sitter parse 超时 → fail-closed 到 'too-complex' → 'ask'
- classifier API 失败 → 不阻塞,fall through to dialog
- hook 写错(返回非法格式) → toolHooks.ts 转 'ask',不 crash

## 5. 工程设计精髓

### 原则 1:权限决策必须有"3 种角色 × 5 路 race"的清晰拓扑

- **体现**:interactive vs coordinator vs swarmWorker 三 handler;每 handler 在自己的语义里 race
- **代表文件**:`hooks/toolPermission/handlers/{interactive,coordinator,swarmWorker}Handler.ts`
- **为什么重要**:Agent 系统会有"主代理 + 后台代理 + 子代理 + 远程批准"四种身份,每种身份的"权限对话"可能性不一样。如果都塞进一个对话框,后台代理触发的对话会卡住主代理 UI。Claude Code 的拆分恰好对应这四种:
  1. interactive = 主代理(用户在场)
  2. coordinator = swarm leader(没用户对话框)
  3. swarmWorker = swarm worker(转发给 leader)
  4. (隐含) async/headless = 'ask' 强制 deny(`isNonInteractiveSession`)
- **复用方式**:自研 Agent 把"决策时的角色"作为 ctx 字段,handler 多分支
- **代价**:测试矩阵爆炸(每路 race × 每种角色 × 每种工具)

### 原则 2:gate 的原子化用 `claim()`,不是 `isResolved + resolve`

- **体现**:`createResolveOnce` 的三段返回 `{ resolve, isResolved, claim }`,所有并发 racer 用 `claim`
- **代表文件**:`hooks/toolPermission/PermissionContext.ts`
- **为什么重要**:`if (!isResolved()) { await ...; resolve(...) }` 在 await 间存在窗口期。如果两个 racer 都通过 isResolved → 都 await → 都 resolve,只有一个真生效但两边的副作用都跑完了(可能多发了 telemetry / 多写了规则)
- **复用方式**:任何"first wins" 并发都用 claim 模式
- **代价**:必须教育每个 callsite 用 claim(代码审查痛点)

### 原则 3:Hook "allow" 不能绕过 settings.json 的 deny/ask

- **体现**:`toolHooks.ts:resolveHookPermissionDecision` —— hook 决策为 allow 仍要走 `checkRuleBasedPermissions`,只有在该函数也允许时才真允许
- **代表文件**:`src/services/tools/toolHooks.ts:resolveHookPermissionDecision`
- **为什么重要**:Hook 是用户配置的 npm 脚本,**信任级别低于 settings.json**(后者要 trust dialog)。用户不会期待"我装了一个 hook 突然就能跳过我自己写的 deny 规则"
- **复用方式**:任何"用户提供的扩展点"都要明确**它在权限拓扑里的位置**(高于 / 等于 / 低于哪些规则)
- **代价**:hook 作者会困惑"我返回 allow 怎么没生效"

### 原则 4:用 useRef 防止 React StrictMode 反复触发副作用

- **体现**:`components/permissions/hooks.ts:usePermissionRequestLogging` 的 `loggedToolUseID` ref 去重
- **代表文件**:`src/components/permissions/hooks.ts:usePermissionRequestLogging`
- **代价(已发生过)**:不去重会 100% CPU + 500MB/min 内存增长(注释里明确写)
- **为什么重要**:`logEvent` 看似廉价,但被反复 fire 后伤害的不是 server,而是**本地序列化 + buffer + 网络写**。React 18 StrictMode + react-compiler 缓存会让 effect 跑奇怪的次数
- **复用方式**:任何"幂等但有 IO 副作用"的 effect,用 `useRef<Set<string>>` 去重
- **代价**:必须每个 callsite 自己想清"幂等键"(toolUseID / requestId / messageId)

### 原则 5:Classifier 走"speculative + consume"模式,跨进程边界并行

- **体现**:`speculativeChecks: Map<string, Promise<ClassifierResult>>` 在 module scope,跨调用栈共享
- **代表文件**:`bashPermissions.ts:1483-1545`(map + start/peek/consume/clear)
- **为什么重要**:用户感受到的延迟 = T(hooks) + T(classifier) 串行;speculative 让 T(classifier) 与 T(hooks) 重叠 → 净延迟降到 max(两者)
- **复用方式**:任何"昂贵但确定可作废的查询"都可以提前 fire(LSP definition / git blame / model token count)
- **代价**:
  - 需要明确"何时清"(不清会内存泄漏 — `clearSpeculativeChecks` 由 cleanupRegistry 调)
  - speculative 的 controller/signal 要与最终消费方同源(否则 abort 不传染)
  - 失败要静默(`.catch(() => {})`)避免 unhandled rejection

### 原则 6:AST + 影子模式(shadow mode)做高风险解析器替换

- **体现**:`feature('TREE_SITTER_BASH_SHADOW')` 跑 tree-sitter 但**丢弃结果**,只 logEvent
- **代表文件**:`bashPermissions.ts:1707-1739`
- **为什么重要**:把 regex-based 安全分析换成 AST 是个"无回滚"操作 —— 误判可能让攻击命令通过。Shadow 让你**先收集一周生产数据再切换**
- **复用方式**:把任何高风险替换都做 shadow mode(并行新旧实现 + 记录差异)
- **代价**:运行时双倍开销(被新代码也跑); 只能跑数小时-数日观察 

### 原则 7:Allow 用窄规则,Deny 用宽规则(不对称失败)

- **体现**:`stripSafeWrappers` 与 `stripAllLeadingEnvVars` 两套
- **代表文件**:`bashPermissions.ts:524, 733`
- **为什么重要**:allow 错放放出风险命令、deny 漏掉放出风险命令 —— 都是事故。但实现取舍上 allow 必须 conservative(只剥白名单),deny 必须 aggressive(尽量剥更多)。这是**对失败方向的不对称偏见编入代码**
- **复用方式**:任何 "allow / deny 都用同一个匹配器" 的设计都该 review
- **代价**:维护两套 normalize

### 原则 8:Bun feature() DCE 复杂度阈值不是抽象边界,是真实物理边界

- **体现**:`bashToolHasPermission` 的整体结构被打包器约束 —— 不能 inline 子函数、不能用 import alias、不能删除已经 dead 的 helper
- **代表文件**:`bashPermissions.ts:81-89, 1389, 1426`、`pathValidation.ts:1163`
- **为什么重要**:这不是"代码风格"而是"工具链反向影响代码结构" —— 调试时 30/30 测试 → 22/30 测试,**没有 lint 规则能告警**(bun 静默把 feature() 评估为 false)。这是 Agent 工程师必须知道的"工具特定陷阱"
- **复用方式**:Agent 项目里建立 "DCE / minifier 反向限制"的 TEAM MEMORY(Claude Code 团队的 `bun-feature-dce-cliff.md`),定期评估
- **代价**:很难记,容易 regress(已 hit 5 次)

### 原则 9:启动期"trust dialog"必须在能力初始化前

- **体现**:`showSetupScreens` 顺序:Onboarding → Trust → MCP → API key → Bypass
- **代表文件**:`interactiveHelpers.tsx`(M01 已分析)+ `TrustDialog.tsx` 列出的 7 类危险源
- **为什么重要**:trust 是**所有其他 trust-gated 能力的前提**(MCP server / hooks / bash perms)。先让用户看到 cwd 启用了什么,再让他/她决定是否信任
- **复用方式**:Agent 项目第一启动到这个 cwd 时强制审查所有"由 cwd 提供的能力"
- **代价**:UX 多一步;要写"7 类来源"探测器(trust/utils.ts)

### 原则 10:Bypass mode 必须显式"我同意"+ 持久化到 user settings

- **体现**:`BypassPermissionsModeDialog.tsx` 的 `'accept'` 路径写 `skipDangerousModePermissionPrompt: true` 到 userSettings
- **代表文件**:`src/components/BypassPermissionsModeDialog.tsx`
- **为什么重要**:Bypass mode 危险性远高于 trust(完全不问权限)。**只能持久化到 userSettings(不写 projectSettings),因为这是"我这台机这个用户"的承诺**,不是"这个项目仓库的承诺"
- **复用方式**:任何"危险开关持久化"都要思考"持久化到哪个 scope" —— user / project / session
- **代价**:写错 scope 会让"接管别人项目"变成 bypass(安全事故)

### 原则 11:权限对话框允许通过 Tab 切换 feedback 模式(双向通信)

- **体现**:`PermissionPrompt.tsx` 的 Tab 切换;rejected 时附 `userResponseToolUseFeedback`,模型读到"用户拒绝并说 X"
- **代表文件**:`src/components/permissions/PermissionPrompt.tsx`
- **为什么重要**:用户拒绝时,模型不知道为什么。让用户当场写一句"用 ripgrep 不要 grep"省一轮对话
- **复用方式**:任何"二元决策"对话框都可以让用户附自然语言修正建议
- **代价**:UI 复杂(Tab 提示 + 输入区) + 模型必须能读"反馈作为 user 消息"

### 原则 12:每条 'allow' / 'deny' 决策都打标"来源"(source)与"reason"

- **体现**:`PermissionApprovalSource` / `PermissionRejectionSource` 判别联合 + 8 种 `decisionReason.type`
- **代表文件**:`hooks/toolPermission/permissionLogging.ts`
- **为什么重要**:**审计** —— 当用户说"为什么 Claude 没问我就跑了 X",团队需要知道是 hook 放过、还是 classifier 高置信、还是哪条 rule 命中。每个 source 单独一个事件名才能拉数据
- **复用方式**:Agent 决策点都打"来源 + 原因"两层 metadata
- **代价**:增加 event 数量;要约束"事件命名公约"

### 原则 13:Bash 命令安全检查必须有 fanout cap

- **体现**:`MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50` + `MAX_SUGGESTED_RULES_FOR_COMPOUND = 5`
- **代表文件**:`bashPermissions.ts:103, 110`
- **为什么重要**:`splitCommand` 在恶意输入下可指数爆炸(CC-643 事故:REPL 100% CPU 卡死,strace 显示 /proc/self/stat 127Hz 读取)。**没有 cap 就没有 DoS 防护**
- **复用方式**:任何"用户输入驱动的递归/分裂"都要 cap
- **代价**:cap 触发时只能 fall-through 到 ask(用户体验下降但安全)

### 原则 14:把"工具特定批量修改"做成 OTel counter,不是单条 event

- **体现**:`code_editing.lines_added` / `code_editing.lines_removed` counter(per-language)
- **代表文件**:`hooks/toolPermission/permissionLogging.ts`
- **为什么重要**:Edit/Write/NotebookEdit 一次 batch 几百行,如果每行一 event 就刷爆。Counter 模式低开销 + 易 dashboard
- **复用方式**:工具调用结果中的"数量"维度都用 counter(token / file / row)
- **代价**:OTel 后端要支持 counter(Statsig 不行,要 OTel collector)

## 6. 错误处理与边界条件

### 6.1 ask 但实际不能弹对话框(non-interactive 路径)

- `isNonInteractiveSession` 标志(`--print` 模式 / SDK / daemon worker)
- 'ask' 在这种模式下被 `useCanUseTool` 强制转为 'deny'(避免无限挂起)
- **对应日志**:`tengu_tool_use_rejected_non_interactive`(待确认)

### 6.2 5 路 race 的取消传播

- gate.resolve 任一方 → 其他方都看到 `signal.aborted`
- swarm leader cancel → mailbox 收到 cancelRequest → workers 全部解锁
- bridge 端 cancel → forward 给本地 controller
- 用户 Ctrl+C → process SIGINT → cleanupRegistry → controllers abort

### 6.3 Trust dialog 拒绝

- `TrustDialog` 选 exit → `gracefulShutdownSync(1)` —— **不写任何 config**
- 这意味着每次启动到不可信目录都会再问(无 silent dismiss)

### 6.4 Bypass dialog 异常

- Esc(`handleEscape`)→ `gracefulShutdownSync(0)` —— 0 退出码(用户主动取消不算 error)
- decline → `gracefulShutdownSync(1)` —— 1 退出码(被显式拒绝是 error)
- accept → 持久化设置 + `onAccept()` 进入 REPL

### 6.5 hooks 子进程错误

- runPreToolUseHooks 内 catch 各类错误 → 'ask' 兜底 + `tengu_pre_tool_hook_error` 事件
- hook 决策格式不合法 → 当作未决(fall through)

### 6.6 classifier 失败模式

- 网络超时 → AbortError → fall through to dialog
- 模型返回非 JSON → 解析错误(在 `bashClassifier.ts` 缺失文件) → fall through
- 高 latency(>2s) → speculative 还在跑,interactive 进入 dialog 了 — UI 显示 "checking..." 直到 onComplete

### 6.7 path validation 错配

- `commands` 是 splitCommand 输出 → 可能漏掉 redirection 目标 → 整体 redirection 单独验证
- shell-quote 在单引号 + 反斜杠场景有 silent bug → AST 路径绕过(注释多次提到)
- Windows UNC 路径 → 'ask'(WebDAV 攻击)

## 7. 可迁移设计清单

| 可迁移设计 | 适用场景 | 复用方式 | 风险 |
|---|---|---|---|
| 3-flow handler 拆分(interactive/coordinator/worker) | 多代理身份的权限决策 | 一个工厂 + 三个 handler 文件 | 测试矩阵爆炸 |
| `claim()` 原子守护并发 race | first-wins 并发(超时 vs 用户 vs 网络) | 通用 createResolveOnce | callsite 必须用 claim |
| Hook allow 不能绕过 deny/ask | 用户级扩展点的安全约束 | hook 结果再走 rule check | 扩展作者困惑 |
| useRef 去重 logEvent | React effect 与 telemetry 接合 | `loggedKey: Set<string>` | 幂等键设计 |
| Speculative + consume | 跨进程边界节省延迟 | Map<key, Promise> + 显式 clear | clear 时机 |
| AST + Shadow mode | 高风险解析器替换 | 双跑 + 记录 divergence | 双倍开销 |
| Allow 窄 / Deny 宽 normalize | 安全规则匹配 | 两套 strip 函数 | 维护两套 |
| 命令 fanout cap | 用户输入驱动的递归 | 顶层常量 + 'ask' fallback | UX 退化 |
| 决策来源 + reason 二维标签 | 决策审计 | 判别联合 + 多事件名 | 事件爆炸 |
| Trust dialog 列举 cwd 危险源 | 信任 boundary 设计 | 7 类探测器 + 列表 dialog | 探测器维护 |
| Bypass mode 持久化 scope | 危险开关持久化 | userSettings 不写 projectSettings | scope 错配 |
| Tab 切换 feedback 模式 | 二元决策 + 修正建议 | dialog 上的 keybinding | UI 复杂 |
| Per-tool dialog component | 工具语义化 UI | tool name → component switch | 加新工具要写组件 |
| Code-editing OTel counter | 高频批量改动 | per-language counter | OTel 后端依赖 |
| Bun DCE cliff 警觉 | 用 bun bundle 的项目 | 顶层 const rebind + helper 不 inline | 团队记忆 |

## 8. 待确认问题

1. **utils/permissions/* 缺失**:具体的 `hasPermissionsToUseTool`、`checkRuleBasedPermissions`、`getDenyRuleForTool`、`PermissionResult` schema、`PermissionRule` schema、`PermissionUpdate` schema 都不可见。本文从 callers 推断,但具体代码无法验证
2. **`bashClassifier.ts` 缺失**:`classifyBashCommand` 的 prompt template 与模型选择(Haiku?)只能从 callsite 推断
3. **`isClassifierPermissionsEnabled`** 的真实判定:从 import 看是 utils,可能是 `feature('BASH_CLASSIFIER') && allowDescriptions.length > 0`
4. **`autoModeDenials.ts` / `classifierApprovals.ts` 缺失**:auto mode 的 transcript classifier 行为不可见
5. **`SandboxManager`**(utils/sandbox/sandbox-adapter):平台特定 sandbox 实现(macOS Seatbelt / Linux user namespace / Windows AppContainer?)不可见
6. **`PowerShellTool` 与 `BashTool` 共享多少代码**:看着像复制 + Windows-specific 改造,但是否有共享 base 类不确定
7. **`commands/permissions/`** UI 的具体交互流(允许/拒绝规则的编辑器):未读
8. **`CHANNEL_PERMISSION_REQUEST_METHOD`** 在 KAIROS MCP 服务器端的具体响应处理(消息→inline keyboard→点击→回复)
9. **`bridgeCallbacks`** 的具体协议(claude.ai 端如何决策然后回 yes/no)
10. **`forceDecision`** 旁路的具体 caller 链(plan mode 退出 / resume permission)

---

## 10. 补读修正(M04 全部 16 文件精读后)

> 把 `bashSecurity.ts` 2593 行 + `bashPermissions.ts` 2621 行 + `pathValidation.ts` 1303 行 + `readOnlyValidation.ts` 1990 行 + `sedValidation.ts` 684 行 + PowerShell 14 个文件全部从头读完之后,以下是 §1-§9 没覆盖、但对"自己开发 Agent"有价值的工程细节。每条带"为啥需要"和"启示"。

### 10.1 [深化] `bashSecurity.ts` 的 23 个 BASH_SECURITY_CHECK_IDS

§2.3 把 `bashSecurity.ts` 概括为"20+ patterns",**实际是 23 个**(enum 1-23):

| ID | Validator | 防御目标 |
|---|---|---|
| 1 | `EMPTY` | 空命令 |
| 2 | `INCOMPLETE_COMMAND` | `cmd \\` 行尾续行未闭合 |
| 3 | `JQ` | `jq -f` / `jq --rawfile` / `jq -L` / `jq system()` |
| 4 | `SHELL_METACHARACTERS` | 未引号 `(`, `)`, `{`, `}`, `<`, `>` |
| 5 | `DANGEROUS_VARIABLES` | `BASH_ENV` / `ENV` 等启动期执行变量 |
| 6 | `DANGEROUS_PATTERNS` | `COMMAND_SUBSTITUTION_PATTERNS`(`$()`, ``\` ``) |
| 7 | `REDIRECTIONS` | `>`, `>>`, `>|`, `&>` |
| 8 | `NEWLINES` | 未引号的换行 |
| 9 | `IFS_INJECTION` | `IFS=$'\\x..'` 等 |
| 10 | `PROC_ENVIRON` | `/proc/self/environ` 读 |
| 11 | `MALFORMED_TOKEN_INJECTION` | 兜底 |
| 12 | `OBFUSCATED_FLAGS` | ANSI-C `$'...'` / locale `$"..."` / 空引号对 |
| 13 | `BACKSLASH_ESCAPED_WHITESPACE` | `cd /tmp\\ /etc` |
| 14 | `BACKSLASH_ESCAPED_OPERATORS` | `cat safe \\; rm /etc` |
| 15 | `UNICODE_WHITESPACE` | U+00A0 NBSP / U+2028 LS / U+3000 IDEOGRAPHIC SPACE |
| 16 | `MID_WORD_HASH` | `git#comment` 这种关键字中间塞 # |
| 17 | `BRACE_EXPANSION` | `git diff {@'{'0},--output=/tmp/pwned}` |
| 18 | `ZSH_DANGEROUS_COMMANDS` | `zmodload` / `fc -e` / `zpty` / `zsocket` 等 |
| 19 | `CONTROL_CHARACTERS` | `0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F` |
| 20 | `SAFE_COMMAND_SUBSTITUTION` | `$(cat <<'EOF'...EOF)` 这类被白名单 |
| 21 | `CARRIAGE_RETURN` | `\\r` (shell-quote 分割,bash 不分割) |
| 22 | `COMMENT_QUOTE_DESYNC` | `# "rm /etc` 未引号 `#` 后跟引号符 |
| 23 | `QUOTED_NEWLINE` | 引号内 `\\n` 后接 `# evil` |

**启示**:列举完整的攻击向量比"我有 20+ 防御"有意义得多。**每个 ID 对应一个 CVE/HackerOne/CTF 案例**——你写自己 Agent 时,看着这张表就知道至少要防 23 类。

### 10.2 [新增] `bashCommandIsSafe_DEPRECATED` 的 deferred-non-misparsing 模式

这是 `bashSecurity.ts` 第 2392-2407 行的精妙设计,**§2.3 完全没提**。

**问题**:验证器分两组:
- **misparsing validators**(`isBashSecurityCheckForMisparsing: true`):它们 `ask` 时,`bashPermissions.ts:~1301-1303` 会**强制拦截**(不让进入用户对话框)
- **non-misparsing validators**(`validateNewlines`, `validateRedirections`):它们 `ask` 时**只是建议**,可被用户对话框允许

**naïve 实现的漏洞**:
```
顺序:[..., validateRedirections(idx 10, non-mis), ..., validateBackslashEscapedOperators(idx 12, mis), ...]
payload: cat safe.txt \; echo /etc/passwd > ./out
- validateRedirections 先 fire ask 'because >' (non-mis)
- short-circuit return → 直接进对话框
- 但 \;BackslashEscapedOperators 没运行,本来会 fire WITH misparsing flag
- 用户在对话框 "allow once" → payload 执行
```

**正确实现(deferred)**:
```typescript
let deferredNonMisparsingResult: PermissionResult | null = null
for (const validator of validators) {
  const result = validator(context)
  if (result.behavior === 'ask') {
    if (nonMisparsingValidators.has(validator)) {
      if (deferredNonMisparsingResult === null) {
        deferredNonMisparsingResult = result  // 先缓存,不返回
      }
      continue  // 继续跑后面的 validator
    }
    return { ...result, isBashSecurityCheckForMisparsing: true }
  }
}
if (deferredNonMisparsingResult !== null) return deferredNonMisparsingResult
```

**启示**:任何"两级严格度"的验证器链,**绝对不能用 short-circuit**。后面的验证器可能升级前面的决策。这是 `bashSecurity.ts` 注释里明确说明的反例(line 2380-2391 整段)。

### 10.3 [新增] `onDivergence` 回调批量化 (CC-643 microtask 风暴)

`bashCommandIsSafeAsync_DEPRECATED` 第 2503-2516 行:

```typescript
if (!tsAnalysis.dangerousPatterns.hasHeredoc) {
  const hasDivergence = tsQuote.fullyUnquoted !== regexQuote.fullyUnquoted || ...
  if (hasDivergence) {
    if (onDivergence) onDivergence()        // 调用方批量
    else logEvent('tengu_tree_sitter_security_divergence', ...)
  }
}
```

**为啥这个 callback 设计**:`bashPermissions.ts` 在 fanout 子命令时用 `Promise.all([...subcommands.map(bashCommandIsSafeAsync)])`。每个 logEvent 会触发 `getEventMetadata()` → `buildProcessMetrics()` → `process.memoryUsage()` → 读 `/proc/self/stat`。memoized metadata 让这些解析为 microtask,**饿死 event loop**。

**CC-643 的修复**:fanout 的 caller 传 `onDivergence` 把 N 个 divergence 收集到本地 set,最后**一次** logEvent。单命令的 caller 不传,保留 per-call 行为。

**启示**:任何"在 fanout 循环里 logEvent"的代码都要审视:logEvent 内部如果有 process metrics、I/O、metadata 解析,**fanout 必须批量**。给 logger 加 batch 模式不是优化,是必需。

### 10.4 [新增] heredoc 跳过 divergence 检查的原因

(承上)tree-sitter 把"quoted heredoc 主体"strip 成空,regex 路径通过 `extractHeredocs` 替换成 placeholder 字符串。两路 `fullyUnquoted` 永远不等,**100% divergence**。如果不 skip,日志被 heredoc 污染,真正的 divergence 信号被淹没。

**启示**:做"两个解析器对比"的 shadow mode 时,**已知系统性差异要显式 skip**,否则信噪比归零。

### 10.5 [新增] zsh precommand modifier 剥除

`validateZshDangerousCommands`(line 2186-2242)的 base command 提取:

```typescript
const ZSH_PRECOMMAND_MODIFIERS = new Set(['command', 'builtin', 'noglob', 'nocorrect'])
const tokens = trimmed.split(/\s+/)
let baseCmd = ''
for (const token of tokens) {
  if (/^[A-Za-z_]\w*=/.test(token)) continue   // skip env var (VAR=value)
  if (ZSH_PRECOMMAND_MODIFIERS.has(token)) continue  // skip modifier
  baseCmd = token
  break
}
if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) return { behavior: 'ask', ... }
```

**为啥需要**:`command zmodload x` 在 zsh 里和 `zmodload x` 完全等价。`builtin` / `noglob` / `nocorrect` 都不改变实际执行的命令,但能让 naïve 验证器看不见 `zmodload`。

**启示**:**所有 shell 都有"语义透明的前缀"**(bash 的 `command`, `exec`, zsh 的 4 个)。任何"按第一个 token 决定语义"的代码都该剥前缀。

### 10.6 [新增] `fc -e` 与 history-as-attack

`validateZshDangerousCommands` 同函数:`if (baseCmd === 'fc' && /\\s-\\S*e/.test(trimmed))`。

**为啥需要**:zsh 的 `fc -e VEDITOR cmd` 把 `cmd` 喂给 `VEDITOR` 编辑后 execute——**任意编辑器执行**。
- `fc -e sed -e 's/$/;rm -rf \/$/' 1 2` → 把 history line 1 编辑成"加 ; rm -rf /"再执行
- `fc -e vim 1` → vim `:!cmd` 任意命令

**启示**:`fc` 本身只读 history,但 `-e` 把它升级为任意编辑器执行。同 fd 的 `-l` → ls fork(§10.10)是一个模式:**只读工具的某些 flag 升级为任意执行**。

### 10.7 [新增] CONTROL_CHAR_RE 精确范围

```typescript
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/
```

**为啥这个范围**:
- 排除 `\x09`(TAB)、`\x0A`(LF)、`\x0D`(CR)——由专门 validator 处理
- 包含 `\x7F`(DEL) 因 bash 不打印
- 包含 `\x00`(NUL) 因 bash **silently drop**——`echo safe\x00; rm -rf /` 的 `\x00` 不阻止后续执行

**注释 line 2247-2249**:"Bash silently drops null bytes and ignores most control chars, so an attacker can use them to slip metacharacters past our checks while bash still executes them."

**启示**:任何"非可视字符"过滤都该明确**哪些被目标 shell 静默吞掉**(silently dropped vs visible error)。被静默吞掉的字符才是攻击向量,不会 silently fail 的反而不需要拦。

### 10.8 [深化] `bashCommandIsSafeAsync_DEPRECATED` 是 fallback,主路径在 `parseForSecurity`

`bashSecurity.ts` 文件名带"安全",但**整个文件都标 `@deprecated`**(line 2254, 2415)。注释说:"The primary gate is `parseForSecurity` (ast.ts)。"

**实际架构**:
```
bashToolHasPermission
  ├── parseCommandRaw (tree-sitter WASM)
  │     ├── 'simple' → use AST directly, skip bashCommandIsSafe entirely
  │     ├── 'too-complex' → ask + classifier (skip bashCommandIsSafe)
  │     └── 'parse-unavailable' → fall back to bashCommandIsSafeAsync_DEPRECATED
  └── ...
```

**启示**:**永远把 legacy 路径标 `_DEPRECATED`**,即使它还在跑。这让代码读者立刻知道"这是 fallback,主路径在别处"。Claude Code 用这个命名约定避免新手误以为这是核心安全实现。

### 10.9 [新增] `bashPermissions.ts` 的 `BARE_SHELL_PREFIXES` 含 sudo/doas/pkexec

这个 set 用于"裸建议为 prefix"的逻辑——意思是建议规则系统**不会自动**为 `sudo`/`doas`/`pkexec` 生成建议规则。

**为啥单独排除**:用户允许 `Bash(sudo:*)` = 允许 root。建议系统永远只走人工写入,即使语义合法。

**启示**:**区分"可建议"和"可手写"**——一个升权工具的规则可以手写,但绝不能自动建议。这是把 UI affordance 当作安全防线的应用。

### 10.10 [新增] `SAFE_WRAPPER_PATTERNS` 用 `[ \\t]+` 而不是 `\\s+`(HackerOne #3543050)

```typescript
// 错: /^env\s+/
// 对: /^env[ \t]+/
```

**为啥**:`\\s` 包含 `\\r\\n\\v\\f`。`env\\nls` 用 `\\s` 会匹配上"env 包装 ls",但 shell 里 newline 是**语句分隔**,实际执行的是两条独立命令——验证器以为 ls 走 env 包装,实际 ls 裸跑。

**启示**:**所有 shell 验证器的 `\\s+` 都是 bug**。固定用 `[ \\t]+`(或 `[ \\t\\f]+` 兼容某些 tab variant)。一次性 audit `\\s` 在你 codebase 的所有出现。

### 10.11 [新增] `TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/`

`timeout`/`stdbuf`/`nice`/`env` 的 flag value 强制白名单字符集。

**为啥**:`timeout -k$(id) 10 ls` 的 `$(id)` 在 shell 解析时**已展开**——验证器看到的字面值是攻击者控制的字符串。强制 `[A-Za-z0-9_.+-]+` 让 `(`, `$`, `\`` 等 metachar 静态阶段就被拒。

**启示**:**flag value 用白名单字符集,不用黑名单**。黑名单永远漏(`<`, `>`, `` ` ``, `$`, `\`, `(`, `)`, `{`, `}`, `;`, `|`, `&`, `*`, `?`, `[`, `]`, `~`, `!`, `#`, `^`, `'`, `"`, `\n`, `\r`)。

### 10.12 [新增] `MAX_SUGGESTED_RULES_FOR_COMPOUND = 5`(GH#11380)

`a && b && c && d && e && f && g` 不会为每个 subcommand 生成建议规则,超过 5 个就不生成。

**为啥**:UI 噪声 cap。一次弹 7 条 suggested rule 让用户失去筛选意愿。

**启示**:**UI 输出有规模就要有上限**,worst case 必然出现(用户 paste 一长串)。"全部展示" = "用户习惯性 Enter"。

### 10.13 [新增] sedValidation Unicode 同形字白名单 + y 命令偏执扫描

`sedValidation.ts` 拒绝列表中显式列入 `ｗ`(全角 U+FF57)、`ᴡ`(small caps)、`w̃`(组合标记)。

**为啥**:某些 locale 下 sed 正则把同形字当 `w` 解释。`s/.../.../ｗ file` 写文件(`w` flag)就绕过 ASCII-only 验证。

另:y 命令(字符转译)本身无害,但只要命令字符串**任意位置**出现 `[wWeE]` 就 paranoid ask——不试图精确判定 `w` 是否在 `y` 命令内合法,统一升级。

**启示**:
- 任何字符级安全检查都要先做 Unicode normalization 或显式枚举同形字
- 对超复杂 grammar,用"上下文无关的偏执扫描"比"精确判定"更可维护

### 10.14 [新增] sed `1,$` shorthand 拒绝(跨实现一致性)

GNU sed 接受 `,p`(从开头到末尾),BSD sed 不接受。验证器**直接拒绝逗号开头的范围**。

**为啥**:跨实现 shorthand 不一致,攻击者可写"GNU 合法 BSD 不接受"的命令——验证器在 BSD 上判合法但 GNU 上行为不同。

**启示**:当目标程序跨实现行为不一致时,**让验证器只接受所有实现都同意的子集**(不是"所有实现都拒绝"的并集)。

### 10.15 [新增] `pathValidation.ts` 的 fd `-l/--list-details` 排除

fd(常被认为只读)在 `-l` 时**内部 fork ls**——PATH 劫持入口:cwd 放假 ls,fd 调用就执行任意代码。

**启示**:**工具的 allowlist 必须按 flag 粒度审计**,不能"工具本身只读 = 所有 flag 安全"。`fd --list-details`、`fc -e`、`git log --diff-merges`(自定义 git command) 都是反例。

### 10.16 [新增] `xargs -i/-e` 彻底移除 + Windows 上 xargs 完全禁用

- **`-i/-e` 的 optional-attached-arg 歧义**:`-i{}` 和 `-i {}` 都合法,验证器无法区分"`-i` 后是 placeholder 还是文件结束"。一旦解析歧义就能塞 payload。**只接受 `-I {}`**(大写、强制空格、强制参数)。
- **Windows 上 xargs 整体禁**:Windows 文件含 UNC `\\server\share`,xargs 把文件内容变命令参数 → 网络访问 + 凭据外泄。

**启示**:
- getopt 的 optional-attached-arg 在 shell 安全里基本是死局,能删就删
- 平台差异要在 allowlist 层体现,不能"跨平台共享一份"

### 10.17 [新增] `readOnlyValidation.ts` 的 `$` token 一律拒(命令令牌之后)

不只 `$()` 被拒,**`git diff "$Z--output=/tmp/pwned"`、`rg . "$Z--pre=bash" FILE`、`ps ax"$Z"e`** 这三种"变量拼接命令选项"都被拒。

**为啥**:变量 shell 解析阶段展开,验证器看到的 `$Z` 在 runtime 变成攻击者控制的字符串。

**启示**:**凡是命令参数里能塞变量的位置都该一刀切拒**,不试图"判断这个 `$` 安不安全"。

### 10.18 [新增] brace expansion 检测的合取条件

```typescript
// 简单 if (/{/) 会误判 git stash@{0}
// 正确:同时含 `{` 和 (`,` 或 `..`)
if (/\{/.test(s) && (/,/.test(s) || /\.\./.test(s))) // ← 才算 brace expansion
```

**启示**:**正则识别语法特征时,加合取条件比单条件少误报**。审视所有"单 metachar 就触发"的检测,问"合法用法里这个 metachar 还在哪儿出现?"。

### 10.19 [新增] node `--run` 在 `-v` 前 = 任意脚本执行

`node --run foo -v` 跑 `package.json` 的 `foo` 脚本,**不是查询版本**。验证器按位置判断,不按"有没有 -v"。

**启示**:工具的"只读 flag"和"执行 flag"共存时,**顺序决定语义**。靠 contains-check 永远漏,必须按 flag parser 的位置语义判定。

### 10.20 [新增] git `-c` 黑名单 fsmonitor/diff.external/gitProxy/--exec-path/--config-env

`git -c core.fsmonitor=evil status` 任意执行(fsmonitor 是 git 的扩展点)。同类:`diff.external`、`core.gitProxy`、`--exec-path`、`--config-env`。

**启示**:**工具有"动态配置注入"能力时**(git -c, env, etc.),必须显式黑名单已知的执行钩子配置项。"只允许 git status" 这种命令级允许不够。

### 10.21 [新增] PowerShell tokenizer **4 种 dash** 字符规范化

PS tokenizer 接受参数前缀:U+002D 普通 `-` / U+2013 en-dash `–` / U+2014 em-dash `—` / U+2015 horizontal bar `―` / `/`(Windows 风格)。

任何参数缩写检查必须先把这 5 种归一化成 ASCII `-`,否则 `Start-Process foo –Verb RunAs` 用 en-dash 绕过 `-Verb` 检查。

**出现位置**(至少 5 处必须 KEEP IN SYNC):
- `powershellSecurity.ts` 的 `psExeHasParamAbbreviation`
- `pathValidation.ts` 的 `isPowerShellParameter`
- `readOnlyValidation.ts` 的 `isAllowlistedCommand` flag check
- `modeValidation.ts` 的 `isItemTypeParamAbbrev`
- `powershellPermissions.ts` 的 step 5 Set-Location target

**启示**:跨平台 shell 安全检查必须先做 dash 字符规范化。**只查 `-` 的代码默认有洞**。

### 10.22 [新增] `checkDynamicCommandName` 用 StringConstant 白名单替代 'Variable' 黑名单

```typescript
// 错: if (elementTypes[0] === 'Variable') ask  ← 漏 IndexExpr, BinaryExpr 等
// 对: if (elementTypes[0] !== 'StringConstant') ask  ← 只放行明确的字面量
```

**为啥**:AST 类型可能新增(`('iex','x')[0]` 是 `IndexExpressionAst`,`'i'+'ex'` 是 `BinaryExpressionAst`)。黑名单只防已知,白名单防未来。

**启示**:**"分类有限的位置"用白名单,新增 AST 类型时默认拒绝**。这条原则适用所有"输入域有限"的安全检查(content type, mime, scheme, etc.)。

### 10.23 [新增] `checkComObject` 显式提取 `-TypeName` 走 CLM

CLM(Constrained Language Mode) allowlist 检查只看 `[TypeLiteral]` 语法,但 `New-Object System.Net.WebClient` 把类型作为**字符串**传入——CLM 永不触发。必须显式提取 `-TypeName` 值(含 colon 绑定、位置参数)再走 `isClmAllowedType`。

**启示**:**安全策略要在所有"它适用的 surface"都触发**,不能只在最显眼的语法上工作。审计每个能触发的 API。

### 10.24 [新增] `Start-Process` colon 语法的"结构 + 文本"双层防御

`-Verb:'RunAs'` 这种 colon 绑定(参数与值在同一 token):
- **Layer 1**:走 parser 提供的 `children[]` 取参数实际子节点(structural,最准)
- **Layer 2**:regex fallback 容忍引号 / 反引号 / 空格(`/...:runas$/` 演进版)

**为啥**:structural 检查在 parser 缺失 children 时失败;regex 在 structural 在场时冗余但不冲突。任一层独立可工作,组合无盲点。

**启示**:**关键安全检查"结构化 + 文本兜底"双层**。任一层独立可工作,组合起来无盲点。

### 10.25 [新增] `Invoke-WmiMethod Win32_Process Create` 单独防御

`Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "..."` 启动任意进程,绕过 `checkStartProcess`(cmd.name 是 Invoke-WmiMethod,不是 Start-Process)。

**对策**:`checkWmiProcessSpawn` 把 Invoke-WmiMethod 和 Invoke-CimMethod 一律 ask。

**启示**:**危险能力按"能力"枚举所有调用方式**,不按 cmd.name。启动进程在 PowerShell 至少有:Start-Process / Invoke-WmiMethod / Invoke-CimMethod / `&` operator / Invoke-Expression / ScheduledJob / Register-WmiEvent action。

### 10.26 [新增] `checkRuntimeStateManipulation` 防 alias hijack

`Set-Alias Get-Content Invoke-Expression` → 后续所有 `Get-Content $x` 变成 `iex $x`。`Set-Variable PSDefaultParameterValues @{'*:Path'='/etc/passwd'}` → 所有 cmdlet 的 Path 默认指向 /etc/passwd。

**对策**:`RUNTIME_STATE_CMDLETS = Set('Set-Alias','New-Alias','Set-Variable','New-Variable')` 一律 ask。

**启示**:**任何能"修改解释器全局状态"的 API 都要 ask**(哪怕本身无害):env、alias、`PSDefaultParameterValues`、shell options、function/cmdlet 定义。

### 10.27 [新增] `GIT_SAFETY_ARCHIVE_EXTRACTORS` 防解压 + git TOCTOU

`tar -xf payload.tar; git status` —— `isCurrentDirectoryBareGitRepo` 检查在权限评估时跑,**解压在 git 运行前才往 cwd 释放 HEAD/hooks/refs/**。

**对策**:任何复合命令含 `tar`/`unzip`/`7z`/`gzip`/`Expand-Archive` + `git` 都 ask。

**启示**:**任何"不透明数据进入文件系统" + 后续敏感命令组合**,都要 TOCTOU 警告。覆盖范围:解压、`wget + chmod +x`、`go install`、`npm install` 脚本、`docker run -v`。

### 10.28 [新增] `decisions[]` collect-then-reduce 取代 sequential early-return

旧实现:`return ask` 一旦命中就返回 → `Get-Process; iex evil` + ask(Get-Process:*) + deny(iex:*) 会先弹 ask,**deny 永不触发**。

新实现:全部 push 到 `decisions[]` 数组,最后 `reduce(deny > ask > allow > passthrough)`。

**结构性消除整类 bug**:下个写 `return ask` 的人写不出旧 bug——因为他必须 push,reduce 自动正确。

**出现位置**:
- `bashPermissions.ts:~1446`
- `powershellPermissions.ts:~900`

**启示**:**当流程有"优先级"需求**(deny > ask > allow),**绝不能 early return**。结构性强制走 collect-then-reduce。

### 10.29 [新增] parse-failed fallback 路径的 backtick 处理

PowerShell `Invoke-Ex\`pression` 反引号字符转义:` ` ` 是行延续(`\<newline>` → 删除)和字符转义(`\`x` → `x`)。回退分片**必须先合并行延续再删反引号**,否则切成 `Invoke-Ex` + `pression`,deny(iex:*) 不命中。

**启示**:**parse-failed fallback 路径里,shell 元字符的"无害行为"**(escape、line continuation、quote)**都要先归一化掉再做规则匹配**。任何能"断词"的字符都是 deny 旁路。

### 10.30 [新增] `statementsSeenInLoop` 仅在 PUSH 时记录

```typescript
// 错:进 loop 就标 seen
for (const stmt of statements) {
  statementsSeenInLoop.add(stmt)  // ← 进 entry 就标
  for (const sub of stmt.subCommands) {
    if (allowRule.matches(sub)) continue  // ← user allow → 跳过 push
  }
}
// 攻击:`if($true){ Get-Process; $env:SECRET }`
// - Get-Process 命中 allow → continue
// - $env:SECRET 是 VariableExpressionAst 不在 sub list
// - statementsSeenInLoop 标了 → fail-closed gate 跳过该 statement
// - secret 静默泄露
```

**正确**:`statementsSeenInLoop.add(stmt)` 只在它**真的产生 ask/passthrough 时**记。

**启示**:**"是否处理过"的标记要在"实际产生约束"时记**,不在"开始考虑"时记。fail-closed gate 不该被"我看过了但没决策"绕过。

### 10.31 [新增] `.git/` 写入无需复合 git 子命令(latent attack)

bare-repo `hooks/`、`refs/` 等位置**只在同一命令含 `git xxx` 时拦**(防误报)。但 **`.git/` 这种带前缀的路径,没有 git 也拦**——种到 `.git/hooks/pre-commit` 的 hook 在用户下次 commit 时被 git 自动执行。

**启示**:**区分"立刻触发的攻击"和"潜伏攻击"**。配置文件、hooks、cron、systemd unit、shell rc 写入不需要"同时执行某个命令"做 trigger,植入即可。

### 10.32 [新增] PowerShell provider path regex 按平台分裂

```typescript
// Windows: /^[a-z0-9]{2,}:/   ← 排除单字母 C:/D: 让 path.win32 处理
// POSIX:   /^[a-z0-9]+:/      ← 任何字母数字+冒号都按 PSDrive 处理 → ask
```

**为啥**:POSIX 上没有"驱动器号",`Z:` 只能是 `New-PSDrive -Name Z -Root /etc` 创建的——验证器无法静态知道指向哪儿,**全部 ask**。Windows 上 C:/D: 是真驱动器,path 库正确处理。

**启示**:**跨平台路径验证按平台分裂规则**,不能"取并集"或"取交集"。Windows 路径在 POSIX 上的含义截然不同。

### 10.33 [新增] unknown 参数走 `hasUnvalidatablePathArg` + 仍提取 colon 绑定值

`extractPathsFromCommand` 中:任何不在 `pathParams`/`knownSwitches`/`knownValueParams` 三集之一的参数都触发 `hasUnvalidatablePathArg → ask`。**同时**如果 unknown 参数是 colon 绑定形式(`-UnknownParam:/etc/hosts`),**值还会被加进 `paths[]`** 让 deny rule 参与。

**为啥**:这是结构性修复"`KNOWN_SWITCH_PARAMS` 打地鼠"——每漏一个 switch,启发式吞下个位置参数(可能是 path)。现在只对完全理解的调用 auto-allow + defense-in-depth(ask 同时尝试提取可识别内容)。

**启示**:**schema 不完整时对未知字段 fail-closed**,同时 defense-in-depth——即使决定 ask,也尝试提取可识别内容让其他规则继续工作。

### 10.34 [新增] `hasComplexColonValue` 文本检测兜底 AST 隐藏

PowerShell `-Path:value` colon 绑定是**单个 token**,AST 把外层 `CommandParameterAst` 报成 'Parameter',内部 Array/Sub/Variable/Hashtable 全藏起来。必须文本检测:含 `,`(ArrayLiteralAst)、`(`(ParenExpr)、`[`(TypeLiteral)、 `` ` ``(escape)、`@(`/`@{`(array sub/hash)、`$`(variable)。

**为啥**:`-Path:safe.txt,/etc/passwd` 实际写两个文件,验证器只看到一个字符串。

**启示**:**AST 的"父节点类型"可能把"子节点类型"隐藏掉**。明确每种 wrapper 隐藏了什么,写文本兜底检测。

### 10.35 [新增] backtick 在路径里 = 不可静态验证

任何含 backtick 的路径都 ask,因为 `` ` `` 是 PowerShell 转义符,在很多位置是 no-op(`` `/ === / ``)**但会让 Node 的 `path.isAbsolute()` 失败**。

**为啥**:redirection target 用原始 `.Extent.Text` 保留 backtick;不在这里拦,下游 `path.isAbsolute(`` `/etc/passwd ``)` 返回 false → 当成相对路径 → 落到 cwd → 错过 deny rule。

**启示**:**一切"在语言里语义为 no-op、在静态分析里却生效"的字符都要拦**。reverse 同理:static analyzer 看到无意义但 runtime 有意义的字符也要拦。

### 10.36 [新增] `CMDLET_ALLOWLIST` 用 `Object.create(null)` 防原型污染

```typescript
// 错: const allowlist: Record<string, ...> = { 'get-content': {...} }
//     allowlist['toString'] → 返回 Function.prototype.toString → 假阳允许
// 对: const allowlist = Object.assign(Object.create(null), { ... })
//     allowlist['toString'] → undefined
```

**启示**:**任何"用户控制字符串"做 key 的 lookup 表都用 `Object.create(null)`**。5 字符防御,经常被忘。

### 10.37 [新增] 从 PowerShell allowlist 移除的"伪只读" cmdlet

显式注释 SECURITY 移除:
- **Select-Xml**:XXE via DOCTYPE 外部实体
- **Test-Json -Schema**:`$ref` 触发网络请求
- **Get-Command / Get-Help**:`-Name pipeline` 触发 module autoload(任意代码)
- **Get-WmiObject / Get-CimInstance**:`Win32_PingStatus` ICMP probe / `-ComputerName` 远程
- **Get-Clipboard**:敏感粘贴泄漏
- **man / help**:别名到 Get-Help

**启示**:**"只读"不是表面定义**。每个 allowlist 条目审计:能不能发网络?能不能 autoload 代码?能不能读敏感缓冲区?能不能 pipeline-bypass 参数检查?

### 10.38 [新增] `SAFE_OUTPUT_CMDLETS` 缩到只剩 `out-null`

原集合含 Format-Table、Out-String、Select-Object、Where-Object 等十几个。**全部移走**,只留 Out-Null。

**为啥**:所有 Format-*/Select-*/Where-*/Measure-* 都接受 **calculated property hashtable**(`@{N='x';E={任意代码}}`)或 **scriptblock 谓词**。name-only 过滤把它们从审批列表过滤掉 → arg check 永不触发 → 泄漏整片打开。

**启示**:**"安全输出"的概念基本是骗局**——几乎所有"输出格式化"工具都接受表达式扩展。要么删掉,要么走完整 arg check。

### 10.39 [新增] `SAFE_EXTERNAL_EXES` 用 `cmd.text` 而非 `cmd.name`

`scripts\where.exe` 跑本地 where.exe(不是 PATH 上的真 where.exe):
- `stripModulePrefix` 把 `cmd.name='where.exe'`(过)
- 但 `cmd.text.split(/\s/, 1)[0] = 'scripts\where.exe'`(不过)

**启示**:**做了"名字归一化"后**(去模块前缀、去扩展名),后续安全决策要清楚用哪个——归一化名 vs 原始 text。每个分支问"我此刻该用哪份数据"。

### 10.40 [新增] `elementTypes` undefined → 一律 fail-closed

```typescript
function isAllowlistedCommand(cmd) {
  if (!cmd.elementTypes) return false  // ← undefined = reject
  // ...
}
```

**为啥**:undefined 在 JS 等同 "not in",白名单循环直接 pass。但 undefined 可能意味着 AST 数据损坏 / 不完整,**应该 fail-closed**。

**启示**:**安全决策里 undefined 必须明确定义**——不是"OK"也不是"reject",写文档明确,默认 fail-closed。

### 10.41 [新增] Windows 沙箱不可用 → 企业策略冲突直接拒(双层)

```typescript
// Layer 1: validateInput
if (isWindowsSandboxPolicyViolation()) return errorInvalidInput
// Layer 2: call()
if (isWindowsSandboxPolicyViolation()) yield errorMessage
```

**为啥**:Windows 没有 bwrap/sandbox-exec,"沙箱"字面不存在。企业策略要求 sandbox.enabled 且不允许 unsandboxed → PowerShell 无法满足 → 直接拒。**不能静默 bypass 企业策略**。

`promptShellExecution` 直接调 `call()` 不走 validateInput——所以 call() 第二层兜底。

**启示**:**安全策略至少在两层都检查**(validation 层 + 执行层)。"直接调 call() 的捷径"在大型项目里几乎必然存在,靠 validation 层兜底永远漏。

### 10.42 [新增] `trackGitOperations` 跳过 pre-flight sentinel

pwsh 不存在/spawn 出错时返回 `code:0 + 空 stdout + 有 stderr` 的哨兵值(让 call() 平滑显示 stderr)。但 `gitOperationTracking` 按 code:0 当成功 git 命令计数 → telemetry 污染。

**对策**:`isPreFlightSentinel` 守卫识别后跳 tracking。

**启示**:**当一个失败状态"伪装成成功"以便下游优雅展示时,所有 telemetry 都要识别 sentinel 跳过**——否则 metrics 受污染,debugger 看着真假混杂。

### 10.43 [新增] `getEditionSection` edition===null 走最保守 5.1 指引

首次 prompt build 在任何工具调用之前,无法探测 pwsh 版本。返回"假设 5.1"的最严格指引(不准用 `&&`/`||`/`?:`/`??`/`?.`)。

**为啥**:默认给 7+ 指引,5.1 用户因模型用 `&&` 一直 parse error。反过来 5.1 指引在 7+ 也能跑(只是用 `; if ($?)` 不优雅)。

**启示**:**环境探测失败时默认"功能最弱、兼容性最强"的子集**。"假设最强、出错再退" 在 LLM 输出场景代价太大(模型不会自动 retry,会重复错)。

### 10.44 跨文件不变量(KEEP IN SYNC 列表)

从 §10.1-§10.43 抽出的**多文件必须同步**的不变量(10 条):

1. **collect-then-reduce decisions[]**——`bashPermissions.ts:~1446` 和 `powershellPermissions.ts:~900` 同模式,任一处加新检查必须 push 不能 return
2. **parse-failed fallback 必须重做规则匹配**——Bash 正则分片走 deny,PowerShell backtickStripped + invocation operator strip + 嵌套 assignment strip 后走规则匹配
3. **nameType='application' 多处守卫**——至少 6 处(exact allow 双路径、read-only allowlist、sub-command continue、symlink guard、cwd desync gate、modeValidation auto-allow),新增任何 auto-allow 路径必须显式 nameType 检查
4. **compoundCommandHasCd 三套并存**——Bash `compoundCommandHasCd` / PS `hasCdSubCommand` / PS `isCwdChangingCmdlet`(含 Set-Location / Push-Location / Pop-Location / New-PSDrive / `ndr`(alias))。Bash 加 pushd/popd 时 PS 也要同步 COMMON_ALIASES
5. **`$` token 检查双端**——Bash 在 `readOnlyValidation.ts` 拒 `$` token,PS 用 `argLeaksValue` + `isAllowlistedCommand` 的 elementTypes 白名单 + children[] 树查询达到同效果
6. **stripWrappersFromArgv 双份**——`pathValidation.ts` canonical 版 + `bashPermissions.ts` dead-code 副本(Bun feature() DCE 悬崖导致不能删,PR #21503 round 3 验证 30/30 → 22/30 fail)。修改 canonical 必须手动同步副本
7. **PowerShell tokenizer 4 字符 dash 规范化**——出现 5 处(`psExeHasParamAbbreviation` / `isPowerShellParameter` / `isAllowlistedCommand` flag check / `isItemTypeParamAbbrev` / step 5 Set-Location target),新增任何参数解析点都要查 `PS_TOKENIZER_DASH_CHARS`
8. **canonical 命令名归一化白名单 vs 黑名单**——`filterRulesByContentsMatchingInput` 中 `stripModulePrefix` 对 deny/ask 适用(over-match 安全),对 allow 不适用(over-match 是 fail-open)
9. **PIPELINE_TAIL_CMDLETS + SAFE_OUTPUT_CMDLETS 演进**——原 SAFE_OUTPUT 含十几个 cmdlet 因 calculated-property hashtable 攻击全迁出到 CMDLET_ALLOWLIST。任何"name-only 安全分类"新增 cmdlet 前必须审计该 cmdlet 是否接受 hashtable/scriptblock
10. **archive extractor + git 复合 TOCTOU**——PowerShell 在 `GIT_SAFETY_ARCHIVE_EXTRACTORS` 显式拦,Bash 应有对称防御

### 10.45 补读后的新待确认问题

5 个新问题(原 §8 之外):

1. **`ANT_ONLY_SAFE_ENV_VARS` 在 ant build 之外如何被剔除?**——bun bundle 时是 dead-code-eliminate 还是 runtime check?如果 runtime,内部用户 ant flag 一旦泄漏就开 27 个 dangerous env
2. **`parseForSecurity` 在 `src/utils/bash/ast.ts` 缺失**——主路径无法验证 simple/too-complex 的精确判定边界
3. **`SAFE_ENV_VARS` 的 27 个具体名单**——在 `utils/managedEnvConstants.js` 缺失,只看到 `TrustDialog/utils.ts` 调用 `!SAFE_ENV_VARS.has(key.toUpperCase())`,无法验证具体哪 27 个
4. **`CLM` (Constrained Language Mode) 完整规范**——`clmTypes.ts` 列了 allowed type literals 但 CLM 完整禁用清单(reflection、type accelerators、Add-Type 等)需要 PS 文档对照
5. **`gitOperationTracking` 上报频率与去重**——pre-flight sentinel 之外,正常 git 命令是否每次都上报还是按 session 聚合?未知

---

**下一步**:M05 Model API client(`services/api/claude.ts` 3419 行),聚焦 Anthropic SDK 的封装、retry/重连、stream 处理、prompt caching、multi-region failover、token counting、stop_reason 调度、headers 注入(含 OTel/extras)。
