// ============================================================
// End-to-end user scenario walkthrough
// Persona: developer implementing "context compaction" in their own agent
// ============================================================

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.join(__dirname, "..", "dist", "server.js");

interface JsonRpc {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", reject);
    proc.on("close", () => {
      const lines = out.split("\n").filter(Boolean);
      for (const ln of lines) {
        try {
          const obj = JSON.parse(ln);
          if (obj.id === 2 && obj.result?.content?.[0]?.text) {
            resolve(obj.result.content[0].text);
            return;
          }
          if (obj.id === 2 && obj.error) {
            reject(new Error(JSON.stringify(obj.error)));
            return;
          }
        } catch {}
      }
      reject(new Error("no response"));
    });
    const init: JsonRpc = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scenario", version: "1.0" } },
    };
    const call: JsonRpc = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } };
    proc.stdin.write(JSON.stringify(init) + "\n");
    proc.stdin.write(JSON.stringify(call) + "\n");
    proc.stdin.end();
  });
}

function head(t: string, n = 20): string {
  return t.split("\n").slice(0, n).join("\n");
}

async function step(no: number, title: string, fn: () => Promise<string>) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`STEP ${no}: ${title}`);
  console.log("=".repeat(70));
  const t0 = Date.now();
  try {
    const r = await fn();
    const dt = Date.now() - t0;
    console.log(`[ok ${dt}ms, ${r.length} chars]\n`);
    console.log(head(r, 25));
    if (r.split("\n").length > 25) console.log(`... (+${r.split("\n").length - 25} more lines)`);
    return r;
  } catch (e) {
    console.log(`[FAIL] ${(e as Error).message}`);
    return "";
  }
}

(async () => {
  console.log("USER GOAL: 实现 context compaction，参考 Claude Code 的做法");

  await step(1, "查看可用模块（list_modules core）",
    () => callTool("list_modules", { category: "core" }));

  await step(2, "用自然语言定位相关模块（query_architecture, depth=brief）",
    () => callTool("query_architecture", { query: "如何在长会话中压缩历史上下文以避免超出 token 上限", depth: "brief" }));

  await step(3, "深入查看 M06 上下文工程模块的 architecture 部分",
    () => callTool("get_module", { module_id: "M06", section: "architecture" }));

  await step(4, "查看 M06 的关键设计决策",
    () => callTool("get_module", { module_id: "M06", section: "decisions" }));

  await step(5, "追踪 'prompt cache' concern 涉及哪些模块",
    () => callTool("trace_concern", { concern: "prompt cache" }));

  await step(6, "搜索可复用的 pattern（关键词：cache）",
    () => callTool("search_patterns", { keywords: ["cache"] }));

  await step(7, "查看 M06 引用的源码文件 src/services/claude.ts 的前 80 行",
    () => callTool("get_source_code", { file_path: "src/services/claude.ts", start_line: 1, end_line: 80 }));

  await step(8, "深度查询：standard 深度看 token 管理整体方案",
    () => callTool("query_architecture", { query: "token 管理 与 上下文窗口 策略", depth: "standard" }));

  console.log(`\n${"=".repeat(70)}\nWalkthrough complete.\n${"=".repeat(70)}`);
})();
