# Agent Architecture Oracle — GitHub 发布与推广方案

> 决策日期：2025-06-11
> 当前状态：代码完成 / 65 测试全过 / 双语 README 完成
> 核心结论：**不建议立即 push**，先补齐"上传前必做"四项，1-2 天内具备发布条件

---

## 一、决策：现在该不该 push？

### 🔴 暂缓 push 的理由

GitHub 的"第一印象窗口"只有一次。Star 曲线是**幂律**——首屏没抓住人，后面再补就难了。当前差距：

| 项目 | 状态 | 阻塞发布？ |
|---|---|---|
| 代码完成度 | ✅ 6 工具 / 65 测试全过 | — |
| 双语 README | ✅ 已完成 | — |
| `.gitignore` | ✅ 已存在 | — |
| **LICENSE** | ❌ **缺失** | **🚫 是** |
| **CONTRIBUTING.md** | ❌ 缺失 | ⚠️ 强烈建议 |
| **examples/ 目录** | ❌ 缺失 | ⚠️ 强烈建议 |
| **截图 / GIF** | ❌ 缺失（README 第一屏没视觉冲击）| ⚠️ 强烈建议 |
| GitHub Topics / About | ❌ 未规划 | ⚠️ push 时一定要填 |
| npm 包名称 | ❌ 未确认是否被占用 | ⚠️ 影响"3 步使用"叙事 |
| HN/Reddit 标题 | ❌ 未起草 | ⚠️ 推广前必做 |

### 🟢 推荐节奏

```
今天 / 明天          后天                   一周内             两周内
─────────────       ───────────            ─────────         ─────────
T0-1: 准备发布      T2: 公开 push           T3-7: 主推广      T8-14: 持续
└─ LICENSE          └─ Topics + About      └─ HN Show HN    └─ 博客
└─ CONTRIBUTING     └─ v1.0.0 tag          └─ Reddit         └─ 视频
└─ examples/        └─ release notes       └─ Twitter        └─ Smithery
└─ 截图 / GIF       └─ MCP awesome PR      └─ 中文社区       └─ npm publish
```

---

## 二、Phase 0：上传前必做（T0–T1，0.5–1 天）

### 0.1 添加 LICENSE（10 分钟）

在仓库根目录创建 `LICENSE`，使用 MIT。GitHub 网页创建时能一键生成；本地直接 `gh repo create --license mit` 也行。

**为什么必须**：没 LICENSE 的项目，许多公司开发者直接跳过——法律不允许使用。

### 0.2 添加 CONTRIBUTING.md（30 分钟）

最小可用模板：
```markdown
# Contributing

Issues and PRs welcome!

## Dev setup
pnpm install && pnpm build && pnpm test

## Adding a new MODULE_NOTES analysis
1. Drop a new .md under claude-code-main/MODULE_NOTES/
2. Follow the 10-section template (see existing M01-M22)
3. Run pnpm build:index, then pnpm exec tsx scripts/test-suite.ts
```

效果：表明项目"活着"且"欢迎参与"，比沉默 README 高一档信任度。

### 0.3 创建 examples/ 目录（1 小时）

放 3 份真实查询示例（截图或 JSON）：
- `examples/01-query-context-engineering.md`：query_architecture("how to compact long conversations")
- `examples/02-trace-prompt-cache.md`：trace_concern("prompt cache") 12 模块输出
- `examples/03-read-source.md`：get_source_code 调用 + 源码片段

**为什么管用**：让访客 30 秒内"看见输出长什么样"，比读 README 更直观。

### 0.4 截图 / GIF（最重要的一项，1–2 小时）

策略里第一条就是这个。建议至少做：

- **1 张主截图**：Claude Desktop / Cursor 中调用 `query_architecture` 的真实回答（带源码链接）
  → 放进 README 第一屏，紧挨标题徽章下方
- **1 个 GIF**（可选但极推荐）：从提问到拿到回答 + 源码的全流程，10–15 秒
  → 用 Kap / Gifox 录屏

放在 `assets/` 或 `docs/images/` 下，README 里相对路径引用。

### 0.5 决定包名（5 分钟）

策略提到“更短更 catchy”。最终决定用 `cc-sensei`（短、8 字符、有角色感、CC = Claude Code）。

| 选项 | 评估 |
|---|---|
| `cc-sensei` | ✅ 最短、有角色感、已确定 |
| `cc-oracle` | ✅ 简短；但语义不清 |
| **`agent-arch-oracle`**（推荐） | ✅ 平衡：18 字符 / 语义清晰 / npx 友好 |

行动：先 `npm view agent-arch-oracle` 检查是否被占用。

---

## 三、Phase 1：Push 时一次性配齐（T2，半小时）

### 1.1 GitHub 仓库设置

| 字段 | 填什么 |
|---|---|
| **Repo name** | `cc-sensei` |
| **Description (About)** | `Your AI's shortcut to mastering Claude Code's architecture — 310K lines distilled into 32 queryable modules via MCP.` |
| **Website** | 暂留空，等博客上线后填 |
| **Topics** | `mcp` `mcp-server` `claude-code` `ai-agent` `agent-architecture` `llm` `developer-tools` `cursor` `claude` `cc-sensei` |

> Topics 是 GitHub Explore 的核心索引信号——**填满 10 个上限**。

### 1.2 首个 Release（v1.0.0）

```bash
git tag -a v1.0.0 -m "v1.0.0 — initial public release"
git push origin v1.0.0
```

Release notes 模板：
```markdown
## v1.0.0 — Initial release 🎉

The first public release of Agent Architecture Oracle.

**What you get**
- 6 MCP tools surfacing Claude Code's architecture (310K LoC distilled into 32 modules)
- Sub-120ms p95 latency, fully local, zero network deps
- 65/65 tests passing across 3 suites
- Bilingual README (English + 中文)

**Quick start**
git clone … && pnpm install && pnpm build → wire into Claude Desktop / Cursor

See README for details.
```

### 1.3 README 顶部加 badges 校验

push 后 GitHub Actions（如有）会生成 build badge。如果暂时没 CI，先把"tests 65/65"维持静态徽章，后补 CI。

---

## 四、Phase 2：核心推广（T3–T7，按 ROI 排序）

### 优先级矩阵

| # | 渠道 | 投入 | 预期 ROI | 时间窗 |
|---|---|---|---|---|
| 1 | **awesome-mcp-servers PR** | 30 分钟 | ⭐⭐⭐⭐⭐ 精准用户 | T3 |
| 2 | **Hacker News Show HN** | 1 小时 | ⭐⭐⭐⭐⭐ 爆发力最强 | T3–T4，**周二 9–10 AM EST** |
| 3 | **Twitter/X 主帖 + Thread** | 1 小时 | ⭐⭐⭐⭐ 长尾扩散 | T3 |
| 4 | **Reddit 三连发** | 2 小时 | ⭐⭐⭐⭐ 讨论度高 | T4–T5 |
| 5 | **Discord（Claude/Cursor）** | 30 分钟 | ⭐⭐⭐ 精准但量小 | T3 |
| 6 | **中文社区（即刻/V2EX/掘金）** | 2 小时 | ⭐⭐⭐ 国内增量 | T5–T6 |
| 7 | **Smithery / Glama 上架** | 1 小时 | ⭐⭐⭐ 持续被发现 | T6–T7 |
| 8 | **npm publish** | 1 小时 | ⭐⭐ 降低门槛 | T7 |

---

### 2.1 awesome-mcp-servers PR（T3）

仓库地址：`https://github.com/punkpeye/awesome-mcp-servers`

PR 步骤：
1. Fork → 在 README 找合适分类（"Knowledge & Memory" 或 "Developer Tools"）
2. 按格式新增一行：
   ```
   - [cc-sensei](https://github.com/contradictory-body/cc-sensei) 🐍 🏠 - Surfaces Claude Code's architecture (32 modules, 310K LoC distilled) for building your own AI agents.
   ```
3. PR 标题：`Add: Agent Architecture Oracle — Claude Code architecture knowledge MCP`

> 一旦合并，**长期被动获 star**——这是 ROI 最高的一条。

### 2.2 Hacker News Show HN（T3–T4，最高爆发力渠道）

**发帖时间**：周二 / 周三美东 9:00–10:00 AM（统计上 HN 黄金时段）

**标题草案（A/B 选一）**：
- A: `Show HN: I distilled Claude Code's 310K LoC source into an MCP server (cc-sensei)`
- B: `Show HN: cc-sensei – an MCP server that teaches your AI Claude Code's architecture`

**首条评论模板**（自己第一时间补充上下文，HN 强烈鼓励 OP 写清楚 why）：
```
Hi HN — author here. I spent 2 weeks reading Claude Code's source and writing
structured analyses of 32 core modules (4 layers of context compaction, prompt
cache strategy, the agent main loop, sub-agent orchestration, etc.). Then I
wrapped them in an MCP server so any LLM (Claude Desktop / Cursor / etc.) can
query "how does X work" and get back: design decisions + reusable patterns +
exact source line numbers.

Happy to answer questions about anything I learned.
```

**风险提示**：HN 用户对 AI/MCP 项目挑剔；首屏代码截图比 README 链接更管用。

### 2.3 Twitter/X 推广（T3）

**主推文**（≤ 280 字符 + GIF）：
```
I distilled Claude Code's 310K LoC source into 32 structured modules
and exposed them through an MCP server.

Now any AI (Claude Desktop, Cursor, …) can ask:
"How does Claude Code compact long conversations?"
→ gets: architecture + 5 copyable patterns + actual source files.

Open source, MIT 👇
[link]
```

**Thread 思路**（10 条，最后一条引向 repo）：
```
1/ I read Claude Code's source for 2 weeks. Here are 10 things I learned 🧵
2/ Their context compaction has FOUR tiers — not one. Each handles a different…
3/ Prompt cache is sticky — once you flip the beta header, never flip back…
4/ …
10/ I packaged all 32 modules' patterns into an MCP server. Your AI can query it
    directly. github.com/contradictory-body/cc-sensei ⭐
```

**触达**：
- @ 人：`@AnthropicAI` `@AnthropicCore` `@cursor_ai` `@modelcontextp` (MCP 官号)
- Hashtag：`#MCP #ClaudeCode #AIAgents`

### 2.4 Reddit 三连发（T4–T5，每个 sub 错开 24h）

| 子版 | 标题角度 | 偏好 |
|---|---|---|
| **r/ClaudeAI** | "Built an MCP server that explains Claude Code's own architecture to your AI" | 工具向 |
| **r/LocalLLaMA** | "Open-source MCP server: turn 310K lines of Claude Code source into queryable knowledge" | 技术向 |
| **r/MachineLearning** | `[P]` 前缀，强调 retrieval engine 的工程细节 | 学术向 |

> 不要复制粘贴同一段文案——每版用不同切入点；评论区主动答疑。

### 2.5 Discord（T3）

- **Claude Developers Discord** → `#showcase` 或 `#mcp-servers`
- **Cursor Community Discord** → 类似频道
- **MCP Discord**（如果存在 official）

发布格式：1 段介绍 + GIF + GitHub 链接，结尾问 "would love feedback"。

### 2.6 中文社区（T5–T6）

| 平台 | 形式 | 重点 |
|---|---|---|
| **即刻** | 短动态 + 截图 | "我把 Claude Code 30 万行源码塞进了 MCP server" |
| **V2EX** /share-projects | 中文短帖 | 强调"双语 / 完全本地 / 65 测试" |
| **掘金** | 简化博客 | 把英文 Medium 翻译精简版 |
| **知乎专栏** | 长文 | 配合 Phase 3 博客同步 |

### 2.7 MCP Marketplace 上架（T6–T7）

- **Smithery.ai** — 提交项目元数据
- **Glama.ai** — 类似 listing
- **mcp.so**（如运营中）

> 这些站点的目标用户 100% 是 MCP server 使用者，转化率非常高。

### 2.8 npm publish（T7）

```bash
# 包名占用检查
npm view agent-arch-oracle

# 加 bin 字段后发布
npm login
npm publish --access public
```

发布后 README 顶部加：
```bash
npx agent-arch-oracle  # zero-install try-out
```

---

## 五、Phase 3：内容营销持续增长（T8–T14）

### 3.1 深度博客（中英双发）

**英文（Medium / dev.to）标题**：
- "How I extracted architectural patterns from Claude Code and turned them into an MCP server"
- "Reading 310K lines of Claude Code so your AI doesn't have to"

**中文（掘金 / 知乎）标题**：
- 《读完 Claude Code 30w 行源码后，我做了一个让 AI 直接学它的 MCP 服务》

**结构骨架**：
1. 起因：构建 Agent 时为什么我对 Claude Code 设计如此着迷
2. 方法：怎么把 30 万行拆成 32 模块（10-section 模板 / 选什么不选什么）
3. 难点：trace_concern 关键词召回为什么不够，怎么改成正文扫描
4. 工具效果：query_architecture / search_patterns 真实示例
5. 你能学到什么：5 条直接可抄的工程原则
6. 链接 → repo

### 3.2 演示视频（2 分钟，T10–T12）

**脚本**：
```
0:00–0:15  痛点：屏幕分屏，左边 Claude Code 源码，右边 Cursor，配音"想抄但不知道从哪看"
0:15–0:30  解决：装上 MCP server，重新提问
0:30–1:30  实演：query_architecture → trace_concern → get_source_code 三连
1:30–1:50  Highlight：65 测试 / p95=118ms / MIT
1:50–2:00  CTA：github.com/... ⭐
```

发布到：YouTube + Twitter + Bilibili（中文版）

### 3.3 持续维护（信号 > 内容）

GitHub 上的 star 曲线对**最近 commit 时间**敏感。每周至少 1 次：
- 处理 issue
- 加 1 个 MODULE_NOTES（如果新版 Claude Code 有大更新）
- 更新 README badge / changelog

---

## 六、量化目标 & 复盘节点

| 节点 | 目标 | 复盘动作 |
|---|---|---|
| **T+24h**（push 后第二天） | 30 ⭐ | 检查 HN/Reddit 流量来源 |
| **T+7 天** | 200 ⭐ | 哪个渠道转化最高？双倍下注 |
| **T+30 天** | 500 ⭐ + 5 issue + 2 PR | 写第二篇博客 / 录中文 demo |
| **T+90 天** | 1k ⭐ + 上架 ≥ 2 个 marketplace | 评估是否做 v2.0（增量索引、HTTP 传输） |

---

## 七、风险与对策

| 风险 | 触发场景 | 对策 |
|---|---|---|
| HN 沉帖 | 标题 / 时段不对 | 备好 2 条标题、固定周二早段发；不上首页就静默撤帖 24h 后重发 |
| 被指"啃 Claude Code 源码侵权" | 评论区可能有人质疑 | README 明确：本项目只索引和分析公开仓库，源码本身遵守原 LICENSE |
| MODULE_NOTES 老化 | Claude Code 大版本更新 | Roadmap 已列"增量索引"；每月跟一次 cc 主仓库 release |
| Star 增长后 issue 处理不及 | 用户多了 | 提前写好 issue template，常见问题转 FAQ |

---

## 八、立即可执行的 Today's Checklist

打勾即可推进：

- [ ] 创建 `LICENSE`（MIT）
- [ ] 创建 `CONTRIBUTING.md`
- [ ] 创建 `examples/` 目录 + 3 份示例
- [ ] 录 1 张主截图 + 1 个 GIF（放 `assets/`）
- [ ] README 第一屏插入截图
- [ ] `npm view agent-arch-oracle` 检查包名
- [ ] 起草 HN 标题 A/B + 首条评论
- [ ] 起草 Twitter 主推文 + 10 条 thread
- [ ] 起草 awesome-mcp-servers PR 描述行
- [ ] 决定 push 当天的 GitHub Topics（10 个）
- [ ] push、打 v1.0.0 tag、写 release notes

> **完成上述 11 项 → 立即 push → 当天提 awesome PR → 次日（周二上午）发 HN。**
