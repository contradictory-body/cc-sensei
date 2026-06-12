// Regression test: verify the 3 fixes after walkthrough review
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.join(__dirname, "..", "dist", "server.js");

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", () => {
      for (const ln of out.split("\n").filter(Boolean)) {
        try {
          const obj = JSON.parse(ln);
          if (obj.id === 2 && obj.result?.content?.[0]?.text) return resolve(obj.result.content[0].text);
          if (obj.id === 2 && obj.error) return reject(new Error(JSON.stringify(obj.error)));
        } catch {}
      }
      reject(new Error("no response"));
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rt", version: "1" } } }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
    proc.stdin.end();
  });
}

interface Check { name: string; pass: boolean; detail: string; }
const checks: Check[] = [];

(async () => {
  // FIX 1: section classifier — M06 decisions/principles/relations should now return non-empty
  {
    const t = await callTool("get_module", { module_id: "M06", section: "decisions" });
    checks.push({ name: "FIX1a M06/decisions returns content", pass: t.length > 200 && !/No.*section found/.test(t), detail: `len=${t.length}` });
  }
  {
    const t = await callTool("get_module", { module_id: "M06", section: "principles" });
    checks.push({ name: "FIX1b M06/principles returns content", pass: t.length > 500 && !/No.*section found/.test(t), detail: `len=${t.length}` });
  }
  {
    const t = await callTool("get_module", { module_id: "M06", section: "relations" });
    checks.push({ name: "FIX1c M06/relations returns content", pass: t.length > 200 && !/No.*section found/.test(t), detail: `len=${t.length}` });
  }

  // FIX 2: search_patterns — default capped, module_id filter works
  {
    const t = await callTool("search_patterns", { keywords: ["cache"] });
    checks.push({ name: "FIX2a search_patterns default size capped (<15K)", pass: t.length < 15000, detail: `len=${t.length}` });
  }
  {
    const t = await callTool("search_patterns", { module_id: "M05" });
    checks.push({ name: "FIX2b search_patterns module_id=M05 only returns M05", pass: t.includes("From M05") && !t.includes("From M01") && !t.includes("From M02"), detail: t.slice(0, 80).replace(/\n/g, " ") });
  }
  {
    const t = await callTool("search_patterns", { keywords: ["cache"], max_per_section: 200, max_sections: 3 });
    checks.push({ name: "FIX2c search_patterns custom limits respected", pass: t.length < 3500 && t.includes("truncated") , detail: `len=${t.length}` });
  }

  // FIX 3: get_source_code path tolerance
  {
    const t = await callTool("get_source_code", { file_path: "src/services/api/claude.ts", start_line: 1, end_line: 20 });
    checks.push({ name: "FIX3a accepts 'src/' prefix", pass: t.includes("services/api/claude.ts") && t.includes("(lines 1-20"), detail: t.slice(0, 80).replace(/\n/g, " ") });
  }
  {
    const t = await callTool("get_source_code", { file_path: "services/api/claude.ts", start_line: 1, end_line: 20 });
    checks.push({ name: "FIX3b accepts no-prefix form", pass: t.includes("services/api/claude.ts") && t.includes("(lines 1-20"), detail: t.slice(0, 80).replace(/\n/g, " ") });
  }
  {
    const t = await callTool("get_source_code", { file_path: "/services/api/claude.ts", start_line: 1, end_line: 20 });
    checks.push({ name: "FIX3c accepts leading slash", pass: t.includes("services/api/claude.ts") && t.includes("(lines 1-20"), detail: t.slice(0, 80).replace(/\n/g, " ") });
  }
  {
    const t = await callTool("get_source_code", { file_path: "src/", start_line: 1, end_line: 20 });
    checks.push({ name: "FIX3d directory listing accepts 'src/' prefix", pass: t.includes("Directory:") && t.toLowerCase().includes("entrypoints"), detail: t.slice(0, 80).replace(/\n/g, " ") });
  }
  // negative: path traversal still blocked
  {
    const t = await callTool("get_source_code", { file_path: "../../../etc/passwd" });
    checks.push({ name: "FIX3e path traversal still blocked", pass: /escapes|not found/i.test(t), detail: t.slice(0, 80).replace(/\n/g, " ") });
  }

  // Print
  console.log("\n=== Regression results for 3 fixes ===");
  let pass = 0, fail = 0;
  for (const c of checks) {
    console.log(`${c.pass ? "✓" : "✗"} ${c.name.padEnd(50)} | ${c.detail}`);
    if (c.pass) pass++; else fail++;
  }
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
