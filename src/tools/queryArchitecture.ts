// ============================================================
// Tool: query_architecture
// Search across all MODULE_NOTES using keyword matching + concern mapping
// ============================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RetrievalEngine } from "../retrieval/engine.js";
import type { Depth } from "../types.js";

export const queryArchitectureToolDef: Tool = {
  name: "query_architecture",
  description:
    "Search the Claude Code architecture knowledge base. Returns relevant module analysis at the requested depth level. Use this to understand how specific features, patterns, or subsystems are implemented.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "Natural language query about Claude Code architecture (e.g., 'how does context trimming work', 'permission system', 'streaming tool execution')",
      },
      depth: {
        type: "string",
        enum: ["brief", "standard", "deep"],
        description:
          "Level of detail: 'brief' = module overview (fast), 'standard' = architecture + key decisions, 'deep' = full module content",
      },
      modules: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional: limit search to specific module IDs (e.g., ['M02', 'M06']). If omitted, searches all modules.",
      },
    },
    required: ["query"],
  },
};

export async function handleQueryArchitecture(
  engine: RetrievalEngine,
  args: { query: string; depth?: string; modules?: string[] }
): Promise<string> {
  const depth: Depth = (args.depth as Depth) || "standard";
  const result = await engine.query(args.query, depth, args.modules);

  if (result.modules.length === 0) {
    return `No modules found matching query: "${args.query}"\n\nTip: Try broader terms or use 'list_modules' to see available modules.`;
  }

  const parts: string[] = [];
  for (const match of result.modules) {
    parts.push(match.content);
    parts.push("\n---\n");
  }

  if (result.relatedModules.length > 0) {
    parts.push(`\n**Related modules**: ${result.relatedModules.join(", ")}`);
  }

  return parts.join("\n");
}
