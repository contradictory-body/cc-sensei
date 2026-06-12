// ============================================================
// Tool: search_patterns
// Extract reusable design patterns from MODULE_NOTES
// ============================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RetrievalEngine } from "../retrieval/engine.js";

export const searchPatternsToolDef: Tool = {
  name: "search_patterns",
  description:
    "Search for reusable design patterns and principles extracted from Claude Code's architecture. Returns 'directly-reusable' patterns that you can adapt for your own Agent implementation. Output is paginated: each section is capped (default 800 chars) and total sections capped (default 12). Use module_id to focus, or get_module(section=\"principles\") for the full text of a specific module.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern_type: {
        type: "string",
        enum: ["reusable", "anti-pattern", "all"],
        description:
          "Type of patterns to search: 'reusable' = patterns you can copy, 'anti-pattern' = patterns to avoid, 'all' = both.",
      },
      keywords: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional: filter patterns by keywords (e.g., ['cache', 'retry', 'streaming']).",
      },
      module_id: {
        type: "string",
        description:
          "Optional: restrict to a single module (e.g., 'M05'). Useful when you already know the relevant module.",
      },
      max_per_section: {
        type: "number",
        description:
          "Optional: per-section character cap (default 800). Truncated sections include a hint to fetch full content via get_module.",
      },
      max_sections: {
        type: "number",
        description:
          "Optional: maximum total number of sections to return (default 12).",
      },
    },
    required: [],
  },
};

export async function handleSearchPatterns(
  engine: RetrievalEngine,
  args: {
    pattern_type?: string;
    keywords?: string[];
    module_id?: string;
    max_per_section?: number;
    max_sections?: number;
  }
): Promise<string> {
  const results = await engine.searchPatterns(
    args.keywords,
    args.module_id,
    args.max_per_section ?? 800,
    args.max_sections ?? 12
  );

  if (results.length === 0) {
    return "No patterns found matching the criteria.\n\nTip: Try broader keywords, omit the keywords filter, or remove module_id to see all available patterns.";
  }

  const parts: string[] = ["# Reusable Design Patterns\n"];

  for (const result of results) {
    parts.push(`## From ${result.moduleId}${result.truncated ? " (truncated)" : ""}\n`);
    parts.push(result.content);
    parts.push("\n---\n");
  }

  const truncatedCount = results.filter((r) => r.truncated).length;
  parts.push(
    `\nReturned ${results.length} pattern section(s) across ${new Set(results.map((r) => r.moduleId)).size} module(s)` +
      (truncatedCount > 0 ? `. ${truncatedCount} were truncated — use get_module(<id>, section="principles") for full content.` : ".")
  );

  return parts.join("\n");
}
