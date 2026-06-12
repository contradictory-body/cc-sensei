# Contributing to cc-sensei

Thanks for considering a contribution! This project lives or dies by the quality of its **MODULE_NOTES**, so even a single typo fix or a new module analysis is genuinely valuable.

[English](#english) · [中文](#中文)

---

## English

### Project at a glance

```
src/                     TypeScript MCP server (compiled to dist/server.js)
 ├─ server.ts            JSON-RPC over stdio
 ├─ retrieval/engine.ts  Keyword + concern + full-text retrieval
 ├─ source-reader.ts     Path-safe local source reader
 └─ tools/               6 MCP tools

scripts/
 ├─ build-index.ts       Parses MODULE_NOTES → knowledge/*.json
 ├─ test-suite.ts        30 baseline tests
 ├─ regression-3fixes.ts 11 UX-fix regressions
 ├─ e2e-comprehensive.ts 24 real-scenario E2E tests
 └─ gen-examples.ts      Regenerates examples/*.md from real queries

claude-code-main/
 ├─ src/                 Claude Code source (read-only reference)
 └─ MODULE_NOTES/        32 module analyses (this is where you contribute)

knowledge/               Build artifacts (generated, do not edit)
```

### Dev setup

```bash
git clone https://github.com/contradictory-body/cc-sensei.git
cd cc-sensei
pnpm install
pnpm build          # compiles src + builds knowledge/*.json indexes
pnpm exec tsx scripts/test-suite.ts          # 30 tests
pnpm exec tsx scripts/regression-3fixes.ts   # 11 tests
pnpm exec tsx scripts/e2e-comprehensive.ts   # 24 tests
```

All tests must stay green before merging.

### How to contribute

#### 1. Fix a typo or factual error in an existing MODULE_NOTES

1. Edit the file under `claude-code-main/MODULE_NOTES/`.
2. Run `pnpm build:index` to regenerate `knowledge/*.json`.
3. Open a PR with a one-line description.

#### 2. Add a new MODULE_NOTES analysis

Pick a sub-system in `claude-code-main/src/` not yet covered and:

1. Create `claude-code-main/MODULE_NOTES/M23-your-module.md` (or `SUPP-yourTopic.md` for deep-dive supplements).
2. **Follow the 10-section template** used by every existing MODULE_NOTES (see M02 / M06 as references):
   - 模块概览 / Overview
   - 核心职责 / Core responsibilities
   - 关键文件清单 / Key files
   - 架构与数据流 / Architecture & data flow
   - 关键设计决策 / Design decisions
   - 设计原则 / Design principles
   - 可复用 Pattern / Reusable patterns
   - 与其他模块的关系 / Relations
   - 关键 Concerns / Key concerns
   - 附录 / Appendix
3. Register the module ID in `src/taxonomy.ts` (under the appropriate category).
4. Run `pnpm build:index` and verify the indexes pick it up.
5. Add at least one E2E case touching it in `scripts/e2e-comprehensive.ts`.
6. Open a PR with a short summary of what the new module covers.

#### 3. Improve the retrieval engine or tools

- Logic changes go in `src/retrieval/engine.ts` or `src/tools/*.ts`.
- **Every behavioural change must come with a regression test** — append to `scripts/regression-3fixes.ts` (or create a new regression script).
- Keep response sizes bounded; the MCP context window is small. Use `max_per_section` / `max_sections` patterns when emitting bulky output.

#### 4. Report a bug

Open an issue with:
- Tool name + arguments
- Expected vs. actual output
- Output of `pnpm exec tsx scripts/test-suite.ts` (paste the failing case)

### Coding conventions

| Topic | Convention |
|---|---|
| Language | TypeScript (ESM), `strict: true` |
| Formatting | Match the surrounding file; no project-wide formatter required |
| Tests | Always add a regression test alongside any retrieval/parser change |
| Path safety | All file reads must go through `validatePath` (see `source-reader.ts`) |
| Backwards compat | New tool args must be optional; never break existing callers |
| Indexes | Never hand-edit `knowledge/*.json`; regenerate with `pnpm build:index` |

### Commit / PR

- Conventional commits encouraged (`fix:`, `feat:`, `docs:`), but not required.
- Squash-merge on green CI.
- Reference the issue number if applicable.

### License

By contributing, you agree your contributions will be licensed under [MIT](LICENSE).

---

## 中文

### 项目结构速览

见英文版同一节。

### 本地开发

```bash
git clone https://github.com/contradictory-body/cc-sensei.git
cd cc-sensei
pnpm install
pnpm build          # 编译 src + 构建 knowledge/*.json 索引
pnpm exec tsx scripts/test-suite.ts          # 30 项基础测试
pnpm exec tsx scripts/regression-3fixes.ts   # 11 项回归
pnpm exec tsx scripts/e2e-comprehensive.ts   # 24 项端到端
```

合并前**所有测试必须通过**。

### 贡献方式

#### 1. 修订已有 MODULE_NOTES 的错别字或事实错误

直接改 `claude-code-main/MODULE_NOTES/` 下对应文件 → 跑 `pnpm build:index` → PR。

#### 2. 新增一份 MODULE_NOTES（最受欢迎）

挑一个 `claude-code-main/src/` 下还未覆盖的子系统：

1. 在 `MODULE_NOTES/` 下新建 `M23-your-module.md` 或 `SUPP-yourTopic.md`。
2. **严格按 10 节模板**写（参考 M02 / M06）：模块概览 / 核心职责 / 关键文件清单 / 架构与数据流 / 关键设计决策 / 设计原则 / 可复用 Pattern / 与其他模块的关系 / 关键 Concerns / 附录。
3. 在 `src/taxonomy.ts` 注册模块 ID。
4. 跑 `pnpm build:index`，确认索引识别。
5. 在 `scripts/e2e-comprehensive.ts` 至少加一个相关用例。
6. PR 简述该模块覆盖什么。

#### 3. 改进检索引擎或工具

- 改动放在 `src/retrieval/engine.ts` 或 `src/tools/*.ts`。
- **任何行为变更必须配套回归用例** —— 追加到 `scripts/regression-3fixes.ts`。
- 注意控制输出大小（MCP 上下文窗口有限），可参考现有 `max_per_section` / `max_sections` 截断策略。

#### 4. 报告 Bug

issue 请包含：
- 调用的工具名 + 参数
- 期望输出 vs. 实际输出
- `pnpm exec tsx scripts/test-suite.ts` 中失败用例的输出

### 代码规范

| 项 | 约定 |
|---|---|
| 语言 | TypeScript（ESM），`strict: true` |
| 格式 | 跟随上下文风格 |
| 测试 | 检索/解析改动必须配回归用例 |
| 路径安全 | 所有文件读取必须经 `validatePath` |
| 兼容性 | 新参数必须可选，不破坏已有调用 |
| 索引 | 禁止手改 `knowledge/*.json`，请用 `pnpm build:index` |

### License

提交即同意你的贡献以 [MIT](LICENSE) 协议发布。
