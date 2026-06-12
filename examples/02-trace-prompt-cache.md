# Example 2 — Trace: "prompt cache" across all 32 modules

> You want to know every module that participates in prompt-cache behaviour, ranked by relevance. `trace_concern` scans every MODULE_NOTES body (not just keywords) and ranks modules by hit count.

## Tool call

```json
{
  "tool": "trace_concern",
  "arguments": {
    "concern": "prompt cache"
  }
}
```

**Latency:** 122 ms · **Response size:** 32,138 chars (showing first 5,000 chars)

## Response

```
# Cross-Module Trace: "prompt cache"

Found in 31 module(s):

## M06: 上下文工程


> 模块定位:在 LLM 有限上下文窗口下,**主动**(autoCompact)/**被动**(reactiveCompact 应对 PROMPT_TOO_LONG)/**轻量**(microCompact)/**外置**(sessionMemory + memdir)四条路径协同管理 messages 数组,使长会话可持续运行。同时管理 git/CWD/CLAUDE.md 等系统上下文的注入与失效。
>
> 本模块是「Agent 工程」最具复用价值的部分之一 —— 任何要长跑的 Agent 都必须解决"上下文不够用"的问题。Claude Code 给出了一整套生产级方案,本文档系统拆解。
...
1. **写入侧(messages 累积)**:每轮 tool_use → tool_result 都在膨胀 messages;Read/Bash 等工具的输出可能动辄数千 token。
2. **读取侧(API 调用)**:Anthropic / Bedrock / Foundry / Vertex 都有硬上限(typically 200K token),逼近上限将报 `prompt_too_long`。
3. **降本侧(prompt cache)**:每次调用都重新计算 cache 是浪费的;但任何 messages 修改都可能让 cache 失效。
4. **跨会话侧(persistent memory)**:用户偏好、项目事实、外部系统引用应跨 session 保留。
...

...
| **sessionMemoryCompact**(实验) | autoCompact 之前 | messages + 已抽取的 sessionMemory | summary + messagesToKeep | ❌(memory 在后台预先抽取) | `sessionMemoryCompact.ts` |
| **autoCompact / 手动 /compact**(主压缩) | tokens 接近窗口阈值 | 整段 messages | 9-section summary + messagesToKeep + attachments | ✅(独立请求) | `compact.ts`, `prompt.ts` |
| **reactiveCompact** | 主线程 API 抛 PROMPT_TOO_LONG | messages | 同上,但带 PTL retry 切片 | ✅ | `compact.ts:truncateHeadForPTLRetry` + `M05` 重试链 |

...
`memdir/*` 则是**外置持久存储**,文件系统作为 LLM 的"长期记忆":通过强结构化的 prompt 让模型自己写文件、自己读文件,主进程几乎不参与读写决策。
...

---

## M13: 输入系统

# M13 · 输入子系统 (PromptInput / 编辑器 / 历史 / Vim / Paste / Suggestions / Footer)

> 范围: `src/components/PromptInput/**` + `src/hooks/useTextInput.ts` + `useInputBuffer.ts` + `useArrowKeyHistory.tsx` + `useHistorySearch.ts` + `useVimInput.ts` + `usePasteHandler.ts` + `usePromptSuggestion.ts` + `useSearchInput.ts` + `useShowFastIconHint.ts`
...
> 关联: M11(Ink 渲染) / M12(消息) / M16(命令) / M14(子代理) / M19(状态) / M10(remote bridge)

...

PromptInput 是 CLI 的"输入舱":一个被多种角色复用的 TextInput,顶部挂着 mode/voice/queued/notifications 等 banner,底部挂着 footer(快捷键 hint / suggestions / 进度计数). 它需要同时满足:

1. **多种"输入语义"** — 普通 prompt / `!` bash 模式 / `/` 命令 / `@` 文件路径 / vim normal/insert / history 搜索 / `&` 后台任务前缀 / 配合 paste 大文本 / 配合粘贴图片.
...
2. **多种"展示形态"** — fullscreen vs 普通终端 / overlay 弹层 vs inline / remote 模式 / coordinator 模式.
3. **多种"键源来源"** — 物理键盘 / Ink stdin / 桥接 stdin(remote) / VSCode IDE 选区 / `claude-bridge` IPC.
...

M13 把这些张力拆成 9 个 hook + 1 个大 PromptInput + 13 个 sub-component, 通过组合解决.

---
...

---

## M05: 模型 API 与流式处理

- 在网络/API 异常时按 4-5 路径升级:retry → fallback model → non-streaming → fail with /rewind hint
- 维护 prompt cache 的"破裂检测"(2-phase),写埋点诊断
- 维护 4 种 provider(Anthropic 直连 / Bedrock / Foundry / Vertex)的客户端
- 把每次请求的 `token usage` / `costUSD` / `requestId` / `gateway` / `betas` 写入 1P/OTel 埋点
...

边界:**不**做 prompt 拼装(交给 `services/compact/` + `context.ts`)、**不**做 tool 调度(交给 `services/tools/`)、**不**做权限决策(交给 `hooks/useCanUseTool`)。

---
...
|---|---|---|
| `services/api/claude.ts` | 3419 行 / 126K | **核心**: queryModel(streaming)、queryModelWithoutStreaming、addCacheBreakpoints、updateUsage、buildSystemPromptBlocks |
| `services/api/withRetry.ts` | 822 行 / 28K | retry 生成器(yield SystemAPIErrorMessage)、5 路 fallback 触发条件、persistent retry 模式 |
| `services/api/errors.ts` | 1199 行 / 41K | getAssistantMessageFromError(20+ 分支)、classifyAPIError(15 桶)、3P fallback suggestion |
...
| `services/api/errorUtils.ts` | 261 行 / 8.4K | extractConnectionErrorDetails(SSL 错误 cause chain)、formatAPIError、sanitizeAPIError(剥离 HTML) |
| `services/api/promptCacheBreakDetection.ts` | 728 行 / 26K | 2-phase 缓存破裂检测(record + check)、per-tool hash diff、LRU per source |
| `services/api/client.ts` | 390 行 / 16K | getAnthropicClient(4 provider 分支)、buildFetch 注入 x-client-request-id |
| `services/api/bootstrap.ts` | 142 行 / 4.6K | /api/claude_cli/bootstrap 拉取 client_data + additional_model_options(zod 校验,disk 缓存) |
...
| `fastModeHeaderLatched` | speed='fast' 曾经发起过 | `/clear` `/compact` |
| `cacheEditingHeaderLatched` | 曾经发过 cache_edits | `/clear` `/compact` |
| `thinkingClearLatched` | 曾用过 redact_thinking | `/clear` `/compact` |

...

---

## M16: 命令系统

| `local-jsx` | 启动一个 Ink JSX 对话框,等用户交互后关闭 | `/model`, `/config`, `/permissions`, `/branch`, `/agents`, `/add-dir`, `/init`, `/statusline` |
| `prompt` | 把命令转成一段 system+user prompt 投给模型,让模型按指令工作 | `/commit`, `/review`, `/security-review`, `/advisor` |

这三类**完全不同的执行路径**,但在注册表里共享同一个 `Command` 类型 union — 调用方拿到 `Command` 对象,再 `switch (cmd.type)` 分发. 这是典型的"算法不同但接口一致"的多态设计.
...
  description: string | (() => string) // 描述,可以是 getter (动态)
  type: 'local' | 'local-jsx' | 'prompt'
  source?: 'builtin' | 'plugin' | 'mcp' | 'bundled' | SettingSource
  loadedFrom?: SettingSource         // 仅 plugin/mcp 时
...
  immediate?: boolean                // 立即执行,不入 prompt 循环 (/exit, /model)
  isHidden?: boolean | (() => boolean) // 不在 menu 显示
  isEnabled?: boolean | (() => boolean) // 总开关,fresh-per-call
...
  Component?: React.FC<...>                       // local-jsx
  getPromptForCommand?: (args, ctx) => Promise<...> // prompt
}
```
...
```ts
const _loadAllCommandsCache = new Map<string, Command[]>()
export async function loadAllCommands(cwd: string): Promise<Command[]> {
  c

…(output truncated for display; full response is returned to the LLM)
```
