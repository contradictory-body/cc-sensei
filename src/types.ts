// ============================================================
// Type definitions for Agent Architecture Oracle MCP Server
// ============================================================

/** Depth levels for knowledge retrieval */
export type Depth = "brief" | "standard" | "deep" | "source";

/** Module category */
export type ModuleCategory = "core" | "supplement";

/** Section type classification */
export type SectionType =
  | "responsibility"
  | "architecture"
  | "decision"
  | "principle"
  | "relation"
  | "pattern"
  | "other";

/** Metadata for a parsed section within a module file */
export interface SectionMeta {
  heading: string;
  level: number; // h2=2, h3=3, etc.
  startLine: number;
  endLine: number;
  type: SectionType;
}

/** A module entry in the registry */
export interface ModuleEntry {
  id: string; // "M01", "M02", ..., "SUPP-autoDream"
  title: string; // "进程引导与生命周期"
  sourceFile: string; // MODULE_NOTES relative path (e.g., "M01-bootstrap.md")
  category: ModuleCategory;
  concerns: string[]; // architectural concern tags
  sourceFiles: string[]; // Referenced src/ files
  keywords: string[]; // Search keywords
  sections: SectionMeta[]; // Parsed section headings with line offsets
}

/** The module registry (generated at build-time) */
export interface ModuleRegistry {
  version: string;
  lastUpdated: string;
  modules: ModuleEntry[];
}

/** Keyword inverted index */
export interface KeywordIndex {
  [keyword: string]: string[]; // keyword → module IDs
}

/** Concern map (concern tag → module IDs) */
export interface ConcernMap {
  [concern: string]: string[]; // concern → module IDs (many-to-many)
}

/** Query result from the retrieval engine */
export interface QueryResult {
  modules: ModuleMatch[];
  relatedModules: string[];
}

/** A single module match result */
export interface ModuleMatch {
  moduleId: string;
  title: string;
  relevance: number; // 0-1 score
  content: string; // Returned content (varies by depth)
}

/** Source code read result */
export interface SourceReadResult {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}
