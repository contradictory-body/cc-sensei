// ============================================================
// Tool: list_modules
// List all available modules with brief descriptions
// ============================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RetrievalEngine } from "../retrieval/engine.js";

export const listModulesToolDef: Tool = {
  name: "list_modules",
  description:
    "List all available architecture modules. Returns module IDs, titles, and key concerns for each module. Use this to discover what knowledge is available before querying specific modules.",
  inputSchema: {
    type: "object" as const,
    properties: {
      category: {
        type: "string",
        enum: ["core", "supplement"],
        description:
          "Optional: filter by category. 'core' = M01-M22 main modules, 'supplement' = SUPP-* deep-dive supplements.",
      },
    },
    required: [],
  },
};

export function handleListModules(
  engine: RetrievalEngine,
  args: { category?: string }
): string {
  const modules = args.category
    ? engine.getModulesByCategory(args.category as "core" | "supplement")
    : engine.getAllModules();

  const lines: string[] = ["# Available Architecture Modules\n"];

  if (!args.category || args.category === "core") {
    lines.push("## Core Modules (M01-M22)\n");
    const coreModules = modules.filter((m) => m.category === "core");
    for (const mod of coreModules) {
      lines.push(`- **${mod.id}**: ${mod.title} — [${mod.concerns.slice(0, 4).join(", ")}]`);
    }
    lines.push("");
  }

  if (!args.category || args.category === "supplement") {
    lines.push("## Supplement Deep-Dives\n");
    const suppModules = modules.filter((m) => m.category === "supplement");
    for (const mod of suppModules) {
      lines.push(`- **${mod.id}**: ${mod.title} — [${mod.concerns.slice(0, 3).join(", ")}]`);
    }
    lines.push("");
  }

  lines.push(`\nTotal: ${modules.length} modules. Use \`get_module\` with a module ID to read its content.`);

  return lines.join("\n");
}
