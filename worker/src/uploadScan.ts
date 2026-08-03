import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import ignore from 'ignore';
import { config } from '../../shared/src/config.js';
import { makeStaging } from '../../shared/src/staging.js';
import type { ScanDoc } from '../../shared/src/types.js';
import { workspacePath, removeWorkspace } from './deepScan.js';

// Directories the scanner never reads (mirrors the engine's IGNORE list) — we
// don't even extract them, keeping the workspace small.
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage',
  'venv', '.venv', '__pycache__', 'vendor', '.tox', '.mypy_cache', '.pytest_cache', '.gradle',
  // Test/fixture artifacts — not deployed, so scanning them is false-positive noise.
  'test-fixtures', 'fixtures', '__tests__', '__mocks__', '.storybook', 'cypress', 'e2e',
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
 * Load the root-most `.gitignore` from the archive (if any) so we can skip the
 * exact files git would — an uploaded folder has no git context, so without this
 * it includes gitignored secrets/.env/local dirs that the deployed repo never
 * would. Returns the matcher + the directory it's anchored at.
 */
function loadGitignore(zip: Buffer): { dir: string; ig: ReturnType<typeof ignore> } | null {
  let entries: Record<string, Uint8Array> = {};
  try {
    entries = unzipSync(zip, { filter: (f) => /(^|\/)\.gitignore$/.test(f.name) && f.originalSize < 200_000 });
  } catch {
    return null;
  }
  const names = Object.keys(entries);
  if (!names.length) return null;
  names.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length); // root-most first
  const name = names[0]!;
  const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
  try {
    return { dir, ig: ignore().add(Buffer.from(entries[name]!).toString('utf8')) };
  } catch {
    return null;
  }
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

  // Skip exactly what the folder's .gitignore would — so an upload matches the
  // pushed repo (no gitignored secrets/.env/local dirs leaking into the scan).
  const gi = loadGitignore(zip);
  const gitignored = (name: string): boolean => {
    if (!gi || !name.startsWith(gi.dir)) return false;
    const rel = name.slice(gi.dir.length);
    if (!rel) return false;
    try {
      return gi.ig.ignores(rel);
    } catch {
      return false;
    }
  };

  const entries = unzipSync(zip, {
    filter: (f) => {
      if (f.name.endsWith('/')) return false; // directory marker — dirs created on write
      if (isUnsafePath(f.name) || isIgnoredPath(f.name)) return false;
      if (gitignored(f.name)) return false; // matches the repo's .gitignore
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
