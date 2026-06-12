// ============================================================
// Module Taxonomy — 22 Core Modules + 10 Supplements
// Aligned with MODULE_NOTES file structure
// ============================================================

export interface TaxonomyEntry {
  id: string;
  title: string;
  titleEn: string;
  sourceFile: string; // Filename in MODULE_NOTES/
  concerns: string[];
  keywords: string[];
}

/**
 * Complete taxonomy of all 32 modules.
 * This is the authoritative mapping between module IDs and their files.
 */
export const MODULE_TAXONOMY: TaxonomyEntry[] = [
  // ---- Core Modules (M01-M22) ----
  {
    id: "M01",
    title: "进程引导与生命周期",
    titleEn: "Bootstrap & Lifecycle",
    sourceFile: "M01-bootstrap-lifecycle.md",
    concerns: ["startup", "trust-dialog", "memoized-init", "fast-path", "lifecycle"],
    keywords: ["bootstrap", "init", "startup", "STATE", "process", "lifecycle", "trust", "memoize"],
  },
  {
    id: "M02",
    title: "Agent 主循环引擎",
    titleEn: "Agent Loop",
    sourceFile: "M02-agent-loop.md",
    concerns: ["query-loop", "streaming", "context-trimming", "error-recovery", "budget"],
    keywords: ["agent", "loop", "query", "streaming", "context", "trim", "budget", "error", "recovery", "QueryEngine"],
  },
  {
    id: "M03",
    title: "Tool 系统",
    titleEn: "Tool System",
    sourceFile: "M03-tool-system.md",
    concerns: ["tool-interface", "execution-pipeline", "streaming-executor"],
    keywords: ["tool", "ToolUseContext", "executor", "pipeline", "streaming", "Tool interface"],
  },
  {
    id: "M04",
    title: "权限与安全",
    titleEn: "Permission & Safety",
    sourceFile: "M04-permission-safety.md",
    concerns: ["bash-security", "AST-parsing", "approval-flow", "sandbox"],
    keywords: ["permission", "safety", "security", "bash", "AST", "tree-sitter", "sandbox", "approval"],
  },
  {
    id: "M05",
    title: "模型 API 与流式处理",
    titleEn: "Model API & Streaming",
    sourceFile: "M05-api-streaming.md",
    concerns: ["fallback-chain", "cache-detection", "providers", "retry"],
    keywords: ["API", "model", "streaming", "fallback", "cache", "provider", "retry", "Anthropic"],
  },
  {
    id: "M06",
    title: "上下文工程",
    titleEn: "Context Engineering",
    sourceFile: "M06-context-engineering.md",
    concerns: ["compaction", "memdir", "persistent-memory", "structured-summary"],
    keywords: ["context", "compaction", "memory", "memdir", "summary", "token", "window"],
  },
  {
    id: "M07",
    title: "文件/Shell/Git 工具",
    titleEn: "FS/Shell/Git Tools",
    sourceFile: "M07-fs-shell-git.md",
    concerns: ["tree-sitter", "collect-then-reduce", "optimistic-lock"],
    keywords: ["file", "shell", "git", "bash", "tree-sitter", "mtime", "PowerShell", "read", "write", "edit"],
  },
  {
    id: "M08",
    title: "MCP 协议实现",
    titleEn: "MCP Protocol",
    sourceFile: "M08-mcp.md",
    concerns: ["scope-config", "dynamic-tool-model", "OAuth", "dedup"],
    keywords: ["MCP", "protocol", "scope", "OAuth", "tool-model", "stub", "graft", "dedup"],
  },
  {
    id: "M09",
    title: "LSP 集成",
    titleEn: "LSP Integration",
    sourceFile: "M09-lsp.md",
    concerns: ["plugin-discovery", "generation-counter", "retry"],
    keywords: ["LSP", "language-server", "plugin", "discovery", "generation", "ContentModified"],
  },
  {
    id: "M10",
    title: "Bridge/IPC 通信",
    titleEn: "Bridge/IPC",
    sourceFile: "M10-bridge-ipc.md",
    concerns: ["bridge-types", "token-layering", "stdin-protocol"],
    keywords: ["bridge", "IPC", "stdin", "JSON", "protocol", "token", "remote", "WebSocket"],
  },
  {
    id: "M11",
    title: "Ink 渲染引擎",
    titleEn: "Ink Rendering",
    sourceFile: "M11-ink-rendering.md",
    concerns: ["TUI-engine", "yoga", "double-buffer", "hit-test"],
    keywords: ["Ink", "render", "TUI", "yoga", "layout", "buffer", "ANSI", "screen", "React"],
  },
  {
    id: "M12",
    title: "消息渲染层",
    titleEn: "Message Rendering",
    sourceFile: "M12-message-rendering.md",
    concerns: ["4-layer", "virtual-list", "streaming-markdown"],
    keywords: ["message", "render", "markdown", "virtual", "list", "streaming", "useMemo"],
  },
  {
    id: "M13",
    title: "输入系统",
    titleEn: "Input System",
    sourceFile: "M13-input.md",
    concerns: ["hooks", "vim", "paste-handler", "suggestions"],
    keywords: ["input", "hook", "vim", "paste", "suggestion", "PromptInput", "useInput"],
  },
  {
    id: "M14",
    title: "子 Agent 与任务系统",
    titleEn: "Sub-agents & Tasks",
    sourceFile: "M14-subagent-tasks.md",
    concerns: ["task-types", "fork-cache", "cleanup", "stall-watchdog"],
    keywords: ["subagent", "task", "fork", "cache", "cleanup", "watchdog", "abort"],
  },
  {
    id: "M15",
    title: "Skills/插件系统",
    titleEn: "Skills & Plugins",
    sourceFile: "M15-skills-plugins.md",
    concerns: ["skill-format", "security-wall", "lazy-extraction"],
    keywords: ["skill", "plugin", "SKILL.md", "LoadedFrom", "scope", "security"],
  },
  {
    id: "M16",
    title: "命令系统",
    titleEn: "Commands",
    sourceFile: "M16-commands.md",
    concerns: ["command-types", "memoize", "lazy-import"],
    keywords: ["command", "slash", "prompt", "memoize", "DCE", "lazy", "local"],
  },
  {
    id: "M17",
    title: "配置与设置",
    titleEn: "Config & Settings",
    sourceFile: "M17-config.md",
    concerns: ["migration", "remote-settings", "policy-limits"],
    keywords: ["config", "settings", "migration", "policy", "sync", "ETag", "remote"],
  },
  {
    id: "M18",
    title: "遥测与分析",
    titleEn: "Telemetry & Analytics",
    sourceFile: "M18-telemetry.md",
    concerns: ["analytics", "transports", "feature-flags", "killswitch"],
    keywords: ["telemetry", "analytics", "Datadog", "OpenTelemetry", "GrowthBook", "feature-flag", "transport", "SSE", "WebSocket"],
  },
  {
    id: "M19",
    title: "状态管理",
    titleEn: "State Management",
    sourceFile: "M19-state.md",
    concerns: ["3-layer-state", "createStore", "context-providers"],
    keywords: ["state", "AppState", "createStore", "context", "provider", "useSyncExternalStore"],
  },
  {
    id: "M20",
    title: "快捷键与焦点",
    titleEn: "Keybindings & Focus",
    sourceFile: "M20-keybindings-focus.md",
    concerns: ["chord-resolver", "vim-mode", "focus-manager"],
    keywords: ["keybinding", "focus", "chord", "vim", "shortcut", "FocusManager"],
  },
  {
    id: "M21",
    title: "Buddy/语音/MoreRight",
    titleEn: "Buddy/Voice/MoreRight",
    sourceFile: "M21-buddy-voice-moreright.md",
    concerns: ["anti-cheat", "PRNG", "voice-integration"],
    keywords: ["buddy", "voice", "MoreRight", "PRNG", "mulberry32", "anti-cheat", "animation"],
  },
  {
    id: "M22",
    title: "可测试性架构",
    titleEn: "Testability Architecture",
    sourceFile: "M22-testability-architecture.md",
    concerns: ["VCR", "mock-facade", "DI", "retry", "watchdog"],
    keywords: ["test", "VCR", "mock", "DI", "retry", "watchdog", "fallback", "fixture"],
  },

  // ---- Supplements (10) ----
  {
    id: "SUPP-AgentSummary",
    title: "AgentSummary 与 MagicDocs",
    titleEn: "AgentSummary & MagicDocs",
    sourceFile: "SUPPLEMENT-AgentSummary-MagicDocs.md",
    concerns: ["agent-summary", "magic-docs", "fork-background"],
    keywords: ["AgentSummary", "MagicDoc", "fork", "background", "timer", "idle"],
  },
  {
    id: "SUPP-SessionMemory",
    title: "会话记忆",
    titleEn: "Session Memory",
    sourceFile: "SUPPLEMENT-SessionMemory.md",
    concerns: ["session-memory", "compact", "threshold-trigger"],
    keywords: ["SessionMemory", "compact", "threshold", "token", "truncate", "extraction"],
  },
  {
    id: "SUPP-autoDream",
    title: "自动梦境",
    titleEn: "Auto Dream",
    sourceFile: "SUPPLEMENT-autoDream.md",
    concerns: ["auto-dream", "background-processing"],
    keywords: ["autoDream", "dream", "background", "idle"],
  },
  {
    id: "SUPP-colorDiff",
    title: "彩色 Diff",
    titleEn: "Color Diff",
    sourceFile: "SUPPLEMENT-color-diff.md",
    concerns: ["diff", "color", "rendering"],
    keywords: ["diff", "color", "patch", "render", "highlight"],
  },
  {
    id: "SUPP-extractMemories",
    title: "记忆提取",
    titleEn: "Extract Memories",
    sourceFile: "SUPPLEMENT-extractMemories.md",
    concerns: ["memory-extraction", "persistence"],
    keywords: ["memory", "extract", "persist", "store", "recall"],
  },
  {
    id: "SUPP-fileIndex",
    title: "文件索引",
    titleEn: "File Index",
    sourceFile: "SUPPLEMENT-file-index.md",
    concerns: ["file-index", "search", "lookup"],
    keywords: ["file", "index", "search", "glob", "lookup", "cache"],
  },
  {
    id: "SUPP-largeFiles",
    title: "大文件处理",
    titleEn: "Large Files",
    sourceFile: "SUPPLEMENT-large-files.md",
    concerns: ["large-file", "chunking", "streaming"],
    keywords: ["large", "file", "chunk", "stream", "truncate", "limit"],
  },
  {
    id: "SUPP-speculation",
    title: "推测执行",
    titleEn: "Speculation",
    sourceFile: "SUPPLEMENT-speculation.md",
    concerns: ["speculation", "prefetch", "optimistic"],
    keywords: ["speculation", "speculative", "prefetch", "optimistic", "parallel"],
  },
  {
    id: "SUPP-teamMemorySync",
    title: "团队记忆同步",
    titleEn: "Team Memory Sync",
    sourceFile: "SUPPLEMENT-teamMemorySync.md",
    concerns: ["team-sync", "shared-memory", "collaboration"],
    keywords: ["team", "sync", "memory", "shared", "collaboration", "merge"],
  },
  {
    id: "SUPP-yogaLayout",
    title: "Yoga 布局引擎",
    titleEn: "Yoga Layout",
    sourceFile: "SUPPLEMENT-yoga-layout.md",
    concerns: ["yoga", "layout", "flexbox"],
    keywords: ["yoga", "layout", "flex", "box", "measure", "node"],
  },
];

/**
 * Get a taxonomy entry by module ID.
 */
export function getTaxonomyEntry(id: string): TaxonomyEntry | undefined {
  return MODULE_TAXONOMY.find((m) => m.id === id);
}

/**
 * Get all module IDs.
 */
export function getAllModuleIds(): string[] {
  return MODULE_TAXONOMY.map((m) => m.id);
}

/**
 * Get modules by category.
 */
export function getModulesByCategory(category: "core" | "supplement"): TaxonomyEntry[] {
  if (category === "core") {
    return MODULE_TAXONOMY.filter((m) => m.id.startsWith("M"));
  }
  return MODULE_TAXONOMY.filter((m) => m.id.startsWith("SUPP"));
}
