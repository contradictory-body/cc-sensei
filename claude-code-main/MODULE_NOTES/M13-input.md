# M13 · 输入子系统 (PromptInput / 编辑器 / 历史 / Vim / Paste / Suggestions / Footer)

> 范围: `src/components/PromptInput/**` + `src/hooks/useTextInput.ts` + `useInputBuffer.ts` + `useArrowKeyHistory.tsx` + `useHistorySearch.ts` + `useVimInput.ts` + `usePasteHandler.ts` + `usePromptSuggestion.ts` + `useSearchInput.ts` + `useShowFastIconHint.ts`
> 关联: M11(Ink 渲染) / M12(消息) / M16(命令) / M14(子代理) / M19(状态) / M10(remote bridge)

---

## 一、模块定位

PromptInput 是 CLI 的"输入舱":一个被多种角色复用的 TextInput,顶部挂着 mode/voice/queued/notifications 等 banner,底部挂着 footer(快捷键 hint / suggestions / 进度计数). 它需要同时满足:

1. **多种"输入语义"** — 普通 prompt / `!` bash 模式 / `/` 命令 / `@` 文件路径 / vim normal/insert / history 搜索 / `&` 后台任务前缀 / 配合 paste 大文本 / 配合粘贴图片.
2. **多种"展示形态"** — fullscreen vs 普通终端 / overlay 弹层 vs inline / remote 模式 / coordinator 模式.
3. **多种"键源来源"** — 物理键盘 / Ink stdin / 桥接 stdin(remote) / VSCode IDE 选区 / `claude-bridge` IPC.

整套设计的核心张力是: **每个新功能都想往 footer 塞一行 hint**, 而 footer 必须在 fullscreen 下保持一行高度;**每次按键都可能触发 8 种 handler**, 而响应又必须 <16ms;**输入区域随键入和 paste 高度变化**, 而上面 ScrollBox 的 scroll offset 不能跳.

M13 把这些张力拆成 9 个 hook + 1 个大 PromptInput + 13 个 sub-component, 通过组合解决.

---

## 二、useTextInput — 单字符 buffer 状态机

`src/hooks/useTextInput.ts` 是底层. 它接收 `value, onChange, columns, ...`, 内部维护 `cursorOffset: number`(字符索引,非字节). 对每个按键事件:

```
input: string  (stdin 解码后的可见字符或控制序列)
key: { ctrl, meta, shift, return, backspace, delete, leftArrow, rightArrow, ... }
```

调度顺序:
1. **空格 / 字面字符** → `insertAtOffset(value, cursorOffset, input)` + cursorOffset++
2. **backspace** → 删 cursorOffset-1 处一字符
3. **delete (fn+backspace)** → 删 cursorOffset 处一字符
4. **leftArrow/rightArrow** → 移光标
5. **alt+leftArrow/alt+rightArrow** → 按"word boundary"跳
6. **ctrl+a / ctrl+e** → 跳行首/行尾
7. **ctrl+k** → 删到行尾
8. **ctrl+u** → 删到行首
9. **ctrl+w** → 删一个 word
10. **return** → 调 `onSubmit(value)` (上层决定)

关键设计:

- **`cursorOffset` 用字符数而非字节数**. 中文 / emoji 是多字节, 但显示上是 1-2 列宽. 用字符数计算 splice, 用 `string-width` 计算 column 位置.
- **每次 setValue 都按 immutable 替换整段字符串**. 因为 React useState 比较 reference, 不可以 mutable splice. 字符串拼接的 O(n) 在 prompt 这种 <10KB 场景下完全可以接受.
- **方向键 word 跳转用 regex `/[\s\-_/]/`**. 既适配空格 + 标点符号 + 路径分隔符. 不是完整的 unicode word-break, 但够用且性能 O(n).

---

## 三、useInputBuffer — 历史滚动 + draft 保护

`src/hooks/useInputBuffer.ts` 比 useTextInput 高一层. 它管:
1. 用户当前未提交的 draft (绑到 useTextInput 的 value).
2. 用户按上箭头时, 进入"history navigation" 模式, value 切到历史第 i 条.
3. 用户在历史中编辑后, 这条历史变成 "modified draft", 不污染原始历史.
4. 用户按下箭头回到最新, 恢复未编辑前的 draft.

精髓:

- **`historyIndex: number | null`** — null 表示"在编辑当前 draft", 非 null 表示"在浏览第 i 条历史".
- **`pristineHistory: string[]`** — 不可变的原始历史(从 disk 加载, append-only).
- **`draftBeforeHistory: string | null`** — 进入历史前快照 draft, 恢复时还回去.
- 一旦在历史中按键编辑, 不写回 `pristineHistory`, 只是 useTextInput.value 自己变. 用户提交时, 这条新文本 append 到历史尾部, 旧的那条原文不动.

**这就是 bash readline 的语义**, 但完全在 React state 里实现, 没用 readline 库. 自定义带来的好处: 我可以一边导航历史一边在历史文本里粘贴图片, 一边响应 `/<cmd>` 自动补全.

---

## 四、useArrowKeyHistory — 上下键单源真相

`src/hooks/useArrowKeyHistory.tsx`:

```
const [historyIndex, setHistoryIndex] = useState<number | null>(null)
const [savedDraft, setSavedDraft] = useState<string | null>(null)
const [savedCursorOffset, setSavedCursorOffset] = useState<number>(0)
```

上箭头:
1. 如果 historyIndex 是 null → 先 save 当前 draft + cursor, 然后跳到 history.length - 1.
2. 否则 → historyIndex - 1 (再老一条), 限制 ≥ 0.

下箭头:
1. 如果 historyIndex 是 null → 不处理(已在最新).
2. 如果 historyIndex < history.length - 1 → +1.
3. 否则 (在历史最后一条) → 恢复 savedDraft / savedCursorOffset, historyIndex = null.

**只在 cursor 处于第一行(↑) 或最后一行(↓) 时才触发**. 因为多行 prompt 时, ↑ 应该在 prompt 内部移动光标. 判定: cursor 前的字符串 indexOf('\n') === -1 → 第一行.

这个判定让 Claude Code 的 prompt 既能像 bash 那样 ↑↓ 翻历史, 又能像 textarea 那样多行编辑.

---

## 五、useHistorySearch — Ctrl+R 兼容 readline

`src/hooks/useHistorySearch.ts` 是 ctrl+r 触发的反向搜索. 状态:

```
isSearching: boolean
historyQuery: string
matchIndex: number  // 命中的第几条历史
historyFailedMatch: boolean
```

每次 historyQuery 变化, 从 history 末尾向前找第一个 includes(query) 的. 找到 → matchIndex, 没找到 → historyFailedMatch = true, footer 区域显示红色 "failed-match" 提示.

ctrl+r 再次按下 → 跳到再老一条的 match.
ctrl+s → 反向(向新).
ctrl+g 或 esc → 退出搜索, value 恢复.

Footer 区域显示 `(reverse-i-search)'{query}': {matched-line}`. 这跟 bash 的 readline 一模一样.

---

## 六、useVimInput — normal / insert 状态机

`src/hooks/useVimInput.ts` 给 vim 用户提供"普通模式". 它是 useTextInput 的 sibling, 不替换它. 流程:

1. 用户按 esc → 状态切到 'normal'.
2. normal 状态下, useTextInput 不消费按键, vim handler 接管. h/j/k/l 移光标, w/b/e word 跳, dd 删行, yy 复制行, p 粘贴, ...
3. 用户按 i / a / o → 切回 'insert', useTextInput 重新接管.

精髓:
- **两个 hook 共享同一份 value / cursorOffset state**. vim 改 cursor 用同一个 setCursorOffset, useTextInput 改也用同一个. 这样模式切换不需要"重新初始化".
- **mode='insert' 时 useVimInput 的所有 useInput hook 用 `isActive: false`** 跳过, 把按键全留给 useTextInput. 反过来 mode='normal' 时 useTextInput 的所有 useInput 用 `isActive: false`.
- ModeIndicator 在 footer 显示 `-- INSERT --` 或 `-- NORMAL --`.

---

## 七、usePasteHandler — 大文本 + 图片粘贴

`src/hooks/usePasteHandler.ts`. 系统接收的 paste 事件可能是:
1. **几千字符的文本** — 不应该直接塞 value 让 useTextInput 一字符一字符 insert(那是 O(n²)). 也不应该全部展开显示在 prompt 里(屏幕直接被挤爆).
2. **图片二进制(base64 编码 OSC52)** — 不是文本, 不能 insert 进 prompt string.
3. **路径(macOS 拖文件 → 终端会把路径文本粘进来)** — 应该当文本.

策略:

```
const pastedText = await readPastedContent()
if (pastedText.length > PASTE_TRUNCATE_THRESHOLD) {
  const pasteId = generatePasteId()
  storePasteContent(pasteId, pastedText)
  insertText(`[Pasted text #${pasteId} +${lineCount} lines]`)
} else {
  insertText(pastedText)
}
```

短文本直接 insert, 长文本 store 到 in-memory map + 给用户看一个 `[Pasted ... +N lines]` 的 placeholder, 提交时再展开. 图片走单独 channel — 转 base64 存内存, 占位符变成 `[Image #abc123]`, agent 调用时附在 message 的 image content 里.

**用户在 prompt 里编辑那个占位符占位符就消失, store 里的 paste 也释放**. 这是显式的"内嵌资源 + ID"模型, 不是富文本.

---

## 八、usePromptSuggestion — 多源补全融合

`src/hooks/usePromptSuggestion.ts` 给 PromptInput 提供"边输入边浮出"的 suggestion 列表. 它根据 prompt 的最新 token 决定要拉哪类 suggestion:

| 触发前缀 | suggestion 类型 | 拉数据来源 |
|---|---|---|
| `/` | commands | `getAllCommands()` (含 plugin commands) |
| `@` | files / mcp-resources / agents | M07 文件系统 + M08 MCP resource registry + M14 agent registry |
| `&` | background-task | recent background tasks |
| `!` | shell command | 无补全, 进 bash mode |
| `/<cmd> --arg ` | command args | command schema 暴露的 args |
| 空白 (无前缀) | 隐藏 | — |

精髓:
- **每个 source 是独立 async fetcher**, 通过 `useDeferredValue(query)` 防抖, 100ms 不变才发. 防止打字时连发请求.
- **结果合并按"前缀长度"排序**. 用户打 `@src/c`, 命中 `src/components/` 比 `src/commands/` 先, 因为前者 prefix-match 更长.
- **结果 cap 在 50 条**, 但 PromptInputFooterSuggestions 只显示 `OVERLAY_MAX_ITEMS = 5` 或 inline 时 `Math.min(6, rows-3)`.
- **selectedIndex 居中**: `startIndex = clamp(selected - floor(maxVisible/2), 0, total - maxVisible)`. 用户按 ↓ 时, 选中项总在视窗中间, 不会贴底.

---

## 九、PromptInput.tsx — 主组件

`src/components/PromptInput/PromptInput.tsx` (2338 行) 是壳, 把上面 9 个 hook 串成完整体验. 它的 state 树:

```
value, cursorOffset (来自 useTextInput)
mode: 'prompt' | 'bash' | 'memory' | 'plan' | 'vim-normal' | ... (toolPermissionContext.activeMode)
suggestions, suggestionIndex (usePromptSuggestion)
historyIndex (useInputBuffer)
isSearching, historyQuery (useHistorySearch)
isPasting, pasteContent (usePasteHandler)
queuedCommands: string[]  (用户连按 enter 攒下的)
notifications: Notification[]
voiceState (来自 voice hook)
swarmBanner (来自 useSwarmBanner)
```

布局 (从上到下):
```
<Notifications />  ← 上方所有 banner 堆叠
<IssueFlagBanner />
<PromptInputModeIndicator />  ← '-- PLAN --' / '-- INSERT --' / ...
<PromptInputQueuedCommands />  ← 还未提交的待执行命令列
<PromptInputStashNotice />
<SwarmBanner />
<HistorySearchInput />  ← 仅 isSearching 时
<VoiceIndicator />
<ShimmeredInput />  ← 真正的输入框, 字符在 stream 进入时有渐显动画
<PromptInputFooterSuggestions />  ← 补全弹层
<PromptInputFooter>
  <PromptInputFooterLeftSide />  ← mode + tasks + teammates + esc-interrupt hint
  <PromptInputHelpMenu />  ← 可选, 按 ? 展开
</PromptInputFooter>
<SandboxPromptFooterHint />  ← 沙箱模式额外提示
```

整个 Box 用 `flexDirection: column`. 关键技巧:

- **每个 banner 组件返回 null 时, Box 自动不占空间**. 不需要外部 if 判断, 减少调用方负担.
- **PromptInputFooterSuggestions 在 overlay 模式下用 `position: absolute, bottom: '100%'`** 浮在输入框上方, 这样不挤占行高.
- **fullscreen 模式下, footer 用 `flexShrink: 0` + `height: 1`** 强制单行, 内容用 `Text wrap='truncate'` 防止换行把屏幕撑爆.

---

## 十、PromptInputFooterLeftSide — 复杂度焦点

`src/components/PromptInput/PromptInputFooterLeftSide.tsx` (87KB) 是整个 M13 工程含量最高的文件. 它要在**一行**显示:

`{mode} · tasks {n} · teammates {n} · pr {y} · esc to interrupt · ? for help`

但显示规则极其精细:

1. **`primaryItemCount = (isCoordinator || hasActiveMode ? 1 : 0) + (hasBackgroundTasks ? 1 : 0) + (hasTeams ? 1 : 0)`** — 计算"必须显示的强项"个数.
2. **`shouldShowPrStatus = primary < 2 && (primary === 0 || columns >= 80)`** — pr 状态只在不挤的时候显示.
3. **`shouldShowModeHint = primaryItemCount < 2`** — `? for help` 只在不挤时显示.

为啥这么麻烦? 因为窄屏(<80列) + 多 mode 同时, 必须按重要性裁掉低优先级. 没规则就乱挤换行, 整个 footer 跳变.

### 10.1 ProactiveCountdown — useSyncExternalStore + setInterval

`ProactiveCountdown` 是 footer 里的"等待倒计时", proactive 模式下显示 `waiting 12s`:

```
useSyncExternalStore(
  proactiveModule?.subscribeToProactiveChanges ?? NO_OP_SUBSCRIBE,
  proactiveModule?.getNextTickAt ?? NULL,
  NULL
)
+ setInterval(update, 1000)
```

精髓: **proactive 模块可选加载**. 没 enable feature flag 时 `proactiveModule = null`, store/getter 全 fallback 到 no-op. setInterval 仍然 tick, 但每次 read 都是 null, render 出 null, footer 这一格空着.

DCE 模式: `const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require(...) : null`. 编译后无 KAIROS 用户的 bundle 完全没有 proactive 代码. 同样的 pattern 在 coordinatorModule.

### 10.2 Tasks pill 不能在 Text 里渲染

footer 主体是 `<Text wrap='truncate'>{...parts}</Text>`, parts 是 Text/string 数组. 但 Tasks pill (蓝底白字) 用 `<Box backgroundColor='blue' paddingX={1}>`, Ink reconciler **不允许 Box 在 Text 里**, 会 throw.

解决: tasks pill 作为 **`<Box>` sibling** 渲染在主 Text 之外:

```
<Box flexDirection='row'>
  {tasksPill}  ← 独立 Box
  <Text wrap='truncate'>{otherParts}</Text>  ← 普通 parts
</Box>
```

这样 layout 还是一行, 但 tasksPill 用 Box 的视觉表现, 其他用 Text 的 truncate. 一个看似细节的 workaround, 实际是 Ink+Yoga 约束下唯一的活法.

### 10.3 fullscreen 空 parts 必须返回 `<Text> </Text>`

当 footer 暂时没有任何 part 要显示(用户刚 enter 提交, banner 全清), 直接 return null 会让 Box 高度变 0. 下一次新 part 出现, 高度从 0 → 1, **导致上面 ScrollBox 内容向下挤一行, 用户视觉感受"滚动跳了"**.

解决: 返回 `<Text> </Text>`(空格). Yoga 仍然给它分配 1 行高度, 但不画字符. footer "高度恒定", scroll content 不跳.

精髓: **不要让 layout 抖动**. UI 稳定性比 "少 1 px 空白" 重要.

### 10.4 voice hint 跨实例并发保护

footer 想偶尔提示用户 "press v for voice input", 最多 3 次. 但用户可能开多个 Claude Code 实例, 各自读写 globalConfig:

```
voiceHintIncrementedRef = useRef(false)  // 当前 session 只增一次
useEffect(() => {
  if (!voiceHintIncrementedRef.current && shouldShowVoiceHint) {
    voiceHintIncrementedRef.current = true
    saveGlobalConfig(prev => {
      const current = prev.voiceFooterHintSeenCount ?? 0
      // 防御: 别的实例可能已经 +1, 不要倒退
      if (current >= newCount) return prev
      return { ...prev, voiceFooterHintSeenCount: newCount }
    })
  }
}, [...])
```

并发模型: 读了 0, 算出 +1 = 1, write 时检查 prev 已经是 1 了 → 不写. 是典型的 **compare-and-set** 思想, 但实现在 JS 单线程里, 通过 saveGlobalConfig 接受 callback (prev => next) 来确保 read-modify-write 原子.

### 10.5 macOS altClick 反挫败 UX

用户在 Mac 终端按 option + click 选区时, 默认终端不工作, 需要在 VS Code 设置 "macOptionClickForcesSelection". 如果用户多次失败, footer 不再重复提示 "press option+click to select", 改成:

```
selGetState()?.lastPressHadAlt
  ? 'set macOptionClickForcesSelection in VS Code settings'
  : 'option+click to select'
```

**第一次失败检测到 alt 键被按但没产生选区, 切到 "去设置" 的提示**. 反挫败设计的代表.

---

## 十一、PromptInputFooterSuggestions — 弹层 vs 内联

`src/components/PromptInput/PromptInputFooterSuggestions.tsx`. 两种渲染:

**Overlay 模式** (fullscreen): 父容器是 `position: absolute, bottom: '100%'`. 浮在 PromptInput 上方. 高度由内容撑开, 但 cap 在 `OVERLAY_MAX_ITEMS = 5` 防止溢出屏幕.

**Inline 模式** (普通终端): 直接 flex 渲染在 PromptInput 下方. 高度 `Math.min(6, rows - 3)` — 给上下留 3 行其他内容空间.

### 11.1 unified suggestion 单字符串技巧

file / mcp-resource / agent 这三种 suggestion 走 "unified" 渲染:

```
const icon = getIcon(item.id)  // '+', '◇', '*'
const lineContent = `${icon} ${displayText} – ${truncatedDesc}`
<Text wrap="truncate" inverse={selected}>{lineContent}</Text>
```

**整行作为单个字符串渲染, 不拆 children**. 这样:
- 终端不会在 icon 和 displayText 之间错误换行.
- Ink 的 wrap='truncate' 精确截在右边界.
- inverse(选中高亮) 整行连续, 没有视觉空隙.

替代方案是把 icon / displayText / desc 拆 3 个 Text children, 但 wrap+truncate 在多 children 上行为不一致, 容易出 bug.

### 11.2 description newline 必须先 flatten

description 来源可能是 skill 的 markdown frontmatter, 含换行:

```
'TRIGGER when:\n- foo\n- bar'
```

直接 truncate 会保留 `\n`, 渲染时这行膨胀成 3 行, 把整个 overlay 的 minHeight 撑变, 当 filter 缩小时不再撑那么多, 出现"幽灵行".

修复: **truncate 前先 `.replace(/\s+/g, ' ')` 把所有空白(含 \n)折叠成单空格**. 然后再裁宽度. 单行恒定.

### 11.3 file path 中间截断

```
truncatePathMiddle('src/components/PromptInput/PromptInputFooterSuggestions.tsx', 50)
→ 'src/components/.../PromptInputFooterSuggestions.tsx'
```

为啥中间截? 因为 prefix (src/components/) 和 suffix (实际文件名) 都重要. 头尾各保留, 中间填 `...`. 比 bash readline 默认的"右边截"更人性化.

### 11.4 overlay 不能 minHeight + flex-end

Inline 模式用 `minHeight=3 + justifyContent='flex-end'` 让 1-2 个 suggestion 也贴底显示, 美观.

Overlay 模式不能这样: 父是 `position: absolute, bottom: '100%'`, y 被 Ink renderer clamp 到 0. 如果 overlay 高度比 cursor 上方空间大, minHeight 撑高会让 overlay 下边覆盖 prompt 区, 视觉上跑进输入框.

所以 overlay 时省略 minHeight + flex-end, 让高度严格等于内容高度.

---

## 十二、PromptInputHelpMenu — 3 列布局

`src/components/PromptInput/PromptInputHelpMenu.tsx` (33KB). 按 ? 展开. 3 列 Box, 每列固定宽度:

```
<Box flexDirection='row' gap={2}>
  <Box width={fixedWidth ? 24 : undefined} flexDirection='column'>
    {col1Lines}
  </Box>
  <Box width={fixedWidth ? 35 : undefined} flexDirection='column'>
    {col2Lines}
  </Box>
  <Box flexDirection='column'>
    {col3Lines}  ← 不限宽
  </Box>
</Box>
```

10 条快捷键通过 `useShortcutDisplay(name)` 拉用户最新自定义的 binding, 经过 `formatShortcut(s)` 把 `ctrl+o` 转成 `ctrl + o` 显示.

精髓:
- **`feature('TERMINAL_PANEL') && getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_panel', false)` 双 gate** — 编译时 + 运行时. 编译时 false 整段 DCE; 运行时 false 同样不显示.
- **`getPlatform() !== 'windows'` 隐藏 `ctrl+z to suspend`** — Windows shell 不支持 SIGTSTP, 显示就是误导.
- **"cycle modes" (Anthropic) vs "auto-accept edits" (external)** 走编译时 `"external" === 'ant'` 决定. 外部 binary 看到 "auto-accept edits" 更友好.

---

## 十三、ShimmeredInput — 字符渐显动画

`src/components/PromptInput/ShimmeredInput.tsx`. 普通文本 input 是字符一旦插入就 fully opaque. ShimmeredInput 让最近插入的字符有个短暂的 dim → bright 过渡, 表达 "AI 正在 stream 字符进来" 的感觉.

实现:
- value 每变化, diff 出"新增的尾部字符".
- 这些字符用 `Text color='dim'`, 然后 100ms 后切到 `Text color='normal'`.
- 不变的部分用普通 color 直接渲染.

精髓: **只有"最新追加的部分"shimmer, 历史字符稳定**. 否则整行 shimmer 会让用户读不下去.

只在 isLoading (agent 正在 stream) 时 active. 用户自己打字时 shimmer 关掉, 否则键入延迟感增加.

---

## 十四、PromptInputQueuedCommands — 用户连按 enter

用户提交 prompt 后, agent 还在思考, 用户又按了一行新 prompt + enter. 这条新 prompt 不应该立刻丢, 也不应该打断当前 agent. 设计:

- queuedCommands: string[] — 用户提交的, 但 agent 还没空处理的.
- 显示在 PromptInput 上方, 灰色 text, 前缀 `[queued]`.
- agent 处理完当前 prompt → 自动 pop 队头, 触发下一轮.
- 用户可以 ctrl+x 清空整个队列.

精髓: **不要让用户的 enter 落空**. CLI 用户的肌肉记忆是"打完按 enter", 如果 agent 不接收, 直观感受是"键盘坏了". queue 是用最低成本(数组 + 1 个 Box)接住所有按键.

---

## 十五、VoiceIndicator — 录音状态

`src/components/PromptInput/VoiceIndicator.tsx`. 用户按下 v 进入语音输入:
- 显示一个 pulsing red circle + `Listening...`.
- 一旦 vad 检测到 0.5s 静音 → 提交录音段 → whisper transcribe → 写入 prompt value.
- 用户可以 esc 取消.

精髓: **整个 voice flow 是独立 hook, 不污染 useTextInput**. transcribe 完后用 `appendToValue(transcribedText)` 像 paste 一样插入到 cursor 位置.

---

## 十六、Notifications — 上方堆叠通知

`src/components/PromptInput/Notifications.tsx`. 显示在 PromptInput 最上方. 类型:
- info (蓝色) — 用户操作成功提示, 如 "Saved 3 files".
- warning (黄色) — 非阻塞警告, 如 "Token usage at 80%".
- error (红色) — 报错, 如 "Tool call failed".

每条 notification 有 `expiresAt: timestamp`, 过期自动 dismiss. 全局 `notificationsStore` (M19 state) 维护, 任何代码可以 `notify({type, message, expiresAfter: 5000})`.

精髓: **不阻塞主交互**. 不像 modal 那样需要点确认, 用户继续打字, notification 自动消失.

---

## 十七、SwarmBanner — 协作模式横幅

`src/components/PromptInput/useSwarmBanner.ts`. 用户开启 "swarm" (多 agent 协作) 模式, prompt 上方显示横幅 `Swarm mode: 3 agents active`. 横幅本身是 click-to-dismiss 的, 但只 dismiss 一次会话, 下次重启又显示, 直到用户在设置里关掉.

精髓: **新功能需要"被发现"**. 用户不会主动 RTFM, 但每次启动看到 banner 会逐渐意识到. 给一个 dismiss 按钮防止打扰.

---

## 十八、PromptInputModeIndicator — 模式标签

`src/components/PromptInput/PromptInputModeIndicator.tsx`. 在 PromptInput 上方显示当前 mode:

| mode | 显示 | 颜色 |
|---|---|---|
| prompt | (不显示) | — |
| bash | `! BASH MODE` | bashBorder (橙) |
| memory | `# MEMORY MODE` | green |
| plan | `-- PLAN MODE --` | cyan |
| auto-accept | `-- AUTO-ACCEPT EDITS --` | yellow |
| vim-normal | `-- NORMAL --` | gray |

精髓: **mode 越显眼, 用户越不会"以为是 prompt 模式但其实在 bash 模式"**. 颜色对比强烈, 字号大写, 占据完整一行.

---

## 十九、SandboxPromptFooterHint — 沙箱辅助提示

`src/components/PromptInput/SandboxPromptFooterHint.tsx`. 沙箱模式下额外加一行 footer hint: "Sandbox active — file writes contained". 提醒用户当前 agent 操作不会影响主仓.

只在 `isSandboxActive()` 时渲染. 普通情况 return null.

---

## 二十、HistorySearchInput — Ctrl+R 的视觉

`src/components/PromptInput/HistorySearchInput.tsx`. 当 useHistorySearch 的 isSearching === true, 整个 PromptInput 上方插入这个组件:

```
(reverse-i-search)'{query}': {matchedLine}
```

颜色: query 灰色, matchedLine 高亮当前 query substring. 完全照搬 bash readline 的视觉.

---

## 二十一、PromptInputStashNotice — stash 提醒

用户按 ctrl+s 把当前 prompt 暂存. 暂存后 PromptInput 清空, 上方显示 `Stashed. Press ctrl+s again to restore`. 用户写完新 prompt 提交, stash 还在, 任何时候 ctrl+s 恢复.

只在 stashStore.hasStashedPrompt 时显示.

---

## 二十二、IssueFlagBanner — 11 行的精简

`src/components/PromptInput/IssueFlagBanner.tsx` 只有 11 行. 显示 `Found something wrong? Press ? then choose "Report issue"`. 仅在 `getGlobalConfig().issueFlagBannerSeen !== true` 时显示, 用户看过一次后永久不再显示.

精髓: **每个 banner 都有"看过一次永久不再显示"机制**. 不然老用户 footer 永远是 noise.

---

## 二十三、跨 hook 协作 — 按键优先级

一次按键, 可能有 9 个 useInput hook 都在监听. 按优先级:

1. **GlobalKeybindings** (`useGlobalKeybindings`) — ctrl+c (exit 确认) / ctrl+z (suspend). 永远第一.
2. **HistorySearch** (`useHistorySearch`) — 仅 isSearching 时 active, 截获大多数按键, esc/ctrl+g 退出.
3. **VimNormal** (`useVimInput`) — 仅 mode='normal' 时 active.
4. **Suggestion navigation** — 仅 suggestions.length > 0 时, ↑↓ 截获.
5. **ArrowKeyHistory** — 仅 cursor 在第一行/最后一行时, ↑↓ 截获.
6. **TextInput** — 兜底, 所有可见字符 + 编辑控制.

每个 hook 通过 `useInput(handler, { isActive: condition })` 控制 active. **Ink 内部按注册顺序广播**, 但每个 handler 自行判断"我是否消费". 没消费的不阻止下一个.

精髓: **没有显式优先级 list**, 全靠 isActive 互斥. 加新 hook 只要确保它的 isActive 跟其他 hook 不重叠, 就不需要改老代码. 是松耦合的极致.

---

## 二十四、给 Agent 开发者能偷的设计精髓

1. **cursorOffset 用字符数, 不用字节数** — 中文/emoji 安全, 不踩 UTF-8 边界.
2. **历史导航单独 hook + draft 保护** — 上下键不污染原始历史, 编辑历史也不污染原文.
3. **大文本 paste 存内存 + 占位符** — 避免 O(n²) insert 和屏幕爆.
4. **图片粘贴单独 channel + ID 引用** — 文本和二进制完全分离.
5. **suggestion 按 source 拆 async fetcher + deferred value 防抖** — 100ms 不变才发, 不打字时连发.
6. **suggestion startIndex = clamp(selected - half, 0, total - max)** — 选中项居中视窗.
7. **fullscreen 空 footer 用 `<Text> </Text>` 占位** — 防 ScrollBox scroll 跳.
8. **Box 在 Text 里会 throw → 用 Box sibling 模式** — Ink+Yoga 约束的标准 workaround.
9. **proactive/coordinator 等可选模块 `feature(...) ? require : null` + 全 fallback no-op** — DCE 友好, 没启用 bundle 不含代码.
10. **voice hint 用 useRef 防同 session 多次 + saveGlobalConfig prev-callback 防跨实例并发** — compare-and-set in single-threaded JS.
11. **macOS altClick 失败检测 → 换成 VS Code 设置提示** — 反挫败 UX.
12. **overlay 模式省略 minHeight + flex-end** — 父是 absolute bottom='100%' 时, 否则 overlay 覆盖输入框.
13. **suggestion 一行单字符串** — 避免多 children 在 wrap+truncate 下行为不一致.
14. **description truncate 前先 replace(/\s+/g, ' ')** — 含 \n 的 markdown desc 会把弹层撑变高.
15. **file path 中间截断** (truncatePathMiddle) — 保留头尾, 中间填 `...`.
16. **3 列 fixedWidth=24/35/undefined 布局** — 第 1/2 列定宽对齐, 第 3 列自适应.
17. **平台差异显式 gate** — Windows 隐藏 ctrl+z, macOS 显示 alt 提示.
18. **compile-time `"external" === 'ant'` 文案分支** — Anthropic 内部 vs 外部用户文案不同.
19. **shimmer 只在 isLoading + 新追加字符** — 历史字符稳定, 用户键入时关掉.
20. **queuedCommands 队列接住连按 enter** — 用户的 enter 永远不落空.
21. **notification 自动过期** — 不阻塞主交互, 自动消失.
22. **mode 高对比颜色 + 占整行** — 防止"以为是 prompt 但其实在 bash 模式".
23. **每个 banner "看过一次永久不再显示"** — 老用户 footer 不被 noise 污染.
24. **9 个 useInput 通过 isActive 互斥共存** — 松耦合, 加新 handler 不动旧代码.

---

## 二十五、收尾

M13 的核心问题: **输入区域被多种功能争夺**(普通 / bash / 命令 / 文件路径 / 历史搜索 / vim / paste / voice / queue), 且必须在终端的窄屏 + 单行 footer 约束下保持视觉稳定.

解法是把每种功能拆成独立 hook, 通过 isActive 互斥共存; 把每种 banner 拆成可选组件, return null 时 Box 自动不占空间; footer 用复杂的 primaryItemCount 判定动态裁剪.

最有"工程含量"的几个点:
- **fullscreen 空 footer 用 `<Text> </Text>` 防 scroll 跳** — Ink+Yoga 的细微陷阱.
- **Box-in-Text reconciler 限制 → Box sibling workaround** — 不打破 Text wrap+truncate 的同时引入复杂 pill.
- **suggestion description newline 必须先 flatten** — 看起来无害的 markdown 排版会撑变弹层.
- **voice hint 跨实例 saveGlobalConfig prev-callback** — 单线程 JS 也能实现 CAS.

跟其他模块联动:
- **M12 消息渲染** — PromptInput 提交后, message 经过 M12 渲染到 ScrollBox.
- **M11 Ink 渲染** — Box/Text/Yoga 的所有约束都在这里集中爆发.
- **M16 命令** — `/<cmd>` 触发 usePromptSuggestion 拉 command list.
- **M14 子代理** — `@` agents 补全, swarm banner 显示 active agent 数.
- **M19 state** — notificationsStore / stashStore / globalConfig 都是 M19 的 useSyncExternalStore.
- **M10 bridge** — remote 模式下, stdin 来源切到 bridge, mode pill 隐藏.

抄这章给 Agent 加 PromptInput, 至少省 3 个月. 输入子系统看似"就是 textarea + 历史", 实际是 UI 设计 + 状态机 + 反挫败 UX 的综合体.

---

## 二十六、补读修正(完整阅读 PromptInput.tsx 2338 行 + 13 个 sub-component 后)

§1-§25 是基于"9 个 hook + 大组件"的概念结构. 把 2338 行的 PromptInput.tsx 一行一行读完后,挖出 30+ 个具体的工程机关,包括 1 个直接 GitHub PR 引用 和 多处"防过去 bug 的 guard". 按类目分组.

### 26.1 State machine 与 race 处理(7 项)

**M13F1. external input 检测靠 ref 比较 + render-phase setState**(PromptInput.tsx:252-260)

`lastInternalInputRef` 在 render 内和 `input` prop 比较. 不一致 → render 内**立刻** `setCursorOffset(input.length)`. 不是放 effect 里——因为 STT/voice 注入的 input 必须当帧光标到尾,差一帧就视觉跳.

**抄作业**:**带外注入** 需要"上一帧 ref + 当帧 setState",不要丢 effect.

**M13F2. `onSubmit` 读 store 拿 fresh state,不是 closure**(PromptInput.tsx:989-995)

`footer:openSelected` 在同一 tick 内 call `selectFooterItem(null)` + `onSubmit`. closure 里的 `footerItemSelected` 已经 stale. 解法:`store.getState()` 重新求值"还可见吗",才避免吞掉 Enter.

**抄作业**:**同 tick 内多个 setState + callback,callback 内必须 `getState()` 而非用 closure**.

**M13F3. Enter 双触发 guard**(PromptInput.tsx:998-1002)

`viewSelectionMode === 'selecting-agent'` 时 Enter 被忽略——因为 `BaseTextInput.useInput` 早于 `useBackgroundTaskNavigation` 注册,Ink 子 effect 先 fire,不 guard 就 Enter 同时 submit + confirm.

**抄作业**:**多个 useInput 注册顺序敏感时,显式 guard 让冲突的那一个静默**.

**M13F4. `pendingSpaceAfterPillRef` 单次 lazy 空格**(PromptInput.tsx:370-373, 1180-1182, 1241-1246)

图像 paste 后 arm 一个 ref. 下一次按键时 `inputFilter` 同步消费: **只在非空白可打印字符时**前置空格,arrow/escape/backspace/paste/space 全部 disarm 不插入. 多图 paste 时把前一个 pill 的 space 放进自己的前缀.

**抄作业**:**"延迟决定的格式化"用 one-shot ref + 多键分类 disarm**,比立刻插入更精细.

**M13F5. mid-chip cursor snap 用 useEffect 不用 handler**(PromptInput.tsx:594-600)

光标停在 `[Image #N]` chip 内部时,effect snap 到最近边界. 不放 click handler 是因为 arrow 键和其他路径也要触发——**effect 是真正的"所有路径汇聚点"**.

**抄作业**:**多个事件源都可能触发的"修正",放 effect 而非各个 handler**.

**M13F6. `-1` sentinel 表示"tasks pill 选中,无 row"**(PromptInput.tsx:376-380, 391-403)

`coordinatorTaskIndex = -1` 是状态机的一个 distinct state. 防"第一次 ↓ 同时选 pill + row 0". 兜底:**只有 local_agent 时根本不渲染 pill,`-1` 状态无效**,所以 `minCoordinatorIndex = hasBgTaskPill ? -1 : 0` 跳过.

**抄作业**:**用 `-1` 等 sentinel 表示"无选中" 时,boundary 也要随条件而变,不能写死**.

**M13F7. stale footer selection: derive + cleanup 双写**(PromptInput.tsx:466-475)

`footerItemSelected` 既"derive"(pill 不在就返 null,UI 立即更新),又有独立 effect 清原 state. 没清的话同名 pill(新 task)出现时会"偷焦点".

**抄作业**:**derive-from-source 模式不够,还要清 source state**——否则同 id 复活会假醒.

### 26.2 阈值与常量(8 项)

| 常量 | 值 | 出处 | 为啥 |
|---|---|---|---|
| `PROMPT_FOOTER_LINES` | 5 | :191 | footer/border/status 占 5 行 |
| `MIN_INPUT_VIEWPORT_LINES` | 3 | :193 | 输入区最少 3 行 |
| auto-mode dialog debounce | 400 ms | :1481-1487 | 防 carousel 快切时闪 modal |
| ultrathink/plan/review notif | 5000 ms | :752-781 | 长行为提示 |
| effort-level notif | 12_000 ms | :1980 | 启动优先,显得"我看到了" |
| "no image clipboard" notif | 1000 ms | :1631 | 简短失败提示 |
| useInputBuffer maxBufferSize | 50 | :838-841 | undo 上限 |
| useInputBuffer debounceMs | 1000 | :838-841 | 1 秒内字符 collapse 1 个 snapshot |
| paste maxLines | `min(rows-10, 2)` | :1218-1239 | 防 Ink 整屏重画 |
| Tab → spaces | 4 | :881, 888, 1204 | 三处一致 |
| stash hint 触发 | peak>=20 且 cur<=5 | :783-830 | 第二 test 排除 esc-esc 跳变 |

**抄作业**:**所有 timeout / threshold 必须有"为啥这数"的 rationale**. PR review 时被问"为啥 400 不是 200"必须能答上来——这是经验值不是猜的.

### 26.3 Ink/Yoga quirks(4 项)

**M13F8. Notifications 不 unmount,降到 `height=0`**(PromptInput.tsx:2278-2295)

suggestions 或 auto-mode dialog 起来时,Notifications 不卸载. **PR#22413 教训**:卸载会让 AutoUpdater 的 initial-check effect 在每次 slash-completion toggle 时重 fire.

**抄作业**:**effect 重 fire 不可接受时,组件保活但 `height=0`**——比 unmount/mount 安全.

**M13F9. `position="absolute"` + 负 marginTop**(PromptInput.tsx:2276-2295)

absolute children 锚在 parent content-box 原点. `marginTop=-1` 把 Notifications 拉进 prompt border 上方的 gap 行. brief mode 没 gap 就 `-2`. `height=1 + overflow="hidden" + flex-end` 把多行裁到最后一行.

**抄作业**:**Ink/Yoga 里的"负 margin + absolute" 是高级用法但安全**,前提是 parent 不切 mode.

**M13F10. portal 逃 `overflowY:hidden` clip**(PromptInput.tsx:2118-2123)

AutoModeOptInDialog 用 `useSetPromptOverlayDialog` portal 到 `DialogOverlay`. **hook 必须在 early return 之前调用**——即使 arg 是 null,否则违反 rules-of-hooks.

**抄作业**:**portal/dialog 类 hook 永远在 early return 之前调,arg 可以传 null**.

**M13F11. 三个 picker memo 防"视觉跳"**(PromptInput.tsx:2019-2066, 2110-2116)

modelPickerElement / fastModePickerElement / thinkingToggleElement 都 memoize. 否则 AppState 因别的事 update(notifications 来等)→ inline picker 视觉跳.

**抄作业**:**inline 显示的"非主体" UI 都要 memoize**,否则父 re-render 导致它们晃.

### 26.4 跨 hook 协作(6 项)

**M13F12. 历史 nav 走 TextInput props 而非 useKeybindings**(PromptInput.tsx:1656-1659, 2177-2184)

`onHistoryUp/Down` 让 useTextInput 先试 cursor movement,**移不动才 fall through 到历史**. 这样多行 prompt 内部 ↑↓ 是移光标,光标已在首/末行才翻历史.

**抄作业**:**"键的多重含义" 用 try-then-fallthrough,不要静态绑定**.

**M13F13. `chat:submit` 直接注册 handler registry,绕开 useKeybindings**(PromptInput.tsx:1637-1653)

useKeybindings 在 Enter 上 call `stopImmediatePropagation`,会挡 autocomplete 看到 key. submit 必须绕开. **chord(如 ctrl+e s)才走 useKeybindings**.

**抄作业**:**键盘事件总线有 stop-propagation 模式时,核心 handler 可能要"旁路注册"**.

**M13F14. `disableCursorMovementForUpDownKeys`**(PromptInput.tsx:2193)

suggestions 显示 OR pill 选中时,TextInput 停止把 ↑↓ 当 cursor 移动. fall through 给外层 typeahead/keybindings.

**抄作业**:**输入键 fall-through 是双向通信** ——子组件需要支持"暂停我对某些键的处理".

**M13F15. 三方 `focus` 协调**(PromptInput.tsx:2199)

`focus: !isSearchingHistory && !isModalOverlayActive && !footerItemSelected` ——TextInput 的 useInput 在三种条件下静默. 这就是 9 个 input hook 不冲突的关键.

**抄作业**:**多 useInput 共存,top-level 用 `focus` 三态布尔表达式控制**.

**M13F16. 类型字符自动退出 footer**(PromptInput.tsx:1894-1902)

pill 选中时打可打印字符 → splice 到 cursor + onChange 隐式 deselect pill. nav 键已被 Footer keybinding 消费.

**抄作业**:**"用户开始打字" = 隐式退出辅助 mode**,无需 ESC.

**M13F17. `x` 在 tasks pill 上 bivalent**(PromptInput.tsx:1842-1860)

`footer:close` 接 `x`: 选中行 IS 当前查看的 agent → 输入 `x` 到 steering input;否则 → dismiss agent. 都不符合 → 返 false 让 keybinding 系统 fall through 到 type-to-exit.

**抄作业**:**同一键在不同状态行为完全不同,handler 返 boolean 决定是否 fall through**.

### 26.5 memo 与 ref 寿命(5 项)

**M13F18. `useRef(-1)` 哨兵防 useRef(fn()) 陷阱**(PromptInput.tsx:366-369)

代码注释明:"useRef(fn()) evaluates fn() on every render and discards the result after mount". `getInitialPasteId` 要 walk all messages + regex,放 `useRef(getInitialPasteId(messages))` = 每帧都跑. 用 `-1` 哨兵 + 第一次访问 init.

**抄作业**:**useRef 的初始值是 expression**, 不是 lazy. 重计算用 `-1` 哨兵 + lazy init pattern.

**M13F19. `memberMentionHighlights` 依赖 `displayedValue` 而非 `input`**(PromptInput.tsx:580)

`displayedValue = 历史 match || input`. highlight 跟着用户看到的,不是底层 input. 历史 search 时也 highlight.

**抄作业**:**显示相关的 memo 依赖"显示什么" 而非"原始数据"**.

**M13F20. `slackChannelTriggers` 用 `useSyncExternalStore` + version**(PromptInput.tsx:535-538)

`knownChannelsVersion` 是 dep,store 本身用 eslint-disable 注释为稳定. MCP-registered channels 通过 version bump invalidate,store 整体不 reactive.

**抄作业**:**外部 store 的局部变化通知用 version**, 不要把整 store 当 dep.

**M13F21. `thinkingToggleElement` 依赖 `messages.length` 而非 `messages`**(PromptInput.tsx:2116)

只有 length 影响 `isMidConversation`. 避免每条 message mutation 都重 memo.

**抄作业**:**memo dep 用最小有效信号**——不是 array,是 `.length`;不是 object,是 `.field`.

**M13F22. `autoModeOptInDialog` memo 保 portal 稳定**(PromptInput.tsx:2122)

`useSetPromptOverlayDialog` 是 effect,identity 不稳就 churn. memo 保稳.

**抄作业**:**给 effect 的 prop 必须 memoize**,identity 稳定 = effect 不重 fire.

### 26.6 cleanup 与 effect 寿命(4 项)

**M13F23. auto-mode timeout 3 处清**(PromptInput.tsx:1481-1487, 1506-1508, 1592-1594)

400ms debounce 在"用户 cycle 过 auto / accept / decline" 三处都 clear + ref null'd. 防 stale fire.

**抄作业**:**any timeout ref 必须列出"所有需要清的路径"**, 一处漏就 stale fire.

**M13F24. `abortPromptSuggestion()` + `abortSpeculation()` 每键都调**(PromptInput.tsx:866-867)

`onChange` 内 abort 两个 in-flight 预测系统. **"用户打字 = 抛弃 speculation"** 的标准路径.

**抄作业**:**任何 speculation 系统都要"user-action canceling"**, 不能让旧 speculation 污染新输入.

**M13F25. 孤儿图像 cleanup effect**(PromptInput.tsx:1185-1200)

effect parse input 找 `[Image #N]` 引用,prune `pastedContents` 里 unreferenced entry. 覆盖 pill-backspace / Ctrl+U / 单字符 delete 等所有删除路径.

**抄作业**:**关联数据的清理用 effect 扫"还在不在"**,而非每个删除路径手动清.

**M13F26. external editor `finally` cleanup**(PromptInput.tsx:1351-1353)

`setIsExternalEditorActive(false)` 在 `finally`. editor crash 也保 UI placeholder 清掉.

**抄作业**:**任何 modal/overlay 状态的 setFalse 必须 in finally**.

### 26.7 防过去 bug 的 guard(5 项)

**M13F27. `viewingAgentColor` 验证 palette**(PromptInput.tsx:334-335)

注释:"identity.color is typed as `string | undefined` ... Validate before casting ... falls back to cyan if invalid". 说明确实有用户在 config 里放过 junk.

**抄作业**:**file-based config 的字符串字段必须 white-list 验证,不能信类型**.

**M13F28. no-revert-on-shift+tab guard**(PromptInput.tsx:1495-1499)

注释:"Do NOT revert ... shift+tab means 'advance the carousel', not 'decline'. Reverting causes a ping-pong loop". 这是个确实踩过的 bug.

**抄作业**:**carousel/cycle 模式下,"取消" 不能 revert 到上一态**——会循环.

**M13F29. `setAppState` 后 `setToolPermissionContext` 模式**(PromptInput.tsx:1533-1547)

注释:"intentionally preserves the existing mode (to prevent coordinator mode corruption from workers)". 防 worker 写坏 coordinator 状态.

**抄作业**:**多状态 source 之间的 update 顺序敏感时,注释要说明"为啥这个顺序"**.

**M13F30. `?` 触发 help 但不插入字符**(PromptInput.tsx:854-859)

`value === '?'` 时 toggle help mode 且不 insert. **`?` 永远不会出现在输入里**, 下一键照常打.

**抄作业**:**"问号触发帮助"是经典 CLI 模式,不要 insert 字符**, 否则用户得手动删.

**M13F31. STT/@-mention/quick-open 三处自动加空格**(PromptInput.tsx:272-273, 1292-1295, 2133-2135)

cursor 前一字符不是 whitespace 就前置空格. `?? ' '` 默认 pos 0 时不加.

**抄作业**:**"自动注入文本"必须看上下文加空格**,否则吃字符.

### 26.8 性能优化与早 return(5 项)

**M13F32. compile-time feature() / `"external" === 'ant'` 当常量**(PromptInput.tsx:322-324, 1701-1719, 等)

`feature()` 和 `"external" === 'ant'` 是 bundler-strippable 常量. useAppState 在 feature-gate 里 conditional call,加 `// biome-ignore lint/correctness/useHookAtTopLevel` —— 因为 dead branch 在 build 时被消.

**抄作业**:**rules-of-hooks 和 dead-code-elimination 冲突时,hook call 留 unconditional,handler body 用 feature-gate**.

**M13F33. `isCursorOnFirstLine/LastLine` 用 cheap `indexOf`**(PromptInput.tsx:417-430)

不 split 成 lines. `input.indexOf('\n')` 比 `cursorOffset`. O(n) 一次扫描而非 O(n) split + array compare.

**抄作业**:**判断"光标在某行边界"只用 indexOf**,别 split.

**M13F34. `tasksFooterVisible` 保 pill 在 task 结束后仍显**(PromptInput.tsx:455-458)

完成的 agent 也在 panel 里. pill 必须可 nav 当 panel 有 rows 时. 不只是 running.

**抄作业**:**UI 元素显示条件 = "数据存在" 而非"操作进行中"**.

**M13F35. `storeImage(newContent)` fire-and-forget**(PromptInput.tsx:1166-1170)

`cacheImagePath` 同步, render 立即可用. `void storeImage(newContent)` 后台写盘.

**抄作业**:**渲染依赖必须同步,持久化用 void promise**.

**M13F36. image chip IS the cursor**(PromptInput.tsx:586-589, 604-616)

cursor 在 chip start 时,chip 渲染成 `inverse: true`——**chip 本身就是 cursor**. chip.end 仍是正常 cursor pos. `showCursor: !cursorAtImageChip` 关掉真 cursor.

**抄作业**:**特殊 token(chip/pill)被 cursor 选中时,自身渲染成 cursor 状态,不并存两个**.

### 26.9 invariants(5 条)

| ID | invariant | 违反后果 |
|---|---|---|
| **INP-1** | lastInternalInputRef render 内 setState,不放 effect | 带外注入光标错位 1 帧 |
| **INP-2** | 多 callback 同 tick 都用 store.getState(),不用 closure | 后 callback 看 stale state |
| **INP-3** | useRef 初始值绝不能是高开销 expression | 每帧都跑 expression |
| **INP-4** | timeout ref 必须列"所有清理路径"且 ref null'd | stale fire |
| **INP-5** | portal/dialog hook 在 early return 之前调用,arg 可 null | 违反 rules-of-hooks |

### 26.10 12 条精华(M13 增补版)

> **1. external 注入需要"上一帧 ref + 当帧 setState",不要丢 effect 否则视觉跳。**
> **2. 同 tick 内多个 setState + callback,callback 内必须 `getState()` 而非用 closure。**
> **3. useRef(fn()) 是陷阱——每帧都跑 fn(),用 `-1` 哨兵 + lazy init 替代。**
> **4. timeout ref 必须列出所有清理路径,ref null'd,防 stale fire。**
> **5. portal/dialog hook 永远在 early return 之前调,arg 可以传 null 满足 rules-of-hooks。**
> **6. inline picker / 显示组件必须 memoize,否则父无关 re-render 导致视觉晃。**
> **7. 键的多重含义用 try-then-fallthrough,handler 返 boolean 决定是否 propagation。**
> **8. memo dep 用最小有效信号(`.length` 不是 array,`.field` 不是 object)。**
> **9. 任何 speculation 系统都要"user-action canceling",每键 abort 旧 speculation。**
> **10. file-based config 的字段必须 white-list 验证,不能信类型。**
> **11. rules-of-hooks 和 DCE 冲突时,hook call 留 unconditional,handler body 用 feature-gate。**
> **12. 特殊 token(chip/pill)被 cursor 选中时,自身渲染成 cursor 状态,不并存两个。**
