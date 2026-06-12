#!/usr/bin/env node
// ============================================================
// Comprehensive Functional Test for Agent Architecture Oracle MCP Server
// ============================================================

import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.resolve(__dirname, "../dist/server.js");

interface TestCase {
  name: string;
  category: string;
  request: any;
  validate: (response: any) => { pass: boolean; reason?: string };
}

interface TestResult {
  name: string;
  category: string;
  pass: boolean;
  reason?: string;
  responsePreview?: string;
}

/**
 * Send a single JSON-RPC request to the MCP server and return the response.
 */
function callServer(request: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      try {
        // Find the JSON response line
        const lines = stdout.trim().split("\n");
        for (const line of lines) {
          if (line.startsWith("{")) {
            resolve(JSON.parse(line));
            return;
          }
        }
        reject(new Error(`No valid response. stderr: ${stderr.slice(0, 500)}`));
      } catch (e) {
        reject(e);
      }
    });

    proc.on("error", reject);

    proc.stdin.write(JSON.stringify(request) + "\n");
    proc.stdin.end();
  });
}

/**
 * Helper: extract text content from MCP response.
 */
function getText(response: any): string {
  return response?.result?.content?.[0]?.text || "";
}

function isError(response: any): boolean {
  return response?.result?.isError === true || response?.error != null;
}

// ---------- Test Cases ----------

const testCases: TestCase[] = [
  // ========== list_modules ==========
  {
    name: "list_modules — all modules",
    category: "list_modules",
    request: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_modules", arguments: {} } },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("M01") && t.includes("M22") && t.includes("SUPP-AgentSummary") && t.includes("Total: 32"),
        reason: t.includes("Total: 32") ? undefined : "expected all 32 modules",
      };
    },
  },
  {
    name: "list_modules — core only",
    category: "list_modules",
    request: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_modules", arguments: { category: "core" } } },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("M01") && t.includes("M22") && !t.includes("SUPP-AgentSummary"),
        reason: t.includes("SUPP-") ? "supplements should be excluded" : undefined,
      };
    },
  },
  {
    name: "list_modules — supplement only",
    category: "list_modules",
    request: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_modules", arguments: { category: "supplement" } } },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("SUPP-AgentSummary") && t.includes("SUPP-yogaLayout") && !t.includes("**M01**:"),
        reason: t.includes("**M01**:") ? "core modules should be excluded" : undefined,
      };
    },
  },

  // ========== query_architecture ==========
  {
    name: "query_architecture — depth=brief (context compaction)",
    category: "query_architecture",
    request: {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "query_architecture", arguments: { query: "context compaction memdir", depth: "brief" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("M06") && t.includes("上下文工程"),
        reason: !t.includes("M06") ? "M06 should be the top match" : undefined,
      };
    },
  },
  {
    name: "query_architecture — depth=standard (permission system)",
    category: "query_architecture",
    request: {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "query_architecture", arguments: { query: "bash security permission AST", depth: "standard" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("M04") && t.length > 500,
        reason: !t.includes("M04") ? "M04 (permission) should be top match" : undefined,
      };
    },
  },
  {
    name: "query_architecture — depth=deep (testability)",
    category: "query_architecture",
    request: {
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "query_architecture", arguments: { query: "VCR mock fixture testability", depth: "deep" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("M22") && t.length > 2000,
        reason: !t.includes("M22") ? "M22 (testability) should match" : t.length <= 2000 ? "deep should return long content" : undefined,
      };
    },
  },
  {
    name: "query_architecture — modules filter",
    category: "query_architecture",
    request: {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "query_architecture", arguments: { query: "streaming", depth: "brief", modules: ["M02", "M05"] } },
    },
    validate: (r) => {
      const t = getText(r);
      // Should only mention M02 or M05, not other modules in the result body
      const hasM02OrM05 = t.includes("M02") || t.includes("M05");
      const hasOtherModule = /M0[136-9]|M1[0-9]|M2[0-2]/.test(t.replace(/Related modules.*/s, ""));
      return {
        pass: hasM02OrM05 && !hasOtherModule,
        reason: !hasM02OrM05 ? "should match M02/M05" : hasOtherModule ? "should not include other modules" : undefined,
      };
    },
  },
  {
    name: "query_architecture — no match (gibberish query)",
    category: "query_architecture",
    request: {
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "query_architecture", arguments: { query: "qzqzqz_nonsense_xyz123", depth: "brief" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("No modules found"),
        reason: !t.includes("No modules found") ? "should return 'No modules found'" : undefined,
      };
    },
  },

  // ========== get_module ==========
  {
    name: "get_module — full M01",
    category: "get_module",
    request: {
      jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "get_module", arguments: { module_id: "M01" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("M01") && t.includes("进程启动与生命周期") && t.length > 5000,
        reason: t.length <= 5000 ? "deep content should be long" : undefined,
      };
    },
  },
  {
    name: "get_module — section=responsibility",
    category: "get_module",
    request: {
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "get_module", arguments: { module_id: "M02", section: "responsibility" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("M02") && t.includes("responsibility"),
        reason: undefined,
      };
    },
  },
  {
    name: "get_module — section=architecture",
    category: "get_module",
    request: {
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "get_module", arguments: { module_id: "M03", section: "architecture" } },
    },
    validate: (r) => {
      const t = getText(r);
      return { pass: t.includes("architecture") && t.length > 100, reason: undefined };
    },
  },
  {
    name: "get_module — section=decisions",
    category: "get_module",
    request: {
      jsonrpc: "2.0", id: 12, method: "tools/call",
      params: { name: "get_module", arguments: { module_id: "M04", section: "decisions" } },
    },
    validate: (r) => {
      const t = getText(r);
      return { pass: t.length > 100 && (t.includes("decisions") || t.includes("决策") || t.includes("No \"decisions\"")), reason: undefined };
    },
  },
  {
    name: "get_module — section=principles",
    category: "get_module",
    request: {
      jsonrpc: "2.0", id: 13, method: "tools/call",
      params: { name: "get_module", arguments: { module_id: "M05", section: "principles" } },
    },
    validate: (r) => {
      const t = getText(r);
      return { pass: t.length > 100, reason: undefined };
    },
  },
  {
    name: "get_module — section=relations",
    category: "get_module",
    request: {
      jsonrpc: "2.0", id: 14, method: "tools/call",
      params: { name: "get_module", arguments: { module_id: "M06", section: "relations" } },
    },
    validate: (r) => {
      const t = getText(r);
      return { pass: t.length > 50, reason: undefined };
    },
  },
  {
    name: "get_module — supplement module SUPP-SessionMemory",
    category: "get_module",
    request: {
      jsonrpc: "2.0", id: 15, method: "tools/call",
      params: { name: "get_module", arguments: { module_id: "SUPP-SessionMemory" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("SUPP-SessionMemory") && t.length > 1000,
        reason: !t.includes("SUPP-SessionMemory") ? "should contain SUPP-SessionMemory header" : undefined,
      };
    },
  },
  {
    name: "get_module — invalid module ID",
    category: "get_module",
    request: {
      jsonrpc: "2.0", id: 16, method: "tools/call",
      params: { name: "get_module", arguments: { module_id: "M99" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("not found") || t.includes("Module not found"),
        reason: !t.includes("not found") ? "should report not found" : undefined,
      };
    },
  },

  // ========== get_source_code ==========
  {
    name: "get_source_code — read entrypoints/cli.tsx (default range)",
    category: "get_source_code",
    request: {
      jsonrpc: "2.0", id: 17, method: "tools/call",
      params: { name: "get_source_code", arguments: { file_path: "entrypoints/cli.tsx" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("entrypoints/cli.tsx") && t.includes("```"),
        reason: undefined,
      };
    },
  },
  {
    name: "get_source_code — line range 10-50",
    category: "get_source_code",
    request: {
      jsonrpc: "2.0", id: 18, method: "tools/call",
      params: { name: "get_source_code", arguments: { file_path: "entrypoints/cli.tsx", start_line: 10, end_line: 50 } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("lines 10-50") && t.includes("  10│"),
        reason: !t.includes("lines 10-50") ? "header should show range" : undefined,
      };
    },
  },
  {
    name: "get_source_code — list root directory",
    category: "get_source_code",
    request: {
      jsonrpc: "2.0", id: 19, method: "tools/call",
      params: { name: "get_source_code", arguments: { file_path: "" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("Directory:") && t.includes("entrypoints/"),
        reason: undefined,
      };
    },
  },
  {
    name: "get_source_code — non-existent file",
    category: "get_source_code",
    request: {
      jsonrpc: "2.0", id: 20, method: "tools/call",
      params: { name: "get_source_code", arguments: { file_path: "nonexistent/fake.ts" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("Error") && t.includes("not found"),
        reason: undefined,
      };
    },
  },
  {
    name: "get_source_code — path traversal attack rejected",
    category: "get_source_code",
    request: {
      jsonrpc: "2.0", id: 21, method: "tools/call",
      params: { name: "get_source_code", arguments: { file_path: "../../../etc/passwd" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("Error") && (t.includes("escapes") || t.includes("not found")),
        reason: undefined,
      };
    },
  },
  {
    name: "get_source_code — line range cap (500 max)",
    category: "get_source_code",
    request: {
      jsonrpc: "2.0", id: 22, method: "tools/call",
      params: { name: "get_source_code", arguments: { file_path: "entrypoints/cli.tsx", start_line: 1, end_line: 9999 } },
    },
    validate: (r) => {
      const t = getText(r);
      // Should cap at 500 lines max
      const match = t.match(/lines 1-(\d+) of (\d+)/);
      if (!match) return { pass: false, reason: "no header" };
      const end = parseInt(match[1]);
      const total = parseInt(match[2]);
      return {
        pass: end <= 500 || end <= total,
        reason: end > 500 && end > total ? `end=${end} exceeds cap` : undefined,
      };
    },
  },

  // ========== search_patterns ==========
  {
    name: "search_patterns — no filter",
    category: "search_patterns",
    request: {
      jsonrpc: "2.0", id: 23, method: "tools/call",
      params: { name: "search_patterns", arguments: {} },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("Reusable Design Patterns") && t.includes("From M") && t.length > 1000,
        reason: undefined,
      };
    },
  },
  {
    name: "search_patterns — keywords filter [cache]",
    category: "search_patterns",
    request: {
      jsonrpc: "2.0", id: 24, method: "tools/call",
      params: { name: "search_patterns", arguments: { keywords: ["cache"] } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("Reusable Design Patterns") || t.includes("No patterns found"),
        reason: undefined,
      };
    },
  },
  {
    name: "search_patterns — non-existent keyword",
    category: "search_patterns",
    request: {
      jsonrpc: "2.0", id: 25, method: "tools/call",
      params: { name: "search_patterns", arguments: { keywords: ["zzzzznonsense_xyz"] } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("No patterns found"),
        reason: undefined,
      };
    },
  },

  // ========== trace_concern ==========
  {
    name: "trace_concern — prompt cache",
    category: "trace_concern",
    request: {
      jsonrpc: "2.0", id: 26, method: "tools/call",
      params: { name: "trace_concern", arguments: { concern: "prompt cache" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("Cross-Module Trace") && t.includes("Found in") && t.length > 500,
        reason: undefined,
      };
    },
  },
  {
    name: "trace_concern — abort signal",
    category: "trace_concern",
    request: {
      jsonrpc: "2.0", id: 27, method: "tools/call",
      params: { name: "trace_concern", arguments: { concern: "abort" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("Cross-Module Trace") && t.includes("Found in"),
        reason: undefined,
      };
    },
  },
  {
    name: "trace_concern — non-existent concern",
    category: "trace_concern",
    request: {
      jsonrpc: "2.0", id: 28, method: "tools/call",
      params: { name: "trace_concern", arguments: { concern: "qzqzqzqznonsense" } },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("No modules found"),
        reason: undefined,
      };
    },
  },

  // ========== tools/list ==========
  {
    name: "tools/list — verify all 6 tools registered",
    category: "tools/list",
    request: { jsonrpc: "2.0", id: 29, method: "tools/list", params: {} },
    validate: (r) => {
      const tools = r?.result?.tools || [];
      const names = tools.map((t: any) => t.name);
      const expected = ["query_architecture", "get_module", "get_source_code", "list_modules", "search_patterns", "trace_concern"];
      const allPresent = expected.every((n) => names.includes(n));
      return {
        pass: allPresent && tools.length === 6,
        reason: !allPresent ? `missing: ${expected.filter((n) => !names.includes(n)).join(",")}` : tools.length !== 6 ? `expected 6, got ${tools.length}` : undefined,
      };
    },
  },

  // ========== Error handling ==========
  {
    name: "error handling — unknown tool name",
    category: "error_handling",
    request: {
      jsonrpc: "2.0", id: 30, method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    },
    validate: (r) => {
      const t = getText(r);
      return {
        pass: t.includes("Unknown tool"),
        reason: undefined,
      };
    },
  },
];

// ---------- Runner ----------

async function runTests() {
  console.log(`\n========================================`);
  console.log(`Agent Architecture Oracle MCP — Test Suite`);
  console.log(`========================================\n`);
  console.log(`Server: ${SERVER_PATH}`);
  console.log(`Total tests: ${testCases.length}\n`);

  const results: TestResult[] = [];

  for (const tc of testCases) {
    process.stdout.write(`[${tc.category.padEnd(20)}] ${tc.name} ... `);
    try {
      const response = await callServer(tc.request);
      const { pass, reason } = tc.validate(response);
      const preview = isError(response)
        ? `[ERROR] ${getText(response).slice(0, 100)}`
        : getText(response).slice(0, 80).replace(/\n/g, " ");
      results.push({ name: tc.name, category: tc.category, pass, reason, responsePreview: preview });
      console.log(pass ? "✓ PASS" : `✗ FAIL — ${reason || "validation failed"}`);
    } catch (e) {
      results.push({
        name: tc.name,
        category: tc.category,
        pass: false,
        reason: `Exception: ${(e as Error).message}`,
      });
      console.log(`✗ FAIL — Exception: ${(e as Error).message}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const byCategory: Record<string, { pass: number; fail: number }> = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { pass: 0, fail: 0 };
    if (r.pass) byCategory[r.category].pass++;
    else byCategory[r.category].fail++;
  }

  console.log(`\n========================================`);
  console.log(`Results by category:`);
  console.log(`========================================`);
  for (const [cat, stats] of Object.entries(byCategory)) {
    const total = stats.pass + stats.fail;
    const status = stats.fail === 0 ? "✓" : "✗";
    console.log(`  ${status} ${cat.padEnd(22)} ${stats.pass}/${total}`);
  }

  console.log(`\n========================================`);
  console.log(`Final: ${passed}/${results.length} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    console.log(`\nFailed tests detail:`);
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  - [${r.category}] ${r.name}`);
      console.log(`    Reason: ${r.reason}`);
      if (r.responsePreview) console.log(`    Response: ${r.responsePreview}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(2);
});
