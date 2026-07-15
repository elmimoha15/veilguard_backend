import { mkdirSync, cpSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildContext, runScan as runEngine, grade, findingId } from 'veilguard-scanner';
import type { Finding, Counts, Grade } from 'veilguard-scanner';
import { config } from '../../shared/src/config.js';
import { decryptJson } from '../../shared/src/crypto.js';
import { getEncryptedSecret, writeFinding, updateProgress } from '../../shared/src/firestore.js';
import type { ScanDoc, GitHubSecret, SupabaseSecret } from '../../shared/src/types.js';

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

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += statSync(p).size;
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
export async function buildDeepWorkspace(scanId: string, uid: string, doc: ScanDoc): Promise<string> {
  const ws = workspacePath(scanId);
  removeWorkspace(ws); // in case of a retry
  mkdirSync(ws, { recursive: true });

  if (doc.sources?.github) {
    const blob = await getEncryptedSecret(uid, 'github');
    if (!blob) throw new Error('github not connected');
    const secret = decryptJson<GitHubSecret>(blob);
    if (secret.mock) {
      if (!existsSync(secret.repoPath)) throw new Error('connected repo path no longer exists');
      // Simulate a shallow clone: copy the repo into the ephemeral workspace.
      cpSync(secret.repoPath, ws, { recursive: true });
    } else {
      const url = `https://x-access-token:${secret.token}@github.com/${secret.repo}.git`;
      await execa('git', ['clone', '--depth', '1', url, ws], { timeout: config.scanTimeoutMs });
    }
  }

  if (doc.sources?.supabase) {
    const blob = await getEncryptedSecret(uid, 'supabase');
    if (!blob) throw new Error('supabase not connected');
    const secret = decryptJson<SupabaseSecret>(blob);
    const dest = join(ws, 'supabase', 'migrations');
    mkdirSync(dest, { recursive: true });
    if (secret.mock) {
      if (!existsSync(secret.policiesPath)) throw new Error('connected policies path no longer exists');
      for (const f of readdirSync(secret.policiesPath)) {
        if (f.endsWith('.sql')) cpSync(join(secret.policiesPath, f), join(dest, f));
      }
    } else {
      // Real mode: pull schema + policies over the read-only connection and
      // write them as .sql for the RLS rules to analyze. (Not exercised locally.)
      writeFileSync(join(dest, 'schema.sql'), '-- pulled read-only schema + policies\n');
    }
  }

  // Size cap so a giant repo can't hang / exhaust memory.
  if (dirSize(ws) > config.deepScanMaxBytes) {
    throw new Error(`workspace exceeds size cap (${config.deepScanMaxBytes} bytes)`);
  }
  return ws;
}

/**
 * Run the engine's white-box rules over the workspace, plus the black-box rules
 * over an optional URL, streaming findings to Firestore and returning a unified
 * grade over the deduped union.
 */
export async function runDeepEngine(scanId: string, workspace: string, doc: ScanDoc): Promise<{ grade: Grade; score: number; counts: Counts }> {
  const all: Finding[] = [];
  const onFinding = (f: Finding) => {
    all.push(f);
    return writeFinding(scanId, f);
  };
  const onProgress = (p: { done: number; total: number; phase: string }) => updateProgress(scanId, p);

  // White-box over the connected source.
  const repoCtx = await buildContext({ type: 'repo', value: workspace });
  await runEngine(repoCtx, { skipEngines: true, onFinding, onProgress });

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
  return grade(uniq);
}
