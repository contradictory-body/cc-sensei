// ============================================================
// Tool: trace_concern
// Trace a concern across ALL modules where it appears
// ============================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RetrievalEngine } from "../retrieval/engine.js";

export const traceConcernToolDef: Tool = {
  name: "trace_concern",
  description:
    "Trace a specific architectural concern across all modules. Shows how one concept (e.g., 'prompt cache', 'error recovery', 'streaming') is handled at different layers of Claude Code's architecture.",
  inputSchema: {
    type: "object" as const,
    properties: {
      concern: {
        type: "string",
        description:
          "The architectural concern to trace (e.g., 'prompt cache', 'error recovery', 'abort signal', 'streaming', 'retry').",
      },
    },
    required: ["concern"],
  },
};

export async function handleTraceConcern(
  engine: RetrievalEngine,
  args: { concern: string }
): Promise<string> {
  const results = await engine.traceConcern(args.concern);

  if (results.length === 0) {
    return `No modules found mentioning "${args.concern}".\n\nTip: Try different terms or use 'query_architecture' for broader searches.`;
  }

  const parts: string[] = [`# Cross-Module Trace: "${args.concern}"\n`];
  parts.push(`Found in ${results.length} module(s):\n`);

  for (const result of results) {
    parts.push(`## ${result.moduleId}: ${result.title}\n`);
    parts.push(result.excerpt);
    parts.push("\n---\n");
  }

  return parts.join("\n");
}
