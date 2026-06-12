// ============================================================
// Tool: get_source_code
// Read actual source from local claude-code-main/src/
// ============================================================

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { readSourceCode, listSourceFiles } from "../source-reader.js";

export const getSourceCodeToolDef: Tool = {
  name: "get_source_code",
  description:
    "Read actual Claude Code source code files. Use this to see implementation details referenced in module analysis. Supports line-range extraction. Returns at most 500 lines per call.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description:
          "Relative path within src/ (e.g., 'entrypoints/cli.tsx', 'services/api/claude.ts'). A leading 'src/' prefix is also accepted and will be stripped automatically.",
      },
      start_line: {
        type: "number",
        description: "Optional: starting line number (1-based). Defaults to 1.",
      },
      end_line: {
        type: "number",
        description: "Optional: ending line number (1-based). Defaults to start_line + 499.",
      },
    },
    required: ["file_path"],
  },
};

export async function handleGetSourceCode(
  args: { file_path: string; start_line?: number; end_line?: number }
): Promise<string> {
  // Normalize for display: strip leading 'src/' or slashes so the header isn't 'src/src/...'
  let displayPath = args.file_path.trim();
  while (displayPath.startsWith("/")) displayPath = displayPath.slice(1);
  if (displayPath.startsWith("src/")) displayPath = displayPath.slice(4);

  // Handle directory listing request
  if (args.file_path.endsWith("/") || args.file_path === "") {
    try {
      const files = await listSourceFiles(args.file_path);
      return `## Directory: src/${displayPath}\n\n${files.map((f) => `- ${f}`).join("\n")}`;
    } catch (e) {
      return `Error listing directory: ${(e as Error).message}`;
    }
  }

  try {
    const result = await readSourceCode(args.file_path, args.start_line, args.end_line);
    const header = `## src/${result.filePath} (lines ${result.startLine}-${result.endLine} of ${result.totalLines})\n\n`;
    return header + "```\n" + result.content + "\n```";
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}
