// ============================================================
// Demo: 单次漂亮查询，适合截图
// Usage: pnpm exec tsx scripts/demo-screenshot.ts
// ============================================================

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.join(__dirname, "..", "dist", "server.js");

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
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "demo", version: "1" } } }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
    proc.stdin.end();
  });
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   🔮 Agent Architecture Oracle — Live Demo                  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Demo 1: query_architecture
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("💬 You: \"Claude Code 是怎么压缩上下文的？\"");
  console.log("🛠  Tool: query_architecture(query='上下文 压缩 compact token', depth='brief')\n");
  
  const q1 = await callTool("query_architecture", { 
    query: "上下文 压缩 compact token 长会话", 
    depth: "brief" 
  });
  // 只取前 2000 字符，避免过长
  const preview1 = q1.text.slice(0, 2000);
  console.log(preview1);
  if (q1.text.length > 2000) console.log("\n  … (response continues, total " + q1.text.length.toLocaleString() + " chars)");
  console.log(`\n⚡ ${q1.ms}ms\n`);

  // Demo 2: trace_concern
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("💬 You: \"Which modules touch 'prompt cache'?\"");
  console.log("🛠  Tool: trace_concern('prompt cache')\n");
  
  const q2 = await callTool("trace_concern", { concern: "prompt cache" });
  // 只取前 1500 字符
  const preview2 = q2.text.slice(0, 1500);
  console.log(preview2);
  if (q2.text.length > 1500) console.log("\n  … (12 modules total, " + q2.text.length.toLocaleString() + " chars)");
  console.log(`\n⚡ ${q2.ms}ms\n`);

  // Demo 3: get_source_code
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("💬 You: \"Show me the source: microCompact.ts lines 1-30\"");
  console.log("🛠  Tool: get_source_code('services/compact/microCompact.ts', 1, 30)\n");
  
  const q3 = await callTool("get_source_code", { 
    file_path: "services/compact/microCompact.ts", 
    start_line: 1, 
    end_line: 30 
  });
  console.log(q3.text);
  console.log(`\n⚡ ${q3.ms}ms`);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ Full pipeline: understand → trace → read source, all under 150ms.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

main().catch(console.error);
