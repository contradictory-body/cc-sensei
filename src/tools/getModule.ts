// ============================================================
// Tool: get_module
// Return specific module's content, optionally filtered to one section
// ============================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RetrievalEngine } from "../retrieval/engine.js";

export const getModuleToolDef: Tool = {
  name: "get_module",
  description:
    "Get detailed content from a specific module. Can optionally return only a specific section type (responsibility, architecture, decisions, principles, or relations).",
  inputSchema: {
    type: "object" as const,
    properties: {
      module_id: {
        type: "string",
        description:
          "Module ID (e.g., 'M01', 'M02', ..., 'M22', 'SUPP-AgentSummary', 'SUPP-SessionMemory', etc.)",
      },
      section: {
        type: "string",
        enum: ["responsibility", "architecture", "decisions", "principles", "relations"],
        description:
          "Optional: return only a specific section type. If omitted, returns the full module.",
      },
    },
    required: ["module_id"],
  },
};

export async function handleGetModule(
  engine: RetrievalEngine,
  args: { module_id: string; section?: string }
): Promise<string> {
  const mod = engine.getModule(args.module_id);
  if (!mod) {
    const allIds = engine.getAllModules().map((m) => m.id).join(", ");
    return `Module not found: "${args.module_id}"\n\nAvailable modules: ${allIds}`;
  }

  if (args.section) {
    const sectionType = args.section as "responsibility" | "architecture" | "decisions" | "principles" | "relations";
    const content = await engine.getModuleSection(args.module_id, sectionType);
    if (!content) {
      return `No "${args.section}" section found in module ${args.module_id} (${mod.title}).\n\nAvailable section types in this module: ${mod.sections.map((s) => s.type).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`;
    }
    return `# ${mod.id}: ${mod.title} — ${args.section}\n\n${content}`;
  }

  // Return full module
  const content = await engine.getModuleContent(mod, "deep");
  return content;
}
