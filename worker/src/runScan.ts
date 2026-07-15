import { existsSync, statSync } from 'node:fs';
import { buildContext, runScan as runEngine } from 'veilguard-scanner';
import type { ScanProgress } from 'veilguard-scanner';
import { config } from '../../shared/src/config.js';
import {
  getScan,
  claimScanForRun,
  setStatus,
  updateProgress,
  writeFinding,
  finishedFields,
} from '../../shared/src/firestore.js';
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

  try {
    assertTargetUsable(doc.target);

    const ctx = await withTimeout(buildContext(doc.target), config.scanTimeoutMs);

    // A URL target that never responded is an error, not an empty pass.
    if (doc.target.type === 'url' && ctx.http && !ctx.http.reachable) {
      throw new Error(`target URL unreachable: ${doc.target.value}`);
    }

    const report = await withTimeout(
      runEngine(ctx, {
        skipEngines: true,
        onFinding: (finding) => writeFinding(scanId, finding),
        onProgress: (progress: ScanProgress) => updateProgress(scanId, progress),
      }),
      config.scanTimeoutMs,
    );

    await setStatus(scanId, 'done', {
      grade: report.grade,
      score: report.score,
      counts: report.counts,
      ...finishedFields(),
    });
    console.log(`[worker] runScan: ${scanId} done — grade ${report.grade}, ${report.counts.critical} critical`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(scanId, 'error', { error: message, ...finishedFields() });
    console.error(`[worker] runScan: ${scanId} error — ${message}`);
  }
}
