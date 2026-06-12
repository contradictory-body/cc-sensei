# M21 · 萌宠伴侣、语音输入与外部桩

> 范围:`src/buddy/`(6 文件,~1298 行)+ `src/services/voice.ts` + `src/services/voiceStreamSTT.ts` + `src/services/voiceKeyterms.ts`(3 文件,~1175 行)+ `src/hooks/useVoice.ts` + `src/hooks/useVoiceIntegration.tsx` + `src/hooks/useVoiceEnabled.ts`(3 文件,~1845 行)+ `src/commands/voice/`(2 文件,~170 行)+ `src/moreright/useMoreRight.tsx`(1 文件,25 行)= 约 4513 行。
>
> 主题:**让"非主路径"功能(萌宠陪伴、语音输入、外部商业版桩)既不污染主程序又能在边角场景下健壮工作**。
>
> 联动:M11(ink)/ M13(input)/ M17(config)/ M18(telemetry)/ M19(state)/ M20(keybindings)。

---

## 一、问题空间

这一章覆盖三个"看似独立、实则共享设计骨架"的子系统:

1. **Buddy(萌宠陪伴)**:在 prompt 上方画一只 ASCII 宠物,有种族 / 稀有度 / 名字 / 性格,跟随 idle 动画。要求:
   - 同一用户多次启动看到同一只(确定性)
   - 启动开销趋零(不能因为加只宠物拖慢启动)
   - 用户改不了稀有度(不能在 config 里手填 `rarity: 'legendary'`)
   - 模型不能误识别为代号(避免 bundle excluded-strings.txt 冲突)
   - fullscreen mode 不能被 ScrollBox 裁掉

2. **Voice(语音输入)**:hold-to-talk 把语音转文字插入输入框。要求:
   - macOS / Linux / Windows / WSL2 都能用(不同录音工具)
   - 不预加载 native 模块(避免触发 macOS TCC 麦克风弹窗)
   - WebSocket 到 Anthropic STT 后端(不是 claude.ai 因为 TLS 指纹封锁)
   - 各种 race(用户连按 / 网络慢 / WS 半连接 / silent-drop / OS 自动重复延迟)都不能丢数据
   - 多语言识别 + 自定义术语
   - focus 模式:窗口 focus 时自动录音,blur 时停

3. **MoreRight(外部商业版扩展点)**:一个 25 行的 stub,真实实现在内部仓库。要求:
   - 类型签名稳定(主代码 import 不动)
   - return 默认值是无害的(no-op)
   - 不引相对路径依赖(让外部 fork 能直接用)

文件分布:

```
src/buddy/
  prompt.ts                36 行,companion 介绍文本 + 防重复 attachment
  types.ts                 148 行,18 SPECIES (charCode) + 5 RARITIES (weight) + Bones/Soul 分离
  companion.ts             133 行,mulberry32 PRNG + SALT + rollFrom + getCompanion (每次 hash 重生 bones)
  sprites.ts               514 行,18 × 3 frames × 5 lines × 12 cols ASCII + 8 HAT_LINES
  CompanionSprite.tsx      370 行,TICK_MS=500 + IDLE_SEQUENCE + 窄屏 collapse + FloatingBubble
  useBuddyNotification.tsx 97 行,April 1-7 teaser window + RainbowText + "external"==='ant' gate

src/moreright/
  useMoreRight.tsx         25 行,外部 build 占位 stub

src/services/
  voice.ts                 525 行,音频采集 (native cpal / arecord / SoX) + WSL2 检测 + TCC 触发
  voiceStreamSTT.ts        544 行,WS 协议 + 5 finalize sources + Nova 3 gate + Bun #40510 workaround
  voiceKeyterms.ts         106 行,GLOBAL_KEYTERMS + splitIdentifier + MAX_KEYTERMS=50

src/hooks/
  useVoiceEnabled.ts       25 行,settings × auth × GB kill-switch
  useVoice.ts              1144 行,主语音 hook,session generation + replay buffer + retry
  useVoiceIntegration.tsx  676 行,键位整合 + matchesKeyboardEvent + 双轨 hold (bare / modifier)

src/commands/voice/
  index.ts                 20 行
  voice.ts                 150 行,/voice 切换 + 预检查 + 语言提示

src/context/voice.ts       voiceState store 写入接口
src/ink/hooks/use-terminal-focus.ts  Focus 监听
```

---

## 二、Buddy:Bones 与 Soul 双层模型

`src/buddy/types.ts` 的核心设计:

```ts
export type CompanionBones = {
  species: Species
  rarity: Rarity
  stats: Stats        // 5 维:joy/sass/calm/spark/care
  uniqueId: string    // hash(userId)
}

export type CompanionSoul = {
  name: string        // 模型生成
  personality: string // 模型生成
  hat?: HatStyle      // 模型生成
}

export type StoredCompanion = {
  soul: CompanionSoul  // 只持久化 soul
}
```

**bones 不持久化**。`getCompanion(userId)` 每次都从 hash(userId) 重新算 bones,只把 soul 存进 settings。

**为啥这么设计?**

- 用户不能在 settings 里编辑 `rarity: 'legendary'` 来"作弊"——下次启动 bones 重生覆盖。
- 同一用户多次启动看到同一只(deterministic from userId)。
- soul(名字 / 性格)可以由模型生成并持久化,因为 soul 是"风味"不影响 stat balance。

这是**"游戏存档防作弊"的工程化版本**:把"算出来的"和"用户填的"严格隔离。任何"应该是系统算的"字段都别持久化。

---

## 三、SPECIES 列表用 `String.fromCharCode` 拼

`src/buddy/types.ts` 里 18 个种族名字像这样写:

```ts
const SPECIES_RAW = {
  // s p a r r o w
  SPARROW: [115, 112, 97, 114, 114, 111, 119],
  // ...
}
export const SPECIES = Object.fromEntries(
  Object.entries(SPECIES_RAW).map(([k, codes]) => [k, String.fromCharCode(...codes)]),
)
```

**为啥不直接写字符串?**

Claude Code 发布时会扫描 bundle 里的 `excluded-strings.txt` 找模型 codename 泄漏(避免暴露内部代号给用户)。某些萌宠种族名(`sparrow`, `oasis`, ...)曾经撞到过 codename 列表,扫描器报红。

**解决方案不是改萌宠种族名**(那等于让代号污染产品命名),而是**让种族名在源码里以 charCode 形式存在**,bundle 文本扫描看不到字面字符串,运行时拼回。

**通用启发**:**当你需要在字符串里"绕开静态扫描"时,charCode + 运行时拼装是干净的逃生口**。同理可以用 base64 / hex,但 charCode 数组对人类相对友好(还能注释 "// s p a r r o w")。

---

## 四、rollFrom + mulberry32 + SALT:确定性 PRNG

`src/buddy/companion.ts`:

```ts
const SALT = 'friend-2026-401'

function hashString(s: string): number {
  if (typeof Bun !== 'undefined' && Bun.hash) {
    return Number(Bun.hash(s) & 0xFFFFFFFFn)
  }
  // FNV-1a fallback
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function rollFrom(userId: string): CompanionBones {
  const rng = mulberry32(hashString(userId + SALT))
  // ...
}
```

要点:
- **SALT**:防止 userId 单独被反推。如果只用 hash(userId),知道用户名的攻击者能预测稀有度。加了 SALT 必须知道 SALT 才能预测。
- **Bun.hash 优先,FNV-1a 兜底**:Bun 平台 Bun.hash 是 native 实现(SipHash 等),纯 JS 时回退 FNV-1a。
- **mulberry32**:32-bit PRNG,周期 2^32,对萌宠这种"低 stake 装饰"足够了。

`rollCache` 是另一个细节:`getCompanion()` 在 3 个热路径调用(sprite tick / 每键 / 每轮 turn),如果每次都跑 mulberry32 + 5 维 stat roll 浪费 CPU。所以:

```ts
let rollCache: { userId: string; bones: CompanionBones; t: number } | null = null
export function getCompanion(userId: string): CompanionBones {
  const now = Date.now()
  if (rollCache && rollCache.userId === userId && now - rollCache.t < 500) {
    return rollCache.bones
  }
  const bones = rollFrom(userId)
  rollCache = { userId, bones, t: now }
  return bones
}
```

500ms TTL。**对"确定性但 CPU 略贵的纯函数",加个短 TTL 缓存就够了**——既不持久化(避免作弊),又减少高频重算。

---

## 五、Rarity rollFrom 算法:peak + dump + scatter

`rollFrom` 不是简单"每维 1-10 随机":

```ts
const stats = { joy: 1, sass: 1, calm: 1, spark: 1, care: 1 }
// 1. 加 rarity floor
const floor = RARITIES[rarity].floor  // common=2, legendary=8
Object.keys(stats).forEach(k => stats[k] += floor)
// 2. peak:随机选一维加 (1 + rng()*3)
const peakDim = pickDim(rng)
stats[peakDim] += 1 + Math.floor(rng() * 3)
// 3. dump:不同的一维 -1
const dumpDim = pickOtherDim(rng, peakDim)
stats[dumpDim] = Math.max(1, stats[dumpDim] - 1)
// 4. scatter:剩下三维 ±1 噪声
```

**为啥这样而不是纯随机?**

纯随机每维都 5 左右,平均值,**没有性格**。peak + dump 保证每只宠物有一个明显的"特长"和一个"短板",感觉像独立角色而不是一团统计噪声。

**通用启发**:**程序化生成"角色"或"装饰"时,显式加 peak/dump 比纯均匀分布有趣得多**。游戏 RPG 经常用这招。

---

## 六、Sprite 渲染:TICK + IDLE_SEQUENCE + 窄屏 collapse

`src/buddy/CompanionSprite.tsx`:

```ts
const TICK_MS = 500
const BUBBLE_SHOW_TICKS = 20    // 10s
const FADE_WINDOW_TICKS = 6
const PET_BURST_MS = 2500
const MIN_COLS_FOR_FULL_SPRITE = 100

const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]
//                     ^^^^^^^^    ^         ^         ^
//                     rest     blink      fidget    chest puff
```

每 500ms 跳一步,从 IDLE_SEQUENCE 取一个相对帧偏移。大多数 tick 都是 0(rest 帧),偶尔 1/2 切动画帧,-1 留空(让动画"呼吸")。

**为啥不是均匀循环帧?**

如果每 tick 都换帧,屏幕上一直闪烁,用户视线被吸引,体验糟。"大部分时间静止 + 偶尔小动作"才像活的——这是动画行业的"12 principles"之一(squash & stretch 的反向:rest pose 主导)。

### 窄屏 collapse

```tsx
if (terminalCols < MIN_COLS_FOR_FULL_SPRITE) {
  return <Text>{singleLineFace}</Text>  // 只画脸
}
return <Box>{fullSpriteLines}</Box>
```

终端窄于 100 列(常见 SSH / iTerm split)就退化到一行脸,不抢屏幕。

### Fullscreen FloatingBubble

```tsx
// CompanionSprite 在 footer 上方挂正常 Box
<Box>...</Box>

// CompanionFloatingBubble 用 ink 的 bottomFloat slot
<BottomFloat>
  <Box>...</Box>
</BottomFloat>
```

**为啥要 floating?**

Fullscreen mode 主 ScrollBox 有 `overflowY: 'hidden'`,任何超出 viewport 的内容被裁。如果 sprite 挂在 ScrollBox 内部,会被 clipping。floating slot 是 ink 的"逃出 ScrollBox"通道,绝对定位到屏幕底部,不被裁。

---

## 七、Pet 模式:sync setState during render

CompanionSprite 有个"被点击/触发会激动"的模式 `petStart`。激动时 sprite 切到 frame 0 显示 burst 动画。

直觉做法:

```tsx
useEffect(() => {
  if (petStart) setFrame(0)
}, [petStart])
```

**问题**:`useEffect` 在 render 之后跑,第一帧 render 显示的还是上一次的 frame(可能是 idle 帧 1)。视觉上"延迟一帧才切到 0",看起来像 lag。

**修复**:**render 内对比 ref 直接 setState**——

```tsx
if (lastPetStartRef.current !== petStart) {
  setFrame(0)
  lastPetStartRef.current = petStart
}
```

React 允许 render 内 setState(只要保证有 escape condition),会立即触发再 render,但第一帧 render 完成时 frame 已经是 0,**当帧到位**。

**通用启发**:**对"带外信号要求当帧响应"的 UI,render 内 ref-compare + setState 不是 antipattern**——`useEffect` 的"晚一帧"特性是 visual jitter 的隐蔽源头。M13 的修正 1(VSCode 选区注入)是同一招的另一应用。

---

## 八、isBuddyTeaserWindow:April 1-7 + 24h rolling wave

`src/buddy/useBuddyNotification.tsx`:

```ts
export function isBuddyTeaserWindow(): boolean {
  const now = new Date()
  const year = now.getFullYear()
  const start = new Date(year, 3, 1)  // April 1 local
  const end = new Date(year, 3, 7, 23, 59, 59)
  if (now < start || now > end) return false
  // 24h rolling wave: each user gets a different 24h window
  // within April 1-7 based on hash(userId)
  const userHash = hashString(getUserId())
  const offset = (userHash % (7 * 24)) * 60 * 60 * 1000
  const userStart = +start + offset
  const userEnd = userStart + 24 * 60 * 60 * 1000
  const t = +now
  return t >= userStart && t <= userEnd
}
```

**为啥不全员 7 天?**

如果 4/1 0:00 全员看到 banner → 所有客户端同一时刻去 generate soul(模型调用) → soul-gen backend 撞墙。

**rolling wave**:每个用户的 24h 窗口基于 hash(userId) 错开。负载在 7 天 × 24 小时 = 168 个 1 小时桶里平摊。

**通用启发**:**全员一时 trigger 的活动必须做 user-level rolling**。哈希 userId → 时间偏移是最便宜的负载均衡。

---

## 九、`"external" === 'ant'` 编译时门

`src/buddy/useBuddyNotification.tsx`:

```ts
if (("external" as string) === 'ant') {
  // 内部员工专用:不显示 banner
  return null
}
```

`'external'` 在编译时被替换成 `'external'` 或 `'ant'`(取决于 build target)。Tree-shaker 看到字符串字面量对比,**整个分支被静态消除**。

外部用户的 bundle 里这段代码完全不存在;内部员工的 bundle 里 `return null` 直接生效。

**通用启发**:**编译时 string-literal 比较 + 静态消除是干净的 multi-target build 套路**。比 `if (process.env.NODE_ENV)` 更明确(后者 webpack/esbuild 也支持但要配 define plugin)。

---

## 十、MoreRight stub:外部商业版的"占位插槽"

`src/moreright/useMoreRight.tsx`(25 行):

```tsx
// External build stub for useMoreRight hook.
// The real hook is internal-only; this file ships in external builds
// to satisfy the import without providing functionality.
//
// Must be self-contained (no relative imports) so the file can be
// physically replaced in the internal build without dragging in
// external-only deps.

export function useMoreRight() {
  return {
    enabled: false,
    actions: [],
  }
}
```

**为啥要 stub 而不是 import-from-internal?**

- 主代码 `import { useMoreRight } from '@/moreright/useMoreRight'`——一个 import,不动。
- 外部 build:这个 stub 文件被 bundle。
- 内部 build:**文件被物理替换**成内部仓库的真实实现。

**自包含 no-relative-imports** 让"物理替换"零摩擦——内部版本不需要去关心 stub 里有没有引用 external-only 的辅助。

**通用启发**:**多版本同构 codebase 的"功能差异"用 stub + 物理替换比 feature flag 更干净**。feature flag 适合运行时切换;stub 适合 build-time 双轨。

---

## 十一、useVoiceEnabled:三层门 + 各自独立 reactive

`src/hooks/useVoiceEnabled.ts`:

```ts
export function useVoiceEnabled(): boolean {
  const settingsEnabled = useSettingsValue(s => s.voiceEnabled ?? false)
  const authVersion = useAuthVersion()
  // ── auth 检查放进 useMemo,deps = authVersion
  // (cold spawn ~60-180ms,只有 /login 后 authVersion bump 才重算)
  const hasAuth = useMemo(() => checkAuthSync(), [authVersion])
  // ── kill-switch 放外面,每次 render 重读
  // (运行时 /gb-flag 切换要立即生效)
  const gbAllowed = !isFeatureKilled('voice_disabled')
  return settingsEnabled && hasAuth && gbAllowed
}
```

三个独立信号:
- `settingsEnabled`:用户在 settings 里勾的
- `hasAuth`:有没有 OAuth token(/login 后才有)
- `gbAllowed`:GrowthBook 没把这功能强关掉

**为啥 hasAuth 进 useMemo,gbAllowed 不进?**

- `checkAuthSync()` 内部要 spawn 子进程读 keychain,60-180ms,**冷数据不想每次 render 都查**。authVersion ref 在 /login 后 bump 一次,memo 才重算。
- `isFeatureKilled` 是内存查 + 同步 boolean,廉价。放外面意味着任何 render 都重读,**远程 kill-switch 改了立即生效**。

**通用启发**:**reactive 信号的更新粒度要单独设计**——贵的进 memo + 显式版本控制;廉价的裸读以获得最大反应性。

---

## 十二、/voice 命令的预检查链

`src/commands/voice/voice.ts`:

```ts
async function enableVoice(): Promise<void> {
  // 1. recording availability
  const avail = await checkRecordingAvailability()
  if (!avail.available) {
    return showError(avail.reason)
  }
  // 2. mic permission (触发 macOS TCC 弹窗,如果没授权)
  const permitted = await requestMicrophonePermission()
  if (!permitted) return showError('Microphone access denied')
  // 3. voice stream backend available
  if (!isVoiceStreamAvailable()) {
    return showError('Voice streaming not available')
  }
  // 4. deps (audio-capture-napi / arecord / SoX)
  const deps = await checkDeps()
  if (deps.missing.length > 0) {
    return showInstall(deps.missing)
  }
  // 通过所有检查
  setSettings({ voiceEnabled: true })
  showLangHintIfNeeded()  // 最多 2 次,LANG_HINT_MAX_SHOWS = 2
}
```

每一步失败给**专属错误消息 + 修复指引**(brew install / apt install / 去系统设置)。

**LANG_HINT_MAX_SHOWS = 2**:第一次启用提示"当前识别语言是 X,改 settings.language",第二次再提示一次,第三次开始不再提示——避免老用户每天被提示一次。

**通用启发**:**功能"启用"按钮的背后是预检查链**,不是单 boolean 翻转。每步专属错误 + 修复指引才不让用户对着"启用失败"干瞪眼。

---

## 十三、voiceKeyterms:本地术语注入 STT

`src/services/voiceKeyterms.ts`:

```ts
const GLOBAL_KEYTERMS = [
  'MCP', 'symlink', 'grep', 'regex', 'TCP', 'IPC', 'LSP',
  'TypeScript', 'JavaScript', 'Node', 'Bun',
  'Anthropic', 'Claude',
  // ...
]

function splitIdentifier(s: string): string[] {
  // camelCase / kebab-case / snake_case / PascalCase / dot.case / path/case
  return s
    .split(/[-_./\\]+/)
    .flatMap(part => part.match(/[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z])|[A-Z]+/g) ?? [])
}

export async function getVoiceKeyterms(): Promise<string[]> {
  const terms = new Set<string>(GLOBAL_KEYTERMS)
  // 加项目根 basename(整体保留,不 split)
  const cwdBase = path.basename(getCwd())
  if (cwdBase) terms.add(cwdBase)
  // 加最近文件路径里的 identifier(split)
  for (const f of await getRecentFiles()) {
    for (const part of splitIdentifier(f)) terms.add(part)
  }
  // 加 branch 名 split
  const branch = await getCurrentBranch()
  if (branch) splitIdentifier(branch).forEach(t => terms.add(t))
  // 截 50
  return Array.from(terms).slice(0, MAX_KEYTERMS)
}
```

为啥这样?

- STT(语音转文字)对**生僻技术词**(如 `kubernetes`, `useMemo`, `protobuf`)经常听错。
- Deepgram 支持 `keyterms` 参数,把"用户业务上下文里出现过的词"告诉模型,识别准确率显著提高。
- **项目名整体保留不 split**:`delta-admin-node` 不要拆成 `delta` + `admin` + `node`,直接当一个短语注入。
- MAX_KEYTERMS=50:Deepgram 有上限,超了会忽略后面的。

**通用启发**:**任何"识别 / 转译"系统都该有"用户上下文 hint"通道**。STT、翻译、autocomplete、OCR 都受益于"喂入用户常用词"。

---

## 十四、services/voice.ts:多平台音频采集 + lazy dlopen

最难的部分。Linux/Mac/Windows/WSL2 音频栈差异巨大。

### Lazy dlopen

```ts
let _native: NativeModule | null = null
function getNative() {
  if (!_native) _native = require('audio-capture-napi')  // 同步 dlopen
  return _native
}
```

**为啥不在文件顶层 `import`?**

native module dlopen 是 sync syscall,macOS 上加载 CoreAudio framework **冷启动 ~1-8 秒阻塞**(coreaudiod 启动)。如果在文件顶 import,Claude Code 启动慢 1-8 秒,99% 不用语音的用户被惩罚。

**lazy + first-keypress 才 dlopen**——按键的人愿意等(他主动要语音),不按的人零成本。

### `hasCommand` via direct spawn

```ts
async function hasCommand(cmd: string): Promise<boolean> {
  try {
    const child = spawn(cmd, ['--version'], { stdio: 'ignore' })
    return new Promise(resolve => {
      child.on('exit', code => resolve(code !== null))
      child.on('error', () => resolve(false))
    })
  } catch { return false }
}
```

**为啥不 `which cmd` 或 `command -v`?**

- Termux / Android 上没有 `which`(busybox 不带)
- Windows shell 没有 `command -v`
- 直接 spawn `cmd --version`,exit code 是 OS 唯一可靠信号

### `probeArecord` 150ms race

```ts
async function probeArecord(): Promise<boolean> {
  if (!await hasCommand('arecord')) return false
  // 不能仅看二进制存在 — WSL1 / headless 没声卡的机器上
  // arecord 二进制装着但 open() 失败
  return Promise.race([
    new Promise<boolean>(resolve => {
      const child = spawn('arecord', ['-d', '0.1', '/dev/null'])
      child.on('exit', code => resolve(code === 0))
    }),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
  ])
}
```

**为啥 race?**

某些 WSL1 / headless 环境 arecord open() 永远 hang(等 ALSA),不能让 Claude Code 启动卡死。150ms 内没结果就当不可用。

### Fallback chain

```ts
async function pickRecorder(): Promise<Recorder> {
  // 1. native (cpal) — macOS / Windows / Linux 都首选
  if (canUseNative()) return new NativeRecorder()
  // 2. arecord — Linux 兜底(WSL2 + WSLg 也能用)
  if (await probeArecord()) return new ArecordRecorder()
  // 3. SoX 'rec' — Linux/macOS 第三选择
  if (await hasCommand('rec')) return new SoxRecorder()
  // Windows: 没 fallback,native 必须可用
  throw new NoRecorderError()
}
```

WSL2+WSLg 走 arecord(通过 PulseAudio RDP pipes),cpal 在 WSL2 下 fail 因为没 /proc/asound/cards。

**通用启发**:**任何调用 OS 设备的代码都要有 fallback chain + 真实 probe**。"二进制存在" ≠ "能用"。

### `requestMicrophonePermission` 触发 TCC

```ts
async function requestMicrophonePermission(): Promise<boolean> {
  try {
    // 实际尝试录 0.1 秒 — macOS 上这一步触发 TCC 弹窗
    // 用户授权才会成功
    const recorder = await pickRecorder()
    await recorder.recordFor(100)
    return true
  } catch { return false }
}
```

**为啥要"真实尝试"而不是查 API?**

macOS TCC 没有"查询"API(privacy reasons),**只能尝试触发**。第一次尝试会弹"Claude Code wants to access microphone",用户点 OK 后才有权限。后续 try-catch 才能 succeed。

**通用启发**:**没有查询 API 的权限模型,只能"尝试 + 期望好"**。

---

## 十五、voiceStreamSTT:WebSocket 协议 + 5 finalize sources

`src/services/voiceStreamSTT.ts`。

### URL 与认证

```ts
const VOICE_STREAM_PATH = '/api/ws/speech_to_text/voice_stream'
const VOICE_STREAM_HOST = 'api.anthropic.com'  // NOT claude.ai

const ws = new WebSocket(`wss://${VOICE_STREAM_HOST}${VOICE_STREAM_PATH}`, {
  headers: {
    Authorization: `Bearer ${oauthToken}`,
  },
})
```

**为啥 api.anthropic.com 而不是 claude.ai?**

`claude.ai` 用 Cloudflare bot detection + TLS fingerprinting,**Node/Bun 的 WebSocket 客户端的 TLS handshake 看起来不像浏览器**,被识别为 bot 拒绝(GitHub issue #34094 用户报告过)。

`api.anthropic.com` 是 API 端点,不做 browser-fingerprint 检查,接受 Bearer token。

### 协议消息

```
client → server (JSON):
  { "type": "Configure", "language": "en", "keyterms": [...] }
  { "type": "KeepAlive" }
  { "type": "CloseStream" }

client → server (binary):
  Audio frames (16kHz/16-bit PCM)

server → client (JSON):
  { "type": "Transcript", "text": "...", "is_final": true|false }
  { "type": "TranscriptError", "fatal": true|false }
  { "type": "Closing" }
```

### 5 finalize sources

```ts
type FinalizeSource =
  | 'post_closestream_endpoint'  // 服务端 CloseStream 后正常发 final
  | 'no_data_timeout'             // CloseStream 后 1.5s 没回任何 transcript
  | 'safety_timeout'              // 总等待 5s 超时(防 hang)
  | 'ws_close'                    // 等待中 WS 主动关闭
  | 'ws_already_closed'           // CloseStream 时 WS 已关
```

每个 source 在 telemetry 里分开埋点,定位"语音突然没文字"的根因。**no_data_timeout = silent-drop 信号**——CE pod 收了 audio 但没产 transcript,触发 replay buffer 重试。

### Nova 3 gate

```ts
const useNova3 = feature('tengu_cobalt_frost')
// Nova 3 模型用 cumulative interim with revisions
// 中间转写不是增量而是"全量重写"
// 如果按 isFinal=false 的 prefix-check 自动 finalize 会丢
if (useNova3) {
  // 不在 segment change 时自动 finalize
}
```

### `setTimeout(0)` 延迟 CloseStream

```ts
async finalize(): Promise<FinalizeSource> {
  // 队列里可能还有未发的 audio frame
  // 直接 CloseStream → 后续 send() 触发 "audio after close" 协议错
  // setTimeout(0) 让 microtask 队列里的 send() 都先 flush
  await new Promise(r => setTimeout(r, 0))
  ws.send(JSON.stringify({ type: 'CloseStream' }))
  // ...等 5 个 source 之一
}
```

### Buffer.from() copy before send

```ts
send(chunk: Buffer) {
  // NAPI 的 audio-capture-napi 返回的 Buffer 共享 pool
  // 不 copy 直接 ws.send,WS 还没真发就被下一个 audio callback 覆盖
  ws.send(Buffer.from(chunk))
}
```

### Bun Windows #40510 workaround

```ts
ws.on('unexpected-response', (req, res) => {
  // Bun Windows 上 ws 库对成功的 101 Switching Protocols 也会触发这个 event
  // 实际上 101 是 WS 升级成功的标志,不是错误
  if (res.statusCode === 101) return  // ignore
  surfaceError(`unexpected-response ${res.statusCode}`)
})
```

**通用启发**:**每个 WS 实现都有 "应该是 spec 但不是" 的 quirk**,跨平台 WS 代码必须有针对每个 runtime 的 known-issue workaround 表。

### Suppress onError during finalize

```ts
async finalize() {
  this.finalizing = true
  // ...
}

onError(err) {
  if (this.finalizing) {
    // finalize 中 WS 关闭会触发 onError
    // 触发 onError → cleanup → 清空 accumulatedTranscript
    // 但 transcript 还没传出去,用户文本丢了
    return  // suppress
  }
  surfaceError(err)
}
```

**通用启发**:**关闭 phase 的 error 通常不是"真错"而是"关闭 noise"**,要 suppress 或 routinize。

---

## 十六、useVoice:session generation + replay buffer

`src/hooks/useVoice.ts`(1144 行)是 M21 最复杂的文件。

### session generation 防 zombie

```ts
const sessionGenRef = useRef(0)

function startRecordingSession() {
  const myGen = ++sessionGenRef.current  // bump
  const isStale = () => sessionGenRef.current !== myGen
  // 所有 callback (onTranscript / onError / onReady / finalize.then) 内
  // 第一句:if (isStale()) return
}

function cleanup() {
  sessionGenRef.current++  // 让所有进行中的 callback stale
  // ...
}
```

**为啥要 generation?**

场景:用户按 V,语音 1 启动,WS 还在握手。用户突然停按,启动 finalize,但 finalize 等 5 秒。其间用户又按 V 启动语音 2。

**没有 generation 的话**:语音 1 的 onReady 终于触发,把 connectionRef 设成语音 1 的 WS;但此时 connectionRef 应该是语音 2 的。语音 2 的 audio 发到语音 1 的 WS,语音 1 的 audio 已被 finalize 取消但 callback 还在 fire。**所有 ref 都被两个 session 互相覆盖**。

**有 generation**:语音 1 的所有 callback 第一句 `isStale()`,sessionGenRef 已被语音 2 bump 到 2,语音 1 的 myGen 仍是 1,所有 callback 立即 early-return。

**通用启发**:**任何"长 async + 可能被新调用打断"的场景,用单调递增 generation + close-over myGen + isStale() 是 React + async race 的最干净解法**。比 AbortController 更稳(AbortController 在不能真 abort 的网络/磁盘场景失灵,详见 M13 修正 1 / M15 修正 2)。

### attemptGenRef 嵌套 generation

```ts
const attemptGenRef = useRef(0)

function attemptConnect(keyterms) {
  const myAttemptGen = attemptGenRef.current
  connectVoiceStream({
    onError: (err) => {
      if (isStale()) return  // session-level
      if (attemptGenRef.current !== myAttemptGen) return  // attempt-level
      // 真错
    },
  })
}

// 早期错误重试:
if (!sawTranscript && !retryUsed) {
  retryUsedRef.current = true
  connectionRef.current = null
  attemptGenRef.current++  // 让 conn 1 的尾随 close-error 被 attempt-level swallow
  setTimeout(() => attemptConnect(keyterms), 250)
}
```

**两层 generation**——session 层管"用户的语音意图变了",attempt 层管"同一 session 内的连接重试"。

### Silent-drop replay buffer

```ts
const fullAudioRef = useRef<Buffer[]>([])
const silentDropRetriedRef = useRef(false)

// audio callback 里
if (!focusTriggeredRef.current) {  // focus mode 不存(20MB 浪费)
  fullAudioRef.current.push(Buffer.from(chunk))
}

// finalize 完成时
if (finalizeSource === 'no_data_timeout' &&
    hadAudioSignal && wsConnected && !focusTriggered &&
    focusFlushedChars === 0 && accumulated.trim() === '' &&
    !silentDropRetriedRef.current && fullAudioRef.current.length > 0) {
  // ~1% session-sticky CE-pod bug:WS 接收 audio 但不出 transcript
  silentDropRetriedRef.current = true
  // 等 250ms,新 WS,把整段 audio 重发
  await sleep(250)
  await connectVoiceStream(...).then(conn => {
    conn.send(Buffer.concat(replayBuffer))
    await conn.finalize()
  })
}
```

**为啥要 replay?**

CE backend 有 ~1% 的 pod 会"看起来正常但实际坏了"(session-sticky bug,internal #287008),audio 收下但 Deepgram 那边 silently drop。用户说话录音都成功但最后没文字,体验灾难。

**Replay**:整段 audio 留 buffer,如果 finalize 命中 `no_data_timeout` + `hadAudioSignal=true` + `wsConnected=true`(说明 backend 接收了 audio 但没产生 transcript),换 pod 重发一次。

**限制**:
- 只重试 1 次(`silentDropRetriedRef`)
- focus mode 不存(每个 final 立即 flush,replay 没意义且占内存)
- buffer 上限 ~2MB(32KB/s × 60s)

**通用启发**:**对"难以 client-side 修复的 backend bug"做兜底 retry 是 frontend 的责任**。客户端的健壮性来自"假设 backend 偶尔会犯傻"。

### everConnectedRef 跨清理生存

```ts
const everConnectedRef = useRef(false)

// onReady 设 true
onReady: (conn) => {
  connectionRef.current = conn
  everConnectedRef.current = true
}

// connectionRef cleanup() 时被 null,但 everConnectedRef 不动
// finishRecording 用 everConnectedRef 做 wsConnected dimension
const wsConnected = everConnectedRef.current
```

**为啥不直接看 connectionRef ≠ null?**

cleanup() 会清 connectionRef。如果 Effect 3 cleanup 跑在 Effect 2 finishRecording 之前(比如 /voice toggled off 时),connectionRef 已 null,wsConnected 错判为 false。

**通用启发**:**为 telemetry / 状态判断保留的 ref 不能跟"资源 ref"混**。资源 ref 该被 cleanup;状态 ref 必须独立持有。

### updateState BEFORE await

```ts
async function startRecordingSession() {
  updateState('recording')  // 立刻同步,不能 await 后才设
  // useVoiceIntegration.tsx 的 space-hold guard 读 voiceState 是同步的
  // 如果 updateState 在 await 后,空格键 auto-repeat 漏到 textarea
  // (PR #20873 review 修过的)
  recordingStartRef.current = Date.now()
  // ...
  const avail = await voiceModule.checkRecordingAvailability()
  // ...
}
```

**通用启发**:**state 转换需要被下游同步读时,setState 必须在 await 前**——不能依赖 React 的 batched 行为。

### Repeat-fallback timer 双计时器

```ts
// 第一次 keypress:
if (currentState === 'idle') {
  startRecordingSession()
  // OS auto-repeat 还没启动(macOS 默认 500ms delay)
  // 不能直接 arm RELEASE_TIMEOUT_MS(200ms),会假阴
  // arm fallback timer:如果 fallbackMs 内没再来 keypress
  // 当作"用户 tap 后即松",arm release timer
  repeatFallbackTimerRef.current = setTimeout(() => {
    seenRepeatRef.current = true  // 假装见了 repeat
    releaseTimerRef.current = setTimeout(finishRecording, 200)
  }, fallbackMs)
}

// 第二次 keypress(auto-repeat 到了):
else if (currentState === 'recording') {
  seenRepeatRef.current = true
  clearTimeout(repeatFallbackTimerRef.current)  // 取消 fallback
  // 后续以"see repeat 后 200ms 没新事件 = release"判断
  clearTimeout(releaseTimerRef.current)
  releaseTimerRef.current = setTimeout(finishRecording, 200)
}
```

**为啥这么麻烦?**

OS 自动重复有个**初始延迟**(macOS slider "Long" ~2 秒, "Short" ~250ms)。Hold-to-talk 的 release 检测靠"超过 200ms 没新事件 = 松开"。

- 如果初始延迟 500ms,你按 1 秒后 release,事件流是:`t=0 keypress, t=500 keypress, t=550, ..., t=1000 keypress`。后续每次 reset 200ms timer,timer 永远不 fire 因为有自动重复。**这是正常情况**。
- 但如果你只 tap 一下(t=0 keypress, t=200 release),没有第二次 keypress 触发 timer reset。**fallback timer 在 600ms 后还没看到第二次 keypress,认为是"tap 释放",arm release timer**。
- 如果是 modifier 组合(`ctrl+space`),初始延迟可能 ~2s,用 `FIRST_PRESS_FALLBACK_MS = 2000`(由 useVoiceIntegration 显式传)。

**通用启发**:**OS 键盘自动重复的"初始延迟"是 hold-to-X 的隐蔽 race 源**。必须 distinguish "等首个 repeat" vs "用户真的松了"。

### Focus 模式三态

```ts
const isFocused = useTerminalFocus()
const focusTriggeredRef = useRef(false)
const silenceTimedOutRef = useRef(false)

useEffect(() => {
  if (!enabled || !focusMode) return
  if (isFocused && stateRef.current === 'idle' && !silenceTimedOutRef.current) {
    // 焦点获得 → 启动录音
    focusTriggeredRef.current = true
    startRecordingSession()
    armFocusSilenceTimer()  // 5s 没语音自动停
  } else if (!isFocused) {
    silenceTimedOutRef.current = false  // blur 时清,下次 focus 再 arm
    if (stateRef.current === 'recording') finishRecording()
  }
}, [enabled, focusMode, isFocused])
```

三个 ref 各管:
- `focusTriggeredRef`:这个 session 是不是 focus 启动的(影响 finalize 行为 + 是否走 replay)
- `silenceTimedOutRef`:focus 期间 silence timer fired 过,**blur 才清**(否则 silence → re-fire → silence loop)
- `isFocused`:terminal 的 focus(reactive,触发 effect)

**为啥不在 silence timer fire 时直接清 `silenceTimedOutRef`?**

Silence 触发 finishRecording → state 进 idle。Effect deps 没变(isFocused 还 true)。如果 `silenceTimedOutRef = false`,effect 立即重新启动录音 → 又 silence → 又 finish → 死循环。

`silenceTimedOutRef = true` 阻止自动重启,**等 blur 才清**。下次 focus 拿到新机会。

**通用启发**:**reactive 自动行为必须有 "anti-loop" 标志**。任何"条件满足就启动 + 启动后会回到条件满足"的逻辑都有死循环风险。

---

## 十七、useVoiceIntegration:键位整合

`src/hooks/useVoiceIntegration.tsx`(676 行)是 useVoice 与 useKeybindings 的桥。

### 4 阈值常量 + 注释

```ts
const RAPID_KEY_GAP_MS = 120  // 比 OS 最快 repeat (~30ms) 大,但比手动连按 (~150ms) 小
const MODIFIER_FIRST_PRESS_FALLBACK_MS = 2000  // macOS "Long" slider 最大
const HOLD_THRESHOLD = 5  // 5 次 rapid event 才算 hold(防误触)
const WARMUP_THRESHOLD = 2  // 2 次内 flow-through 让普通字符 textarea 也能收到
```

**这些不是从天上掉的数字**——每个都有注释解释来源和边界。

**通用启发**:**"魔术阈值"必须有注释**,标 来源(实验 / 标准 / OS 文档)。否则一年后没人敢动。

### matchesKeyboardEvent

```ts
function matchesKeyboardEvent(parsed: ParsedKeystroke, input: string, key: KeyState): boolean {
  // 'space' / 'return' 名字 mapping
  let expected = parsed.key
  if (expected === 'space') expected = ' '
  if (expected === 'return') expected = 'enter'
  // alt|meta 折叠(terminal 不区分)
  const altOrMeta = key.alt || key.meta
  if (parsed.alt !== altOrMeta && parsed.meta !== altOrMeta) return false
  // ...
}
```

**为啥 alt|meta 折叠?**

Terminal 在 macOS 下 alt key 也叫 "Meta key"(historic vt100)。ParsedKeystroke 里 `alt: true` 和 `meta: true` 应该都能 match。这是 terminal-only 的 quirk,GUI keyboard 不混。

### DEFAULT_VOICE_KEYSTROKE 只对 no-provider

```ts
const customKeystroke = getVoiceKeystrokeFromSettings()  // string | null | undefined
const keystroke = customKeystroke === undefined
  ? DEFAULT_VOICE_KEYSTROKE  // 用户从没碰过 settings
  : customKeystroke           // 用户显式设置(可能是 null = 解绑)
```

`undefined` vs `null` 的语义区别:
- `undefined`:没设置项 → 用 default
- `null`:用户显式解绑 → 别用 default

**通用启发**:**"用户没说" vs "用户说了'什么也不'" 在 settings 里要区分**。`undefined` / `null` / `""` 不能混。

### 双轨 hold 检测

```ts
function handleVoiceKey(input, key) {
  const isBareChar = !key.ctrl && !key.alt && !key.meta && !key.shift
  if (isBareChar) {
    // 普通字符(比如绑的 v 键):
    // 不能第一次按下就吞,否则 v 永远写不进 textarea
    // 让前 2 次 flow-through 到下游 useInput,从 5 次开始算 hold
    if (rapidCount < WARMUP_THRESHOLD) return false  // 不消费
    if (rapidCount < HOLD_THRESHOLD) return false   // 不消费,等 hold 阈值
    // 第 5 次确认 hold,启动语音
    activateVoice()
    return true  // 消费,不传下游
  } else {
    // modifier 组合(比如 ctrl+space):
    // 第一次就启动(modifier 组合用户不会"误按 5 次")
    activateVoice()
    return true
  }
}
```

**为啥 bare-char 要等 5 次?**

绑 `v` 当语音键:用户打 "vacation",第一个 v 不能吞。OS auto-repeat 之前的 5 次 event 是用户连打或自动重复都可能,过了 5 次基本只可能是 hold。

**通用启发**:**"快捷键 vs 字符输入"的双重含义需要"flow-through warmup"**。让前几次事件通过,验证是 hold 再消费。

### Reset hold on leaving 'recording'

```ts
useEffect(() => {
  if (prevVoiceState === 'recording' && voiceState !== 'recording') {
    // 不是 'processing',因为:
    // - leaving recording → processing 时还在 finalize,需要 hold state 维持
    // - leaving processing → idle 时是 finalize 完成,这时才该清
    holdStateRef.current = { rapidCount: 0, lastKeyTime: 0 }
  }
}, [voiceState])
```

**为啥不是 processing?**

processing 状态可能持续几秒(等 finalize)。如果在 leaving recording 时清,下次 hold 的判断就会从 0 开始;但如果用户在 processing 期间又按 V,应该被 ignore(state 不该变),清不清都行。**但 leaving processing 才清才能保证下一个 idle 完整重启**——其实两者效果几乎一样,代码注释说选 leaving recording 是因为更稳。

### `require()` namespace 捕获

```ts
const voiceNs = require('../hooks/useVoice')

function activateVoice() {
  // 用 voiceNs.useVoice / voiceNs.handleKeyEvent
  // 而不是 const { useVoice } = require('../hooks/useVoice')
}
```

**为啥保留 namespace?**

测试时 `vi.spyOn(voiceNs, 'handleKeyEvent')` 能替换。如果解构成局部变量,spyOn 监听的是 module exports,但 useVoiceIntegration 已经 cache 了原函数引用,spy 无效。

**通用启发**:**`require()` 用 namespace,不解构**——为 spy/mock 留窗口。

### Submit race protection

```ts
const lastSetInputRef = useRef('')
const inputValueRef = useRef('')

function onTranscript(text) {
  const newValue = stripTrailing(inputValueRef.current) + text
  lastSetInputRef.current = newValue  // 记录"我刚 set 的"
  setInput(newValue)
}

// submit handler:
function handleSubmit() {
  // 用户 ENTER 提交;但语音 onTranscript 可能正在 fire
  // 如果 voiceTranscript 在 ENTER 后才到达,会触发额外 setInput
  // 用户已 submit 完进入 idle,新文本 stuck 在 textbox
  // 防御:对比 inputValueRef.current(刚 submit 后被 cleared)和 lastSetInputRef.current
  if (inputValueRef.current === lastSetInputRef.current) {
    // 没有 voice 干扰,正常 submit
  } else {
    // voice 还在补文字,要 wait
  }
}
```

(实际代码更复杂,但思想类似 — 用两个 ref 对比检测 "submit 后 voice 还在 fire" 的 race。)

---

## 十八、ChatVoice ↔ useVoice 数据流图

```
KeyboardEvent
  ↓
useKeybindings (M20) → 决定哪个 handler 收
  ↓
useVoiceIntegration.handleVoiceKey
  ↓ (matchesKeyboardEvent + 双轨 hold)
useVoice.handleKeyEvent
  ↓ (idle → recording, arm timers)
voice.startRecording  (lazy dlopen audio-capture-napi)
  ↓ (chunk callback)
audioBuffer.push (WS 没 ready 时) / conn.send (WS ready)

平行进行:
connectVoiceStream  (voiceStreamSTT)
  ↓ WS handshake
  ↓ onReady → connectionRef = conn → flush audioBuffer
  ↓ onTranscript → accumulatedRef += text → setVoiceState(interim)

用户松开:
release timer fires → finishRecording
  ↓ state → processing
  ↓ conn.finalize() → 5 sources 之一
  ↓ if no_data_timeout + ... → silent-drop replay (new WS, 重发 fullAudioRef)
  ↓ text = accumulated → onTranscript(text) → setInput(prefix + text + suffix)
  ↓ state → idle
```

每一环都有 isStale guard,任何一环用户重按都立即 abort。

---

## 十九、telemetry 埋点(M21 部分)

```
tengu_voice_recording_started: { focusTriggered, sttLanguage, sttLanguageIsDefault, sttLanguageFellBack, systemLocaleLanguage }
tengu_voice_recording_completed: { transcriptChars, recordingDurationMs, hadAudioSignal, retried, silentDropRetried, wsConnected, focusTriggered }
tengu_voice_stream_early_retry: { }
tengu_voice_silent_drop_replay: { recordingDurationMs, chunkCount }
tengu_voice_stream_*: 各 finalize source 分别埋
tengu_buddy_companion_revealed: { species, rarity }
tengu_buddy_teaser_shown: { }
```

`sttLanguage` 用 `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` cast——M15 修正 1 同样的 PII 治理风格:**敏感字段必须显式 cast,cast 名故意拗口**,review 时一眼能抓出。`sttLanguage` 是 ISO 639(en/es/...),理论上不是 PII,但要进 cast 才允许写入分析事件——这是"先验证再允许"的强制门。

---

## 二十、给我们做 Agent 时能偷的招

如果你也要做一个 Agent 的萌宠/语音/外部桩系统,这些经验值得直接抄:

**通用工程**:
1. **多版本 bundle 用 stub + 物理替换**(`useMoreRight.tsx`)比 feature flag 更干净。stub 必须 self-contained no-relative-imports。
2. **编译时 string-literal 比较**(`"external" === 'ant'`)做 build-target 分支,tree-shaker 静态消除。
3. **"魔术阈值"必须有注释**,标 来源 + 边界。否则一年后没人敢动。
4. **PII / 敏感字段强制 cast**(`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`),cast 名拗口防 PR 蒙混。
5. **lazy native module dlopen**——首次使用时才加载,不在文件顶 import。
6. **fallback chain + 真实 probe**(150ms race)——"二进制存在" ≠ "能用"。

**Buddy 设计**:
7. **Bones(算的)vs Soul(存的)分离**——防止用户编辑 settings "作弊"。
8. **种族名用 charCode 拼**——绕开 bundle 静态扫描的代号撞名。
9. **确定性 PRNG + SALT + 短 TTL cache**——同用户每次一致,加 SALT 防反推,500ms TTL 减重算。
10. **rollFrom 用 peak+dump 而非均匀分布**——程序生成的角色有性格。
11. **IDLE_SEQUENCE 大部分静止 + 偶尔小动作**——像活的不像 strobe。
12. **窄屏 collapse**——< 100 列退化到一行脸,不抢屏幕。
13. **Fullscreen 用 floating slot**——`BottomFloat` 逃出 ScrollBox clipping。
14. **render 内 ref-compare + setState**(pet trigger)——`useEffect` 晚一帧的视觉 jitter。
15. **24h rolling wave** 基于 hash(userId)——全员同时启动的活动避免 backend 撞墙。

**Voice 设计**:
16. **lazy import 避免 macOS TCC 弹窗**——native module dlopen 才触发 mic 权限请求。
17. **WSL2 / Termux / headless 各自的 fallback** + probeArecord 150ms race——OS 检测要"真试"。
18. **WS 到 api.anthropic.com 而非 claude.ai**——TLS 指纹封锁规避。
19. **session generation + attempt generation 双层**——任何 async race 都用 myGen + isStale。
20. **5 finalize sources 分别埋点**——"silent drop" 类问题需要按"为啥结束"分类。
21. **silent-drop replay buffer**(no_data_timeout + audio signal + ws connected)——~1% backend bug 客户端兜底。
22. **Nova 3 用 cumulative interim with revisions** → 关掉 prefix-based auto-finalize。
23. **setTimeout(0) 延迟 CloseStream** 让 queued audio flush。
24. **Buffer.from() copy before send**——NAPI pooled ArrayBuffer 共享危险。
25. **suppress onError during finalize**——关闭 phase 的 error 通常是 noise,会清空已积累 transcript。
26. **Bun Windows ws#40510 ignore status=101**——每个 WS runtime 有 spec-deviation,写已知列表。
27. **everConnectedRef 跨 cleanup 生存**——telemetry 状态 ref 不能与资源 ref 混。
28. **updateState BEFORE await**——下游同步读 state 时 setState 不能延后。
29. **Repeat-fallback timer + FIRST_PRESS_FALLBACK_MS**——OS 自动重复初始延迟会让 release 检测假阴。
30. **focus mode silenceTimedOutRef = true 阻止重启,blur 才清**——anti-loop 标志。
31. **bare-char hold 用 warmup flow-through + activate-on-N**——既能当 char 又能 hold-to-X。
32. **DEFAULT only for `undefined`,`null` = 用户显式解绑**——settings 三态语义。
33. **`require()` 保 namespace 不解构**——为 vi.spyOn() 留窗口。
34. **submit race protection 用 lastSetInputRef vs inputValueRef 对比**——非常隐蔽的 voice + enter race。
35. **focus mode 不存 replay buffer**——20MB 浪费,且每个 final 已立即 flush。

**通用启发(跨子系统)**:
36. **"应该是 spec 但不是" workaround 表**——跨平台 / 跨 runtime 代码必备。
37. **任何长 async + 可能被新调用打断**用单调 generation + isStale,比 AbortController 在不可中断场景更稳。
38. **reactive 自动行为必须有 anti-loop 标志**——"条件满足就启动 + 启动后回到条件满足"是死循环温床。

---

## 二十一、收尾

M21 三个子系统看似不相关(萌宠 / 语音 / 外部桩),但**共享一个工程主题**:**主路径之外的功能怎么"既不污染主程序又自身健壮"**。

- **Buddy**:Bones 不持久化解决"作弊";charCode 解决"代号污染";rolling wave 解决"全员同时";floating slot 解决"被 ScrollBox 裁"。
- **Voice**:lazy dlopen 解决"启动开销";fallback chain 解决"OS 差异";generation 解决"async race";replay buffer 解决"~1% backend bug";5 finalize sources 解决"silent drop 归因"。
- **MoreRight**:stub + 物理替换解决"双轨 bundle"。

最有"工程含量"的几个点:
- **Bones vs Soul** 是"游戏存档防作弊"的工程化版本,值得记住。
- **session/attempt 嵌套 generation** 是 React + async race 的最优解之一。
- **silent-drop replay buffer** 是"客户端兜底 backend bug"的典范。
- **bare-char hold 双轨**(warmup flow-through + activate-on-N)是"快捷键 vs 字符"双义键的标准答案。
- **`"external" === 'ant'`** 是"编译时分支"最干净的写法。

跟 M11(Ink floating slot)/ M13(input race / settings 三态)/ M17(settings)/ M18(telemetry PII cast)/ M19(state)/ M20(keybindings 整合)联动。抄这章给 Agent 加萌宠、语音或商业版扩展点,至少省 4 个月。**M21 的关键不是"做语音"而是"做长链 async + race-prone + multi-platform 的功能时怎么保持代码不烂"**。这套套路你学会了,后面再做任何"录音 / 录屏 / 上传 / OAuth flow / 第三方 SDK 集成"都用得上。
