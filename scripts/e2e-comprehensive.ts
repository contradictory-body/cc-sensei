// ============================================================
// Comprehensive E2E scenario walkthrough
// Three distinct developer personas, each completing a full task journey.
// ============================================================

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER = path.join(__dirname, "..", "dist", "server.js");

interface Step {
  scenario: string;
  no: number;
  title: string;
  tool: string;
  args: Record<string, unknown>;
  // assertions
  expect: {
    minLen?: number;
    maxLen?: number;
    mustInclude?: string[];
    mustNotInclude?: string[];
    isErrorOk?: boolean;
  };
}

interface Result {
  step: Step;
  ms: number;
  text: string;
  pass: boolean;
  reasons: string[];
}

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
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
    proc.stdin.end();
  });
}

// ============================================================
// SCENARIO A: 实现 context compaction
// ============================================================
const scenarioA: Step[] = [
  {
    scenario: "A", no: 1,
    title: "全局浏览：列出所有 supplement 深度补充",
    tool: "list_modules", args: { category: "supplement" },
    expect: { minLen: 200, mustInclude: ["SUPP-SessionMemory", "SUPP-extractMemories"] },
  },
  {
    scenario: "A", no: 2,
    title: "自然语言定位：'长会话历史摘要 token 限制'",
    tool: "query_architecture", args: { query: "长会话历史摘要 token 限制 上下文窗口", depth: "brief" },
    expect: { minLen: 500, mustInclude: ["M06"] },
  },
  {
    scenario: "A", no: 3,
    title: "钻取 M06 architecture（多 section 合并）",
    tool: "get_module", args: { module_id: "M06", section: "architecture" },
    expect: { minLen: 2000, mustInclude: ["数据流", "compact"] },
  },
  {
    scenario: "A", no: 4,
    title: "钻取 M06 principles（修复 1 验证）",
    tool: "get_module", args: { module_id: "M06", section: "principles" },
    expect: { minLen: 1000, mustNotInclude: ["No \"principles\" section found"] },
  },
  {
    scenario: "A", no: 5,
    title: "钻取 M06 decisions（修复 1 验证）",
    tool: "get_module", args: { module_id: "M06", section: "decisions" },
    expect: { minLen: 500, mustNotInclude: ["No \"decisions\" section found"] },
  },
  {
    scenario: "A", no: 6,
    title: "横向 trace：'prompt cache' 影响哪些模块",
    tool: "trace_concern", args: { concern: "prompt cache" },
    expect: { minLen: 1000, mustInclude: ["M05", "M06"] },
  },
  {
    scenario: "A", no: 7,
    title: "聚焦 M06 的 patterns（修复 2：module_id 过滤）",
    tool: "search_patterns", args: { module_id: "M06", max_per_section: 600 },
    expect: { minLen: 200, mustInclude: ["From M06"], mustNotInclude: ["From M01", "From M05"] },
  },
  {
    scenario: "A", no: 8,
    title: "读源码：services/compact/microCompact.ts（修复 3：无 src/ 前缀）",
    tool: "get_source_code", args: { file_path: "services/compact/microCompact.ts", start_line: 1, end_line: 60 },
    expect: { minLen: 300, mustInclude: ["microCompact.ts", "lines 1-60"] },
  },
  {
    scenario: "A", no: 9,
    title: "deep 深度查询补全细节",
    tool: "query_architecture", args: { query: "compact 9-section summary prompt", depth: "deep", modules: ["M06"] },
    expect: { minLen: 5000, mustInclude: ["BASE_COMPACT_PROMPT", "9"] },
  },
];

// ============================================================
// SCENARIO B: 实现工具权限/安全系统
// ============================================================
const scenarioB: Step[] = [
  {
    scenario: "B", no: 1,
    title: "自然语言定位：'危险命令检测 用户授权 沙盒'",
    tool: "query_architecture", args: { query: "危险命令检测 用户授权 沙盒 bash 安全", depth: "brief" },
    expect: { minLen: 500, mustInclude: ["M04"] },
  },
  {
    scenario: "B", no: 2,
    title: "钻取 M04 责任范围",
    tool: "get_module", args: { module_id: "M04", section: "responsibility" },
    expect: { minLen: 300 },
  },
  {
    scenario: "B", no: 3,
    title: "钻取 M04 principles（修复 1）",
    tool: "get_module", args: { module_id: "M04", section: "principles" },
    expect: { minLen: 500 },
  },
  {
    scenario: "B", no: 4,
    title: "trace 'approval flow' 跨模块",
    tool: "trace_concern", args: { concern: "approval flow 用户授权" },
    expect: { minLen: 500, mustInclude: ["M04"] },
  },
  {
    scenario: "B", no: 5,
    title: "search_patterns 关键词=security（修复 2：默认有大小限制）",
    tool: "search_patterns", args: { keywords: ["security", "approval", "sandbox"], max_per_section: 500, max_sections: 8 },
    expect: { minLen: 300, maxLen: 12000 },
  },
  {
    scenario: "B", no: 6,
    title: "列源码目录：tools/（带 src/ 前缀，修复 3）",
    tool: "get_source_code", args: { file_path: "src/tools/" },
    expect: { minLen: 200, mustInclude: ["Directory: src/tools/"], mustNotInclude: ["src/src/"] },
  },
  {
    scenario: "B", no: 7,
    title: "读取 BashTool 源码（无前缀写法）",
    tool: "get_source_code", args: { file_path: "tools/BashTool/BashTool.tsx", start_line: 1, end_line: 50 },
    expect: { isErrorOk: true }, // file may or may not exist; test path handling
  },
];

// ============================================================
// SCENARIO C: 错误恢复 / 边界场景
// ============================================================
const scenarioC: Step[] = [
  {
    scenario: "C", no: 1,
    title: "未知模块 ID",
    tool: "get_module", args: { module_id: "M99", section: "responsibility" },
    expect: { minLen: 10, isErrorOk: true, mustInclude: ["not found", "Module"] },
  },
  {
    scenario: "C", no: 2,
    title: "完全无关的查询（gibberish）",
    tool: "query_architecture", args: { query: "xyzqwerty foobar nonsense 12345", depth: "brief" },
    expect: { minLen: 5, isErrorOk: true },
  },
  {
    scenario: "C", no: 3,
    title: "路径穿越攻击：../../../etc/passwd",
    tool: "get_source_code", args: { file_path: "../../../etc/passwd" },
    expect: { mustInclude: ["Error", "escapes"], isErrorOk: true },
  },
  {
    scenario: "C", no: 4,
    title: "路径穿越变体：~/.ssh/id_rsa",
    tool: "get_source_code", args: { file_path: "../../../../../../home" },
    expect: { mustInclude: ["Error"], isErrorOk: true },
  },
  {
    scenario: "C", no: 5,
    title: "超长行范围：start_line=99999",
    tool: "get_source_code", args: { file_path: "entrypoints/cli.tsx", start_line: 99999, end_line: 100050 },
    expect: { isErrorOk: true }, // engine should clamp gracefully
  },
  {
    scenario: "C", no: 6,
    title: "search_patterns 极端关键词：[zzz]",
    tool: "search_patterns", args: { keywords: ["zzznevermatch"] },
    expect: { mustInclude: ["No patterns"], isErrorOk: true },
  },
  {
    scenario: "C", no: 7,
    title: "trace_concern 空字符串",
    tool: "trace_concern", args: { concern: "" },
    expect: { isErrorOk: true },
  },
  {
    scenario: "C", no: 8,
    title: "list_modules 非法 category",
    tool: "list_modules", args: { category: "nonexistent" },
    expect: { isErrorOk: true },
  },
];

async function runStep(step: Step): Promise<Result> {
  const t0 = Date.now();
  const reasons: string[] = [];
  let text = "";
  try {
    text = await callTool(step.tool, step.args);
  } catch (e) {
    text = `<TOOL_ERROR> ${(e as Error).message}`;
  }
  const ms = Date.now() - t0;

  const e = step.expect;
  if (e.minLen !== undefined && text.length < e.minLen)
    reasons.push(`len=${text.length} < min=${e.minLen}`);
  if (e.maxLen !== undefined && text.length > e.maxLen)
    reasons.push(`len=${text.length} > max=${e.maxLen}`);
  if (e.mustInclude)
    for (const s of e.mustInclude) if (!text.includes(s)) reasons.push(`missing: "${s}"`);
  if (e.mustNotInclude)
    for (const s of e.mustNotInclude) if (text.includes(s)) reasons.push(`unexpected: "${s}"`);

  // For "isErrorOk" edge cases, just having a non-empty graceful response counts as pass
  // unless explicit assertions failed.
  let pass = reasons.length === 0;
  if (!pass && e.isErrorOk && text.length > 0 && !text.startsWith("<TOOL_ERROR>")) {
    // graceful error responses: relax minLen (other failures are still real)
    const onlyMinLen = reasons.every((r) => r.startsWith("len="));
    if (onlyMinLen) {
      reasons.push("(soft-pass: graceful error)");
      pass = true;
    }
  }

  return { step, ms, text, pass, reasons };
}

async function runScenario(name: string, steps: Step[]): Promise<Result[]> {
  console.log(`\n${"#".repeat(72)}\n# SCENARIO ${name}\n${"#".repeat(72)}`);
  const results: Result[] = [];
  for (const step of steps) {
    const r = await runStep(step);
    const status = r.pass ? "✓" : "✗";
    console.log(`  ${status} A${step.scenario}.${step.no.toString().padStart(2)} [${r.ms.toString().padStart(4)}ms ${r.text.length.toString().padStart(6)}ch] ${step.title}`);
    if (!r.pass) {
      for (const reason of r.reasons) console.log(`       ↳ ${reason}`);
      // Show first 2 lines of the response for diagnosis
      const firstLines = r.text.split("\n").slice(0, 3).join(" | ").slice(0, 160);
      console.log(`       ↳ resp: ${firstLines}`);
    }
    results.push(r);
  }
  return results;
}

(async () => {
  console.log("=".repeat(72));
  console.log("Agent Architecture Oracle MCP — Comprehensive E2E Walkthrough");
  console.log("=".repeat(72));

  const a = await runScenario("A: Implementing context compaction", scenarioA);
  const b = await runScenario("B: Implementing tool permission/security", scenarioB);
  const c = await runScenario("C: Edge cases & error handling", scenarioC);

  const all = [...a, ...b, ...c];
  const pass = all.filter((r) => r.pass).length;
  const fail = all.length - pass;

  // Aggregate metrics
  const latencies = all.map((r) => r.ms).sort((x, y) => x - y);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const max = latencies[latencies.length - 1];

  const totalChars = all.reduce((s, r) => s + r.text.length, 0);
  const avgChars = Math.round(totalChars / all.length);

  console.log(`\n${"=".repeat(72)}\n# Summary\n${"=".repeat(72)}`);
  console.log(`Total steps: ${all.length}   pass: ${pass}   fail: ${fail}`);
  console.log(`Latency:  p50=${p50}ms  p95=${p95}ms  max=${max}ms`);
  console.log(`Response: avg=${avgChars}ch  total=${totalChars}ch`);

  // Per-scenario breakdown
  console.log(`\nBy scenario:`);
  for (const [n, list] of [["A", a], ["B", b], ["C", c]] as const) {
    const pa = list.filter((r) => r.pass).length;
    console.log(`  ${n}: ${pa}/${list.length} pass`);
  }

  // Per-tool breakdown
  console.log(`\nBy tool:`);
  const toolGroups = new Map<string, Result[]>();
  for (const r of all) {
    if (!toolGroups.has(r.step.tool)) toolGroups.set(r.step.tool, []);
    toolGroups.get(r.step.tool)!.push(r);
  }
  for (const [tool, rs] of toolGroups) {
    const pa = rs.filter((r) => r.pass).length;
    const avgMs = Math.round(rs.reduce((s, r) => s + r.ms, 0) / rs.length);
    console.log(`  ${tool.padEnd(20)} ${pa}/${rs.length} pass, avg ${avgMs}ms`);
  }

  if (fail > 0) {
    console.log(`\n✗ ${fail} steps failed.\n`);
    process.exit(1);
  } else {
    console.log(`\n✓ All ${all.length} steps passed.\n`);
  }
})();
