<div align="center">

# 🎓 cc-sensei

### *Inject every ounce of Claude Code's architectural wisdom into your AI's brain*

[English](README.md) | [中文](README_zh.md)

[![MCP](https://img.shields.io/badge/MCP-2024--11--05-blueviolet?style=for-the-badge)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/tests-65%2F65%20passing-success?style=for-the-badge)](#tests)
[![Modules](https://img.shields.io/badge/modules-32-orange?style=for-the-badge)](#dive-deeper)
[![Latency](https://img.shields.io/badge/p95-118ms-green?style=for-the-badge)](#performance)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

<img src="assets/social-preview.png" alt="cc-sensei: 310K lines of source distilled into 32 queryable modules via MCP" width="100%" />

</div>

---

## Sound familiar?

> 😩 **"I've already dug deep into Claude Code's source, but when I ask my AI to help me build an Agent, it has no idea what I'm talking about — what I read, it didn't."**

> 😫 **"I'd love to build a knowledge base so my AI can learn from Claude Code, but the moment I open it — 300K+ lines, 1,250 files — both my AI and I are scared off."**

> 😵 **"I've barely looked at Claude Code's source, but I still want an Agent just as powerful — where do I even begin?"**

If any of these hit home — **this project is built for you.**

---

## What it does for you

**Agent Architecture Oracle distills Claude Code's 310K lines of source and 1,250 files into 32 core modules with 40K lines of structured analysis, and serves it directly to your AI through the MCP protocol.**

It covers every core capability of Claude Code:
> 🔁 Agent main loop · 🛠️ Tool system & execution pipeline · 🛡️ Permissions & security sandbox · 🌊 Model API & streaming
> 🧠 Context engineering & compaction · 📂 File / Shell / Git tools · 🔌 MCP protocol · 🎨 Ink rendering engine · 🧩 Skills/plugins
> 💾 Persistent memory · ⚡ Prompt cache break detection · 🤖 Sub-agents & task system … (22 core + 10 deep-dive supplements)

It establishes a complete index pipeline: **natural language → module → design decision → reusable pattern → corresponding source code**:

```
       You say one thing                  Oracle automatically does five things
  ─────────────────────────         ──────────────────────────────────────────
  "How do you compact long       ──►  ① Match natural language to M06 (Context Engineering)
   conversations?"                     ② Return the 4-tier compaction architecture & 9-section summary prompt
                                       ③ List 5 directly-copyable engineering principles
                                       ④ Cross-trace the 12 modules touched by prompt cache
                                       ⑤ Pull up services/compact/microCompact.ts source on demand
```

After plugging it into Claude Desktop / Cursor / Qoder / your own Agent, **your AI gains a "Chief Architect of Claude Code" as its consultant** — whether you're cloning the whole thing or just stealing one design, it tells you exactly **where to look, why it works, and how to copy it.**

In one night, your AI becomes a world-class Agent architect.

---

## 🚀 Quick Start (3 steps)

### Step 1 — Clone the project

Open a terminal and copy-paste this line:

```bash
git clone https://github.com/contradictory-body/cc-sensei.git && cd cc-sensei
```

### Step 2 — Install and build

Copy-paste again:

```bash
pnpm install && pnpm build
```

> 💡 Don't have pnpm? Run `npm install -g pnpm` first.
> 💡 This step parses 32 module analyses, generates the knowledge index, and compiles the server. **One-time only.**

When done, you should see: `✅ module-registry.json (32 modules)` and `✅ Build success`.

### Step 3 — Connect your AI

Add this snippet to your MCP client's configuration file (**replace the path with the one you just cloned to**):

```json
{
  "mcpServers": {
    "cc-sensei": {
      "command": "node",
      "args": ["/your/absolute/path/cc-sensei/dist/server.js"]
    }
  }
}
```

Don't know where the config file is? Common locations:
| Client | Config file path |
|---|---|
| **Claude Desktop (macOS)** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Desktop (Windows)** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Cursor** | Settings → MCP → Add new server |
| **Qoder** | Settings → MCP → Edit mcpServers |

**Restart your client. Done!** Your AI just gained 6 new skills.

### 🎯 Try it out

Just say to your AI:

> *"Use cc-sensei to tell me how Claude Code optimizes prompt cache."*

It will call the tools on its own and return a complete analysis with source-code references. **That's it.**

---

## Dive deeper

### 🛠️ What the 6 tools do

| Tool | One-line capability | When to use |
|---|---|---|
| **`list_modules`** | List all 32 modules and their concerns | "Which modules does Claude Code break down into?" |
| **`query_architecture`** | Natural-language search with 3 depth levels (brief/standard/deep) | "How do they prevent long-conversation context overflow?" |
| **`get_module`** | Drill into one module's specific section (responsibility / architecture / decisions / principles / relations) | "Show me M06's design principles" |
| **`trace_concern`** | Trace one concern across all 32 modules, ranked by hit count | "Which modules touch 'prompt cache'?" |
| **`search_patterns`** | Bulk-extract reusable patterns with built-in size limiting | "Give me every cache-related design I can copy" |
| **`get_source_code`** | Read Claude Code source directly (with line numbers, ranges, and directory listings) | "Show me `services/api/claude.ts:1412-1456`" |

Every tool comes with:
- ✅ **Path-prefix tolerance** — both `src/...` and bare paths are accepted; no more copy-paste failures
- ✅ **Result rate-limiting** — 800 chars per section and 12 sections by default, so your AI's context window stays alive
- ✅ **Path-traversal protection** — attacks like `../../../etc/passwd` are rejected outright
- ✅ **Graceful degradation** — bad arguments return friendly hints instead of crashes

---

### 🎬 Real scenario: "I want to add context compaction to my Agent"

```
You:    "How do you compact conversation history to avoid hitting the token limit?"

Oracle (query_architecture, 103ms):
  → Hit M06: Context Engineering
  → Returns the 4-tier compaction architecture comparison table
    (microCompact / sessionMemoryCompact / autoCompact / reactiveCompact)
  → Trigger conditions, whether LLM is invoked, key file locations — all listed

You:    "Show me M06's key design principles"

Oracle (get_module section=principles, 102ms):
  → "Sticky-on Beta Headers — performance over simplicity"
    "Single message-level cache_control marker (max 4)"
    "9-section summary structure — eval-driven prompt"
  → Each principle includes: where it lives, code snippet, why, how to reuse, the trade-off

You:    "How many modules does 'prompt cache' span?"

Oracle (trace_concern, 118ms):
  → 12 modules ranked by hit count
  → Each with 5 lines of file:line excerpts

You:    "Show me src/services/compact/microCompact.ts"

Oracle (get_source_code, 99ms):
  → Source with line numbers + total line count
```

**A complete "understand → copy → ship" loop, averaging ~110ms.**

---

### 📦 Knowledge scale

```
📚 32 module analyses  (40K lines of distilled insight covering 310K lines of source)
├── M01-M22  Core modules
│   M01 Process bootstrap & lifecycle · M02 Agent main loop · M03 Tool system
│   M04 Permissions & security · M05 Model API & streaming · M06 Context engineering
│   M07 File/Shell/Git tools · M08 MCP protocol · M09 LSP integration
│   M10 Bridge/IPC · M11 Ink rendering engine · M12 Message rendering
│   M13 Input system · M14 Sub-agents & tasks · M15 Skills/plugins
│   M16 Command system · M17 Configuration & settings · M18 Telemetry & analytics
│   M19 State management · M20 Hotkeys & focus · M21 Buddy/voice · M22 Testability
└── SUPP-* 10 deep-dive supplements
    AgentSummary · SessionMemory · autoDream · ColorDiff
    extractMemories · fileIndex · largeFiles · speculation
    teamMemorySync · yogaLayout

🗂️ Indexes: 390 keywords / 104 concerns / full section-line mappings
💻 Full source code: claude-code-main/src/  available for direct local reads
```

---

### 🏗️ Engineering philosophy

This project is **dogfooding** itself — built using the methods Claude Code teaches, made to serve Claude.

| Claude Code's design philosophy | How this project applies it |
|---|---|
| **Build-time indexing + zero runtime analysis** | Section line ranges, keywords, and concerns are all computed in `pnpm build:index`; runtime just looks up JSON |
| **Path-traversal gatekeeping** | `validatePath` runs before every file read |
| **Graceful degradation > unhandled crashes** | Section not found? Return the "available types" hint |
| **Structured prompt-as-spec** | All 32 MODULE_NOTES strictly follow a 10-section template |
| **Rate-limiting by default** | search_patterns defaults to 800 chars per section, 12 sections cap, configurable |

---

### ⚡ Performance

```
p50 = 105ms   p95 = 118ms   max = 125ms
Average response size: 7K chars
Fully local, 0 network dependency
```

---

### ✅ Tests

```bash
pnpm exec tsx scripts/test-suite.ts          # 30 baseline functional tests
pnpm exec tsx scripts/regression-3fixes.ts   # 11 UX-fix regression tests
pnpm exec tsx scripts/e2e-comprehensive.ts   # 24 real-scenario E2E tests
```

| Test suite | Cases | Result |
|---|---|---|
| Baseline functionality (6 tools × multiple branches) | 30 | ✅ 30/30 |
| UX-fix regression | 11 | ✅ 11/11 |
| Real user-scenario E2E (3 personas) | 24 | ✅ 24/24 |
| **Total** | **65** | **✅ 65/65** |

---

### 📁 Project structure

```
cc-sensei/
├── src/
│   ├── server.ts                 # MCP server entry
│   ├── retrieval/engine.ts       # Retrieval engine
│   ├── source-reader.ts          # Source reading + path safety
│   ├── taxonomy.ts               # 32-module mapping table
│   └── tools/                    # 6 MCP tools
├── scripts/
│   ├── build-index.ts            # Parses MODULE_NOTES into indexes
│   ├── test-suite.ts
│   ├── regression-3fixes.ts
│   └── e2e-comprehensive.ts
├── knowledge/                    # Build artifacts
│   ├── module-registry.json
│   ├── keyword-index.json
│   └── concern-map.json
├── claude-code-main/             # Claude Code source + 32 module analyses
│   ├── src/                      #   ← Source
│   └── MODULE_NOTES/             #   ← Analyses
└── dist/server.js                # Bundle output
```

---

### ⚙️ Advanced configuration

| Env var | Purpose | Default |
|---|---|---|
| `CC_SOURCE_ROOT` | Claude Code source root | `<project>/claude-code-main/src` |
| `MODULE_NOTES_ROOT` | Module-analysis directory | `<project>/claude-code-main/MODULE_NOTES` |

Point these to anywhere else and **Oracle becomes a knowledge server for any project** — as long as that project has analyses written to the same MODULE_NOTES template.

---

## Roadmap

- [ ] Incremental indexing (only re-parse changed MODULE_NOTES)
- [ ] More section types (performance / security / observability)
- [ ] HTTP / SSE transport (in addition to stdio)
- [ ] Multi-codebase support (mount several projects at once)

---

## License

MIT

---

<div align="center">

**Can't read 310K lines of source? Let 40K lines of distilled analysis read it for you, and let your AI copy from it.**

If this project helped you, drop a ⭐ so more Agent developers can find it.

</div>
