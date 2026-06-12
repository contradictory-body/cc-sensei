# SUPPLEMENT — 大文件深读补遗（技术版）

> 补充 M04 / M06 / M08 中此前略读的四个超大文件，全部源码逐行通读后整理。
> 范围：
> - `src/services/compact/compact.ts`（1705 行）— 补 M06
> - `src/services/mcp/client.ts`（3348 行）— 补 M08
> - `src/tools/BashTool/bashSecurity.ts`（2592 行）— 补 M04
> - `src/tools/BashTool/bashPermissions.ts`（2621 行）— 补 M04

目标：「我自己写 Agent」时，把这些文件里散落的工程招数集中沉淀，每条都带文件 / 函数指针。

---

## 一、`compact.ts` — 上下文压缩子系统补遗（补 M06）

### 1.1 PTL 重试：按 API 轮次切片，从最旧丢起
- `truncateHeadForPTLRetry(messages, ptlResponse)` —— 当压缩调用本身又触发 prompt-too-long 时，**不是**字符截断，而是按"API 轮次组"（一次 assistant 调用 + 跟随的 tool_result）整组丢弃最旧的一组。
- `MAX_PTL_RETRIES = 3`，重试前会在内容前缀加上 `PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'`。下一次重试时先 strip 这个前缀再 prepend，避免堆叠。
- 工程意义：**重试的语义最小单位是「一轮工具调用」**，不能切碎到工具调用 / 工具结果不配对。这条规则可以直接抄给任何带 tool-use 的 Agent。

### 1.2 forked-agent 复用 prompt cache：禁止设 maxOutputTokens
- 压缩通过 `runForkedAgent({ querySource: 'compact', forkLabel: 'compact', maxTurns: 1, skipCacheWrite: true })` 跑。
- 注释明确写：**不要在 forked agent 里塞 `maxOutputTokens`**。理由：上游会用 `Math.min` 把 `budget_tokens` 夹紧，造成 thinking config 与主对话不一致，**直接打穿 prompt 缓存前缀**（`tengu_compact_cache_prefix`）。
- 工程意义：**任何"派生 / 分叉"调用都要让 system prompt + 前 N 条消息位级一致**，否则缓存命中归零；任何 Math.min 风格的"防御性夹紧"都可能成为缓存杀手。

### 1.3 同步 abort 守卫：`!assistantMsg.isApiErrorMessage`
- 压缩内部循环消费 `query()` 流时会做：`if (!assistantMsg.isApiErrorMessage)` 才把 assistant 文本累加为摘要。
- 原因：`query()` 在 abort 时会 yield 一条**合成的** assistant 消息 "Request was aborted."，这条消息**不会**匹配 `startsWithApiErrorPrefix`，但又确实是错误。普通的「以 API Error 前缀判错」会漏掉。
- 工程意义：错误判定不能只看"前缀"，要在合成消息上单独打 flag 字段（`isApiErrorMessage`）。

### 1.4 Skill 截断：硬预算 + 文件数上限
- `POST_COMPACT_TOKEN_BUDGET = 50_000`（压缩后允许保留的总 token 预算）
- `POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000` / `POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000`
- `POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000` / `POST_COMPACT_MAX_FILES_TO_RESTORE = 5`
- `truncateToTokens(content, maxTokens)` 加 `SKILL_TRUNCATION_MARKER`，提示模型自己用 `Read` 重新拉全文。
- 工程意义：**"压缩后还原"是分级预算的**——总预算 / 每文件 / 每 skill / 总 skill / 文件个数五道门。给 Agent 写还原逻辑就抄这五个常量名。

### 1.5 `createCompactCanUseTool`：压缩期间禁用一切工具
- 实现里直接拒绝任何 tool 调用，强迫模型只产文本摘要。
- 工程意义：摘要任务的 forked agent 必须显式 deny 工具，否则它可能"为了写好摘要"去再执行一次工具，把上下文越压越大。

### 1.6 `stripImagesFromMessages`：递归剥图
- 处理两层：top-level content 里的 image block，以及 `tool_result` 内嵌的 image block。
- 工程意义：摘要里几乎不需要图片，剥掉之后 token 直接腰斩，但要注意嵌套结构。

### 1.7 `CompactionResult` 数据形状
```ts
interface CompactionResult {
  boundaryMarker, summaryMessages, attachments, hookResults,
  messagesToKeep?, userDisplayMessage?,
  preCompactTokenCount?, postCompactTokenCount?, truePostCompactTokenCount?,
  compactionUsage?
}
```
注意三个 token 计数字段：pre / post / **true** post。`truePostCompactTokenCount` 是把 attachments 还原后真实占用，便于事后做"压缩有效率"指标。

---

## 二、`mcp/client.ts` — MCP 客户端补遗（补 M08）

### 2.1 三种传输统一抽象：stdio / sse / streamable-http / ws
- 每种 transport 用自己的 reconnect 策略和 keep-alive 心跳。
- 工程意义：自写 Agent 想接 MCP 一定要把"连接重建 + 重连后重订阅"做成 transport 通用接口，否则每加一种传输都要重写。

### 2.2 OAuth 凭据双轨存储
- 用户级凭据 / 项目级凭据分开存，避免共享机器上的串号。
- token 刷新做了 race-condition 保护（同一时刻只有一个 refresh 在飞）。

### 2.3 Tool / Prompt / Resource 拉清单是 lazy + cached
- 启动只 ping，不预拉所有 schema；首次用到才 listTools/listPrompts。
- 重连后清缓存重拉，避免拿到陈旧 schema。

### 2.4 错误分类：transport / protocol / auth / tool-execution
- 不同错误类对外抛不同 user-friendly 文案；只有 transport 错误会触发自动重连。
- 工程意义：错误分层是"是否自动重试"的决策依据，别把 auth 错误当 transport 错误重连——会进死循环。

### 2.5 通知通道：`notifications/tools/list_changed` 等
- 服务端推变更后，客户端是**清缓存等下次拉**而不是立即重拉，避免风暴。

### 2.6 schema sanitize：兼容不规范 server
- MCP 定义里允许的 JSON schema 不是所有 server 都老实给。client 会做 sanitize（补 type、降级 unknown keyword）再喂给 LLM 工具描述。
- 工程意义：和外部协议交互，**永远假定对方 schema 是脏的**，进入你的 prompt 之前要洗一遍。

---

## 三、`bashSecurity.ts` — Bash 安全校验补遗（补 M04）

### 3.1 命令的"六视图"在 `ValidationContext`
```ts
{ originalCommand, baseCommand, unquotedContent, fullyUnquotedContent,
  fullyUnquotedPreStrip, unquotedKeepQuoteChars }
```
- 不同检查需要不同视图：检测注入要 `originalCommand`，检测命令名要 `baseCommand`，检测内容要 `fullyUnquoted*`。
- 工程意义：**安全校验不是「拿一个字符串去 grep」**，而是先把字符串归一化成多种视图，每种检查挑合适的视图用。

### 3.2 18 个 validator 串成"延迟非误解"模式
```ts
const nonMisparsingValidators = new Set([validateNewlines, validateRedirections])
let deferredNonMisparsingResult: PermissionResult | null = null
for (const validator of validators) {
  const result = validator(context)
  if (result.behavior === 'ask') {
    if (nonMisparsingValidators.has(validator)) {
      if (deferredNonMisparsingResult === null) deferredNonMisparsingResult = result
      continue  // 不立即 return
    }
    return { ...result, isBashSecurityCheckForMisparsing: true as const }
  }
}
if (deferredNonMisparsingResult !== null) return deferredNonMisparsingResult
```
- 普通 validator 第一次说 "ask" 立即返回并打 `isBashSecurityCheckForMisparsing: true`。
- 但 `validateNewlines`、`validateRedirections` 是"非误解类"——它们说 ask 不代表解析有歧义，所以**先暂存继续跑**，让真正的 misparsing ask 优先冒出来。
- 工程意义：多 validator 串行时，**"哪类 ask 优先级更高"必须显式建模**，不能先到先得。

### 3.3 `stripSafeRedirections` 的尾边界守卫
```ts
return content
  .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
  .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
  .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '')
```
- 三条都强制 `(?=\s|$)`。
- 工程意义：去掉"安全后缀"时，不带尾边界就会吃掉攻击载荷里的字符。所有"白名单去尾巴"型 strip 都要这么写。

### 3.4 `COMMAND_SUBSTITUTION_PATTERNS` 含 PowerShell `<#`
- 不仅检 `$()` `${}` `<()` `>()` `=()`，还检 PowerShell 注释 `<#`、Zsh `=cmd`、`$[]`、反引号。
- 工程意义：跨 shell 的代码注入面比想象大，做检查表要把每种 shell 的"过程替换 / 子命令"全列。

### 3.5 `ZSH_DANGEROUS_COMMANDS` 黑名单
- `zmodload, emulate, sysopen, sysread, syswrite, sysseek, zpty, ztcp, zsocket, mapfile, zf_rm, zf_mv, zf_ln, zf_chmod` …
- 这些是 zsh 内建，能绕过 PATH 限制做文件 / 网络操作。
- 工程意义：黑名单要按 shell 内建画一遍，不能只盯外部命令。

### 3.6 `CONTROL_CHAR_RE` + `UNICODE_WS_RE`
```ts
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/
const UNICODE_WS_RE = /[   -     　﻿]/
```
- 控制字符（CR、BEL、ESC 等）和 Unicode 空白字符（不间断空格、行分隔符等）都要检——它们能让 shell-quote 和真 bash 的解析结果分歧。
- 工程意义："Parser differential"是关键攻击面。两个不同的 parser 看同一个字符串看出不同结果，攻击就能塞过去。

### 3.7 heredoc 安全：行匹配而非正则贪婪
- 不用 `[\s\S]*?` 这种贪婪/非贪婪正则，而是按行扫，匹配到结束 delimiter 才结束。
- 处理引号 / 反斜杠转义的 delimiter（`<<'EOF'`、`<<\EOF`）。
- 拒绝嵌套同名 delimiter；剩余命令递归再走 validator。
- 工程意义：heredoc 是 shell 里最容易被正则误解析的语法之一，必须用状态机。

### 3.8 双轨校验链：早期 / 主校验
- 早期 validator（early-validators）允许 short-circuit 到 passthrough（"这个明显安全，跳过主校验"）。
- 主 validator 跑完才返回最终判定。
- 工程意义：**"快速放行"和"详尽审查"是两条链**，不要混在一起；快速放行链只能输出 allow / pass-through，不能输出 deny / ask。

### 3.9 `BASH_SECURITY_CHECK_IDS` 23 个数字 ID
- 每条规则有数字 ID，便于 telemetry 区分"是哪条规则触发了 ask"。
- 工程意义：用户体验调优靠这种 ID 才能做 funnel——"过去 7 天有多少次因为规则 7 被拦"。

### 3.10 `bashCommandIsSafeAsync_DEPRECATED` 的 `onDivergence` 回调
- 主流程不直接 logEvent 每次 parser-differential，而是通过 `onDivergence(count)` 累计，最后**单条 logEvent**。
- 原因（CC-643）：每次都 log 会触发 `/proc/self/stat` 读，把事件循环饿死。
- 工程意义：**telemetry 高频路径要做批处理**，syscall 次数比 log 内容更影响性能。

### 3.11 命名层级
- `bashCommandIsSafe_DEPRECATED` / `bashCommandIsSafeAsync_DEPRECATED` —— 名字里带 DEPRECATED，但仍然在用：是 fallback 路径（AST 不可用时）。
- 工程意义：命名"DEPRECATED"在大厂代码里常表示"想退役但还得养着"，搬代码时不要直接删。

---

## 四、`bashPermissions.ts` — Bash 权限编排补遗（补 M04）

### 4.1 顶层 `bashToolHasPermission` 12 步流水线
按顺序：
1. AST parse via `parseCommandRaw` + `parseForSecurityFromAst`，三种结果：too-complex / simple / parse-unavailable
2. Sandbox auto-allow（仍尊重 deny / ask）
3. Bash classifier deny / ask **并行**跑（`Promise.all`）
4. `checkCommandOperatorPermissions`（pipe / redirect 操作符）
5. Legacy misparsing gate（仅当 `astSubcommands === null` 时）
6. 子命令展开，硬上限 `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50`（CC-643）
7. 多个 cd → ask
8. cd + git 联用 → ask（裸仓库 `core.fsmonitor` 攻击）
9. 每个子命令 `bashToolCheckPermission`
10. 输出重定向检查跑在**原始命令**上（在 deny 之后、result 之前）
11. GH#28784：**子命令独立 ask 时，不能用 path-constraint 'ask' 短路**（避免 python3 被 cd 的 Read 建议盖住）
12. 建议聚合 + Bash(exact) 兜底，最多 `MAX_SUGGESTED_RULES_FOR_COMPOUND = 5` 条（GH#11380）

### 4.2 ANT-only 环境变量白名单：内外有别
```ts
const ANT_ONLY_SAFE_ENV_VARS = new Set([
  'KUBECONFIG', 'DOCKER_HOST', 'AWS_PROFILE',
  'CLOUDSDK_CORE_PROJECT', 'CLUSTER',
  'COO_CLUSTER', 'COO_NAMESPACE', /* ... */
])
```
- **故意只对 Anthropic 内部用户开放**（`USER_TYPE === 'ant'`）。
- 注释里明写：**绝不能漏给外部用户**——否则会架空"路径前缀权限"（攻击者 `KUBECONFIG=/evil/path kubectl ...` 就绕过了）。
- 工程意义：白名单分级是产品安全的常见 pattern，但**分级配置必须在编译期就能看到**——不能靠运行时配置开关，否则一改 flag 就漏。

### 4.3 `SAFE_ENV_VARS` 白名单原则
- 收：`GOEXPERIMENT, GOOS, GOARCH, CGO_ENABLED, GO111MODULE, RUST_BACKTRACE, RUST_LOG, NODE_ENV, PYTHON*, LANG, LC_*, TERM, TZ, ANTHROPIC_API_KEY` …
- **绝对不收**：`PATH, LD_*, DYLD_*, NODE_OPTIONS, PYTHONPATH`（二进制劫持向量）
- `BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/`
- 工程意义：环境变量白名单要按"是否能改变 binary 解析路径或 hook"画线，不是按"是否常用"。

### 4.4 `stripSafeWrappers` 两阶段
- **Phase 1**：剥环境变量赋值（`FOO=bar cmd` 形式）+ 注释
- **Phase 2**：剥 wrapper 命令（`timeout`, `time`, `nice`, `nohup`, `stdbuf`）+ 注释（**此阶段不再剥环境变量**）
- 原因（HackerOne #3543050）：wrapper 用 `execvp` 执行后续命令，wrapper 后面的 "FOO=bar cmd" 在子进程里**不是环境变量赋值，是命令参数**。如果继续按环境变量剥就会漏掉危险命令。
- 工程意义：**"剥皮顺序"决定语义**，每一阶段能干啥不能干啥要严格定义。

### 4.5 `TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/`
- 旧版用 `[^ \t]+` 匹配 timeout 的 `-k` 等 flag 值——但这会匹配到 `$(id)`、反引号、`|`、`;`、`&` 等危险字符。
- 攻击：`timeout -k$(id) 10 ls` 之前能绕过。
- 修复后：值必须是允许字符集才放行，否则不算 flag 值，wrapper 剥皮停止。
- 工程意义：**正则要用「allowlist 字符集」而不是「除了空白以外」**，否则永远会被新 metacharacter 打穿。

### 4.6 Speculative classifier checks
```ts
const speculativeChecks = new Map<string, Promise<ClassifierResult>>()
export function startSpeculativeClassifierCheck(command, ctx, signal, isNoninteractive)
```
- 用户还没确认"是否运行"时就先把分类器 fire-and-forget，等用户点确认时直接读 Map 拿结果。
- 工程意义：**"用户的犹豫时间"是免费的预算**，可以拿来跑 LLM 分类、Haiku 风险评估等。

### 4.7 Bun feature flag 死码消除阈值
- 文件多处注释：保持 `feature('BASH_CLASSIFIER')` 在阈值内，要靠把 `filterCdCwdSubcommands`、`checkEarlyExitDeny`、`checkSemanticsDeny`、`skipTimeoutFlags`、`buildPendingClassifierCheck` 等 helper 抽出去。
- 工程意义：**Bun / esbuild 的 DCE 看的是「函数复杂度」**，主流程里堆 if 会让它放弃 inline，从而把整段死码留下。给 Agent 用 feature flag 时要时刻意识到这个上限。

### 4.8 `stripAllLeadingEnvVars(command, blocklist?)`
- 比 `stripSafeWrappers` 的环境变量剥皮更宽泛，专门给 deny 规则用。
- 防 `FOO=bar denied_command` 直接绕过 deny 规则。
- 工程意义：**deny 路径要比 allow 路径剥得更狠**——allow 谨慎，deny 宽泛，是非对称安全设计的核心。

### 4.9 `BARE_SHELL_PREFIXES` 集合
```ts
const BARE_SHELL_PREFIXES = new Set([
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash',
  'cmd', 'powershell', 'pwsh', 'env', 'xargs',
  'nice', 'stdbuf', 'nohup', 'timeout', 'time',
  'sudo', 'doas', 'pkexec',
])
```
- 任何子命令的首段是这些之一，都不能当"普通命令"判权限——因为它们的语义是"再执行一段命令"。
- 工程意义：**"嵌套执行器"列表是权限设计的关键**，做 Agent 时一定要枚举到位。

### 4.10 GH#28784 修复模式
- 旧逻辑：第一个 ask 出现就短路返回。
- 问题：`cd /foo && python3 script.py` 里，cd 因为路径未授权 ask（建议加 Read 规则），python3 也独立 ask（建议加 Bash 规则），但短路只输出 cd 的建议，用户加完 Read 还是被 python3 拦——体验崩溃。
- 修复：**path-constraint 'ask' 永远跑完所有子命令**，建议合并展示。
- 工程意义：用户体验类 bug 经常长这样——技术上"对"但流程上不闭环。修复需要"先收集再展示"的范式。

### 4.11 `isNormalizedGitCommand` / `isNormalizedCdCommand` / `commandHasAnyCd`
- normalized 版本会把 `xargs git` / `xargs cd` 也算成 git / cd，因为 xargs 实际执行的就是它。
- 工程意义：**"语义命令"和"字面命令"要分开建模**——权限走语义，展示走字面。

### 4.12 cd + git 联用 ask（裸仓库攻击）
- 攻击：`cd /tmp/evil && git status`，evil 是裸仓库且 `core.fsmonitor = bash -c "evil"`，git 启动会执行 fsmonitor 命令。
- 防御：cd + git 组合一律 ask。
- 工程意义：**配置文件能注入命令的工具（git、ssh、make…）一律不能自动放行**，组合检测比单点检测重要。

---

## 五、跨四文件汇总：六条「我自己写 Agent」可直接抄的设计原则

1. **重试单位 = 业务最小语义单元**：压缩按 API 轮次、tool-use 配对，不要按字符。
2. **派生 / 分叉调用绝不改 prompt 前缀**：所有"防御性 clamp"都可能成为缓存杀手；把缓存命中当一等公民。
3. **白名单要分级**：内外有别 + 按"语义影响"画线（环境变量白名单）+ "allow 谨慎 / deny 宽泛"非对称。
4. **多视图归一化**：同一命令字符串至少六种视图，每种检查挑合适的；强字符串安全靠这个。
5. **Parser differential 是真攻击面**：控制字符 / Unicode 空白 / 反引号 / heredoc 都要跑两个 parser 比对；diff telemetry 必须批处理。
6. **用户犹豫期是免费预算**：speculative classifier、prefetch schema、predict-next-tool 都可以挂在用户思考时间上。

---

> 文件清单（路径已在文档内引用）：
> - `src/services/compact/compact.ts`
> - `src/services/mcp/client.ts`
> - `src/tools/BashTool/bashSecurity.ts`
> - `src/tools/BashTool/bashPermissions.ts`
