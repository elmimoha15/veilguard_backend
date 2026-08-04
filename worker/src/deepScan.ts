import { mkdirSync, cpSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildContext, runScan as runEngine, grade, findingId } from 'veilguard-scanner';
import type { Finding, Counts, Grade } from 'veilguard-scanner';
import { config } from '../../shared/src/config.js';
import { decryptJson, encryptJson } from '../../shared/src/crypto.js';
import { installationToken } from '../../shared/src/github-app.js';
import { refreshAccessToken, fetchSchemaSql, probeAnonReadableTables } from '../../shared/src/supabase-api.js';
import {
  getEncryptedSecret,
  writeFinding,
  updateProgress,
  updateEncryptedSecret,
  patchConnectionMeta,
} from '../../shared/src/firestore.js';
import type { ScanDoc, GitHubSecret, SupabaseSecret } from '../../shared/src/types.js';

/** Thrown when a Supabase token can't be refreshed — the user must reconnect. */
export class NeedsReconnectError extends Error {}

/** What buildDeepWorkspace surfaces beyond the workspace path (ephemeral). */
export interface DeepWorkspace {
  ws: string;
  /** Tables the anon role could read that it shouldn't (active RLS probe). */
  anonReadable: string[];
}

/** Deterministic ephemeral workspace path for a scan (so cleanup is verifiable). */
export function workspacePath(scanId: string): string {
  return join(tmpdir(), 'veilguard-ws', scanId);
}

/** Guaranteed cleanup — safe to call multiple times. */
export function removeWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort; force:true already ignores missing */
  }
}

// Directories the scanner NEVER reads (mirrors the engine's IGNORE list). The
// size cap exists to protect the SCAN, so it must measure only what gets scanned
// — counting .git history or committed node_modules/build output would reject
// repos whose actual source is small.
const SIZE_IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage',
  'venv', '.venv', '__pycache__', 'vendor', '.tox', '.mypy_cache', '.pytest_cache', '.gradle',
]);
// The engine only ever READS files under this size (see recon.ts readFile), so
// bigger files (videos, images, datasets, binaries) never affect the scan's
// memory — counting them toward the cap would reject repos with heavy assets but
// small source. Measure only what actually gets scanned.
const MAX_SCANNED_FILE_BYTES = 2_000_000;

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SIZE_IGNORE_DIRS.has(entry.name)) continue; // never scanned → don't count
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) {
      const sz = statSync(p).size;
      if (sz < MAX_SCANNED_FILE_BYTES) total += sz; // only count files the engine will actually read
    }
    if (total > config.deepScanMaxBytes) return total; // early-out
  }
  return total;
}

/**
 * Fetch the user's connected source(s) into a fresh ephemeral workspace. Source
 * is NEVER persisted anywhere — it lives only under this tmp dir, which the
 * caller deletes in a finally block. Throws (→ scan marked 'error') on bad
 * credential, missing repo, or size-cap breach.
 */
export async function buildDeepWorkspace(scanId: string, uid: string, doc: ScanDoc): Promise<DeepWorkspace> {
  const ws = workspacePath(scanId);
  removeWorkspace(ws); // in case of a retry
  mkdirSync(ws, { recursive: true });
  let anonReadable: string[] = [];

  if (doc.sources?.github) {
    const blob = await getEncryptedSecret(uid, 'github');
    if (!blob) throw new Error('github not connected');
    const secret = decryptJson<GitHubSecret>(blob);
    if (secret.mock) {
      if (!existsSync(secret.repoPath)) throw new Error('connected repo path no longer exists');
      // Simulate a shallow clone: copy the repo into the ephemeral workspace.
      cpSync(secret.repoPath, ws, { recursive: true });
    } else {
      // Real: mint a fresh, short-lived, repo-scoped installation token and do a
      // read-only shallow clone. The token is never stored. Clone the repo the
      // user chose for THIS scan (validated at create time); fall back to the
      // connection's default repo for older scans without an explicit choice.
      const repo = doc.sources.githubRepo ?? secret.repo;
      const token = await installationToken(secret.installationId);
      const url = `https://x-access-token:${token}@github.com/${repo}.git`;
      // A large shallow clone can take a while — use the deep-scan budget, not the URL one.
      await execa('git', ['clone', '--depth', '1', url, ws], { timeout: config.deepScanTimeoutMs });
      // The engine never reads git history — drop .git so it doesn't bloat the
      // workspace (disk + the size cap) or slow the scan.
      rmSync(join(ws, '.git'), { recursive: true, force: true });
    }
  }

  if (doc.sources?.supabase) {
    const blob = await getEncryptedSecret(uid, 'supabase');
    if (!blob) throw new Error('supabase not connected');
    const secret = decryptJson<SupabaseSecret>(blob);
    const dest = join(ws, 'supabase', 'migrations');
    mkdirSync(dest, { recursive: true });

    if (secret.mode === 'mock-path') {
      // Legacy direct-mock: copy the fixture's .sql into the workspace.
      if (!existsSync(secret.policiesPath)) throw new Error('connected policies path no longer exists');
      for (const f of readdirSync(secret.policiesPath)) {
        if (f.endsWith('.sql')) cpSync(join(secret.policiesPath, f), join(dest, f));
      }
      anonReadable = await probeAnonReadableTables('', '', concatSql(dest));
    } else {
      // OAuth: ensure a live access token (refresh if expired), then pull the
      // read-only schema + policies. On refresh failure, flag "needs reconnect"
      // and abort THIS scan cleanly (never crash the worker).
      const token = await ensureFreshSupabaseToken(uid, secret);

      if (secret.mock) {
        // Mock OAuth: the connection points at the local fixture.
        const src = secret.policiesPath;
        if (!src || !existsSync(src)) throw new Error('connected policies path no longer exists');
        for (const f of readdirSync(src)) {
          if (f.endsWith('.sql')) cpSync(join(src, f), join(dest, f));
        }
      } else {
        const sql = await fetchSchemaSql(token, secret.projectRef);
        writeFileSync(join(dest, 'schema.sql'), sql);
      }
      // Active, read-only anon-read probe over what we just pulled.
      anonReadable = await probeAnonReadableTables(token, secret.projectRef, concatSql(dest));
      // A successful fetch means the connection is healthy again.
      await patchConnectionMeta(uid, 'supabase', { needsReconnect: false });
    }
  }

  // Size cap so a giant repo can't hang / exhaust memory.
  if (dirSize(ws) > config.deepScanMaxBytes) {
    throw new Error(`workspace exceeds size cap (${config.deepScanMaxBytes} bytes)`);
  }
  return { ws, anonReadable };
}

/** Concatenate the .sql files just written to `dir` (for the anon-read probe). */
function concatSql(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

/**
 * Return a non-expired Supabase access token, refreshing server-side if needed.
 * Persists a refreshed token back to secrets/{uid}. If refresh fails, marks the
 * connection needsReconnect and throws NeedsReconnectError so the scan ends in a
 * clean 'error' state (the worker's catch handles it) — never an uncaught crash.
 */
async function ensureFreshSupabaseToken(
  uid: string,
  secret: Extract<SupabaseSecret, { mode: 'oauth' }>,
): Promise<string> {
  const expired = typeof secret.expiresAt === 'number' && Date.now() >= secret.expiresAt - 60_000;
  if (!expired) return secret.accessToken;
  if (!secret.refreshToken) {
    await patchConnectionMeta(uid, 'supabase', { needsReconnect: true });
    throw new NeedsReconnectError('Supabase access token expired and no refresh token — reconnect Supabase');
  }
  try {
    const next = await refreshAccessToken(secret.refreshToken);
    const updated: SupabaseSecret = { ...secret, accessToken: next.accessToken, refreshToken: next.refreshToken ?? secret.refreshToken, expiresAt: next.expiresAt };
    await updateEncryptedSecret(uid, 'supabase', encryptJson(updated));
    return next.accessToken;
  } catch {
    await patchConnectionMeta(uid, 'supabase', { needsReconnect: true });
    throw new NeedsReconnectError('Supabase token refresh failed — reconnect Supabase');
  }
}

/**
 * Run the engine's white-box rules over the workspace, plus the black-box rules
 * over an optional URL, streaming findings to Firestore and returning a unified
 * grade over the deduped union.
 */
/** Detected tech stack of a scanned repo — drives the "connect Supabase" / Firebase hints. */
export interface DetectedStack {
  supabase?: boolean;
  firebase?: boolean;
  firebaseRulesInRepo?: boolean;
}

/** Infer the stack from the cloned repo's deps + files (no engine change, no content-wide scan). */
function detectStack(repo: { files: string[]; packageManifest: { allDeps?: Record<string, string> } | null } | undefined): DetectedStack {
  if (!repo) return {};
  const deps = repo.packageManifest?.allDeps ?? {};
  const files = repo.files;
  const hasDep = (names: string[]) => names.some((n) => n in deps);

  const supabase =
    hasDep(['@supabase/supabase-js', 'supabase', '@supabase/ssr', '@supabase/auth-helpers-nextjs']) ||
    files.some((f) => /(^|\/)supabase\//i.test(f) || /supabase\/config\.toml$/i.test(f));
  const firebase =
    hasDep(['firebase', 'firebase-admin', '@angular/fire']) ||
    files.some((f) => /(^|\/)firebase\.json$/i.test(f) || /(^|\/)\.firebaserc$/i.test(f));
  const firebaseRulesInRepo = files.some((f) => /\.rules$/i.test(f));

  const stack: DetectedStack = {};
  if (supabase) stack.supabase = true;
  if (firebase) { stack.firebase = true; stack.firebaseRulesInRepo = firebaseRulesInRepo; }
  return stack;
}

export async function runDeepEngine(
  scanId: string,
  workspace: string,
  doc: ScanDoc,
  anonReadable: string[] = [],
): Promise<{ grade: Grade; score: number; counts: Counts; stack: DetectedStack }> {
  const all: Finding[] = [];
  const onFinding = (f: Finding) => {
    all.push(f);
    return writeFinding(scanId, f);
  };
  const onProgress = (p: { done: number; total: number; phase: string }) => updateProgress(scanId, p);

  // White-box over the connected source.
  const repoCtx = await buildContext({ type: 'repo', value: workspace });
  const stack = detectStack(repoCtx.repo);
  await runEngine(repoCtx, { skipEngines: true, onFinding, onProgress });

  // Active anon-read probe results (read-only) — a live confirmation that the
  // anon role can read tables it shouldn't. These come from the connector, not
  // the static analyzer, and are deduped alongside the rest.
  for (const table of anonReadable) {
    await onFinding(anonReadFinding(table));
  }

  // Optional black-box over a provided URL — one unified grade over the app.
  if (doc.sources?.url) {
    const urlCtx = await buildContext({ type: 'url', value: doc.sources.url });
    await runEngine(urlCtx, { skipEngines: true, onFinding, onProgress });
  }

  // Dedupe by stable finding id (a finding could surface from >1 source).
  const seen = new Set<string>();
  const uniq = all.filter((f) => {
    const k = findingId(f);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ...grade(uniq), stack };
}

/** A live "anon can read this table" finding from the active RLS probe. */
function anonReadFinding(table: string): Finding {
  return {
    ruleId: 'DATABASE_SUPABASE_RLS_OPEN_LIVE',
    category: 'database',
    severity: 'critical',
    cwe: 'CWE-1220',
    owasp: 'A01:2021',
    title: `Anyone can read your "${table}" table`,
    whyItMatters:
      'Using only the project’s public anon role, we read rows from this table — Row Level Security is not protecting it.',
    location: { url: `supabase:${table}` },
    fix: `Enable RLS on "${table}" and add owner-scoped policies so the anon role can’t read other users’ rows.`,
    fixPrompt: `Enable Row Level Security on the Supabase "${table}" table and add a policy so users can only read their own rows.`,
    confidence: 'high',
    mode: 'blackbox',
    source: 'native',
  };
}
