// ============================================================
// Source Code Access Layer
// Reads files from local claude-code-main/src/
// ============================================================

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceReadResult } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve project root regardless of whether we run from src/ or dist/.
 * Both `src/source-reader.ts` and `dist/server.js` are one level below project root.
 */
function getProjectRoot(): string {
  // If running from dist/, __dirname = <project>/dist
  // If running from src/ via tsx, __dirname = <project>/src
  return path.resolve(__dirname, "..");
}

/** Resolve the source code root directory */
function getSourceRoot(): string {
  if (process.env.CC_SOURCE_ROOT) {
    return path.resolve(process.env.CC_SOURCE_ROOT);
  }
  return path.join(getProjectRoot(), "claude-code-main", "src");
}

/** Resolve the MODULE_NOTES root directory */
export function getModuleNotesRoot(): string {
  if (process.env.MODULE_NOTES_ROOT) {
    return path.resolve(process.env.MODULE_NOTES_ROOT);
  }
  return path.join(getProjectRoot(), "claude-code-main", "MODULE_NOTES");
}

/** Max lines returned per read */
const MAX_LINES_PER_READ = 500;

/**
 * Validate that a path doesn't escape the source root.
 * Prevents path traversal attacks.
 */
function validatePath(filePath: string, root: string): string {
  const resolved = path.resolve(root, filePath);
  if (!resolved.startsWith(root)) {
    throw new Error(`Path escapes source root: ${filePath}`);
  }
  return resolved;
}

/**
 * Normalize an input path to be relative to src/.
 * Tolerant to a leading 'src/' prefix that users may copy from MODULE_NOTES.
 */
function normalizeSrcRelativePath(filePath: string): string {
  let p = filePath.trim();
  // strip leading slashes
  while (p.startsWith("/")) p = p.slice(1);
  // strip a leading 'src/' since paths are already relative to src root
  if (p.startsWith("src/")) p = p.slice(4);
  return p;
}

/**
 * Read source code from claude-code-main/src/.
 * Supports line-range extraction.
 * Tolerant to inputs with or without 'src/' prefix.
 */
export async function readSourceCode(
  filePath: string,
  startLine?: number,
  endLine?: number
): Promise<SourceReadResult> {
  const root = getSourceRoot();
  const normalized = normalizeSrcRelativePath(filePath);
  const absolutePath = validatePath(normalized, root);

  // Check file exists
  try {
    await fs.access(absolutePath);
  } catch {
    throw new Error(`File not found: ${filePath} (resolved to src/${normalized})`);
  }

  const content = await fs.readFile(absolutePath, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  // Default range
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(totalLines, endLine ?? Math.min(totalLines, start + MAX_LINES_PER_READ - 1));

  // Cap at MAX_LINES_PER_READ
  const actualEnd = Math.min(end, start + MAX_LINES_PER_READ - 1);

  const selectedLines = lines.slice(start - 1, actualEnd);
  const numberedContent = selectedLines
    .map((line, i) => `${(start + i).toString().padStart(4)}│${line}`)
    .join("\n");

  return {
    filePath: normalized,
    content: numberedContent,
    startLine: start,
    endLine: actualEnd,
    totalLines,
  };
}

/**
 * Read a MODULE_NOTES file by relative path.
 */
export async function readModuleNotes(relativePath: string): Promise<string> {
  const root = getModuleNotesRoot();
  const absolutePath = validatePath(relativePath, root);

  try {
    await fs.access(absolutePath);
  } catch {
    throw new Error(`Module notes file not found: ${relativePath}`);
  }

  return fs.readFile(absolutePath, "utf-8");
}

/**
 * Read a specific line range from a MODULE_NOTES file.
 */
export async function readModuleNotesSection(
  relativePath: string,
  startLine: number,
  endLine: number
): Promise<string> {
  const content = await readModuleNotes(relativePath);
  const lines = content.split("\n");
  return lines.slice(startLine - 1, endLine).join("\n");
}

/**
 * List all .ts files in a source directory (non-recursive, for exploration).
 * Tolerant to a leading 'src/' prefix.
 */
export async function listSourceFiles(dirPath: string = ""): Promise<string[]> {
  const root = getSourceRoot();
  const normalized = normalizeSrcRelativePath(dirPath);
  const absolutePath = validatePath(normalized, root);

  try {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    return entries.map((e) => {
      const rel = path.relative(root, path.join(absolutePath, e.name));
      return e.isDirectory() ? rel + "/" : rel;
    });
  } catch {
    throw new Error(`Directory not found: ${dirPath}`);
  }
}
