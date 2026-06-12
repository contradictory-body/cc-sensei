# M20 · 键位绑定与焦点系统

> 范围:`src/keybindings/`(14 文件,~3159 行)+ `src/hooks/useGlobalKeybindings.tsx` / `useCommandKeybindings.tsx` / `useExitOnCtrlCD.ts` / `useExitOnCtrlCDWithKeybindings.ts` / `useVimInput.ts` / `src/ink/focus.ts`(6 文件,~971 行) = 约 4130 行。
>
> 主题:**让 CLI 终端里的键位绑定系统既"用户可配置"又"内部 chord 安全",同时支持 vim 模式和 DOM-like 焦点切换**。
>
> 联动:M13(input)/ M11(ink)/ M16(commands)/ M19(state)。

---

## 一、问题空间

终端 Agent 的键位远不止"按一个键调一个 handler":

1. **多 context**:Chat 输入框、Autocomplete 弹层、ModelPicker dialog、Transcript view... 同一个键(↑)在不同 context 含义完全不同。
2. **chord**:VS Code 的 `ctrl+k ctrl+s` 这种双键序列。第一键按下不动作,等第二键。
3. **vim**:NORMAL 模式下 hjkl 是光标移动、INSERT 模式下是字面输入。
4. **用户可配置**:`~/.claude/keybindings.json` 让用户能改任意非保留快捷键。
5. **去重 / 校验**:用户写错配置(同一个键绑两个 action、不识别的 context、保留键)要警告。
6. **保留键**:`ctrl+c` 用于中断、`ctrl+d` 用于退出 — 不能让用户改成别的。
7. **PII 治理**:埋点不能泄露用户键位配置的字符串内容。

文件分布:

```
src/keybindings/
  index.ts                       export 总线
  schema.ts                      KEYBINDING_ACTIONS / KEYBINDING_CONTEXTS 联合类型 + 文档字符串
  types.ts                       Keybinding / KeybindingBlock / ParsedKeystroke 数据形状
  parser.ts                      "ctrl+shift+k k" → ParsedKeystroke[]
  resolver.ts                    runtime 解析:输入事件 + pending chord state → 'match' / 'chord_start' / 'chord_cancelled' / 'unbound'
  loader.ts                      JSON 文件加载 + merge default + hot reload
  defaults.ts                    DEFAULT_KEYBINDINGS 常量
  reserved.ts                    RESERVED_SHORTCUTS 表
  validate.ts                    校验 + 警告生成
  KeybindingContext.tsx          React Context + Provider
  KeybindingProviderSetup.tsx    顶层 Provider + ChordInterceptor 安装
  useKeybinding.ts               每个 handler 子组件 register API
  hot-reload.ts                  file watcher → reload + diff notification

src/hooks/
  useGlobalKeybindings.tsx       全局 app:* 键位 (toggleTodos, toggleTranscript, redraw, ...)
  useCommandKeybindings.tsx      command:* → 自动提交 /<name>
  useExitOnCtrlCD.ts             ctrl+c / ctrl+d 双击退出 (不走 keybinding 系统)
  useExitOnCtrlCDWithKeybindings.ts  trivial wrapper,DI 切环

src/ink/focus.ts                 DOM-like FocusManager
src/hooks/useVimInput.ts         vim NORMAL/INSERT/REPLACE 模式实现
```

---

## 二、KEYBINDING_CONTEXTS 与 KEYBINDING_ACTIONS

`schema.ts` 定义两个联合类型,是整个系统的"动词表 + 名词表":

### KEYBINDING_CONTEXTS(18 个)

```
'Global' | 'Chat' | 'Autocomplete' | 'Brief' | 'Transcript' |
'TranscriptSearch' | 'ModelPicker' | 'FastModePicker' | 'PermissionRequest' |
'SkillPermissionRequest' | 'CodexUpgrade' | 'IDEPicker' | 'SubAgentPicker' |
'FocusedInput' | 'MoreOptions' | 'PlanReview' | 'Terminal' | 'HelpMenu'
```

**Context 是栈式互相覆盖**:Chat 是基础,弹出 ModelPicker 时 ModelPicker context 临时入栈,关闭 dialog 后回到 Chat。

### KEYBINDING_ACTIONS(~95 个)

按 namespace 分:`app:*`(toggleTodos, redraw, interrupt, exit)、`chat:*`(submit, killAgents, cyclePane)、`autocomplete:*`(next, prev, accept, dismiss)、`vim:*`(escape — 实际 vim 内部没用)、`command:*`(用户在 JSON 里写 `command:loop` 之类,自动 → `/loop`)等。

精髓:**action 命名带 namespace**。这避免了"reset"这种通用名字在不同 context 含义冲突。

---

## 三、parser.ts:键盘字符串到结构化

输入 `"ctrl+shift+k k"`(VS Code 风格 chord),`parseKeybinding` 返回:

```ts
[
  { ctrl: true, shift: true, key: 'k' },
  { key: 'k' }
]
```

实现要点:
1. **按 ' '(空格)分 chord 步骤**,每步内部按 `+` 分组件。
2. **modifier 任意顺序**:`ctrl+shift+k` 和 `shift+ctrl+k` 等价 — 调用 `normalizeKeyForComparison` 时按固定顺序重排。
3. **特殊键名映射**:`escape`/`return`/`tab`/`backspace`/`delete`/`space`/`leftArrow`/`rightArrow`/`upArrow`/`downArrow`/`pageUp`/`pageDown`/`home`/`end`/`f1`-`f12`。
4. **大小写敏感**:`Ctrl` 不识别,只接受小写 `ctrl`。这是故意的 — 强迫一致风格。

`normalizeKeyForComparison(parsed)` 返回 "canonical string" 用于 dedup —"shift+ctrl+k" 和 "ctrl+shift+k" 都规约成 `"ctrl+shift+k"`。

---

## 四、resolver.ts:输入事件到 action

`resolveKeyWithChordState(input, key, pendingChord, bindings)` 返回:

| 返回值 | 含义 |
|---|---|
| `{ type: 'match', action, wasInChord }` | 命中单键或 chord 完成 |
| `{ type: 'chord_start', step }` | 第一键命中 chord 的第一步,等下一键 |
| `{ type: 'chord_cancelled' }` | 在 chord 中按了非 chord 第二键的键 — 取消整个 chord |
| `{ type: 'unbound' }` | 完全没绑定 |

为啥不直接返回 handler 调?**resolver 是纯函数,不知道 handler 在哪。** 它告诉调用方"应该执行什么 action",由 ChordInterceptor 去 handlerRegistry 查 handler 调。

**关键 `wasInChord` 标志**:

- 单键直接 match → `wasInChord: false` → ChordInterceptor 不阻止下游传播,让 useTypeahead 等子 hook 还能收到 Enter。
- chord 第二键 match → `wasInChord: true` → ChordInterceptor `stopImmediatePropagation`,因为 chord 完成是"完整意图,不该再被解读"。

这个区分至关重要 — 没有它,所有键命中绑定后 Enter 都被吞,用户无法在 TextInput 里换行。

---

## 五、loader.ts + hot-reload.ts

`loadKeybindingsSyncWithWarnings`:
1. 读 default keybindings(`defaults.ts`)。
2. 读 `~/.claude/keybindings.json` 用户层。
3. 读 `<project>/.claude/keybindings.json` 项目层(若存在)。
4. 三层 merge(后覆盖前)。
5. 调 `validateBindings` 收集 warnings,返回 `{ bindings, warnings }`。

`hot-reload.ts` 监听文件变化:
- 文件 mtime 变化 → 重新 load → 比 diff(新增 / 删除 / 修改 action)。
- 发 reload event → KeybindingProviderSetup 内的 useEffect 监听 → 调 `setBindings(newBindings)`。
- 也发新增的 warnings(去重老的,只通知新出现的)。

**为啥 sync load 启动?** 因为 KeybindingSetup 用 `useState` 初始化要立刻有 bindings,不能等异步。CLI 启动延迟敏感,文件读取不能 await。Hot reload 才是异步。

---

## 六、validate.ts(498 行,本次完整读)

5 种 warning 类型:`parse_error` / `invalid_context` / `invalid_action` / `duplicate_key` / `reserved_shortcut` / `bare_letter_warning`(voice:pushToTalk 专用)。

### `validateKeystroke`

每个 keystroke 解析后:
- 解析失败 → `parse_error`,具体说明哪部分错。
- modifier 和 key 都为空 → 报错(类似 `"ctrl+"` 这种漏写)。
- 解析成功但 key 是 bare letter 且 action 是 `voice:pushToTalk` → `bare_letter_warning`(因为 PTT 热身阶段会把字母打进输入框)。

### `validateBlock`

每个 context block 验证:
- context 名字必须在 VALID_CONTEXTS。
- bindings 字段必须存在且是对象。
- 每个 action 名字必须在 KEYBINDING_ACTIONS,**或** 匹配 `command:*` 正则 `/^command:[a-zA-Z0-9:\-_]+$/`。
- `command:*` action **必须在 Chat context 注册** — 不然警告(因为它走 onSubmit 链)。

### `checkDuplicateKeysInJson`(raw regex 扫描)

**为啥不用 JSON.parse 后查重?** 因为 `JSON.parse({"a": 1, "a": 2})` 静默返回 `{a: 2}` — 第一个 `a: 1` 被丢了,你查不出。

所以用正则扫 raw JSON 文本,在每个 bindings block 内统计 key 出现次数:

```ts
const blockRegex = /"bindings"\s*:\s*\{([^}]+)\}/g
const keyRegex = /"([^"]+)"\s*:/g
```

跨 context 允许同 key(不同 context 含义不同),同 context 内重复就警告。

### `checkDuplicates`(post-parse 语义查重)

用 `normalizeKeyForComparison` 统一形式后比对 — 防"ctrl+shift+k" 和 "shift+ctrl+k" 这种 syntactically 不同但 semantically 相同的键被都接受。

### `checkReservedShortcuts`

`RESERVED_SHORTCUTS` 表里:`ctrl+c`、`ctrl+d`、`ctrl+z` 等系统级或 Claude Code 强保留的键。**用户绑定这些键 → 警告,但不阻止**(尊重用户控制权,只是提醒后果)。

### `validateBindings`(orchestrator)

收集所有 warning,**按 `${type}:${key}:${context}` 去重** — 同一个 warning 不会反复打扰用户。

### `formatWarning`

`error` 类用 `✗ ` 前缀,`warning` 类用 `⚠ ` 前缀 — 终端展示时颜色 + 图标区分严重程度。

---

## 七、KeybindingProviderSetup.tsx(307 行,本次完整读 — React Compiler output)

整个系统的"装配车间"。

### `CHORD_TIMEOUT_MS = 1000`

chord 第一键按下后,1 秒内无第二键自动取消。这是用户友好阈值 —"我按了一半,但忘了第二键是啥"应该自然 reset。

### `useKeybindingWarnings`

warning 通过 `useNotificationCenter` 推:
- timeoutMs = **60000**(显示 1 分钟)。
- priority 依错误数:warning 5 / error 10。
- 信息后缀 `" · /doctor for details"` — 引导用户去诊断命令看完整列表。

### `KeybindingSetup` 组件

state 初始化用 `useState(loadKeybindingsSyncWithWarnings)` — **sync**,启动零延迟。
subscribe 到 file watcher 的 reload event → set state — **hot reload 是异步的**。

### 几个关键 ref / state

- `pendingChordRef`:RefObject,**同步 ref** — input handler 触发时立刻读最新。
- `pendingChord`:state,用于 UI 显示("Waiting for second key of chord ctrl+k...")。
- `chordTimeoutRef`:setTimeout 句柄,新 chord 来时 clear 老的。
- `handlerRegistryRef`:`Map<actionKey, Set<{action, context, handler}>>` — 子组件通过 `useKeybinding` 注册 handler 时塞进来。
- `activeContextsRef`:**Set,ref 不 state** — 因为 input handler 需要立刻读当前所有激活 context,不能等 render 周期。

`registerActiveContext` / `unregisterActiveContext` 用 `useCallback` `[]` 依赖 — 引用恒定,子组件不会因为父 re-render 而被认为 props 变了。

### `setPendingChord` wrapper

```ts
const setPendingChord = useCallback(next => {
  clearTimeout(chordTimeoutRef.current)
  pendingChordRef.current = next         // 同步更新 ref
  setPendingChordState(next)              // 异步触发 re-render
  if (next) {
    chordTimeoutRef.current = setTimeout(() => {
      pendingChordRef.current = null
      setPendingChordState(null)
    }, CHORD_TIMEOUT_MS)
  }
}, [])
```

**ref 和 state 同时更新** — ref 给 handler 同步用,state 给 UI 渲染用。这是 React 里 sync/async 双轨的标准模式。

### `ChordInterceptor`(内部组件,returns null)

```tsx
useInput((input, key) => {
  // wheel 事件短路 — 不在 chord 中就完全跳过 registry scan
  if (key.wheel && !pendingChordRef.current) return

  const contexts = new Set<KeybindingContextName>()
  for (const [, set] of handlerRegistryRef.current) {
    for (const { context } of set) contexts.add(context)
  }
  for (const ctx of activeContextsRef.current) contexts.add(ctx)
  contexts.add('Global')

  const result = resolveKeyWithChordState(input, key, pendingChordRef.current, bindings)
  switch (result.type) {
    case 'match': {
      const handlers = handlerRegistryRef.current.get(result.action)
      if (handlers) {
        for (const { handler, context } of handlers) {
          if (contexts.has(context)) handler(input, key)
        }
      }
      if (result.wasInChord) {
        setPendingChord(null)
        // 关键:chord 完成时阻止下游
        key.stopImmediatePropagation?.()
      }
      // 单键 match — 让下游 useTypeahead / useTextInput 继续看到
      break
    }
    case 'chord_start':
      setPendingChord(result.step)
      key.stopImmediatePropagation?.()  // 第一键不让下游用
      break
    case 'chord_cancelled':
      setPendingChord(null)
      key.stopImmediatePropagation?.()  // chord 取消也不下传
      break
    case 'unbound':
      // 完全不动 — 让其他 hook 继续处理
      break
  }
})
```

**为啥用 `useInput` 而不是 `useKeybinding`(注释里 eslint-disable):** 因为 ChordInterceptor **必须最先收到所有按键** — 它要决定是否要 stopPropagation。如果走 useKeybinding 流程会先经过 dispatcher,无法实现"在分发之前拦截"。

---

## 八、useKeybinding.ts:子组件注册 API

```ts
useKeybinding({ action: 'chat:submit', context: 'Chat', handler: () => onSubmit() })
```

实现:`useEffect` 中往 handlerRegistryRef.current 塞条目,cleanup 时移除。注册时用 `useLayoutEffect`(不是 useEffect)— **必须在子 hook 的 useInput 注册之前完成**,否则首次按键会漏。

---

## 九、useGlobalKeybindings.tsx(248 行,本次完整读)

8 个全局 keybindings 注册:

| Action | 默认键 | Handler 要点 |
|---|---|---|
| `app:toggleTodos` | `ctrl+t` | cycle `expandedView` 状态: 有 teammate 时 none → tasks → teammates → none,否则 none ↔ tasks |
| `app:toggleTranscript` | `ctrl+r` | enter/exit transcript view + 解决 `isBriefOnly` 卡 state |
| `app:toggleBrief` | `ctrl+b` | **asymmetric gate** — OFF 转换总是允许,即使条件不满足(避免卡住) |
| `app:toggleTeammatePreview` | `ctrl+i` | 切 teammate preview |
| `app:toggleTerminal` | `ctrl+\` | TERMINAL_PANEL feature + GB gated,`getTerminalPanel().toggle()` — 会 block 直到 detach from tmux 完成 |
| `app:redraw` | `ctrl+l` | `instances.get(process.stdout)?.forceRedraw()` — 强制 Ink 重渲 |
| `transcript:toggleShowAll` | `t`(in Transcript) | 切完整显示 vs 仅 message |
| `transcript:exit` | `escape` | 退 transcript view |

### `handleToggleTranscript` 的 escape hatch

```ts
if (isBriefOnly) {
  // GB kill-switch 可能让 brief 模式卡住
  setBriefOnly(false)
}
// 然后才 toggle transcript
```

**真实事故的解药** — 当 growth-book killswitch 临时关掉 brief 后,`isBriefOnly` 状态可能滞留 — 用户按 ctrl+r 不仅切 transcript,也顺便清这个 stuck state。**别让用户被迫重启**。

### `handleRedraw`(ctrl+l)

```ts
instances.get(process.stdout)?.forceRedraw()
```

为啥需要?**外部 clear** —— macOS Cmd+K 或 `clear` 命令 — 会清终端但 Ink 的 diff engine 不知道,以为屏幕上还显示着旧内容,下次更新时只发送 diff,导致用户看到空白。`forceRedraw` 重发完整 frame。

### `transcript:exit` isActive 门

```ts
isActive: isInTranscript && !searchBarOpen
```

**没这个 `!searchBarOpen` 就坑** — 用户在 transcript 里打开 search bar,按 Esc 想关 search。useSearchInput 的 onCancel 也注册 Esc,transcript:exit 也注册 Esc。React 顺序里子组件先注册 → 同时 fire → search 关了 + transcript 也退了。

加上 isActive gate 后:search 开着时 transcript:exit 自己 dormant,只让 search 处理 Esc。

### `require()` 动态导入

```ts
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { InProcessTeammateTask } = require('../task/InProcessTeammateTask')
const { BriefTool } = require('../tools/BriefTool')
```

**破循环 import** — `useGlobalKeybindings` 被很多 component 引用,而它如果静态 import InProcessTeammateTask / BriefTool,这两个模块再 import 回来就死锁。

---

## 十、useCommandKeybindings.tsx(107 行,本次完整读 — React Compiler output)

用户在 keybindings.json 写:

```json
{
  "Chat": {
    "bindings": {
      "ctrl+l": "command:loop"
    }
  }
}
```

`useCommandKeybindings` 扫描 bindings,找出所有 `command:*` action,为每个注册一个 handler,handler 触发时:

```ts
onSubmit(`/${commandName}`, NOOP_HELPERS, { fromKeybinding: true })
```

### `NOOP_HELPERS`

```ts
const NOOP_HELPERS = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
}
```

**为啥都 no-op?** 因为用户按快捷键时,输入框里可能已经在打字 — 触发 `/loop` 时不该清空输入。等命令处理完(可能是 sub-agent 启动),用户的草稿还在原地。

### `{ fromKeybinding: true }` 标志

下游命令系统(M16)收到这个标志 → 知道是快捷键触发不是手动输入 → 跳过某些 echo / confirm 逻辑。

### `isActive` 门

```ts
isActive: isActive && !isModalOverlayActive
```

ModelPicker / FastModePicker 等 modal 打开时,快捷键 dormant — 避免按 ctrl+l 时模态对话框看到 `/loop` 直接 submit 的诡异行为。

### `useOptionalKeybindingContext`

返回 null 如果没 Provider — graceful fallback,不强求所有 component 都在 KeybindingProvider 之内。

---

## 十一、useExitOnCtrlCD.ts + useExitOnCtrlCDWithKeybindings.ts(共 119 行)

ctrl+c / ctrl+d 处理的几个独有约束:

### 为啥不走 chord 系统?

第一次按 ctrl+c 必须**立刻**触发 `onInterrupt`(打断当前 agent 工作),然后再判断"如果 N 秒内再按一次就 exit"。

如果走 chord 系统:第一次按 ctrl+c → ChordInterceptor 看到 "可能是 chord 第一键,等等",**不触发 interrupt** — 用户血压上升。

所以用 `useDoublePress`(基于时间窗的双击检测):

```ts
const onCtrlC = () => {
  const handled = onInterrupt()       // 总是先 try interrupt
  if (!handled) {
    // 没有可中断的事,就走 exit 双击
  }
}
useDoublePress(ctrlCRef, onCtrlC, () => process.exit(0), DOUBLE_PRESS_WINDOW)
```

### 注册到 keybinding 但 hardcoded

```ts
useKeybinding({ action: 'app:interrupt', handler: ctrlCHandler, context: 'Global' })
useKeybinding({ action: 'app:exit', handler: ctrlDHandler, context: 'Global' })
```

但 default binding 是固定 `ctrl+c` / `ctrl+d`,**用户改不了**(在 RESERVED_SHORTCUTS 里)。注册到 keybinding 系统只是为了"能被 disable 当 isActive=false"。

### isActive=false 时

embedded TextInput focused 时(比如 Brief 表单),isActive=false — TextInput 自己处理 cancel/exit(esc 退出 form 而不是 exit program)。

### `useExitOnCtrlCDWithKeybindings`(24 行 wrapper)

```ts
export function useExitOnCtrlCDWithKeybindings(onInterrupt, onExit, isActive) {
  return useExitOnCtrlCD(useKeybindings, onInterrupt, onExit, isActive)
}
```

**DI 切环** — useExitOnCtrlCD.ts 本身**不 import keybindings module**(避免循环),它接受 `useKeybindingsHook` 作为参数。这个 wrapper 在外层把真的 hook 注入进来。

精髓:**模块间循环时,把"使用方"做成 DI 接受方,在更高层组装时注入** — 比 dynamic require 更"声明式"。

---

## 十二、useVimInput.ts(316 行,本次完整读)

vim NORMAL / INSERT / REPLACE 三模式。

### 关键 state 三层

| 名字 | 类型 | 作用 |
|---|---|---|
| `mode` | `state` | UI 渲染(footer 显示 NORMAL/INSERT) |
| `vimStateRef` | `Ref` | input handler 同步访问(NORMAL idle / count / operator / ...) |
| `persistentRef` | `Ref` | 跨模式持久:register(yank/del 内容)、lastChange(. 重放)、lastFind(; , 重复) |

为啥 mode 是 state 而 vimState 是 ref?**mode 显示给用户看(footer),需要 React render;vimState 切换频繁(每键都可能变),用 state 会过度 re-render 且 handler 拿不到最新值。**

### 包装 useTextInput **不带 inputFilter**

```ts
const textInput = useTextInput({
  ...,
  // 注意:不传 inputFilter
})

const handleVimInput = (input, key) => {
  // 在这里手动调 inputFilter
  if (inputFilter) {
    const filtered = inputFilter(input, key)
    if (filtered === null) return  // filter 吞了
  }
  // ... vim 逻辑
}
```

为啥?**vim 有些键路径走完后 return,不调用 textInput.onInput** — 比如按 'j' 移光标只调 setCursorOffset。如果 filter 注入到 useTextInput 内,这些路径完全绕过 filter,filter 的 stateful 状态(比如 paste 检测)就保留不清,下次进 INSERT 模式按键时 filter 误判。

所以 vim 在最外层先 apply filter,保证所有路径都 filter 过。

### `switchToNormalMode`

按 Esc 进 NORMAL 时:
- 光标左移 1(除非已在行首或 offset 0)— 模拟 vim 的"INSERT 后光标在字符前,NORMAL 时回到字符上"。
- 调 `setMode('NORMAL')`。

### **Esc 故意不走 keybindings 系统**

代码注释里直接写:**"intentionally NOT migrated to the keybindings system"**。

为啥?**vim 的 Esc 是 vim 范畴的语义,不该让用户改成别的键** — vim 老用户的肌肉记忆是 Esc。改成别的会把 vim emulation 搞得四不像。

### `insertedText` 跟踪 + 点重放

INSERT 模式下每按一个字符,在 `state.insertedText` 上 append。按 Esc → NORMAL 时把这段记到 `persistentRef.lastChange`。下次按 `.` 时 replay 这段。

backspace 用 `lastGrapheme(state.insertedText)` 取最后一个字素 — 处理多字节(emoji / 中文)正确。

### `expectsMotion` gate

vim 的几个"等 motion"状态:`idle`、`count`、`operator`、`operatorCount`(光标对的 dw / d3w 之类)。

只有这些状态下 backspace 才 map 成 `h`(左移),delete 才 map 成 `x`(删字符)。

为啥要 gate?**`replace` 状态下 r+Backspace 应该是"用 backspace 字符替换当前字符" — 如果还 map 成 h 就是"用 h 替换",完全错乱。**

### `replayLastChange`

`change.type` 10 种:`insert / x / replace / toggleCase / indent / join / openLine / operator / operatorFind / operatorTextObj`。每种独立 replay 逻辑。

### 箭头键 → vim 键映射

NORMAL 模式下:`leftArrow → h`、`rightArrow → l`、`upArrow → k`、`downArrow → j`。

这是给"不愿意学 vim 但想用 NORMAL 模式做某些事(比如 d3w 删 3 词)的用户"的过渡。

### NORMAL idle 委托

NORMAL 模式 idle 状态下按上下键,如果当前不是 vim 命令,委托 baseHandler — 走 useTextInput 的光标移动 + 历史 fallback。

### `setModeExternal` API

让外部代码(比如某 plugin)能 force mode change — 比如某 plugin 实现 "/" 进 vim search mode 自动切 NORMAL。

---

## 十三、ink/focus.ts(181 行,本次完整读)

DOM-like FocusManager — 给 Ink 加焦点管理。

### `FocusManager` class

纯 state 容器,**不发副作用**:

```ts
class FocusManager {
  stack: DOMElement[] = []        // 焦点历史栈
  current: DOMElement | null = null
  enabled = true
  rawListeners: Map<DOMElement, Set<Listener>> = new Map()
}
```

### `MAX_FOCUS_STACK = 32`

stack 长度上限。为啥?**Tab cycle 一直按下去,如果不 cap 会无限增长** — 内存泄漏。

### `focus(node)`

1. dedup before push — 如果 node 已经在 stack 顶,不再 push。
2. dispatch blur to old,focus to new。
3. push new。
4. 超过 MAX_FOCUS_STACK 时 shift 掉最老的。

### `handleNodeRemoved(node, root)`

DOM 节点被 unmount 时调:
1. 从 stack 过滤掉 node 和它所有 descendants(用 `isInTree(stackNode, node)`)。
2. 焦点恢复:从 stack 找最近还 mounted 的元素 → focus 它。
3. 如果 stack 空了,current = null。

### `handleAutoFocus` / `handleClickFocus`

- `autoFocus`:DOMElement render 时如果有 autoFocus prop 就自动获取焦点。
- `clickFocus`:鼠标点击后获取焦点 — **要求 tabIndex 已设置**(不可点击非 tabbable 元素)。

### `enable / disable`

模态对话框打开时 `disable` — Tab 在 modal 内部循环,不到外面去。close 时 `enable`。

### `focusNext / focusPrevious`

`moveFocus(direction: 1 | -1)`:
1. `collectTabbable(root)` 走树收集所有 `tabIndex >= 0` 的元素。
2. 当前 index + direction(取模实现 wrap)。
3. focus 新元素。

### `getRootNode` / `getFocusManager`

```ts
function getRootNode(node: DOMElement): DOMElement {
  let cur = node
  while (cur.parentNode) cur = cur.parentNode
  return cur
}

function getFocusManager(node: DOMElement): FocusManager | undefined {
  return getRootNode(node).focusManager
}
```

**像 browser 的 `node.ownerDocument`** — FocusManager 挂在 root 上,任何子节点能往上走拿到。这避免了"传 FocusManager 引用到每个 component"的繁琐。

---

## 十四、给 Agent 作者的可复用清单

1. **keybinding action 加 namespace 前缀**(`app:*` / `chat:*` / `command:*`)— 避免 "reset" 这种通用名在不同 context 含义冲突。
2. **chord 用 ref 存 pendingChord + 1 秒 timeout 自动取消** — 用户友好阈值,可调。
3. **resolver 纯函数返回 'match'/'chord_start'/'chord_cancelled'/'unbound'** — 不知道 handler 在哪,让上层去查 registry。
4. **`wasInChord` 标志决定要不要 stopPropagation** — chord 完成阻断,单键命中放行。否则 Enter 等键会被吞。
5. **`activeContextsRef` 是 ref 不是 state** — input handler 触发是同步的,等不及 render 周期。
6. **`useLayoutEffect` 注册 keybinding,不用 useEffect** — 必须在子 hook useInput 之前装好。
7. **JSON 配置查重用 raw regex 不用 JSON.parse** — parse 会静默丢弃重复 key,你查不出。
8. **warning 按 type:key:context 去重 + 只在第 2 次出现时才警告** — 噪音抑制。
9. **保留键(ctrl+c/d/z)默认不让改但允许 warning + 用户坚持的话还是接受** — 尊重用户控制权。
10. **`command:*` 这种灵活 action 在 schema 之外用正则匹配** — 不需要枚举所有可能命令名。
11. **NOOP_HELPERS 模式:快捷键触发命令不清空输入框** — 用户草稿保留。
12. **`{ fromKeybinding: true }` 标志透传**,让下游知道触发源。
13. **`isActive && !isModalOverlayActive` gate** — modal 期间 keybinding dormant。
14. **escape hatch:某 GB 切换可能让 state 卡住** — 在常用 toggle handler 里顺便清掉 stuck state,别让用户重启。
15. **ctrl+l forceRedraw 救火外部 clear** — `instances.get(process.stdout)?.forceRedraw()`。
16. **child + parent 同时注册 Esc 时 parent 加 `!childOpen` gate** — 避免 double-fire。
17. **ctrl+c 不走 chord 用 useDoublePress** — 第一次按必须立刻 interrupt。
18. **DI 切循环:把 useKeybindings hook 作为参数传给底层 hook** — 比 dynamic require 更"声明式"。
19. **vim 模式 state 用 ref + state 双轨**:mode 给 UI 看(state),vimState 给 handler 用(ref)。
20. **vim inputFilter 在最外层 apply 不在 useTextInput 内** — 否则 vim 路径绕过 filter,stateful filter 状态错乱。
21. **vim Esc 故意 NOT 走 keybindings** — vim 语义不该让用户改。
22. **`expectsMotion` gate 决定 backspace→h 映射只在 idle/count/operator 状态生效** — replace 状态下 r+Backspace 不能变成"用 h 替换"。
23. **`lastGrapheme` 取多字节最后一字素** — emoji / 中文正确处理。
24. **FocusManager 加 MAX_FOCUS_STACK cap** — Tab 一直按不会无限增长。
25. **`handleNodeRemoved` 过滤 node + 所有 descendants** — 避免焦点卡在已 unmount 节点。
26. **focus stack `dedup before push`** — Tab cycling 不会反复 push 同一节点。
27. **FocusManager 挂在 root,getFocusManager(node) 像 ownerDocument** — 不用传引用到每层。

---

## 十五、收尾

M20 解决:**键位绑定系统既要让用户配置又要让内部 chord 安全工作,同时兼顾 vim 模式和 DOM-like 焦点切换**。

精髓总结:
- **resolver 是纯函数,registry / context / state 都从外部注入** — 高度可测。
- **ref + state 双轨** — sync handler 用 ref,UI 用 state,这是 React 里 sync/async 双轨标准模式。
- **wasInChord 区分** 把"单键直接 match 放行 / chord 完成阻断"严格分开,Enter 等键不被吞。
- **保留键警告但不阻止** — 尊重用户控制权。
- **DI 切循环 import** — 比 dynamic require 优雅。
- **vim 故意保留 Esc 不可配置** — 不是所有键位都该交给用户改。
- **FocusManager 像 DOM** — 老概念重用,认知成本低。

这套设计抄到你的 Agent,能让你少走 6 个月弯路 — 特别是 `wasInChord` 区分、`isActive` gate、DI 切环这几条。
