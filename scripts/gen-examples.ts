// ============================================================
// Generate examples/*.md from real MCP server queries.
// Runs 3 representative tool calls and wraps each output as a Markdown demo.
// ============================================================

import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.join(__dirname, "..", "dist", "server.js");
const EXAMPLES_DIR = path.join(__dirname, "..", "examples");

async function callTool(name: string, args: Record<string, unknown>): Promise<{ ms: number; text: string }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", () => {
      for (const ln of out.split("\n").filter(Boolean)) {
        try {
          const obj = JSON.parse(ln);
          if (obj.id === 2 && obj.result?.content?.[0]?.text) {
            return resolve({ ms: Date.now() - start, text: obj.result.content[0].text });
          }
          if (obj.id === 2 && obj.error) return reject(new Error(JSON.stringify(obj.error)));
        } catch {}
      }
      reject(new Error("no response"));
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "examples", version: "1" } } }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
    proc.stdin.end();
  });
}

interface Sample {
  file: string;
  title: string;
  story: string;
  tool: string;
  args: Record<string, unknown>;
  // optional truncation for very large outputs (in chars)
  maxChars?: number;
}

const samples: Sample[] = [
  {
    file: "01-query-context-engineering.md",
    title: "Example 1 — Query: \"How does Claude Code compact long conversations?\"",
    story:
      "You are building an Agent and want to add context compaction. You ask `query_architecture` in natural language; Oracle resolves your intent to **M06 (Context Engineering)** and returns the design with directly-copyable patterns.",
    tool: "query_architecture",
    args: { query: "how to compact long conversation history to avoid token limit", depth: "standard" },
    maxChars: 6000,
  },
  {
    file: "02-trace-prompt-cache.md",
    title: "Example 2 — Trace: \"prompt cache\" across all 32 modules",
    story:
      "You want to know every module that participates in prompt-cache behaviour, ranked by relevance. `trace_concern` scans every MODULE_NOTES body (not just keywords) and ranks modules by hit count.",
    tool: "trace_concern",
    args: { concern: "prompt cache" },
    maxChars: 5000,
  },
  {
    file: "03-read-source.md",
    title: "Example 3 — Source: read `services/compact/microCompact.ts` lines 1–60",
    story:
      "After learning the design, you want to read the actual source. `get_source_code` accepts both `src/...` and bare paths, supports line ranges, and rejects path traversal.",
    tool: "get_source_code",
    args: { file_path: "services/compact/microCompact.ts", start_line: 1, end_line: 60 },
  },
];

async function main() {
  await mkdir(EXAMPLES_DIR, { recursive: true });
  const indexLines: string[] = [
    "# Examples",
    "",
    "Three real MCP tool calls demonstrating the full **understand → trace → read** loop.",
    "",
    "Each file is the verbatim output of a real query against the running server.",
    "",
    "| # | File | Tool | Story |",
    "| - | ---- | ---- | ----- |",
  ];

  for (const s of samples) {
    process.stdout.write(`→ ${s.tool}(${JSON.stringify(s.args)}) ... `);
    const { ms, text } = await callTool(s.tool, s.args);
    let body = text;
    let truncated = false;
    if (s.maxChars && body.length > s.maxChars) {
      body = body.slice(0, s.maxChars);
      truncated = true;
    }
    const md =
      `# ${s.title}\n\n` +
      `> ${s.story}\n\n` +
      `## Tool call\n\n` +
      "```json\n" +
      JSON.stringify({ tool: s.tool, arguments: s.args }, null, 2) +
      "\n```\n\n" +
      `**Latency:** ${ms} ms · **Response size:** ${text.length.toLocaleString()} chars` +
      (truncated ? ` (showing first ${s.maxChars!.toLocaleString()} chars)` : "") +
      "\n\n## Response\n\n" +
      "```\n" +
      body +
      (truncated ? "\n\n…(output truncated for display; full response is returned to the LLM)\n" : "\n") +
      "```\n";
    await writeFile(path.join(EXAMPLES_DIR, s.file), md);
    process.stdout.write(`${ms}ms / ${text.length} chars\n`);
    indexLines.push(`| ${samples.indexOf(s) + 1} | [${s.file}](./${s.file}) | \`${s.tool}\` | ${s.story.replace(/\n/g, " ").slice(0, 90)}… |`);
  }

  indexLines.push(
    "",
    "---",
    "",
    "## Reproduce locally",
    "",
    "```bash",
    "pnpm install && pnpm build",
    "pnpm exec tsx scripts/gen-examples.ts",
    "```",
    "",
    "These examples are regenerated by running `scripts/gen-examples.ts`; outputs are deterministic given the indexed MODULE_NOTES.",
    "",
  );
  await writeFile(path.join(EXAMPLES_DIR, "README.md"), indexLines.join("\n"));
  console.log("\n✅ examples/ regenerated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
