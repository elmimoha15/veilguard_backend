import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { config } from '../../shared/src/config.js';
import { makeStaging } from '../../shared/src/staging.js';
import type { ScanDoc } from '../../shared/src/types.js';
import { workspacePath, removeWorkspace } from './deepScan.js';

// Directories the scanner never reads (mirrors the engine's IGNORE list) — we
// don't even extract them, keeping the workspace small.
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage',
  'venv', '.venv', '__pycache__', 'vendor', '.tox', '.mypy_cache', '.pytest_cache', '.gradle',
]);
// The engine only reads files under this size, so larger entries are never
// scanned — skip them at extract time (also neutralizes single-giant-file zip bombs).
const MAX_SCANNED_FILE_BYTES = 2_000_000;

/** A zip entry name is unsafe if absolute or escapes the root via `..`. */
function isUnsafePath(name: string): boolean {
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[\\/]/).includes('..');
}

/** True if any path segment is an ignored (never-scanned) directory. */
function isIgnoredPath(name: string): boolean {
  return name.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg));
}

/**
 * Extract a .zip into `root` SAFELY. Guards, applied during parse so unsafe or
 * oversized entries are never even decompressed:
 *   - path traversal / absolute paths → skipped
 *   - ignored dirs (node_modules/.git/…) → skipped
 *   - per-file ≥ 2MB (engine won't read them) → skipped
 *   - entry-count capped at config.uploadMaxEntries
 *   - total uncompressed capped at config.deepScanMaxBytes
 * Returns what was written; `truncated` = a cap was hit and extraction stopped early.
 */
export function safeUnzip(zip: Buffer, root: string): { files: number; bytes: number; truncated: boolean } {
  const rootAbs = resolve(root);
  let included = 0;
  let total = 0;
  let truncated = false;

  const entries = unzipSync(zip, {
    filter: (f) => {
      if (f.name.endsWith('/')) return false; // directory marker — dirs created on write
      if (isUnsafePath(f.name) || isIgnoredPath(f.name)) return false;
      if (f.originalSize >= MAX_SCANNED_FILE_BYTES) return false; // never scanned anyway
      if (included >= config.uploadMaxEntries || total + f.originalSize > config.deepScanMaxBytes) {
        truncated = true;
        return false;
      }
      included++;
      total += f.originalSize;
      return true;
    },
  });

  let files = 0;
  let bytes = 0;
  for (const [name, data] of Object.entries(entries)) {
    const dest = resolve(rootAbs, name);
    // Final defense-in-depth: never write outside the workspace root.
    if (dest !== rootAbs && !dest.startsWith(rootAbs + sep)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    files++;
    bytes += data.length;
  }
  return { files, bytes, truncated };
}

/**
 * Stage-in an uploaded scan: fetch the staged .zip, extract it SAFELY into a
 * fresh ephemeral workspace, then DELETE the staged archive immediately (the
 * upload never outlives extraction). The workspace itself is wiped by the
 * worker's `finally` after the scan. Throws (→ scan 'error') on a missing or
 * empty/hostile archive.
 */
export async function buildUploadWorkspace(scanId: string, _doc: ScanDoc): Promise<{ ws: string }> {
  const ws = workspacePath(scanId);
  removeWorkspace(ws); // in case of a retry
  mkdirSync(ws, { recursive: true });

  const staging = makeStaging();
  let zip: Buffer;
  try {
    zip = await staging.get(scanId);
  } catch {
    throw new Error('uploaded archive not found');
  }

  try {
    const res = safeUnzip(zip, ws);
    if (res.files === 0) throw new Error('uploaded archive contained no scannable files');
  } finally {
    // Wipe the staged upload the instant it is extracted — success or failure.
    await staging.delete(scanId);
  }
  return { ws };
}
