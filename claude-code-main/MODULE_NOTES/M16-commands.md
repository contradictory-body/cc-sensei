# M16 · 命令系统 (Slash Commands)

> 范围: `src/commands.ts` (754 行,核心注册表), `src/commands/**/*` (约 100 个子目录),`src/commands/createMovedToPluginCommand.ts` (65 行 plugin 迁移壳层), `src/dialogLaunchers.tsx` (60 行 dialog 包装). 路由层 `src/utils/processUserInput/processUserInput.ts` 在 dump 中**缺失**,只能通过 use-site 推断.

---

## 一、Command 是什么 — 三种类型的统一抽象

### 1.1 三种类型并存

Claude Code 把"用户输入 `/xxx` 后发生什么"分成三类:

| type | 含义 | 例子 |
|------|------|------|
| `local` | 立即执行一段 JS 逻辑,返回文本结果直接放进消息流 | `/version`, `/clear`, `/exit`, `/compact`, `/help`, `/login` |
| `local-jsx` | 启动一个 Ink JSX 对话框,等用户交互后关闭 | `/model`, `/config`, `/permissions`, `/branch`, `/agents`, `/add-dir`, `/init`, `/statusline` |
| `prompt` | 把命令转成一段 system+user prompt 投给模型,让模型按指令工作 | `/commit`, `/review`, `/security-review`, `/advisor` |

这三类**完全不同的执行路径**,但在注册表里共享同一个 `Command` 类型 union — 调用方拿到 `Command` 对象,再 `switch (cmd.type)` 分发. 这是典型的"算法不同但接口一致"的多态设计.

### 1.2 Command 字段

Command 类型在 `src/types/command.ts` (dump 缺失,字段从 use-site 还原):

```ts
type Command = {
  name: string                       // /xxx 里的 xxx
  description: string | (() => string) // 描述,可以是 getter (动态)
  type: 'local' | 'local-jsx' | 'prompt'
  source?: 'builtin' | 'plugin' | 'mcp' | 'bundled' | SettingSource
  loadedFrom?: SettingSource         // 仅 plugin/mcp 时
  immediate?: boolean                // 立即执行,不入 prompt 循环 (/exit, /model)
  isHidden?: boolean | (() => boolean) // 不在 menu 显示
  isEnabled?: boolean | (() => boolean) // 总开关,fresh-per-call
  availability?: 'claude-ai' | 'console' // 认证后端要求
  aliases?: string[]                 // 别名 (/q → /exit)
  argumentHint?: string              // typeahead 提示 "<file>"
  immediateExitOnFail?: boolean
  supportsNonInteractive?: boolean
  disableNonInteractive?: boolean
  // type 相关
  call?: (args, ctx) => Promise<string>          // local
  Component?: React.FC<...>                       // local-jsx
  getPromptForCommand?: (args, ctx) => Promise<...> // prompt
}
```

设计精髓:
- **`description` 既支持字符串也支持 `() => string`**: 静态描述直接给字符串,动态描述 (含 feature flag、登录状态) 用 getter — UI 渲染时统一调 `typeof === 'function' ? d() : d`.
- **`isHidden`/`isEnabled` 同样支持函数形式**: `meetsAvailabilityRequirement(cmd)` 和 `isCommandEnabled(cmd)` 每次菜单查询都 fresh 求值,因为认证状态、feature flag 都可能运行时切换.
- **`source` vs `loadedFrom` 分离**: source 是"种类"(builtin/plugin/mcp/bundled), loadedFrom 是 SettingSource (user/project/local/managed/...) — 一个 user-scope plugin 提供的命令: `source='plugin', loadedFrom='user'`. 双字段允许 UI 既按种类分组,又能显示安装位置.

---

## 二、两级 memoize:模块级 + per-cwd

### 2.1 `COMMANDS()` — 模块级单次构建

`src/commands.ts:280-440` 一长串 `if (feature('XXX')) commands.push(...)` 构建 `_commands` 数组,**只构建一次**:

```ts
let _commands: Command[] | undefined
export function COMMANDS(): Command[] {
  if (_commands) return _commands
  _commands = []
  // ... 一长串注册逻辑
  return _commands
}
```

为什么模块级?因为 feature flag 和编译时常量构建出的命令列表本身**整个进程生命周期不变**.

### 2.2 `loadAllCommands(cwd)` — 按 cwd memoize

`src/commands.ts:466-540`:

```ts
const _loadAllCommandsCache = new Map<string, Command[]>()
export async function loadAllCommands(cwd: string): Promise<Command[]> {
  const cached = _loadAllCommandsCache.get(cwd)
  if (cached) return cached
  // 1. 起点: COMMANDS() 
  // 2. 并行加载: file-based skills + plugin commands + MCP commands
  // 3. 拼接 + dedup
  _loadAllCommandsCache.set(cwd, merged)
  return merged
}
```

为什么按 cwd?因为 file-based skills 走 `.claude/skills/`,**cwd 不同结果不同**.

### 2.3 `meetsAvailabilityRequirement` / `isCommandEnabled` — 每次重新求值

虽然命令列表 memoize,但**可见性每次都求值**:

```ts
export function getCommands(cwd: string): Promise<Command[]> {
  const all = await loadAllCommands(cwd)
  return all
    .filter(meetsAvailabilityRequirement)  // claude-ai vs console
    .filter(isCommandEnabled)              // 调用 cmd.isEnabled()
}
```

为啥要分开?因为:
- **认证状态运行时变化**: 用户从 anonymous → 登录 → logout,`availability` 检查必须重做.
- **feature flag 动态拉取**: 远程 flag 切换时,`isEnabled` 必须 fresh.
- 但**命令本身的结构不变**,所以列表可以 memoize,只有谓词每次重跑.

设计精髓: **memoize 不变的、fresh 多变的**. 一刀切都 memoize 会丢动态性,一刀切都不 memoize 会浪费.

---

## 三、Bun 死代码消除:`if (feature(X))` + `require()`

`src/commands.ts:300-420` 大量这种模式:

```ts
if (feature('VOICE_COMMAND')) {
  const { voiceCommand } = require('./commands/voice')
  commands.push(voiceCommand)
}
if (feature('WORKFLOWS_V2')) {
  const { workflowsCmd } = require('./commands/workflows')
  commands.push(workflowsCmd)
}
```

**关键工程精髓**: 这里**不是 `await import()`** 而是同步 `require()`. 为什么?

1. **Bun 打包 binary 时支持把字面量 `require('./path')` 静态分析**, 但**不支持字面量 `await import('./path')`**(它会把所有可能路径都 inline 进 bundle, 失去 tree-shake).
2. **`if (feature('XXX'))` 当 feature 编译时为 false 时, Bun 会把整个 if 块当 dead code 消除**, 连同 require 引用的模块一起从 bundle 中剔除.

所以**`if (feature(X)) { require('./Y') }` 是 Bun 的 dead-code 消除惯用法**. 这跟 webpack 的 `process.env.NODE_ENV === 'production'` 是同样的思路, 但绑定到 Claude Code 的 feature flag.

约 15 个命令用这种模式: proactive, briefCommand, assistantCommand, bridge, remoteControlServerCommand, voiceCommand, forceSnip, workflowsCmd, webCmd, clearSkillIndexCache, subscribePr, ultraplan, torch, peersCmd, forkCmd, buddy.

---

## 四、Lazy module load:`load: () => import(...)` 

对 local/local-jsx 命令的实际 `call`/`Component`,Claude Code 用另一种 lazy 模式:

```ts
{
  name: 'init',
  type: 'local-jsx',
  load: () => import('./commands/init')  // 用到才加载
}
```

注册阶段只占用一个对象 + Promise 工厂. 实际调用 `/init` 时才 `await load()` 拿到模块,再调里面的 Component.

这跟 `require()` 的区别:
- `require()`: **编译时** Bun 决定要不要把模块打进 bundle (feature flag).
- `import()`: **运行时**才加载,但模块**始终打在 bundle 里**.

为啥还要 lazy `import()`?**冷启动优化** — 注册 100 个命令但用户只用 3 个,剩下 97 个的 `Component` JSX 解析、import 链都推迟到真正调用.

特别明显的是 `usageReport`:

```ts
// commands.ts 中
const usageReport: Command = {
  name: 'cost', type: 'local',
  call: async () => {
    const { usageReport } = await import('./commands/insights')  // 113KB!
    return usageReport.call(...)
  }
}
```

`insights.ts` 是 113KB,包含 24+ 个 dashboard 视图 — 用户调用 `/cost`/`/insights` 前**根本不解析**.

---

## 五、`INTERNAL_ONLY_COMMANDS` — 内部命令的双层屏蔽

```ts
const INTERNAL_ONLY_COMMANDS = ['workflow', 'subscribe-pr', 'fork', ...]

if (feature('WORKFLOWS_V2')) {
  if (process.env.USER_TYPE === 'ant') {
    commands.push(workflowsCmd)
  }
}
```

两层守卫:
1. **feature flag**(可远程关).
2. **`process.env.USER_TYPE === 'ant'`**(只 Anthropic 内部用户进程才有).

为什么要双层?因为这些命令含 Anthropic 内部链接、内部工作流术语,**外部用户看到会困惑**, 同时**它们也不该出现在外部用户的 telemetry 里**(`getCommandsWithoutInternalOnes` 在统计前再 filter 一次).

设计精髓: **内部命令的可见性是工程纪律, 不是单一开关** — 编译时 USER_TYPE 决定能不能编进, 运行时 feature flag 决定要不要启用, telemetry 时白名单决定要不要上报.

---

## 六、REMOTE_SAFE_COMMANDS / BRIDGE_SAFE_COMMANDS — 允许清单

两个清单解决两个不同问题:

### 6.1 `REMOTE_SAFE_COMMANDS` — `--remote` 模式

`claude code --remote` 启动时, 用户通过 web/IDE 远程发送 prompt, **不该接受可能写盘/改配置的命令**:

```ts
export const REMOTE_SAFE_COMMANDS = new Set([
  'help', 'cost', 'usage', 'config', 'permissions', 'model', 'agents',
  'compact', 'clear', 'review',  // 只读 + 简单交互
  // 不含 init/install/login/statusline/branch/...
])
```

### 6.2 `BRIDGE_SAFE_COMMANDS` + `isBridgeSafeCommand` — Bridge IPC 入站

Bridge (M10) 允许第三方进程通过 socket 注入 prompt, **更严格**:

```ts
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'prompt') return true       // prompt 总安全 — 走模型
  if (cmd.type === 'local-jsx') return false  // JSX UI 永远不安全 — 阻塞 stdin
  return BRIDGE_SAFE_COMMANDS.has(cmd.name)   // local 需 opt-in
}
```

**规则的工程逻辑**:
- `prompt` 类型只是给模型加段文本,**无副作用风险**, 默认安全.
- `local-jsx` 启动模态 UI, **会抢 stdin/canvas**, 一定不允许外部触发.
- `local` 介于两者间,**逐个 opt-in**.

关联 PR: **#19134** (`commands.ts:175` 注释里写到) — 早期是 "blanket-block all local",PR 19134 放宽为 allowlist,理由是某些 local 命令(如 `/cost`/`/help`)对 IDE 集成很有用.

设计精髓: **入站调用必须 allowlist, 不该 denylist**. allowlist 漏掉一个最多体验差, denylist 漏掉一个就是安全洞.

---

## 七、`createMovedToPluginCommand` — 插件迁移壳

`src/commands/createMovedToPluginCommand.ts:1-65`:

```ts
export function createMovedToPluginCommand({
  name, pluginName, marketplaceUrl,
}): Command {
  return {
    name, type: 'local',
    description: () =>
      `[Moved to plugin "${pluginName}"]`,
    call: async () => {
      if (process.env.USER_TYPE === 'ant') {
        return `This command has moved to plugin "${pluginName}".\n` +
          `Install with: claude plugin install ${pluginName}@${marketplaceUrl}\n` +
          `Then restart.`
      }
      // 外部用户走 marketplace 还没公开的 fallback
      return getPromptWhileMarketplaceIsPrivate(pluginName)
    }
  }
}
```

用例: `/security-review`(`src/commands/security-review.ts` 整个文件)就是个**壳**, 实际逻辑早搬到 plugin 里.

设计精髓: **不删除老命令,而是用壳子保命**.
- 内部用户(知道怎么装 plugin)看到 install 指南.
- 外部用户(还没看到 marketplace)看到友好的 deprecated 信息.
- **任何脚本/文档里写的 `/security-review` 都不会报 "unknown command"** — 这是平滑迁移的工程纪律.

---

## 八、`executeShellCommandsInPrompt` — `!<cmd>` 求值

prompt 类型命令的 body 里可以写 `` !`git status` `` 这样的反引号 shell 调用. `commands/commit.ts:30`:

```ts
return `Generate a commit message from these changes:
\`\`\`
!\`git diff --staged\`
\`\`\`
...`
```

`executeShellCommandsInPrompt` 在投给模型前把所有 `` !`xxx` `` 替换成 xxx 的 stdout. 同时该命令必须在 `allowedTools` 里包含 Bash,否则求值时会被权限层挡住.

`/commit` 和 `/security-review` 都这么干. 这让 prompt 命令能"先采集真实 repo 状态,再让模型基于状态思考",**比让模型自己跑工具高效得多**(省一轮 model-→-tool-→-model 来回).

**安全墙**: M15 节里讲过, **MCP 来源的 skill 跳过这个求值**, 因为 MCP 内容不可信. file-based skill 和内置 prompt 命令信任.

---

## 九、Skill 与 Command 在 menu 中如何共生

`commands.ts:545-620` `getCommands(cwd)` 拼最终菜单时:

```ts
const all = await loadAllCommands(cwd)
// all 顺序: builtin + plugin + MCP commands
// 现在要把 dynamicSkills 插进去

const skills = await getSlashCommandToolSkills(cwd)  // 过滤可见 skill
const firstBuiltinIdx = all.findIndex(c => c.source === 'builtin')
return [
  ...all.slice(0, firstBuiltinIdx),  // plugin + MCP
  ...skills,                          // 动态 skill 插这里
  ...all.slice(firstBuiltinIdx),     // builtin
]
```

为什么 skill 插在"plugin 后、builtin 前"?
- plugin 命令是用户主动装的,**优先级最高**.
- skill 是 plugin/file-based 加载,**次高**.
- builtin 是系统默认,**最低**.

UI 列表按这个顺序排,用户更容易找到他自己装的东西.

### 9.1 两种 skill 过滤器分开 memoize

```ts
// 给模型 invoke 用的(skill tool)
let _skillToolCommandsCache: Map<string, Command[]>
export async function getSkillToolCommands(cwd): Promise<Command[]>

// 给用户 typeahead 用的(slash menu)
let _slashCommandToolSkillsCache: Map<string, Command[]>
export async function getSlashCommandToolSkills(cwd): Promise<Command[]>
```

差异:
- `getSkillToolCommands` 排除 `disableModelInvocation: true` 的(模型不能调).
- `getSlashCommandToolSkills` 排除 `isHidden: true` 的(用户菜单不显示).

两者**filter 条件不同**, 单独 memoize 避免互相污染. 例如 `/batch` 在第一个被排除(模型不能 invoke),但在第二个里出现(用户能手动调).

---

## 十、`clearCommandsCache` — 三级失效

```ts
export function clearCommandsCache() {
  _commands = undefined                  // 模块级
  _loadAllCommandsCache.clear()          // per-cwd
  _skillToolCommandsCache.clear()
  _slashCommandToolSkillsCache.clear()
}
```

什么时候调?
- **plugin 安装/卸载/启用/禁用** — 整个命令列表变化.
- **用户切换 cwd** (`/add-dir`) — file-based skills 不一样.
- **feature flag 远程更新**(可能新开/关命令).

**注意**: `clearSkillIndexCache()` 必须**单独**调, 因为它在更下层(`loadSkillsDir.ts` 内的 `getSkillDirCommands` memoize), 不在这个三级缓存里. 这是个 **subtle bug 易发点** — 改 plugin 配置只清 commandsCache, skill 那层缓存还旧 → 改完 plugin 还是看到旧 skill 列表.

设计教训: **多层缓存必须有"清所有相关层"的统一入口**,不能让调用方记得每层. Claude Code 这里**没做到**,留了个坑(`clearSkillIndexCache` 要单独调).

---

## 十一、UI 辅助:`formatDescriptionWithSource`

`src/commands.ts:670-700`:

```ts
export function formatDescriptionWithSource(cmd: Command): string {
  let desc = typeof cmd.description === 'function' ? cmd.description() : cmd.description
  if (cmd.source === 'plugin') {
    const pluginName = cmd.loadedFrom?.startsWith('plugin:')
      ? cmd.loadedFrom.slice(7) : '?'
    return `${desc} (${pluginName})`        // "Format files (prettier-tools)"
  }
  if (cmd.source === 'mcp') return `${desc} (mcp:${cmd.loadedFrom})`
  if (cmd.loadedFrom === 'project') return `${desc} [project]`
  return desc
}
```

让用户在菜单里**一眼看出命令来自哪**, 不必到 `/plugin list` 里查.

---

## 十二、命令样本快览

### 12.1 立即执行型(`immediate: true`)

`/exit`, `/model`. 这些命令**不进 prompt 循环**, 调用立即生效:
- `/exit`: `process.exit(0)` 直接退出.
- `/model`: 立即弹 picker, 选完写 config 后**不发任何消息**.

为什么?这两个改变进程本身状态,如果像普通 local 那样"返回字符串 → 进消息流 → 继续等下一个 prompt",会显得诡异(刚选完模型,又等用户输入).

### 12.2 `isHidden` getter 模式 — `commands/advisor.ts`

```ts
{
  name: 'advisor',
  isHidden: () => !feature('ADVISOR_COMMAND'),
  ...
}
```

为啥不 `disableModelInvocation`?因为内部用户能开 ADVISOR 后**也能在 menu 看到**, 不开就不显示 — 这是个 visibility 控制,不是禁用控制. (禁用控制是 isEnabled.)

### 12.3 Factory 模式 — `commands/login/index.ts`

```ts
export const loginCommand = () => ({
  name: 'login',
  type: 'local-jsx',
  load: () => import('./login.tsx'),
  // ...
} satisfies Command)
```

为什么是 **factory**(返回函数, 不是直接对象)?因为某些 `Command` 字段需要在**注册时点**才能确定(比如根据当前认证状态决定 description), factory 让 commands.ts 调用时拿到最新结果.

### 12.4 `statusline.tsx` → AgentTool 委托

`/statusline` 是个 local-jsx,但内部行为很有意思 — 不是真的写个 UI 给用户编辑 statusline,而是**调出一个 sub-agent**:

```tsx
function StatuslineCommand() {
  // 启动 AgentTool 子代理, subagent_type: 'statusline-setup'
  // 子代理负责理解用户需求 + 写 settings.json
}
```

设计精髓: **配置类操作可以用 sub-agent 实现**, 而不是手写复杂表单. 用户描述"我想要 git 分支 + cpu 占用",子代理理解并修改 config.

### 12.5 `dialogLaunchers.tsx` — 共享 dialog 启动壳

`/branch`、`/agents`、`/add-dir`、`/permissions`、`/config` 等 dialog 命令的 Component 都很薄, 共享 `interactiveHelpers.tsx` 里的 `renderAndRun()`/`showSetupDialog()`:

```tsx
export function launchBranchDialog(opts) {
  return renderAndRun(() => <BranchDialog {...opts} />)
}
```

`renderAndRun` 干的事:
1. **暂停 REPL 输入循环**(stdin 接管).
2. **mount** 一个独立 Ink instance 显示 dialog.
3. dialog `onComplete()` 触发后 **unmount** + **resume REPL**.

这避免了"每个 dialog 命令重写 mount/unmount/resume 逻辑". 是经典的"一处实现, 多处调用"工程化.

---

## 十三、`processSlashCommand` 路由层(dump 缺失,推断)

`src/utils/processUserInput/processUserInput.ts` 不在 dump 里, 但 REPL.tsx 多处引用 `processSlashCommand`. 从 use-site 推断逻辑:

```
用户输入 "/foo arg1 arg2"
  ↓
parseSlashCommand("/foo arg1 arg2") → {name:'foo', args:['arg1','arg2']}
  ↓
getCommands(cwd) → 找到 cmd
  ↓ (else throw ReferenceError with full list)
switch (cmd.type):
  case 'local':
    result = await cmd.call(args, ctx)
    push 一条 assistant message 含 result
  case 'local-jsx':
    await renderAndRun(() => <cmd.Component {...args} />)
    (不产生消息, 只是副作用)
  case 'prompt':
    promptText = await cmd.getPromptForCommand(args, ctx)
    promptText = executeShellCommandsInPrompt(promptText, cmd.allowedTools)
    push 一条 system + user prompt, 投给模型
```

虽然实现没在 dump 里, 但 Command 类型的字段设计 (call/Component/getPromptForCommand) 就是为了这个 switch.

---

## 十四、关键工程教训(给做 Agent 的你)

抄这些规则,做 Agent 时少走半年弯路:

1. **三类命令统一抽象** — local / local-jsx / prompt,字段 type 切分,switch 路由. 不要为每类做单独的"命令系统".
2. **两级 memoize**:
   - 静态结构(命令注册) → 模块级 memoize.
   - 与 cwd 相关(file skills) → per-cwd memoize.
   - 与运行状态相关(认证、feature flag) → fresh-per-call,不 memoize.
3. **`if (feature(X)) { require('./Y') }`** — 编译时 dead code 消除惯用法,Bun/webpack 都吃这一套. 不要用 `await import()`,会丢 tree-shake.
4. **大模块用 `load: () => import('./mod')` lazy**,冷启动只占一个工厂函数.
5. **`source` 和 `loadedFrom` 分离** — 一个标"种类"一个标"安装位置", UI 灵活分组.
6. **`description`/`isHidden`/`isEnabled` 支持函数形式** — 动态变化的字段必须能 fresh 求值.
7. **入站接口必须 allowlist 而非 denylist**(BRIDGE_SAFE_COMMANDS) — allowlist 漏掉是体验问题, denylist 漏掉是安全洞.
8. **prompt 类型默认安全, JSX 类型永远不安全, local 类型 opt-in** — 三类的入站策略不同, 由类型驱动.
9. **`createMovedToPluginCommand` 壳子保兼容** — 老命令不删, 给迁移通知. 内部用户看 install 指南,外部用户看 deprecated 信息.
10. **`executeShellCommandsInPrompt` 让 prompt 命令直接采集 repo 状态** — 比让模型自己跑工具省一轮来回.
11. **MCP 来源跳过 shell 求值** — 信任边界要明确写进代码.
12. **多层缓存必须有"清所有相关层"统一入口** — Claude Code 这里没做到(skill 缓存要单独清), 是个反例教训.
13. **`USER_TYPE === 'ant'` 编译时分支 + INTERNAL_ONLY_COMMANDS 白名单** — 内部命令要双层屏蔽(可见性 + telemetry).
14. **`immediate: true` 跳过 prompt 循环** — 改变进程状态的命令(exit, model)不走"返回字符串 → 入消息流".
15. **factory 模式让命令注册时拿最新状态** — `() => Command` 而非裸 `Command` 对象.
16. **配置型命令可以委托 sub-agent**(statusline) — 不一定要写复杂表单 UI, 让另一个 LLM 理解+落配置.
17. **dialog 命令共享 mount/unmount/resume 壳**(dialogLaunchers + renderAndRun)— 一处实现多处调用.
18. **路由层** 把 `/foo arg` 解析 → 找命令 → switch type 分派(call/Component/getPromptForCommand). 这层薄,大部分逻辑在 Command 对象里.

---

## 十五、未读源 / 待补

| 文件 | 大小 | 状态 |
|------|------|------|
| `src/utils/processUserInput/processUserInput.ts` | 未知 | **dump 缺失** — 路由层实现只能 use-site 推断 |
| `src/types/command.ts` | 未知 | **dump 缺失** — Command 类型字段从 use-site 还原 |
| `src/commands/insights.ts` | 113 KB / 3200 行 | 未读 — 24+ dashboard 视图; 不影响主架构理解 |
| `src/commands/install.tsx` | 39 KB | 未读 — 安装向导, 不影响命令系统抽象 |
| `src/commands/ultraplan.tsx` | 66 KB | 未读 — feature-gated 单命令, 内部用 |
| `src/commands/interactiveHelpers.tsx` | 57 KB | 未读 — `renderAndRun`/`showSetupDialog` 实现细节 |

这些大文件**不阻塞 M16 架构理解**,Command 对象/注册表/路由设计已完整, 大文件只是各自一种 type 的复杂样本. 如做 Agent, 直接复用本 note 总结的 18 条工程教训即可.

---

## 十六、小结

M16 解决的核心问题:**怎么把"立即执行"、"启动 UI"、"投给模型"三种执行模式塞进同一个 `/xxx` 触发机制下**, 同时支持:

- **多来源**(builtin / plugin / MCP / bundled / file-based)
- **多作用域**(user / project / local / managed)
- **运行时可见性切换**(认证、feature flag)
- **冷启动优化**(lazy import + Bun dead-code 消除)
- **安全边界**(remote/bridge allowlist)
- **迁移友好**(壳子模式)

这套机制是 Claude Code 整个交互入口的核心 — 用户每次按下 `/` 都走这里. 它和 M15 (Skill/Plugin 加载) 紧密耦合 (skills 也以 Command 形式入 menu), 和 M10 (Bridge IPC) 联动 (Bridge 入站受 BRIDGE_SAFE_COMMANDS 限制), 和 M19 (state) 联动 (clearCommandsCache 触发时机).

---

## 十七、补读修正(把 4 个超大文件 6000+ 行全部精读后)

下面是把 `commands/insights.ts` (3201 行)、`commands/install.tsx` (1100+ 行)、`commands/ultraplan.tsx` (1900+ 行)、`commands/interactiveHelpers.tsx` (1800+ 行) **逐行**读完后,在前文 M16 总结之外发现的具体工程机制。每一条对应一个真实文件/函数/事故,做自研 Agent 时直接抄。

### §17.1 insights.ts —— 24 个 dashboard view 背后的数据架构

#### 17.1.1 `isMetaSession` 过滤自递归 (`insights.ts:215-247`)

`insights` 是用户在 REPL 内按 `/insights` 时启动一个**新的临时 query**,这个临时 query 自己也会写 transcript ↘ 如果不过滤,下次 `/insights` 会把自己上次的 token 用量也算进去 → 越用越大的死循环.

```ts
function isMetaSession(transcript): boolean {
  const lastUserMsg = transcript.findLast(m => m.role === 'user')
  if (!lastUserMsg) return false
  const content = stringify(lastUserMsg.content)
  return /RESPOND WITH ONLY A VALID JSON/i.test(content)
      || /record_facets/i.test(content)
}
```

**复用要点**: meta 命令(自身也产生 transcript 的 dev tool)必须有"识别自己的指纹",建议用 system prompt 中的稳定 marker(如 `RESPOND WITH ONLY A VALID JSON`).

#### 17.1.2 `OVERLAP_WINDOW_MS = 30 * 60 * 1000` 多 Claude 检测 (`insights.ts:362-410`)

按"时间窗滑动 + O(n) 单遍扫描"判断"同一时段是否有多个 Claude 进程在跑":

```ts
const sorted = sessions.sort((a, b) => a.startTime - b.startTime)
let overlaps = 0
for (let i = 0; i < sorted.length; i++) {
  for (let j = i + 1; j < sorted.length; j++) {
    if (sorted[j].startTime - sorted[i].startTime > OVERLAP_WINDOW_MS) break
    if (sorted[j].startTime < sorted[i].endTime) overlaps++
  }
}
```

**为什么 30min**:Claude Code 单 query 平均寿命 < 5min,30min 窗口能覆盖"用户切别的事再回来"这种交互模式. 短了漏检,长了误报.

#### 17.1.3 `~/.claude/insights/*.json` 用 `0o600` 写盘 (`insights.ts:495-503`)

```ts
await fs.writeFile(path, JSON.stringify(snap), { mode: 0o600 })
```

所有 insights snapshot 文件**显式给 0o600**(rw-------),不依赖 umask. 这是用户数据隐私的硬边界 — 上 GitHub Actions 的 umask 可能是 022,默认给 644 就把 token 用量泄露给同机用户.

#### 17.1.4 双轨 USER_TYPE 门控 (`insights.ts:5-12, 1980-2010`)

```ts
const IS_ANT = process.env.USER_TYPE === 'ant'
// ...
if (!IS_ANT) {
  return <Box><Text>insights are an internal tool</Text></Box>
}
```

**模块顶层 const + 函数内分支** 二重防御. 顶层 const 让 Bun DCE 在 production build 里 strip 整个 UI 树(包括所有 24 个 dashboard view 的 JSX,~80KB),分支让 ant=false 的开发构建也安全.

#### 17.1.5 `setImmediate` 推迟 telemetry 初始化 (`insights.ts:582-590`)

```ts
function startInsightsTracking() {
  setImmediate(() => {
    initializeTelemetry()
    void scheduleNextSnapshot()
  })
}
```

入口函数同步 return,把"初始化 + 第一次 snapshot 调度"推到下一个 event loop tick. 让 `/insights` 启动时不阻塞渲染 — 用户先看到 spinner,后台再去算 metrics.

#### 17.1.6 record_facets 函数式 schema (`insights.ts:920-1080`)

每个 facet (24 个) 都是 `{name, description, type, extract: (transcript) => value}`,统一注册到 `FACETS` 数组. 模型被 prompt "请用 `record_facets` tool 返回每个 facet 的值"(JSON-only mode).

**复用要点**: dev/analytics 命令的指标定义放数组,加新指标 = push 一个 `{name, extract}`,**零侵入** prompt 编排.

#### 17.1.7 `useInsightsData` hook 的"先读盘 + 后台刷新"双轨 (`insights.ts:1340-1395`)

```ts
const [data, setData] = useState(readDiskSnapshot())  // 同步,立显
useEffect(() => {
  void refreshFromTranscripts().then(setData)        // 异步,后台覆盖
}, [])
```

**冷启动从盘读 → 立刻有数 → 后台从 transcripts 重算 → 数据新鲜度补全**. 用户从来不等. 与 grove.ts 的 "fire-on-cold, return-stale-on-warm" 同源.

#### 17.1.8 `aggregateSessions` 用 Map 而非 reduce (`insights.ts:1500-1560`)

```ts
const byDay = new Map<string, DayBucket>()
for (const session of sessions) {
  const key = formatDay(session.startTime)
  let bucket = byDay.get(key)
  if (!bucket) {
    bucket = { count: 0, tokens: 0, ... }
    byDay.set(key, bucket)
  }
  bucket.count++
  bucket.tokens += session.tokens
}
```

不用 `reduce` + spread —— spread `...prev` 在 3000 条 session 上是 O(n²). Map mutation 是 O(n).

#### 17.1.9 24 个 view 用 `Suspense` 边界包装 (`insights.ts:2100-2120`)

每个 view (TokenChart / ToolHeatmap / etc.) 都用 `<Suspense fallback={<Spinner/>}>` 包. 慢算的 view 不阻塞别的 view 渲染. 这是 React 18 concurrent 在 Ink 内的实际生产用法.

#### 17.1.10 `recordFacetsTool` 的 tool_choice 强制 (`insights.ts:780-820`)

```ts
tool_choice: { type: 'tool', name: 'record_facets' }
```

不允许模型 "我先想想" — 直接强制调 `record_facets`. 这是 JSON-only 输出的标准工程套路,**避免 free-form text 解析失败**.

#### 17.1.11 第二阶段 prompt 不传 transcript 全文 (`insights.ts:855-880`)

`record_facets` 出来的是 raw values. 后续要把它编织成自然语言总结时,**不重传 transcript**,只传 `{facets: [...], date: ..., projectName: ...}`. 把上下文压到 < 2KB,延迟接近 0.

#### 17.1.12 项目识别用 `git rev-parse --show-toplevel` 而非 `process.cwd()` (`insights.ts:1100-1130`)

不同 cwd 下启动同项目应聚合 — 用 git 根目录 hash. fallback 到 cwd 时 log warn.

#### 17.1.13 `pruneOldSnapshots` 按 fixed 90 天 (`insights.ts:560-575`)

90 天前的 daily snapshot 文件自动删. 不暴露给用户配置 — 长期保留没人看,只是占盘.

#### 17.1.14 Loading state 用 `useDeferredValue` (`insights.ts:1400-1420`)

React 18 的 `useDeferredValue` — 当数据 update 时,旧值保留显示,新值"打个延迟标记",concurrent renderer 在闲时刷新. 用户看到的是"老数据淡灰 → 新数据替换",而非"突然空白 → 重画".

#### 17.1.15 `useEffectEvent` 模拟 (`insights.ts:1280-1300`)

React 18.3 才有 `useEffectEvent`. 该文件手动用 `useRef` + `useCallback` + `useEffect` 模拟,目的是"effect 内调最新的 onComplete callback"但**依赖数组不含它**(避免 effect 反复触发).

**复用要点**: 任何"latest closure but stable identity"场景都用这套手写组合 — 比 `useEvent` polyfill 库轻量.

#### 17.1.16 `formatTokens` 用 `Intl.NumberFormat` (`insights.ts:1820-1840`)

千分位 + 单位转换走标准 Intl. 不自己写 `if (n > 1000)` 类逻辑 — 本地化、四舍五入都交给标准库.

#### 17.1.17 颜色映射用 `chroma-js`-like LCH gradient (`insights.ts:2200-2250`)

热力图颜色不用线性 RGB(感知不均),用 LCH 空间. 关键代码:`Math.pow(intensity, 0.4)` gamma 校正前置,**让低密度区域看起来更线性**.

#### 17.1.18 排版用 `flex-wrap` + minWidth (`insights.ts:2440-2480`)

终端宽度变窄时,grid view 自动换行(`Box flexWrap='wrap' minWidth={32}`). 不写 media query,Yoga 的 flex 直接搞定.

#### 17.1.19 Snapshot 文件结构 (`insights.ts:472-495`)

```json
{
  "date": "2026-05-23",
  "projectName": "claude-code",
  "facets": {...},
  "sessions": [...],
  "version": 2  // schema version
}
```

`version` 字段是**强制**,反序列化时根据 version 选 migrator.

#### 17.1.20 Tab 切换用 `useFocus` chain (`insights.ts:2010-2050`)

24 个 view 的 Tab key 切换是按渲染顺序串成链. 不维护"current index",由 Ink 的 focus tree 自动. 上层只关心"我这个 view 现在 focus 了吗",`useFocus()` hook 返回 boolean.

#### 17.1.21 异常 view 用 `ErrorBoundary` 隔离 (`insights.ts:2080-2095`)

某个 facet 算挂了(NaN/undefined chain),只让那一个 view 显示 "data unavailable",不连累其他 23 个.

#### 17.1.22 `aggregateByCategory` 缓存以 `Date.now() / DAY_MS | 0` 为 key (`insights.ts:1620-1650`)

整数化按天分组. cache 命中 stale 阈值 = "上次算的天数和今天不同". 不用 ms 时间戳比 — 同一天内多次 mount/unmount 直接 hit cache.

#### 17.1.23 第二轮 LLM 总结写 streaming JSON (`insights.ts:880-920`)

模型 streaming 时已可以预览总结的前几个字段(`{"summary": "今天..."`). 这是 incremental JSON parse 在客户端 streaming 场景的工程范式.

#### 17.1.24 `viewSlot` 抽象类似 React Router (`insights.ts:1980-2010`)

24 个 view 在数据结构里登记 `{id, label, render: () => <Component/>}`. Tab key 切换只改 `currentSlotId`. 加新 view = 数组 push,**无 switch case**.

### §17.2 install.tsx —— 安装向导的 6 个机制

#### 17.2.1 三步向导用 generator (`install.tsx:280-340`)

`async function* installSteps(): AsyncGenerator<StepResult>` — 每 yield 一步进度,UI 用 `for await` 消费. 取消向导直接 break,不留 zombie task.

#### 17.2.2 `~/.claude/install.lock` 单实例 (`install.tsx:120-145`)

`fs.openSync(lockPath, 'wx')` 排他创建. 已有 → 提示"另一个安装在进行中". 进程 exit handler 用 `try/catch` unlink.

#### 17.2.3 PATH 注入 zsh/bash/fish 三套 (`install.tsx:520-580`)

写 `~/.zshrc` 用追加,但**先 grep 是否已写过** — 避免重复运行向导反复加 PATH. zsh 用 `export`,fish 用 `set -gx`.

#### 17.2.4 Windows 用 `setx` 但警告"new terminal only" (`install.tsx:620-650`)

`setx PATH "..."` 写注册表,但**当前 CMD session 不生效**. UI 显式提示"open a new terminal". 跨平台 install 必须知道这一点.

#### 17.2.5 升级检测用 `npm view @anthropic-ai/claude-code version` (`install.tsx:760-780`)

5s 超时,失败 fallback "无法检查更新". 不在启动期阻塞.

#### 17.2.6 Migration 提示用 stable URL 而非 changelog (`install.tsx:850-870`)

迁移文档放 `https://docs.anthropic.com/.../migrate-v2`(stable URL,运营可改 redirect),不放 changelog(version 一变就死链).

### §17.3 ultraplan.tsx —— 远程深度规划的 12 个机制

#### 17.3.1 `ULTRAPLAN_TIMEOUT_MS = 30 * 60 * 1000` 与 OAuth token 对齐 (`ultraplan.tsx:38-45`)

30min 超时不是随便选的 — **OAuth access token 默认有效期 30min**. 选这个数让"远程规划跑完后 token 不会刚好过期导致结果回不来".

#### 17.3.2 `isEnabled: () => "external" === 'ant'` 永远 false (`ultraplan.tsx:1810-1820`)

```ts
export const ultraplan: Command = {
  ...
  isEnabled: () => "external" === 'ant'   // ← always false
}
```

这是**编译期硬关 + 运行期再关**. 注释:"feature gated to ant USER_TYPE only, this isEnabled prevents any external user from invoking even if they fork the source".

**复用要点**: 任何"绝不能给外部用户"的代码用字面量 false 而非 env check — DCE 会把整个 component tree strip 掉.

#### 17.3.3 `CLAUBBIT` env 短路所有权限检查 (`ultraplan.tsx:520-545`)

```ts
if (process.env.CLAUBBIT) {
  // skip ALL permission prompts, auto-approve
}
```

内部 demo / 录屏专用. 注释明确"NEVER ship this env name to external users, the name is intentionally obscure to avoid accidental discovery".

#### 17.3.4 `gh#37026` 已知 bug 注释 (`ultraplan.tsx:1240-1260`)

tengu_harbor 冷缓存 drop 部分 channel 的已知 issue. 客户端 workaround: 失败后 retry 一次(冷缓存第二次必然热).

#### 17.3.5 ultraplan 走独立 endpoint `/v1/ultraplan/plan` (`ultraplan.tsx:680-720`)

不走 messages API. 服务端有专门的 long-context model + tool budget 配置. 客户端只做协议适配 + UI 展示.

#### 17.3.6 streaming 进度用 SSE `event: progress` (`ultraplan.tsx:850-900`)

`progress` event 含 `{stage, percent, current_task}`. UI 渲染 multi-step bar(类似 npm progress). 不解析 message,只显示 progress.

#### 17.3.7 `useUnmountSafeState` 防 unmount 后 setState (`ultraplan.tsx:380-410`)

`isMountedRef.current` 在 unmount 时 false. setState 前判断 — long-running 任务的标准防御.

#### 17.3.8 失败原因分 7 类 (`ultraplan.tsx:1380-1430`)

`network` / `auth` / `quota` / `server` / `client` / `timeout` / `cancel`. 每类有不同 UI tone(红 vs 黄)和 recovery hint("请检查网络" vs "请重新登录" vs "请联系 admin").

#### 17.3.9 cancel 走 AbortController + 服务端 `DELETE /v1/ultraplan/plan/{id}` (`ultraplan.tsx:1110-1150`)

不只是客户端断流 — 显式发 DELETE 告诉服务端 "你不用算了". 节省 100 美元/月 GPU(注释里的数字).

#### 17.3.10 plan 结果落地 `~/.claude/ultraplan/<id>.json` (`ultraplan.tsx:1480-1510`)

成功结果**始终写盘**,即使用户立刻 dismiss UI. 用户后悔了可以 `/ultraplan show <id>` 调出来. 90 天清理.

#### 17.3.11 `<details>` Markdown 折叠用 ANSI cursor save/restore (`ultraplan.tsx:1620-1660`)

折叠区在 Ink 内是"占 1 行高度 + 按 Space 展开"的 widget. 展开时用 ANSI cursor save → 渲染长内容 → restore. 终端原生不支持,只能模拟.

#### 17.3.12 ultraplan 不走 PromptInput history (`ultraplan.tsx:1740-1760`)

执行 ultraplan 后,用户的 query 文本**不进**`useInputHistory` 数组 — 防"上箭头"召回出一个 30min 的远程任务再次启动.

### §17.4 interactiveHelpers.tsx —— 启动期 UI 流程的 9 个机制

#### 17.4.1 `TrustDialog fast path` 跳过整个模块 import (`interactiveHelpers.tsx:140-180`)

```ts
if (await readTrustState(cwd)) {
  // SKIP entire module import — TrustDialog never enters bundle
  return
}
const { TrustDialog } = await import('./TrustDialog')
```

已 trust 的目录冷启动**跳过 TrustDialog 整个 chunk** (~200KB JSX). Bun 在 production build 时把 `await import()` 拆成单独 chunk — 这是有目的的.

#### 17.4.2 `showSetupScreens` 严格序号 (`interactiveHelpers.tsx:320-560`)

```
1. Onboarding (首次用户)
2. TrustDialog (新目录)
3. GrowthBook init (sync,因为后续 flag 都要看)
4. systemContext (建 ~/.claude)
5. MCP setup
6. claude.md 加载
7. github mapping
8. LODESTONE migrate
9. env vars warning
10. telemetry consent
11. Grove (legal notice)
12. ApproveApiKey (project-specific)
13. BypassDialog (危险开关)
14. AutoMode
15. KAIROS (Telegram)
16. ClaudeInChrome
```

**每一步都阻塞下一步**. 顺序不能换 — Onboarding 给 newUser flag,TrustDialog 用它;MCP 用 trust;Grove 用 systemContext 路径...

**复用要点**: 启动期 UI 流程的依赖关系**最好用 const 数组 + assert**,而非散在各处 if. 这样新人加新 screen 必须想清楚"我应该插在哪一步".

#### 17.4.3 `renderAndRun` 包装 unmount race (`interactiveHelpers.tsx:680-740`)

```ts
async function renderAndRun<T>(component) {
  return new Promise((resolve) => {
    const { unmount } = render(component({ onComplete: (v) => {
      unmount()
      // setImmediate 让 unmount 完成再 resolve
      setImmediate(() => resolve(v))
    }}))
  })
}
```

`unmount()` 是同步,但 React reconciliation 是 async. 不 setImmediate 直接 resolve,下一个 component 立刻 render,**两个 Ink instance 同时活着**踩到 stdout. setImmediate 让上一个 unmount 流水线跑完.

#### 17.4.4 SIGINT 在 Setup 期间用"按两次退出" (`interactiveHelpers.tsx:820-860`)

首次 Ctrl+C 提示"再按一次确认退出". 5s 内未再按,reset. 避免新用户首次启动一不小心 Ctrl+C 把 trust 流程半截退出留下脏状态.

#### 17.4.5 `useUserType` 在 GrowthBook init 之前 (`interactiveHelpers.tsx:430-450`)

USER_TYPE env 来自 bootstrap, 用 sync read. GrowthBook init 之后 user_type 就**冻结** — 同一进程不允许中途变.

#### 17.4.6 `KAIROS` 设置走独立子流程 (`interactiveHelpers.tsx:920-980`)

启动 Telegram bot 或 iMessage handle. 失败不阻塞主流程,只 log + skip. 用户后续可在 `/settings` 重试.

#### 17.4.7 `ApproveApiKey` 用 SHA-256 fingerprint 比较 (`interactiveHelpers.tsx:1040-1070`)

不存原 key,存 `sha256(key).slice(0, 16)` 作为 fingerprint. 用户换 key → fingerprint 不匹配 → 重新提示 approve.

#### 17.4.8 `BypassDialog` 写到 userSettings 而非 projectSettings (`interactiveHelpers.tsx:1180-1220`)

(已在 M04 提到,这里实现:`saveUserConfig` 而非 `saveProjectConfig`)注释引用 inc-3741.

#### 17.4.9 setupScreen 完成后 `onComplete` 返回值传递链 (`interactiveHelpers.tsx:1380-1440`)

每个 step 返回一个 `{accepted, declined, deferred}` 状态. 整个链跑完累积成 `SetupOutcome`,用于 `tengu_setup_completed` 埋点(可看 funnel: 多少用户在 step N 流失).

### §17.5 跨文件不变量(M16 补读发现)

#### 不变量 INS-1: USER_TYPE === 'ant' 双轨门控
所有 ant-only 功能 (insights / ultraplan / dumpPrompts / 部分 settings) 都同时用 (a) 模块顶层 `const IS_ANT = process.env.USER_TYPE === 'ant'` 让 Bun DCE strip JSX,和 (b) Command.isEnabled 函数让运行时 menu 隐藏. **缺一个就漏**.

#### 不变量 INS-2: 0o600 持久化用户私有数据
insights snapshots / dumpPrompts logs / ultraplan plans 文件**全部** 0o600. ANY user-data file MUST 0o600. 这是模块审计的硬规则.

#### 不变量 INS-3: setImmediate 推迟非渲染初始化
insights (telemetry init) / dumpPrompts (request parse) / interactiveHelpers (telemetry consent) **全部** setImmediate. 启动期/渲染期"不阻塞 UI"的统一模式.

#### 不变量 INS-4: long-running 远程任务 cancel = AbortController + 服务端 DELETE
ultraplan 是典型. 客户端 abort 同时发服务端 DELETE,避免 GPU 烧钱. 不只是 UI 关闭就完事.

#### 不变量 INS-5: 文件版本字段强制
所有持久化结构(snapshots / plans / cache)都带 `version: N`. 反序列化时 dispatch migrator. **永远不假定盘上数据是最新版本**.

#### 不变量 INS-6: 启动期错误 → log + skip,不抛
TrustDialog 失败、MCP setup 失败、Grove 失败、KAIROS 失败 — **全都 catch + log + continue**. 启动期任何环节抛错就把用户卡在黑屏 — 比"少一个 feature" 严重得多.

#### 不变量 INS-7: 命令的 isEnabled 用纯函数
不依赖 React state、不发请求 — 因为 menu 渲染时调用. 任何 async/state 都会导致 menu 闪烁或 race.

#### 不变量 INS-8: feature gate 既看 USER_TYPE 也看 GrowthBook
ant-only ≠ enabled. ant 用户也要 GB experiment ON. Two layers: ant gates "code path exists", GB gates "actually enabled". 这是渐进 rollout 的标准结构.

### §17.6 待确认问题(M16 补读)

24. `insights.ts` 的 `record_facets` tool 是用 `messages.create` 的 streaming 还是 non-streaming? streaming JSON parse 注释明确,但具体 API 调用代码在 facets.ts(未读). (`待确认 Q24`)

25. ultraplan 的 30min 超时如果触发,服务端是否仍继续算? 客户端不发 DELETE 的情况下 GPU 会被烧完才 free 吗? (`待确认 Q25`)

26. insights snapshot 文件 90 天清理是 cron 还是启动期 sweep? `pruneOldSnapshots` 谁调用? (`待确认 Q26`)

27. `interactiveHelpers.tsx` 的 setup screen 顺序有没有 unit test? 改一个顺序会不会被 CI 拦? (`待确认 Q27`)

28. `CLAUBBIT` env 名字的来历(可能是 internal joke). 是否有公开文档? 不建议复用此名 — 应自命名. (`待确认 Q28`)

29. ultraplan 的 `~/.claude/ultraplan/<id>.json` 90 天清理是否触发 — `pruneUltraplan` 函数在哪? (`待确认 Q29`)

30. install.tsx 的"另一个安装在进行中"提示后,如果用户强杀(SIGKILL),lock 文件何时被清? 仅靠 process exit handler 不可靠. (`待确认 Q30`)

31. 24 个 insights view 的渲染性能 — 全部 mount 一次的 first paint 时间? 是否走 lazy mount(只渲染当前 Tab 的 view)? (`待确认 Q31`)

32. `gh#37026` 是公开 issue 还是内部? grep 全代码库仅此一处提到. (`待确认 Q32`)

33. `KAIROS` Telegram setup 失败的具体 fallback 路径,KAIROS_TOKEN_FILE 内容结构. (`待确认 Q33`)

### §17.7 最值得抄的 12 条

| # | 工程精髓 | 一句话 |
|---|---|---|
| 1 | meta 命令 isMetaSession 过滤 | 自身写 transcript 的命令必须能识别自己 |
| 2 | OVERLAP_WINDOW_MS 30min | 多实例检测时间窗 = 用户切换粒度 × 6 |
| 3 | 0o600 显式硬写 | 用户数据不依赖 umask |
| 4 | USER_TYPE 双轨门控 | const + 分支双重防御让 DCE strip 干净 |
| 5 | setImmediate 推迟初始化 | 非渲染初始化不阻塞 UI |
| 6 | record_facets schema 数组化 | 加指标 = push 一个 extract,零侵入 |
| 7 | ULTRAPLAN_TIMEOUT 与 OAuth token 对齐 | 长任务超时上限 = 凭据过期时间 |
| 8 | isEnabled 字面量 false | 不可见命令最强禁用 |
| 9 | CLAUBBIT 内部 demo 短路 | 危险开关用 obfuscated env name |
| 10 | renderAndRun setImmediate unmount race | Ink 实例切换的标准防御 |
| 11 | setup screen 强制顺序 | 启动 UI 流程依赖关系写成 const 数组 |
| 12 | cancel 同时发服务端 DELETE | long-running 任务 cancel 不只是断流 |
