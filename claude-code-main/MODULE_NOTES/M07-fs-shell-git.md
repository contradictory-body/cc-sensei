# M07 文件系统 / Shell / Git 工具集(FS-Shell-Git)

> 范围:
> - **文件 IO 工具**:`src/tools/FileReadTool/`、`src/tools/FileEditTool/`、`src/tools/FileWriteTool/`、`src/tools/NotebookEditTool/`
> - **检索工具**:`src/tools/GlobTool/`、`src/tools/GrepTool/`
> - **Shell 工具**:`src/tools/BashTool/`(POSIX) + `src/tools/PowerShellTool/`(Windows)
> - 工具内的安全/权限/路径/沙箱判定全部归此模块(M04 中只触及决策"框架",具体规则在这里)
>
> ⚠️ 与 M04 的边界:M04 = "通用决策流"(谁问、5 路 race、UI、logging);M07 = "每个工具针对其语义的具体规则"。`bashSecurity.ts`、`bashPermissions.ts`、`PowerShellTool/*` 是规则池本身,逻辑容量上比 M04 的决策骨架还大。
>
> ⚠️ `src/utils/` 仍然完整缺失,本节中所有 `utils/permissions/*`、`utils/bash/*`、`utils/powershell/parser.ts`、`utils/fileHistory.ts`、`utils/path.ts`、`utils/fsOperations.ts` 等都只能从调用方推断契约。

## 1. 模块定位

把"模型可以无副作用地把全宇宙都搞坏"压缩到"模型可以高效完成软件工程任务,但任何 IO 都经过几层人形守门员"。

需要解决的 5 类工程问题:

1. **静态判定 vs 运行时副作用** — 验证器在文件读写之前运行,而 PowerShell/Bash 的求值在运行时;凡是 validator 看到的字符串 ≠ 真实执行的指令,都是潜在 0-day。整个模块的 70% 复杂度都在追这种**"解析器差异(parser differential)"**。
2. **deny > ask > allow > passthrough 的四级优先级** — 不只是名词;是结构性的"一定收集完所有判断再 reduce"的写法(BashTool/PowerShellTool 的 `decisions[]` 数组、`firstAsk` ??=)。
3. **文件新鲜度(staleness)** — 编辑文件之前必须先读;读完后被外部进程改了就 fail closed。`fileHistory` + mtime check 是隐藏的"乐观锁"。
4. **跨工具并发安全** — 同一类工具(只读)可以并发,涉写一律串行;`isConcurrencySafe` 在 M03 已定义,这里是消费方。
5. **平台等价性** — POSIX shell 的每一条安全规则,Windows PowerShell 都要有"形状一致"的实现;反之亦然。`BashTool` 与 `PowerShellTool` 在文件名、函数名、防御项编号上一对一对应(如 `compoundCommandHasCd` ↔ `isCwdChangingCmdlet`)。

## 2. 工具目录全景

| 工具 | 主入口 | 核心特征 |
|---|---|---|
| FileReadTool | `tools/FileReadTool/FileReadTool.ts` | mtime 写入 fileHistory;支持 image/pdf/notebook;`offset`/`limit`/`pages` 分页;大文件读保护 |
| FileEditTool | `tools/FileEditTool/FileEditTool.ts` | 必须先 Read;`old_string` 唯一性强制;`replace_all` 选项;sed-as-edit 检测(BashTool 联动) |
| FileWriteTool | `tools/FileWriteTool/FileWriteTool.ts` | 创建/覆盖;新文件不需要先 Read;覆盖需要 Read 后无外部修改 |
| NotebookEditTool | `tools/NotebookEditTool/NotebookEditTool.ts` | `.ipynb` cell 级编辑;支持 replace/insert/delete;输出剥离与重建 |
| GlobTool | `tools/GlobTool/GlobTool.ts` | ripgrep `--files` 路径过滤;mtime 排序;CWD 默认值 |
| GrepTool | `tools/GrepTool/GrepTool.ts` | ripgrep 包装,3 种 output_mode(content/files/count);multiline 标记;`-A/-B/-C` 上下文 |
| BashTool | `tools/BashTool/BashTool.tsx`(+ 7 个支撑文件) | tree-sitter AST 解析;多层权限规则;sandbox;持久 shell 会话;后台任务 |
| PowerShellTool | `tools/PowerShellTool/PowerShellTool.tsx`(+ 14 个支撑文件) | PowerShell AST(.NET 解析器外置);24 个安全检测器;CLM 类型白名单;git 安全 |

## 3. 关键文件分类详解

### 3.1 文件 IO 工具 — 编辑前置约束与"乐观锁"

**`FileReadTool.ts`** 的隐藏副作用是**把 mtime 注入 `fileHistory`**(`utils/fileHistory.ts` 不可见,从调用方推断):
- 调用方:`recordFileRead(filePath, mtime)`。
- 这条记录是 FileEditTool/FileWriteTool 检查"用户/外部进程是否在我读之后改动过文件"的乐观锁基准。

**`FileEditTool.ts`** 的契约(从 Tool description 反推 + 调用流推断):
- **must-read-first**:`fileHistory` 没有该文件 → fail closed,提示"请先用 Read"。
- **old_string 唯一性**:如果 `old_string` 在文件里有多处匹配 → fail,要求要么扩展上下文使之唯一,要么 `replace_all: true`。
- **行号前缀剥离**:Read 工具返回的 `cat -n` 格式行号必须从 `old_string`/`new_string` 里剥掉,否则匹配失败(这是用户/模型的共同教训点)。
- 与 `sedEditParser.ts`(BashTool)联动:模型如果想用 `sed` 改文件,会被 BashTool 重写成 "用 FileEditTool 替代"的建议,避免绕过 fileHistory 锁。

**`FileWriteTool.ts`** 区分两类写:
- **新建**:不需要 fileHistory 记录(没人能"在我之前改过它"——因为它不存在)。
- **覆盖**:必须有 fileHistory + 当前 mtime 与记录一致。stale → 强制重新 Read。

**`NotebookEditTool.ts`** 处理 `.ipynb` 的 5 个特殊场景:
- `cell_number` 0-indexed,与 cell_id 二选一。
- `edit_mode`:`replace`(默认)/`insert`/`delete`。
- cell 类型(`code`/`markdown`)在 insert 时必填。
- **输出剥离**:写入时主动清空 cell outputs,避免污染 git diff。
- **格式保持**:重新写出 `.ipynb` 时保留原文件的 json 缩进风格(防止整文件 diff)。

### 3.2 检索工具 — 都是 ripgrep 的薄包装

**`GlobTool`** ≈ `rg --files --glob <pattern>` + 按 mtime 排序:
- 默认 cwd,可选 `path` 参数。
- 大量结果时不分页(模型自己控制 pattern 收敛)。
- **mtime 排序**的原因:"最近改动的文件最可能与当前对话相关"——直接做了 LRU 启发式。

**`GrepTool`** = 把 ripgrep 70% 的功能抽出来,扁平化成参数:
- 3 种 `output_mode`:`content`(grep -n)/`files_with_matches`(默认)/`count`。
- `-A`/`-B`/`-C` 仅在 content 模式下生效。
- `-i`/`-n`/`-o` 一组 boolean。
- `multiline: true` 启用 `rg -U --multiline-dotall`,用于 `struct \{[\s\S]*?field` 这类跨行 pattern。
- `head_limit` 默认 250(防上下文爆炸);`offset` + `head_limit` 组合等价于 `| tail -n +N | head -N`。
- 注释里特别提醒:`interface\{\}` 要写成 `interface\\{\\}`(ripgrep PCRE2,字面 `{` 需要转义)。

⇒ **设计精髓**:把"模型熟悉的 CLI 概念"(grep)直接做成结构化参数,而不是让模型自己拼 shell。这避免了"模型不小心用了 zsh 才有的 `(P)`" 这种工具偶发失败。

### 3.3 Shell 工具的双轨架构 — BashTool / PowerShellTool

#### 3.3.1 平台拓扑

- 进程启动时 `getShellPreference()`(在 utils,不可见)决定 BashTool 或 PowerShellTool 哪个被注册到 `getTools()`(在 `tools.ts` 中条件 import)。
- Windows 默认 PowerShell;POSIX 默认 Bash;允许显式覆盖。
- 安全规则**逐项对齐**:每个 BashTool 的防御项,在 PowerShellTool 都有对应实现且 inline 注释里互相引用("BashTool parity")。

#### 3.3.2 BashTool 子系统(POSIX)

```
tools/BashTool/
  BashTool.tsx           — 主入口,持久 shell + 后台任务编排
  bashPermissions.ts     — 2621 行,规则匹配 + suggestion 生成
  bashSecurity.ts        — 2592 行,命令分类 + 危险标记
  readOnlyValidation.ts  — 1990 行,只读判定与白名单
  pathValidation.ts      — 路径合法性(基于 AST 抽出的路径参数)
  modeValidation.ts      — acceptEdits / bypassPermissions / dontAsk 模式
  shouldUseSandbox.ts    — sandbox-or-not 决策
  destructiveCommandWarning.ts — 显示用警告(不影响判定)
  commandSemantics.ts    — 退出码语义(grep no-match / robocopy bitfield)
  sedEditParser.ts       — sed 命令解析为 FileEditTool 等价物
  ...
```

核心抽象:**tree-sitter 解析 shell** → 抽出 pipeline / 重定向 / 命令链 / 子 shell → 在 AST 上跑规则匹配。
- 拒绝 regex-based 的命令分类(过去多次被引号转义/分号嵌套绕过)。
- 把"命令"定义为 AST 节点(`SimpleCommand` / `Pipeline` / `Subshell` / `ProcessSubstitution`),不是字符串。
- 子 shell 必须递归校验(`if ; then cmd; fi` 内部的 `cmd` 也要走完整规则链)。

#### 3.3.3 PowerShellTool 子系统(Windows)

```
tools/PowerShellTool/
  PowerShellTool.tsx           — 1000 行,主入口,会话/后台/64MB 持久化
  powershellSecurity.ts        — 1090 行,24 个安全检测器(check* 函数链)
  powershellPermissions.ts     — 1648 行,collect-then-reduce 决策流
  readOnlyValidation.ts        — 1823 行,cmdlet 白名单 + 外部命令分发
  pathValidation.ts            — 2049 行,CMDLET_PATH_CONFIG + 路径校验
  modeValidation.ts            — 404 行,acceptEdits 模式专用校验
  gitSafety.ts                 — 176 行,bare-repo HEAD + git-internal 攻击
  destructiveCommandWarning.ts — 109 行,显示用警告
  commandSemantics.ts          — 142 行,robocopy/grep/findstr 退出码
  clmTypes.ts                  — 211 行,Constrained Language Mode 类型白名单
  commonParameters.ts          — 30 行,COMMON_SWITCHES + COMMON_VALUE_PARAMS(打破 import 循环)
```

#### 3.3.4 PowerShellTool 主入口(`PowerShellTool.tsx`)

- **`MAX_PERSISTED_SIZE = 64 * 1024 * 1024`**(64 MB)— 大输出通过 `link()` → `copyFile()` 回退方式落到 `tool-results/` 目录,引用回模型;BashTool 同款逻辑同款常量。
- **`runPowerShellCommand`** 是 AsyncGenerator:
  - 预检失败返回 `code:0`(stderr 友好降级,避免硬错误打断 agent loop)。
  - `spawnShellTask` 通过 `Shell` 工具助手启动 — 共享 BashTool 的会话注册表(`backgroundExistingForegroundTask`)。
  - `feature('KAIROS') && getKairosActive() && isMainThread` 时,执行超过 `ASSISTANT_BLOCKING_BUDGET_MS = 15s` 自动转后台。
- **resolveProgress 信号** — 通过 `Promise.race` 把生成器的"等下一个 chunk" 与 "刚被后台化"事件捆绑,避免 setTimeout 轮询。
- **race condition**:任务在"刚完成"和"被标记后台化"之间的窗口,通过设置 `backgroundTaskId` 后再重建 `outputFilePath` + `markTaskNotified` 处理。
- **`resizeShellImageOutput`**:当图像输出解析失败,**主动把 `isImage` 设回 false**,让 `mapToolResultToToolResultBlockParam` 走文本分支——保持 UI 标签真实。

#### 3.3.5 24 个安全检测器(`powershellSecurity.ts`)

`powershellCommandIsSafe` 是 24 个 `checkXxx` 函数的有序链;**第一个返回 'ask' 的赢**(short-circuit)。这是"枚举出有这么多攻击面"本身就是一份威胁建模文档。

| # | 检测器 | 防御对象 |
|---|---|---|
| 1 | `checkInvokeExpression` | `Invoke-Expression` / `iex` — 任意代码 eval |
| 2 | `checkDynamicCommandName` | `& $cmd` 形式(命令名是变量) |
| 3 | `checkEncodedCommand` | `-EncodedCommand <base64>` — 隐藏内容 |
| 4 | `checkPwshCommandOrFile` | 嵌套调用 `pwsh -Command` / `-File`(绕过外层校验) |
| 5 | `checkDownloadCradles` | `(New-Object Net.WebClient).DownloadString(...) | iex` |
| 6 | `checkDownloadUtilities` | `Start-BitsTransfer` / `certutil -urlcache` / `bitsadmin /transfer`(LOLBAS 下载) |
| 7 | `checkAddType` | `Add-Type -TypeDefinition '<C#>'` — 编译执行任意 .NET |
| 8 | `checkComObject` | `New-Object -ComObject Shell.Application` — COM 自动化 |
| 9 | `checkDangerousFilePathExecution` | `Invoke-Command -FilePath ./script.ps1` |
| 10 | `checkInvokeItem` | `Invoke-Item` — 用默认程序打开(可触发 lnk/url 利用) |
| 11 | `checkScheduledTask` | `Register-ScheduledTask` / `schtasks /create` — 持久化 |
| 12 | `checkForEachMemberName` | PS7+ `ForEach-Object Kill`(positional MemberSet binding) |
| 13 | `checkStartProcess` | `Start-Process -Verb RunAs`(提权)或 `Start-Process pwsh ...` |
| 14 | `checkScriptBlockInjection` | scriptblock 内嵌任意代码 |
| 15 | `checkSubExpressions` | `$(...)` 子表达式求值 |
| 16 | `checkExpandableStrings` | `"$($x)"` 内插入子表达式 |
| 17 | `checkSplatting` | `@params` 参数展开 |
| 18 | `checkStopParsing` | `--%` 之后原样传给原生命令 |
| 19 | `checkMemberInvocations` | `$obj.Method()` — 任意 .NET 方法 |
| 20 | `checkTypeLiterals` | `[Type]::Method()` — 静态调用 |
| 21 | `checkEnvVarManipulation` | `$env:PATH = 'evil'` |
| 22 | `checkModuleLoading` | `Import-Module evil` |
| 23 | `checkRuntimeStateManipulation` | `Set-Alias`/`New-Alias`/`Set-Variable` — 篡改后续解析 |
| 24 | `checkWmiProcessSpawn` | `Invoke-WmiMethod ... -Name Create` — 隐式生成进程 |

**针对 #6 的 LOLBAS 列表**(`DOWNLOADER_NAMES`):`invoke-webrequest`, `iwr`, `invoke-restmethod`, `irm`, `new-object`, `start-bitstransfer`。

**针对 #8 的关键防御** — `checkComObject` 提取 `-TypeName` 后过 CLM(Constrained Language Mode)类型白名单(`clmTypes.ts` 中的 `CLM_ALLOWED_TYPES`,~90 个 .NET 类型);**显式删除**了 `adsi`/`adsisearcher`(LDAP 网络绑定)、`wmi`/`wmiclass`/`wmisearcher`/`cimsession`(WMI/CIM 远程)、`DirectoryEntry`/`DirectorySearcher`/`ManagementObject`/`ManagementClass`/`ManagementObjectSearcher`(同样危险的全限定名)。

**针对 #11 的命令名集**(`SCHEDULED_TASK_CMDLETS`):`register-scheduledtask`/`new-scheduledtask`/`set-scheduledtask` + `schtasks /create` 或 `/change` 或 `-create` 或 `-change`(模型可能省略 `/`)。

**针对 #13 的两个向量**:
- Vector 1:`-Verb RunAs` — 空格分隔(`children[]` 结构化检查) + 冒号绑定(`-Verb:'RunAs'`/`-Verb:"RunAs"`/反引号转义)— 通过 regex fallback 兜底。
- Vector 2:`Start-Process` 目标是 PS 可执行 — 接受已知误报 `-WorkingDirectory C:\projects\pwsh`(路径中含 pwsh 字面值但不是真的执行 PowerShell)。

**`checkForEachMemberName`**(#12)— PS7+ 引入 positional MemberSet binding:`Get-Process | ForEach-Object Kill` 等同于 `ForEach-Object -MemberName Kill`,会调用每个进程的 `.Kill()` 方法。这种"看起来像参数,实际上是方法名"的语法是新近(2022 年后)的攻击面。

#### 3.3.6 路径解析的"PowerShell 几何学"(`pathValidation.ts` + `gitSafety.ts`)

PowerShell 路径有**11 种伪造方式**,validator 需要每一种都覆盖:

1. **驱动器前缀**:`C:foo`(drive-relative,不等于 `C:\foo`)→ 必须用负向 lookahead `[a-z]:(?!\\|/)` 剥掉。
2. **Provider 前缀**:`FileSystem::/etc/passwd` → 剥到 `::` 之后。
3. **完全限定模块前缀**:`Microsoft.PowerShell.Core\FileSystem::/etc/passwd` → 同样剥到 `::`。
4. **反引号转义**:`` /e`t`c/passwd `` → 静态不可解析,treat as unvalidatable(deny 规则做"猜测匹配"兜底)。
5. **NTFS 8.3 短名**:`GIT~1`/`GIT~2`(老 Windows 兼容名)→ 用 `/^git~\d+($|\/)/` 显式 catch。
6. **NTFS 每段尾部空格/点**:`.git ` 与 `.git` 在 NTFS 上等价 → do/while 循环剥到稳定。
7. **POSIX vs Windows 路径分隔**:`\` 在 Linux 是字面字符,在 Windows 是分隔符 → 统一转换 `\` → `/` 后再 `posix.normalize`。
8. **Provider 路径 vs 文件路径**(`providerPathRegex`):
   - Windows:`^[a-z0-9]{2,}:/i`(2+ 字符才算 PSDrive,排除 `C:`/`D:` 等原生 drive letter)。
   - POSIX:`^[a-z0-9]+:/i`(单字符也算 PSDrive — `New-PSDrive Z /etc; Get-Content Z:/shadow` 攻击)。
9. **UNC 路径**:`//server/share` 或 `\\\\server\\share`(可触发 NTLM/Kerberos 凭证泄露)→ 直接拒绝。
10. **DavWWWRoot / @SSL@**:UNC 的 WebDAV 变体 → 同样拒绝。
11. **变量插入**:路径里包含 `$` 或 `%` → 拒绝(运行时展开后不可知)。

**glob 模式特殊处理**:
- 写操作里出现 `*?[]` → 拒(过 deny 规则前)。
- 读操作 + glob + `..` 路径回溯 → 先解析整条 path 再校验(防 `/project/*/../../etc/shadow`)。
- 读操作 + glob 但无回溯 → 只对 glob base directory(第一个 glob 字符前的最后一个 `/`)做 deny 规则匹配,匹配失败 force ask("glob 里的 symlink 无法静态验证")。

**`gitSafety.ts` 的两类攻击**:

1. **Bare-repo HEAD 攻击**:当前目录下放一个伪造的 `HEAD`/`objects/`/`refs/`/`hooks/`(bare repo 文件结构),后续 `git` 命令会把 cwd 当成 git 仓库读 — 攻击者可注入恶意 hooks。防御:`isGitInternalPathPS` 检测 13 个 write cmdlet(`GIT_SAFETY_WRITE_CMDLETS`)+ 14 个 archive extractor(`GIT_SAFETY_ARCHIVE_EXTRACTORS`,如 `tar`/`unzip`/`7z`/`Expand-Archive` — 这些可在 git 命令前完成解压,**TOCTOU**)是否往这些路径写。
2. **`.git/` 写攻击**:`.git/hooks/pre-commit` 等 — 即使**没有任何 git 子命令**,模型下次提交时 hook 自动跑;所以 `.git/` 写一律 ask。

**`normalizeGitPathArg` 的 10 步标准化链**(实际是为了让所有比较都在同一空间下进行):
```
dash/slash 前缀剥 → 引号剥 → 反引号剥 → provider 前缀(FileSystem::)
→ drive-relative(C:foo)剥 → \ → /
→ NTFS 每段(空格→剥;`.`/`..` 短路 return;dot 剥)循环至稳定
→ posix.normalize → 开头 ./ 剥 → lowercase
```

**`resolveEscapingPathToCwdRelative` 是 SOLE 守卫**:针对 `../bare-repo/HEAD` 这种"用 ../ 跳出 cwd 再回来"的路径,迭代剥 `../<cwd-basename>/` 对,直到不再变化。

#### 3.3.7 acceptEdits 模式的"四限定准"(`modeValidation.ts`)

在 acceptEdits 模式下,**自动批准**的范围被收得极窄(只 4 个 cmdlet):
```ts
ACCEPT_EDITS_ALLOWED_CMDLETS = ['set-content', 'add-content', 'remove-item', 'clear-content']
```
原因:这 4 个都是"第一个 positional 参数 = `-Path`",其他参数都有明确语义,**容易完整验证**。`new-item`/`copy-item`/`move-item`/`rename-item` 等 Tier 3 cmdlet 参数绑定更复杂(`-Name` 可能 relative-to-Path 而非 cwd),**让它们 fall through 到 ask**。

acceptEdits 模式的 4 条额外门禁:

1. **不能含任何子表达式/scriptblock/member 调用/splatting/赋值/stop-parsing/expandable string**(直接 passthrough)。
2. **compound 命令里如果有 cwd-changing 命令** + **任意 write 命令** → 拒(`Set-Location ./.claude; Set-Content ./settings.json '...'` 攻击)。
3. **compound 命令里如果创建符号链接**(`New-Item -ItemType SymbolicLink`/`Junction`/`HardLink`)→ 拒。**没有** `hasWriteCommand` 条件 — 因为 read-through-symlink 也是攻击面(`Get-Content ./link/etc/shadow`)。
4. **每个命令的 elementTypes 只允许 `StringConstant`/`Parameter`**;`Variable`/`Other`(Hashtable)/`SubExpression` 都意味着运行时求值,fail closed。

**`isSymlinkCreatingCommand`** 的"参数缩写"处理:
- PowerShell 允许参数缩写(`-it` 即 `-ItemType`)。
- 最短前缀:`-it`(避免 `-Item*` 系列其他参数冲突)、`-ty`(避免 `-t`/`-Target` 冲突)。
- 同时处理 unicode dash(`–`/`—`/`―`/U+2013/2014/2015)和 PS 5.1 的 `/` 参数前缀。

#### 3.3.8 cmdlet 白名单(`readOnlyValidation.ts` 的 `CMDLET_ALLOWLIST`)

约 50 个 cmdlet 被分类为只读;每个都附带 `safeFlags`(允许的标志)或 `allowAllFlags`(全部允许,适用于 `where.exe` 之类)+ 可选 `additionalCommandIsDangerousCallback`(参数级深度校验)。

**用 `Object.create(null)` 创建** — 防止 `constructor`/`__proto__` 这种 prototype-chain pollution(模型如果拼出 cmdlet 名 `"constructor"`,Object.prototype 会让它命中)。

**`argLeaksValue` 2 层防御**(为所有"看起来无害但能 leak 参数到 stdout"的 cmdlet 使用):
1. `elementTypes` 白名单(只接受 `StringConstant`/`Parameter`)。
2. 冒号绑定参数(`-InputObject:$env:SECRET`)→ 查询 parser 的 `children[]` 树;无 children 时 fallback 用 `/[$(@{[]/` 正则匹配冒号后的文本。

**关键 SECURITY 移除项**(每个都附带攻击向量的注释):
- `Select-Xml` — XXE 网络请求(DOCTYPE SYSTEM/PUBLIC)。
- `Test-Json` — `-Schema`(positional 1)JSON Schema `$ref` 网络取值;safeFlags 只验证显式 flag,positional 绑定绕过。
- `Get-Command` / `Get-Help` — `-Name`(`ValueFromPipeline=true`)触发模块自动加载(pipeline input 绕过 arg 级 callback)。
- `Get-WmiObject` / `Get-CimInstance` — `Win32_PingStatus` 枚举时发 ICMP;远程 `-ComputerName`;provider DLL autoload。
- `Get-Clipboard` — 敏感数据暴露(对齐 bash 的 `pbpaste`/`xclip` 拒)。
- `Join-Path` / `Split-Path` 的 `-Resolve` — 触摸文件系统验证联合路径存在性,无路径校验。
- `Get-WinEvent` 的 `-FilterXml` / `-FilterHashtable` — XXE;`-ComputerName` / `-Credential` 隐式排除。
- `Get-DnsClientCache` 的 `-CimSession` — 远程主机连接。

**`SAFE_OUTPUT_CMDLETS` 只剩 `out-null`** — 老版本里 `out-string`/`out-host` 也在,但发现 `Get-Process | Out-String -InputObject $env:SECRET` 能 leak,**全部迁移到 `CMDLET_ALLOWLIST` 并加 `argLeaksValue` 回调**。
- `format-table`/`format-list`/`format-wide`/`format-custom`/`measure-object`/`select-object`/`sort-object`/`group-object`/`where-object`/`out-string`/`out-host` 全部如此(都接受 calculated-property hashtable 或 scriptblock predicate)。
- **`ForEach-Object` 不在 `SAFE_SCRIPT_BLOCK_CMDLETS`** — 因为它的 block 是任意代码而非 predicate。

**`SAFE_EXTERNAL_EXES = new Set(['where.exe'])`**(bash `which` 的等价物):
- `where.exe` 路径中含 `.` → `nameType='application'` 通常会被拒。
- 但允许通过 **匹配 cmd.text 第一个 token**(不是 stripModulePrefix 后的 cmd.name)— 防止 `scripts\where.exe` 这种本地脚本伪装。

#### 3.3.9 外部命令的细粒度规则

**git** — `isGitSafe`:
- 任何参数含 `$` → 拒(`git diff $VAR` where `$VAR='--output=/tmp/evil'` 攻击)。
- `DANGEROUS_GIT_GLOBAL_FLAGS`:`-c`/`-C`/`--exec-path`/`--config-env`/`--git-dir`/`--work-tree`/**`--attr-source`**(创建 parser differential — 验证器看到 `git --attr-source HEAD~10 log status` 跳 2 个,git 把 `log` 当作 pathspec 然后跑 `status`)。
- `DANGEROUS_GIT_SHORT_FLAGS_ATTACHED = ['-c', '-C']`:前缀匹配(`-ccore.pager=sh log` 会启动 shell)。
- `GIT_GLOBAL_FLAGS_WITH_VALUES`:8 个 value-consuming 全局 flag — **这个集合必须完备**,任何遗漏都会造成 parser differential。
- 多词子命令优先匹配(`git stash list` 优先于 `git stash`)。
- `git ls-remote URL` — 拒(数据外泄向量:把 secret 编码到 hostname → DNS/HTTP 命令外传)。

**gh** — `isGhSafe`:
- `process.env.USER_TYPE !== 'ant'` → 直接拒(只允许 Anthropic 内部用户用)。
- 同样的 `$` blanket rejection。
- 多词子命令(`gh pr view`)。

**docker** — `isDockerSafe`:
- `$` rejection 放在 fast-path 之前(老 bug:`docker ps --format $env:SECRET` 走 fast-path 绕过)。
- `EXTERNAL_READONLY_COMMANDS` fast-path(`docker ps`/`docker images`)。
- `DOCKER_READ_ONLY_COMMANDS`(`docker logs`/`docker inspect`)走 per-flag config。

**dotnet** — `isDotnetSafe`:
- 极简:任何参数不在 `DOTNET_READ_ONLY_FLAGS = {--version, --info, --list-runtimes, --list-sdks}` → 拒。

#### 3.3.10 决策聚合(`powershellPermissions.ts`)

核心模式:**collect-then-reduce**(从 BashTool 移植)。

```
powershellToolHasPermission:
  decisions: PermissionResult[] = []
  
  Step 1: parse 失败 → fallback dangerous-removal hard-deny
  Step 2: 模式校验(checkPermissionMode)→ push
  Step 3: git safety(bare-repo + .git/ + archive)→ push
  Step 3.5: provider 路径(env:/HKLM:/HKCU:/...)→ push
  Step 4: 路径校验(checkPathConstraints)→ push
  Step 5: 每个子命令循环:
    - 过滤 safe-output / cd-to-CWD(no-op)
    - 检查 deny rule → push
    - 检查 ask rule → push
    - 检查 allow rule + nameType + argLeaksValue + hasSymlinkCreate gate → push
    - fail-closed gate via isProvablySafeStatement + statementsSeenInLoop
  
  reduce: deny > ask > allow > passthrough(返回最严重的)
```

**关键设计要点**:

- **`statementsSeenInLoop` 只在 push 时记录**(不在 continue 时记录)— 防止"其他子命令有 allow 规则 continue 通过,导致 `$env:SECRET` 这种 bare variable 也被自动 allow"的逻辑漏洞。
- **空 `subCommandsNeedingApproval` + `hasScriptBlocks`** → 不能 auto-allow(`Where-Object {$true} | Sort-Object {$env:PATH='evil'}` 攻击)。
- **空格归一化** `rest = command.slice(rawCmdName.length).replace(/^\s+/, ' ')` — 防止 `rm\t./x` 用 tab 分隔绕过 `Remove-Item:*` deny 规则。
- **`stripModulePrefixForRule` asymmetric**:deny/ask 通过 secondary canonical match 拓宽匹配(over-match 安全);allow **不** 拓宽(over-match 会 fail-open)。
- **`hasCdSubCommand` 要求 `allSubCommands.length > 1`** — 单独的 `cd` 不是 TOCTOU 风险。
- **`hasSymlinkCreate` 串到所有 auto-allow 路径**。
- **`.git/` 写在没有 git 子命令时也 ask** —— 模型可能"先写 hook,再让你下次手动 commit"。

**parse-failed 兜底**(语法解析失败时不直接 fail-open):
1. 反引号剥(`/`[\r\n]+\s*/g`,然后 ` /```/g `)
2. 拆 `[;|\n\r{}()&]+`
3. 归一 `PS_ASSIGN_PREFIX_RE` / dot-source(`. ./script.ps1`)
4. parse-independent dangerous-removal hard-deny via `resolveToCanonical` + `isDangerousRemovalRawPath` + `dangerousRemovalDeny`

### 3.4 cmdlet 路径参数配置(`CMDLET_PATH_CONFIG`)

每个 file-touching cmdlet 都有 schema:
```ts
type CmdletPathConfig = {
  operationType: 'read' | 'write' | 'create'
  pathParams: string[]                  // -Path / -LiteralPath / -PSPath / -LP 等
  knownSwitches: string[]               // -Recurse / -Force(不消费下一个 arg)
  knownValueParams: string[]            // -Encoding UTF8(消费下一个,不验证为路径)
  leafOnlyPathParams?: string[]         // -Name(相对于 -Path,不是 cwd)
  positionalSkip?: number               // iwr 的 positional-0 是 URL 不是路径
  optionalWrite?: boolean               // iwr 没 -OutFile 时只走 pipeline,不是 write
}
```

**18 个写 cmdlet** + **15 个读 cmdlet** 被配置;其余的 cmdlet 走 fall-through。

设计要点:
- **任何 `-Param` 不在三个集合里(switch / value / path)** → `hasUnvalidatablePathArg = true` → 强制 ask。这结束了"KNOWN_SWITCH_PARAMS whack-a-mole"(每漏一个 switch,unknown 启发式会吞下一个 positional path)。
- **`-PSPath` 和 `-LP` 一定要在 `pathParams` 里**,否则 colon syntax(`-PSPath:/etc/x`)会 fall through 到 unknown-param 分支,path 被困在 single token 内,`paths=[]`,deny 规则不再咨询。
- **`leafOnlyPathParams`** 处理 `New-Item -Name`:value 包含 `/`、`\`、`.`、`..` → 强制 ask(因为 validatePath 会针对 cwd 而非 -Path 解析,可能漏 deny)。
- **`-Destination`** 在 `pathParams`:`Copy-Item`/`Move-Item` 的源和目标**两者都被验证**;`operationType='write'` 是有意的"宁错杀"(源语义上是读,但通过 Edit deny 规则统一拦截更安全)。
- **`positionalSkip: 1`** 用于 `Invoke-WebRequest`/`Invoke-RestMethod`:positional-0 是 URL。
- **`optionalWrite: true`** 同上:没 `-OutFile` 就不是 write,跳过"write with no target path"的 forced-ask。

**`isPathAllowed`** 5 层检查(`pathValidation.ts:863`):
1. **deny rules** 总是先检查。
2. **internal editable paths**(plan files / scratchpad / agent memory / job dirs,通过 `checkEditableInternalPath`)— 写操作的 fast-allow。
3. **2.5 safety check**(`checkPathSafetyForAutoEdit`)— 写到 `.git/`、`node_modules/`、`.claude/` 等"dangerous directory" 的强制 ask。
4. **working directory 内 + (读 || acceptEdits 模式)** → allow。
5. **3.5 internal readable paths**(`checkReadableInternalPath`)— 读操作的 fast-allow。
6. **3.7 sandbox write allowlist**(`isPathInSandboxWriteAllowlist`)— 沙箱配置的额外可写目录。
7. **allow rules**。
8. 否则 not allowed。

**`validatePath` 的"deny-guess"模式**:对路径含反引号或 `::`(无法静态解析的形式),先 strip 出"猜测路径",**只拿来匹配 deny 规则**(从不 auto-allow);匹配上就直接 deny,匹配不上 fall-through 到 ask。这个模式在 3 处复用,是"无法精确验证时仍然能 deny 拦截"的妙手。

## 4. 工程精髓(Agent 开发可复用)

### 4.1 Parser differential 是 0-day 的主源头

**所有 validator 必须在 parser 完成后再决策**,绝不基于字符串匹配。`bashSecurity.ts` / `powershellSecurity.ts` 加起来 ~3700 行,90% 是在处理"validator 看到的和 shell 真实执行的不同"——`--attr-source` / `-ccore.pager=sh` / `git rm --force` 子串匹配 / shell 引号嵌套 / unicode dash(`–Path` vs `-Path`)/ NTFS 8.3 短名 / drive-relative `C:foo` / provider `FileSystem::` / 反引号转义 / colon-bound expression。

⇒ **对自研 agent**:任何"通过描述/字符串决定能否调用 tool"的设计在 shell 工具上都会被绕过;**必须** AST 化。

### 4.2 Collect-then-reduce 比早 return 安全

```python
# 错误模式:
if rule_says_allow(cmd): return allow  # 跳过了后续的 deny 检查
if rule_says_ask(cmd): return ask

# 正确模式:
decisions = []
decisions.append(check_mode(cmd))
decisions.append(check_path(cmd))
decisions.append(check_each_subcommand(cmd))
return reduce(decisions, priority=deny > ask > allow > passthrough)
```

**ask-before-deny 整类 bug 被结构性地消除**。这模式在 `powershellToolHasPermission` 与 `bashToolHasPermission` 中显式复用,值得在自研 agent 复刻。

### 4.3 fail-closed gate + statement allowlist 是只读判定的命门

`isProvablySafeStatement` 只对**`PipelineAst` + 每个元素都是 `CommandAst`** 返回 true;其他 AST 类型 fall through 到 false。这是"新语法添加时默认 fail-safe"的写法——PowerShell 未来加任何新 statement 类型,都会被自动拒绝直到验证器跟进。

⇒ **对自研 agent**:把"能不能 auto-approve"建模成 explicit whitelist(白名单 statement shapes),不要写"除了这些 case 都 ok"。

### 4.4 多层 defense-in-depth 的写法

`argLeaksValue` 的 2 层(elementTypes 白名单 + colon-bound children 查询)+ 上游 `deriveSecurityFlags` 检查 + 下游 `validatePath` 的 `$`/`%` 检查 — 同一个攻击向量被**3 处**截获。任何单层失效都不会全垮。

设计准则:**安全检查的代价远低于安全事故的代价**;允许冗余检查,反对优化合并。

### 4.5 文件新鲜度作为"乐观锁"

FileEditTool 的"必须先 Read"机制 + mtime 校验 = 一个分布式系统设计中的乐观锁(optimistic concurrency control)在本地 IO 上的应用:
- **乐观**:大多数情况文件不会被外部进程改动。
- **失败模式明确**:mtime 不匹配 → 强制重新 Read → 模型可见冲突 → 重新决策。
- **没有锁文件**(避免分布式锁的复杂度)。

⇒ **对自研 agent**:任何"读 → 思考 → 写"序列都该考虑加 mtime/etag/hash 乐观锁。

### 4.6 退出码语义化(`commandSemantics.ts`)

`robocopy` 的 exit code 是 bitfield(0-7 = 各种成功;8+ = 失败);`grep`/`rg`/`findstr` 的 1 是"no match"不是 error;`Compare-Object`/`Test-Path` 是 native cmdlet,异常通过 `$?` 而非 exit code。

**deliberately omitted**:`diff`/`fc`/`find`/`test`/`[` — 因为 PS 别名 vs `.exe` 的歧义无法可靠区分。

⇒ **对自研 agent**:tool 的 success/failure 判定不应该用一刀切 `exitCode === 0`;每个外部命令都应该有自己的语义解释器。

### 4.7 平台等价性的"逐项对齐"

POSIX 的每条防御项,在 Windows 都有"形状一致"的实现,且代码注释里互相引用("BashTool parity")。这种**deliberate parity** 比"两套实现各自演化"更易维护,且能让安全审计员只学一套规则。

具体例子:
- `compoundCommandHasCd`(Bash)↔ `isCwdChangingCmdlet`(PS)
- bash 的 ls-remote URL 拒 ↔ PS 的 ls-remote URL 拒(同一代码模式)
- bash 的 `$` blanket rejection ↔ PS 的 `$` blanket rejection
- `BashTool.tsx:1399` 的 cleanup ↔ `PowerShellTool.tsx` 的 shellCommand.cleanup

⇒ **对自研 agent**:有多平台支持时,**先抽象出"防御项编号"**(safe path validation、TOCTOU mitigation、parser differential coverage),再让每个平台实现对应的编号,而不是各写各的。

### 4.8 64MB 输出持久化 + 链接回退

`MAX_PERSISTED_SIZE = 64 * 1024 * 1024`,大输出走 `link()` → `copyFile()` 回退(同盘 link 是 O(1),跨盘 fall back to copy)。模型只看到引用,不直接消耗上下文。

⇒ **对自研 agent**:tool 输出大小必须有上限;超限时落盘 + 引用回模型,而不是直接截断或塞满上下文。

### 4.9 "Tier 4 cmdlet 过严" 是有意的

PowerShell 的 `New-Item`/`Copy-Item`/`Move-Item`/`Rename-Item` 都不在 acceptEdits 自动批准列表,但 cli 用户可以手动 confirm。这是"参数绑定复杂度 → 选择性弃权"的精细取舍:**宁可让用户多按一次回车,也不放过一个 -Name `../../etc/passwd` 攻击**。

⇒ **对自研 agent**:每个 tool 的"自动批准"白名单要分 tier;参数绑定/求值时机复杂的命令默认 ask,不被"为了 UX 流畅而 auto-allow"的诱惑带偏。

### 4.10 `Object.create(null)` 防 prototype pollution

`CMDLET_ALLOWLIST = Object.assign(Object.create(null), {...})`。这是 JS 特有的攻击面(`Object.prototype.constructor` 让所有未定义 cmdlet 名都"命中"白名单)。

⇒ **对自研 agent**:任何"用对象作为 lookup table 而 key 来自用户/模型输入"的场景都要用 `Object.create(null)` 或 `Map`。

## 5. 跨模块联动

- **M03 Tool 系统**:`isConcurrencySafe` 在这里被消费 — 文件读 / Glob / Grep 是 concurrency-safe(可并行),Bash / PS / FileWrite / FileEdit 不是。
- **M04 权限决策**:本模块的 `bashToolHasPermission` / `powershellToolHasPermission` 是 M04 的 `useCanUseTool` 调用链的下游节点。
- **M02 Agent loop**:FileEdit 的 mtime stale 错误最终冒泡到 query.ts,作为 tool error 让模型重读。
- **M06 上下文工程**:大文件 Read 的 64KB cap、Bash/PS 输出 64MB 持久化都直接影响下一轮 LLM 输入大小。
- **M14 Sub-agent**:LocalShellTask 复用 BashTool/PowerShellTool 的 spawn / 持久化机制。

## 6. 待确认问题

1. **`utils/fileHistory.ts` 的具体实现**:从 FileEditTool 的调用契约推断 `recordFileRead(path, mtime)` + `getRecord(path)`,但是否使用 watchdog 监听外部 mtime 变化未知。
2. **bashSecurity.ts 完整规则集**(2592 行)未通读;本笔记基于"模式与 PowerShellTool 对应"的推断。
3. **`shouldUseSandbox.ts`**:Sandbox decision 的具体启发式(哪些命令默认 sandbox,哪些必须非 sandbox)未读全。
4. **`sedEditParser.ts`**:把 `sed -i 's/x/y/' file` 重写成 FileEditTool 等价物的解析逻辑细节。
5. **`utils/permissions/filesystem.ts`**:`checkEditableInternalPath` / `checkReadableInternalPath` / `pathInAllowedWorkingPath` / `matchingRuleForInput` 的内部实现都不可见,只能从调用方推断契约。
6. **`utils/powershell/parser.ts`**:PowerShell AST 解析器(.NET runtime 调用),具体 IPC 协议(stdin/stdout JSON?subprocess?)未读。

## 7. 与 ANALYSIS_INDEX 状态同步

| 项 | 状态 |
|---|---|
| BashTool 主体 | 主路径已扫(160K BashTool.tsx);bashSecurity.ts/bashPermissions.ts 未通读 |
| PowerShellTool 14 文件 | ✅ 通读 |
| FileEditTool / FileReadTool / FileWriteTool / NotebookEditTool | 主入口与契约已读 |
| GlobTool / GrepTool | 主入口已读 |
| `utils/permissions/*` | ❌ 缺失,只能推断 |
| sedEditParser / shouldUseSandbox / commandSemantics | 部分(PS 端通读;Bash 端只读 PowerShell parity 注释引用) |
