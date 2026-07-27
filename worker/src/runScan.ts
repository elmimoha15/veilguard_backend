import { existsSync, statSync } from 'node:fs';
import { buildContext, runScan as runEngine } from 'veilguard-scanner';
import type { ScanProgress, Grade, Counts } from 'veilguard-scanner';
import { buildDeepWorkspace, runDeepEngine, removeWorkspace, workspacePath } from './deepScan.js';
import { buildUploadWorkspace } from './uploadScan.js';
import { config } from '../../shared/src/config.js';
import {
  getScan,
  claimScanForRun,
  setStatus,
  updateProgress,
  writeFinding,
  finishedFields,
} from '../../shared/src/firestore.js';
import { recordMonitoringResult } from '../../shared/src/monitor.js';
import type { ScanJob } from '../../shared/src/types.js';

class ScanTimeoutError extends Error {
  constructor(ms: number) {
    super(`scan exceeded ${ms}ms timeout`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ScanTimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Reject early for targets we know are invalid, so they end "error" cleanly. */
function assertTargetUsable(target: { type: string; value: string }): void {
  if (target.type === 'repo') {
    if (!existsSync(target.value) || !statSync(target.value).isDirectory()) {
      throw new Error(`repo path not found: ${target.value}`);
    }
  }
}

/**
 * The worker's core: load the scan doc, claim it (idempotent), run the engine,
 * stream findings into Firestore as they arrive, then mark done — or error.
 */
export async function runScanJob(job: ScanJob): Promise<void> {
  const { scanId } = job;

  const doc = await getScan(scanId);
  if (!doc) {
    console.warn(`[worker] runScan: scan ${scanId} not found`);
    return;
  }

  const claim = await claimScanForRun(scanId);
  if (!claim.proceed) {
    console.log(`[worker] runScan: ${scanId} no-op (${claim.reason})`);
    return;
  }

  // Deep (white-box, connected) scans fetch source into an ephemeral workspace
  // that MUST be deleted no matter what — hence the finally block below.
  let workspace: string | null = null;
  let completed = false;

  try {
    let result: { grade: Grade; score: number; counts: Counts; stack?: { supabase?: boolean; firebase?: boolean; firebaseRulesInRepo?: boolean } };

    if (doc.type === 'deep') {
      if (!doc.ownerUid) throw new Error('deep scan requires an owner');
      // Record the workspace path BEFORE building it, so the finally block
      // always cleans up even if buildDeepWorkspace throws mid-fetch.
      workspace = workspacePath(scanId);
      const built = await withTimeout(buildDeepWorkspace(scanId, doc.ownerUid, doc), config.scanTimeoutMs);
      result = await withTimeout(runDeepEngine(scanId, workspace, doc, built.anonReadable), config.scanTimeoutMs);
    } else if (doc.type === 'upload') {
      if (!doc.ownerUid) throw new Error('upload scan requires an owner');
      // Same ephemeral-workspace contract as deep: set the path first so the
      // finally always wipes the extracted (uploaded) source, then white-box it.
      workspace = workspacePath(scanId);
      await withTimeout(buildUploadWorkspace(scanId, doc), config.scanTimeoutMs);
      result = await withTimeout(runDeepEngine(scanId, workspace, doc), config.scanTimeoutMs);
    } else {
      assertTargetUsable(doc.target);
      const ctx = await withTimeout(buildContext(doc.target), config.scanTimeoutMs);
      // A URL target that never responded is an error, not an empty pass.
      if (doc.target.type === 'url' && ctx.http && !ctx.http.reachable) {
        throw new Error(`target URL unreachable: ${doc.target.value}`);
      }
      result = await withTimeout(
        runEngine(ctx, {
          skipEngines: true,
          onFinding: (finding) => writeFinding(scanId, finding),
          onProgress: (progress: ScanProgress) => updateProgress(scanId, progress),
        }),
        config.scanTimeoutMs,
      );
    }

    await setStatus(scanId, 'done', {
      grade: result.grade,
      score: result.score,
      counts: result.counts,
      ...(result.stack ? { stack: result.stack } : {}),
      ...finishedFields(),
    });
    console.log(`[worker] runScan: ${scanId} done — grade ${result.grade}, ${result.counts.critical} critical`);
    completed = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(scanId, 'error', { error: message, ...finishedFields() });
    console.error(`[worker] runScan: ${scanId} error — ${message}`);
  } finally {
    // Guaranteed cleanup: the user's source never outlives the scan, even on
    // error/timeout. Source is never written to Firestore — only findings.
    if (workspace) removeWorkspace(workspace);
  }

  // Monitoring diff/alert runs AFTER cleanup — it reads findings from Firestore,
  // never the workspace, so it must not delay (or depend on) the source teardown.
  if (completed && doc.origin === 'monitor') {
    await recordMonitoringResult(scanId);
  }
}
