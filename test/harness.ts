import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { makeQueue } from '../shared/src/queue.js';
import { getDb, getScan, listFindings, createScanDoc, type PublicFinding } from '../shared/src/firestore.js';
import { handleCreateScan, type CreateScanOptions } from '../functions/src/createScan.js';
import { runScanJob } from '../worker/src/runScan.js';
import { resetRateLimit } from '../functions/src/rate-limit.js';
import type { ScanDoc, Target } from '../shared/src/types.js';

export const QUICKCART_PATH = resolve(process.cwd(), '../veilguard-scanner/test-fixtures/vulnerable/quickcart');

/** InMemoryQueue wired to the in-process worker (the standard local topology). */
export function localQueue() {
  return makeQueue(runScanJob);
}

/**
 * Internal service path: create the scan doc + enqueue directly, bypassing the
 * public abuse guard. Represents the pipeline the worker runs (repo or url).
 * Slice-2 tests use this.
 */
export async function createScan(target: Target): Promise<{ status: number; body: { scanId: string } }> {
  const scanId = await createScanDoc(target);
  await localQueue().enqueue({ scanId });
  return { status: 202, body: { scanId } };
}

/** Public endpoint path (guarded + rate-limited), as the browser/API hits it. */
export async function createScanPublic(target: Target, opts: CreateScanOptions = {}) {
  resetRateLimit();
  return handleCreateScan({ target }, localQueue(), opts);
}

export async function waitForTerminal(scanId: string, timeoutMs = 60_000): Promise<ScanDoc> {
  const start = Date.now();
  for (;;) {
    const doc = await getScan(scanId);
    if (doc && (doc.status === 'done' || doc.status === 'error')) return doc;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`scan ${scanId} did not finish within ${timeoutMs}ms (status=${doc?.status})`);
    }
    await sleep(75);
  }
}

/** createScan → wait for terminal → return the doc + findings. */
export async function runFullScan(target: Target): Promise<{ scanId: string; doc: ScanDoc; findings: PublicFinding[] }> {
  const res = await createScan(target);
  if (res.status !== 202) throw new Error(`createScan failed: ${JSON.stringify(res)}`);
  const { scanId } = res.body as { scanId: string };
  const doc = await waitForTerminal(scanId);
  const findings = await listFindings(scanId);
  return { scanId, doc, findings };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A minimal local site with no security headers — used for the black-box path. */
export function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveP) => {
    const server: Server = createServer((_req, res) => {
      // Intentionally no CSP/HSTS/X-Frame-Options/etc.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>test</title></head><body>hi</body></html>');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveP({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((c) => server.close(() => c())),
      });
    });
  });
}

export { getDb, getScan, listFindings };
