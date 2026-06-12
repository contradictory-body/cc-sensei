// ============================================================
// Agent Architecture Oracle — MCP Server Entry Point
// ============================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RetrievalEngine } from "./retrieval/engine.js";
import type { ModuleRegistry, KeywordIndex, ConcernMap } from "./types.js";

// Tool imports
import { queryArchitectureToolDef, handleQueryArchitecture } from "./tools/queryArchitecture.js";
import { getModuleToolDef, handleGetModule } from "./tools/getModule.js";
import { getSourceCodeToolDef, handleGetSourceCode } from "./tools/getSourceCode.js";
import { listModulesToolDef, handleListModules } from "./tools/listModules.js";
import { searchPatternsToolDef, handleSearchPatterns } from "./tools/searchPatterns.js";
import { traceConcernToolDef, handleTraceConcern } from "./tools/traceConcern.js";

// Resolve paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const KNOWLEDGE_DIR = path.join(PROJECT_ROOT, "knowledge");

// ---- Load Knowledge Base ----
async function loadKnowledgeBase(): Promise<{
  registry: ModuleRegistry;
  keywordIndex: KeywordIndex;
  concernMap: ConcernMap;
}> {
  const registryPath = path.join(KNOWLEDGE_DIR, "module-registry.json");
  const keywordPath = path.join(KNOWLEDGE_DIR, "keyword-index.json");
  const concernPath = path.join(KNOWLEDGE_DIR, "concern-map.json");

  try {
    const [registryRaw, keywordRaw, concernRaw] = await Promise.all([
      fs.readFile(registryPath, "utf-8"),
      fs.readFile(keywordPath, "utf-8"),
      fs.readFile(concernPath, "utf-8"),
    ]);
    return {
      registry: JSON.parse(registryRaw) as ModuleRegistry,
      keywordIndex: JSON.parse(keywordRaw) as KeywordIndex,
      concernMap: JSON.parse(concernRaw) as ConcernMap,
    };
  } catch (err) {
    console.error(`[agent-architecture-oracle] Failed to load knowledge base from ${KNOWLEDGE_DIR}`);
    console.error(`  Run 'pnpm build:index' first to generate the index.`);
    console.error(`  Error: ${err}`);
    return {
      registry: { version: "0.0.0", lastUpdated: new Date().toISOString(), modules: [] },
      keywordIndex: {},
      concernMap: {},
    };
  }
}

// ---- Main ----
async function main() {
  console.error("[agent-architecture-oracle] Starting MCP server...");

  // Load knowledge
  const { registry, keywordIndex, concernMap } = await loadKnowledgeBase();
  const engine = new RetrievalEngine(registry, keywordIndex, concernMap);

  console.error(
    `[agent-architecture-oracle] Loaded ${registry.modules.length} modules, ${Object.keys(keywordIndex).length} keywords, ${Object.keys(concernMap).length} concerns`
  );

  // Create MCP Server
  const server = new Server(
    {
      name: "agent-architecture-oracle",
      version: "2.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      queryArchitectureToolDef,
      getModuleToolDef,
      getSourceCodeToolDef,
      listModulesToolDef,
      searchPatternsToolDef,
      traceConcernToolDef,
    ],
  }));

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case "query_architecture":
          result = await handleQueryArchitecture(engine, args as any);
          break;
        case "get_module":
          result = await handleGetModule(engine, args as any);
          break;
        case "get_source_code":
          result = await handleGetSourceCode(args as any);
          break;
        case "list_modules":
          result = handleListModules(engine, args as any);
          break;
        case "search_patterns":
          result = await handleSearchPatterns(engine, args as any);
          break;
        case "trace_concern":
          result = await handleTraceConcern(engine, args as any);
          break;
        default:
          result = `Unknown tool: ${name}. Use list_modules to see available tools.`;
      }

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${errMsg}` }],
        isError: true,
      };
    }
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[agent-architecture-oracle] Server connected via stdio");
}

main().catch((err) => {
  console.error("[agent-architecture-oracle] Fatal error:", err);
  process.exit(1);
});
