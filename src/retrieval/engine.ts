// ============================================================
// Retrieval Engine — Module-based knowledge retrieval
// ============================================================

import type {
  ModuleRegistry,
  KeywordIndex,
  ConcernMap,
  ModuleEntry,
  QueryResult,
  ModuleMatch,
  Depth,
} from "../types.js";
import { readModuleNotes, readModuleNotesSection } from "../source-reader.js";

export class RetrievalEngine {
  private registry: ModuleRegistry;
  private keywordIndex: KeywordIndex;
  private concernMap: ConcernMap;
  private moduleMap: Map<string, ModuleEntry>;

  constructor(registry: ModuleRegistry, keywordIndex: KeywordIndex, concernMap: ConcernMap) {
    this.registry = registry;
    this.keywordIndex = keywordIndex;
    this.concernMap = concernMap;

    // Build module lookup map
    this.moduleMap = new Map();
    for (const mod of registry.modules) {
      this.moduleMap.set(mod.id, mod);
    }
  }

  /** Get a module entry by ID */
  getModule(id: string): ModuleEntry | undefined {
    return this.moduleMap.get(id);
  }

  /** Get all modules */
  getAllModules(): ModuleEntry[] {
    return this.registry.modules;
  }

  /** Get modules by category */
  getModulesByCategory(category: "core" | "supplement"): ModuleEntry[] {
    return this.registry.modules.filter((m) => m.category === category);
  }

  /**
   * Search for relevant modules given a query string.
   * Returns modules ranked by relevance.
   */
  searchModules(query: string, filterModuleIds?: string[]): ModuleEntry[] {
    const queryTokens = this.tokenize(query);
    const scores = new Map<string, number>();

    for (const token of queryTokens) {
      // Check keyword index
      const moduleIds = this.keywordIndex[token] || [];
      for (const id of moduleIds) {
        if (filterModuleIds && !filterModuleIds.includes(id)) continue;
        scores.set(id, (scores.get(id) || 0) + 2);
      }

      // Check concern map
      const concernModules = this.concernMap[token] || [];
      for (const id of concernModules) {
        if (filterModuleIds && !filterModuleIds.includes(id)) continue;
        scores.set(id, (scores.get(id) || 0) + 3);
      }

      // Partial matching against all keywords
      for (const [keyword, ids] of Object.entries(this.keywordIndex)) {
        if (keyword.includes(token) || token.includes(keyword)) {
          for (const id of ids) {
            if (filterModuleIds && !filterModuleIds.includes(id)) continue;
            scores.set(id, (scores.get(id) || 0) + 1);
          }
        }
      }
    }

    // Sort by score descending
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => this.moduleMap.get(id)!)
      .filter(Boolean);

    return ranked;
  }

  /**
   * Query architecture at a given depth.
   */
  async query(queryStr: string, depth: Depth, filterModuleIds?: string[]): Promise<QueryResult> {
    const modules = this.searchModules(queryStr, filterModuleIds);

    if (modules.length === 0) {
      return { modules: [], relatedModules: [] };
    }

    // Limit results based on depth
    const limit = depth === "brief" ? 5 : depth === "standard" ? 3 : 2;
    const topModules = modules.slice(0, limit);

    const matches: ModuleMatch[] = [];
    const relatedModuleIds = new Set<string>();

    for (const mod of topModules) {
      const content = await this.getModuleContent(mod, depth);
      matches.push({
        moduleId: mod.id,
        title: mod.title,
        relevance: 1, // Normalized later if needed
        content,
      });

      // Collect related modules from "relation" sections
      const relationSections = mod.sections.filter((s) => s.type === "relation");
      if (relationSections.length > 0) {
        // Find other module IDs mentioned
        for (const otherMod of this.registry.modules) {
          if (otherMod.id !== mod.id && !topModules.includes(otherMod)) {
            relatedModuleIds.add(otherMod.id);
          }
        }
      }
    }

    // Only keep top 5 related
    const relatedModules = [...relatedModuleIds].slice(0, 5);

    return { modules: matches, relatedModules };
  }

  /**
   * Get module content at the specified depth.
   */
  async getModuleContent(mod: ModuleEntry, depth: Depth): Promise<string> {
    switch (depth) {
      case "brief":
        return this.getModuleBrief(mod);
      case "standard":
        return this.getModuleStandard(mod);
      case "deep":
        return this.getModuleDeep(mod);
      default:
        return this.getModuleBrief(mod);
    }
  }

  /**
   * Brief: Module title + responsibility section (first section)
   */
  private async getModuleBrief(mod: ModuleEntry): Promise<string> {
    const responsibilitySections = mod.sections.filter(
      (s) => s.type === "responsibility" || s.level === 2
    );
    if (responsibilitySections.length > 0) {
      const section = responsibilitySections[0];
      const content = await readModuleNotesSection(mod.sourceFile, section.startLine, section.endLine);
      return `# ${mod.id}: ${mod.title}\n\n${content}`;
    }
    // Fallback: first 30 lines
    const content = await readModuleNotesSection(mod.sourceFile, 1, 30);
    return `# ${mod.id}: ${mod.title}\n\n${content}`;
  }

  /**
   * Standard: Architecture + decision titles + principles list
   */
  private async getModuleStandard(mod: ModuleEntry): Promise<string> {
    const parts: string[] = [`# ${mod.id}: ${mod.title}\n`];

    // Get architecture sections
    const archSections = mod.sections.filter(
      (s) => s.type === "architecture" || s.type === "responsibility"
    );
    for (const section of archSections.slice(0, 2)) {
      const content = await readModuleNotesSection(mod.sourceFile, section.startLine, section.endLine);
      parts.push(content);
    }

    // Get decision sections (just headings/titles)
    const decisionSections = mod.sections.filter((s) => s.type === "decision");
    if (decisionSections.length > 0) {
      parts.push("\n## Key Design Decisions\n");
      for (const section of decisionSections) {
        const content = await readModuleNotesSection(
          mod.sourceFile,
          section.startLine,
          Math.min(section.endLine, section.startLine + 50)
        );
        parts.push(content);
      }
    }

    // Get principle sections
    const principleSections = mod.sections.filter((s) => s.type === "principle" || s.type === "pattern");
    if (principleSections.length > 0) {
      for (const section of principleSections.slice(0, 1)) {
        const content = await readModuleNotesSection(mod.sourceFile, section.startLine, section.endLine);
        parts.push(content);
      }
    }

    return parts.join("\n");
  }

  /**
   * Deep: Full module content
   */
  private async getModuleDeep(mod: ModuleEntry): Promise<string> {
    const content = await readModuleNotes(mod.sourceFile);
    return `# ${mod.id}: ${mod.title}\n\n${content}`;
  }

  /**
   * Get a specific section type from a module.
   */
  async getModuleSection(
    moduleId: string,
    sectionType: "responsibility" | "architecture" | "decisions" | "principles" | "relations"
  ): Promise<string | null> {
    const mod = this.moduleMap.get(moduleId);
    if (!mod) return null;

    const typeMap: Record<string, string[]> = {
      responsibility: ["responsibility"],
      architecture: ["architecture"],
      decisions: ["decision"],
      principles: ["principle", "pattern"],
      relations: ["relation"],
    };

    const targetTypes = typeMap[sectionType] || [];
    const sections = mod.sections.filter((s) => targetTypes.includes(s.type));

    if (sections.length === 0) return null;

    const parts: string[] = [];
    for (const section of sections) {
      const content = await readModuleNotesSection(mod.sourceFile, section.startLine, section.endLine);
      parts.push(content);
    }

    return parts.join("\n\n");
  }

  /**
   * Search for reusable patterns across all modules.
   * @param keywords  Optional keyword filter
   * @param moduleId  Optional restrict to a single module
   * @param maxPerSection Optional per-section character cap (default 800)
   * @param maxSections   Optional total section cap (default 12)
   */
  async searchPatterns(
    keywords?: string[],
    moduleId?: string,
    maxPerSection: number = 800,
    maxSections: number = 12
  ): Promise<{ moduleId: string; content: string; truncated: boolean }[]> {
    const results: { moduleId: string; content: string; truncated: boolean }[] = [];

    for (const mod of this.registry.modules) {
      if (moduleId && mod.id !== moduleId) continue;

      const patternSections = mod.sections.filter(
        (s) => s.type === "principle" || s.type === "pattern"
      );

      if (patternSections.length === 0) continue;

      // If keywords specified, check if module matches
      if (keywords && keywords.length > 0) {
        const modKeywords = mod.keywords.map((k) => k.toLowerCase());
        const hasMatch = keywords.some(
          (kw) => modKeywords.some((mk) => mk.includes(kw.toLowerCase()) || kw.toLowerCase().includes(mk))
        );
        if (!hasMatch) continue;
      }

      for (const section of patternSections) {
        if (results.length >= maxSections) break;
        const raw = await readModuleNotesSection(mod.sourceFile, section.startLine, section.endLine);
        const truncated = raw.length > maxPerSection;
        const body = truncated ? raw.slice(0, maxPerSection) + "\n\n… [truncated; call get_module(" + mod.id + ", section=\"principles\") for full content]" : raw;
        results.push({
          moduleId: mod.id,
          content: `[${mod.id}: ${mod.title}]\n${body}`,
          truncated,
        });
      }
      if (results.length >= maxSections) break;
    }

    return results;
  }

  /**
   * Trace a concern across all modules.
   *
   * Strategy: scan every module's MODULE_NOTES body for line-level matches.
   * We deliberately do NOT pre-filter by keywords/concerns/title because those fields
   * may not lexically include the concern token even when the body discusses it
   * extensively (e.g. M06 discusses 'prompt cache' in its body but doesn't list it
   * as a keyword).
   */
  async traceConcern(concern: string): Promise<{ moduleId: string; title: string; excerpt: string }[]> {
    const tokens = this.tokenize(concern);
    if (tokens.length === 0) return [];

    const results: { moduleId: string; title: string; excerpt: string; hits: number }[] = [];

    for (const mod of this.registry.modules) {
      try {
        const content = await readModuleNotes(mod.sourceFile);
        const lines = content.split("\n");

        const matchingLines: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          const lineLower = lines[i].toLowerCase();
          if (tokens.every((t) => lineLower.includes(t)) || tokens.some((t) => lineLower.includes(t) && t.length >= 4)) {
            matchingLines.push(i);
          }
        }

        if (matchingLines.length === 0) continue;

        // Build excerpt with context around first few matches
        const excerptLines: string[] = [];
        const seen = new Set<number>();
        for (const lineIdx of matchingLines.slice(0, 5)) {
          const start = Math.max(0, lineIdx - 1);
          const end = Math.min(lines.length, lineIdx + 3);
          for (let i = start; i < end; i++) {
            if (!seen.has(i)) {
              seen.add(i);
              excerptLines.push(lines[i]);
            }
          }
          excerptLines.push("...");
        }

        results.push({
          moduleId: mod.id,
          title: mod.title,
          excerpt: excerptLines.join("\n").slice(0, 2000),
          hits: matchingLines.length,
        });
      } catch {
        // Skip files that can't be read
      }
    }

    // Sort by hit count desc so most-relevant modules surface first
    results.sort((a, b) => b.hits - a.hits);

    return results.map(({ moduleId, title, excerpt }) => ({ moduleId, title, excerpt }));
  }

  /**
   * Tokenize a query string into searchable tokens.
   */
  private tokenize(query: string): string[] {
    return query
      .toLowerCase()
      .replace(/[_\-\/\.]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .map((t) => t.trim());
  }
}
