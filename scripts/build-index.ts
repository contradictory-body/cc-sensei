// ============================================================
// Build Index Script
// Parses MODULE_NOTES files and generates knowledge indexes
// ============================================================

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODULE_TAXONOMY } from "../src/taxonomy.js";
import type { ModuleEntry, ModuleRegistry, KeywordIndex, ConcernMap, SectionMeta, SectionType } from "../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MODULE_NOTES_DIR = path.join(PROJECT_ROOT, "claude-code-main", "MODULE_NOTES");
const KNOWLEDGE_DIR = path.join(PROJECT_ROOT, "knowledge");

/**
 * Classify a section heading into a SectionType.
 * Patterns are checked in priority order; more specific patterns first.
 */
function classifySection(heading: string): SectionType {
  const h = heading.toLowerCase();
  // responsibility
  if (/模块定位|系统职责|职责|定位|概述|overview/.test(h)) return "responsibility";
  // architecture / data flow / structure
  if (/架构|结构|数据流|流程|组件|核心抽象/.test(h)) return "architecture";
  // pattern (directly-reusable). Check BEFORE principle so "可迁移设计清单" goes here.
  if (/精髓|可迁移|可直接|可复用|直接抄|迁移到|工程设计.*精髓|清单/.test(h)) return "pattern";
  // principle
  if (/设计原则|原则|设计哲学|pattern|模式/.test(h)) return "principle";
  // decision (includes trade-offs, edge cases & error handling — they discuss design choices)
  if (/设计决策|关键决策|决策|设计选择|关键设计|权衡|trade-?off|选型|为什么不|why not|错误处理|边界/.test(h)) return "decision";
  // relation
  if (/关联|依赖|关系|与.*关系|相关模块|接口|交互|协作|附录/.test(h)) return "relation";
  return "other";
}

/**
 * Parse a MODULE_NOTES markdown file and extract sections.
 */
async function parseModuleFile(filePath: string): Promise<{ sections: SectionMeta[]; sourceFiles: string[]; keywords: string[] }> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split("\n");

  const sections: SectionMeta[] = [];
  const sourceFiles: string[] = [];
  const keywords: string[] = [];

  // Track heading positions
  const headingPositions: { heading: string; level: number; line: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Parse headings (## or ###)
    const headingMatch = line.match(/^(#{2,4})\s+(.+)/);
    if (headingMatch) {
      headingPositions.push({
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        line: i + 1, // 1-based
      });
    }

    // Extract source file references (src/... patterns)
    const srcMatches = line.match(/`(src\/[^`]+)`/g);
    if (srcMatches) {
      for (const m of srcMatches) {
        const filePath = m.replace(/`/g, "");
        if (!sourceFiles.includes(filePath)) {
          sourceFiles.push(filePath);
        }
      }
    }

    // Extract inline code identifiers as keywords
    const codeMatches = line.match(/`([A-Z][a-zA-Z]+(?:[A-Z][a-z]+)*)`/g);
    if (codeMatches) {
      for (const m of codeMatches) {
        const identifier = m.replace(/`/g, "");
        if (identifier.length >= 3 && identifier.length <= 40 && !identifier.includes("/")) {
          if (!keywords.includes(identifier)) {
            keywords.push(identifier);
          }
        }
      }
    }
  }

  // Build sections with start/end lines.
  // A section's endLine extends until the NEXT heading at the SAME OR LOWER level
  // (i.e. level <= current.level). This way a level-2 section encompasses all of its
  // level-3+ sub-headings, instead of stopping at the first child heading.
  for (let i = 0; i < headingPositions.length; i++) {
    const current = headingPositions[i];
    let endLine = lines.length;
    for (let j = i + 1; j < headingPositions.length; j++) {
      if (headingPositions[j].level <= current.level) {
        endLine = headingPositions[j].line - 1;
        break;
      }
    }
    sections.push({
      heading: current.heading,
      level: current.level,
      startLine: current.line,
      endLine,
      type: classifySection(current.heading),
    });
  }

  return { sections, sourceFiles, keywords };
}

/**
 * Main build function.
 */
async function buildIndex() {
  console.log("[build-index] Starting index generation...");
  console.log(`[build-index] MODULE_NOTES dir: ${MODULE_NOTES_DIR}`);
  console.log(`[build-index] Output dir: ${KNOWLEDGE_DIR}`);

  // Ensure knowledge dir exists
  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });

  const modules: ModuleEntry[] = [];
  const keywordIndex: KeywordIndex = {};
  const concernMap: ConcernMap = {};

  for (const entry of MODULE_TAXONOMY) {
    const filePath = path.join(MODULE_NOTES_DIR, entry.sourceFile);

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      console.warn(`[build-index] WARNING: File not found: ${entry.sourceFile}, skipping`);
      continue;
    }

    // Parse the file
    const { sections, sourceFiles, keywords: extractedKeywords } = await parseModuleFile(filePath);

    // Merge taxonomy keywords with extracted keywords
    const allKeywords = [...new Set([...entry.keywords, ...extractedKeywords])];

    const moduleEntry: ModuleEntry = {
      id: entry.id,
      title: entry.title,
      sourceFile: entry.sourceFile,
      category: entry.id.startsWith("SUPP") ? "supplement" : "core",
      concerns: entry.concerns,
      sourceFiles,
      keywords: allKeywords,
      sections,
    };

    modules.push(moduleEntry);

    // Build keyword index
    for (const kw of allKeywords) {
      const normalized = kw.toLowerCase();
      if (!keywordIndex[normalized]) {
        keywordIndex[normalized] = [];
      }
      if (!keywordIndex[normalized].includes(entry.id)) {
        keywordIndex[normalized].push(entry.id);
      }
    }

    // Build concern map
    for (const concern of entry.concerns) {
      if (!concernMap[concern]) {
        concernMap[concern] = [];
      }
      if (!concernMap[concern].includes(entry.id)) {
        concernMap[concern].push(entry.id);
      }
    }

    console.log(`[build-index] ✓ ${entry.id}: ${entry.title} (${sections.length} sections, ${sourceFiles.length} src refs, ${allKeywords.length} keywords)`);
  }

  // Build registry
  const registry: ModuleRegistry = {
    version: "2.0.0",
    lastUpdated: new Date().toISOString(),
    modules,
  };

  // Write outputs
  await fs.writeFile(
    path.join(KNOWLEDGE_DIR, "module-registry.json"),
    JSON.stringify(registry, null, 2),
    "utf-8"
  );
  await fs.writeFile(
    path.join(KNOWLEDGE_DIR, "keyword-index.json"),
    JSON.stringify(keywordIndex, null, 2),
    "utf-8"
  );
  await fs.writeFile(
    path.join(KNOWLEDGE_DIR, "concern-map.json"),
    JSON.stringify(concernMap, null, 2),
    "utf-8"
  );

  console.log(`\n[build-index] Done! Generated:`);
  console.log(`  - module-registry.json (${modules.length} modules)`);
  console.log(`  - keyword-index.json (${Object.keys(keywordIndex).length} keywords)`);
  console.log(`  - concern-map.json (${Object.keys(concernMap).length} concerns)`);
}

buildIndex().catch((err) => {
  console.error("[build-index] Fatal error:", err);
  process.exit(1);
});
