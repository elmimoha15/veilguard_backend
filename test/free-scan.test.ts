import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { doc, collection, getDoc, getDocs, onSnapshot } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import type { Queue } from '../shared/src/queue.js';
import { handleCreateScan } from '../functions/src/createScan.js';
import { resetRateLimit } from '../functions/src/rate-limit.js';
import { getScan, listFindings, readPrivateFix, createScanDoc } from '../shared/src/firestore.js';
import { startStaticServer, sleep, waitForTerminal, localQueue } from './harness.js';
import { clientDb, isPermissionDenied } from './client.js';
import { config } from '../shared/src/config.js';

let server: Server;
let baseUrl: string;
let target: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  target = await startStaticServer();
  await new Promise<void>((done) => {
    const app = createDevServer();
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      done();
    });
  });
  // Warm the Admin gRPC channel so the first createScan latency is representative.
  await getScan('warmup');
});

afterAll(async () => {
  await target.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function createViaHttp(value: string) {
  const res = await fetch(`${baseUrl}/createScan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { type: 'url', value } }),
  });
  return { status: res.status, body: (await res.json()) as { scanId?: string; error?: string } };
}

/**
 * Attach CLIENT SDK listeners (rules-enforced, like the browser) that capture
 * the streaming timeline, but detect completion via the reliable Admin poll —
 * so the assertions never hinge on a transient client-listener hiccup.
 */
async function watchClientUntilDone(scanId: string) {
  const { db, close } = clientDb();
  const statuses: string[] = [];
  const findingCounts: number[] = [];
  const progress: number[] = [];
  const unsubDoc = onSnapshot(
    doc(db, 'scans', scanId),
    (snap) => {
      const d = snap.data() as any;
      if (!d) return;
      statuses.push(d.status);
      if (d.progress) progress.push(d.progress.done);
    },
    () => {},
  );
  const unsubFind = onSnapshot(collection(db, 'scans', scanId, 'findings'), (snap) => findingCounts.push(snap.size), () => {});

  await waitForTerminal(scanId, 30_000);
  await sleep(300); // let final client snapshots flush
  unsubDoc();
  unsubFind();
  await close();
  return { statuses, findingCounts, progress };
}

describe('A — end-to-end via HTTP (mirrors the browser)', () => {
  it('createScan over HTTP → queued fast → streams to done', async () => {
    const t0 = Date.now();
    const res = await createViaHttp(target.url);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(202);
    expect(res.body.scanId).toBeTruthy();
    // Non-blocking: returns fast and does NOT run the scan inline.
    expect(elapsed).toBeLessThan(1200);

    const scanId = res.body.scanId!;
    // Right after createScan returns, the scan has not finished.
    const immediate = await getScan(scanId);
    expect(['queued', 'running']).toContain(immediate?.status);

    const seen = await watchClientUntilDone(scanId);
    expect(seen.statuses).toContain('running'); // client observed the live transition
    const final = await getScan(scanId);
    expect(final?.status).toBe('done');
    const findings = await listFindings(scanId);
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe('B — live streaming to a subscribing client', () => {
  it('client observes the live progression (not one terminal batch)', async () => {
    // Subscribe BEFORE the worker starts so the fast black-box scan's live
    // transitions are reliably observed by the client (as a browser would).
    const scanId = await createScanDoc({ type: 'url', value: target.url });
    const { db, close } = clientDb();
    const statuses: string[] = [];
    const progress: number[] = [];
    const sizes: number[] = [];
    const u1 = onSnapshot(doc(db, 'scans', scanId), (s) => { const d = s.data() as any; if (d) { statuses.push(d.status); if (d.progress) progress.push(d.progress.done); } }, () => {});
    const u2 = onSnapshot(collection(db, 'scans', scanId, 'findings'), (s) => sizes.push(s.size), () => {});
    await sleep(150);
    await localQueue().enqueue({ scanId });
    await waitForTerminal(scanId, 30_000);
    await sleep(300);
    u1(); u2(); await close();

    const finalSize = Math.max(...sizes, 0);
    const partial = sizes.some((n) => n > 0 && n < finalSize) || new Set(sizes.filter((n) => n > 0)).size >= 2;
    // Live, over-time delivery: multiple statuses OR multiple progress OR partial findings.
    expect(new Set(statuses).size >= 2 || new Set(progress).size >= 2 || partial).toBe(true);
    expect(statuses).toContain('done');
  });
});

describe('C — fix-locking at the data layer', () => {
  it('client can read public fields but NOT fix/fixPrompt; admin can', async () => {
    const res = await createViaHttp(target.url);
    await watchClientUntilDone(res.body.scanId!);
    const scanId = res.body.scanId!;
    const findings = await listFindings(scanId);
    const withFix = findings[0]!;
    const fid = (await getDocs(collection(clientDb().db, 'scans', scanId, 'findings'))).docs[0]!.id;

    const { db, close } = clientDb();
    try {
      // Public finding doc: readable, but no fix/fixPrompt fields.
      const pub = await getDoc(doc(db, 'scans', scanId, 'findings', fid));
      expect(pub.exists()).toBe(true);
      const data = pub.data() as any;
      expect(data.title).toBeTruthy();
      expect(data.whyItMatters).toBeTruthy();
      expect(data.severity).toBeTruthy();
      expect(data.fix).toBeUndefined();
      expect(data.fixPrompt).toBeUndefined();

      // Private fix doc: client read must be DENIED.
      let denied = false;
      try {
        await getDoc(doc(db, 'scans', scanId, 'findings', fid, 'private', 'fix'));
      } catch (e) {
        denied = isPermissionDenied(e);
      }
      expect(denied).toBe(true);
    } finally {
      await close();
    }

    // Admin CAN read the locked fix.
    const priv = await readPrivateFix(scanId, fid);
    expect(priv?.fix || priv?.fixPrompt).toBeTruthy();
    void withFix;
  });
});

describe('D — no enumeration', () => {
  it('cannot list the scans collection; CAN read a known scan + its findings', async () => {
    const res = await createViaHttp(target.url);
    await watchClientUntilDone(res.body.scanId!);
    const scanId = res.body.scanId!;
    const { db, close } = clientDb();
    try {
      // Listing all scans is denied.
      let listDenied = false;
      try {
        await getDocs(collection(db, 'scans'));
      } catch (e) {
        listDenied = isPermissionDenied(e);
      }
      expect(listDenied).toBe(true);

      // Reading a known scan id is allowed.
      const known = await getDoc(doc(db, 'scans', scanId));
      expect(known.exists()).toBe(true);

      // Listing a known scan's findings is allowed (needed for streaming).
      const findings = await getDocs(collection(db, 'scans', scanId, 'findings'));
      expect(findings.size).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

describe('E — abuse guards on the public endpoint', () => {
  const noopQueue: Queue = { enqueue: async () => {} };

  it('rejects repo, localhost, private-IP, and non-http targets', async () => {
    const guarded = (value: string, type: 'url' | 'repo' = 'url') =>
      handleCreateScan({ target: { type, value } }, noopQueue, { allowPrivateTargets: false });

    expect((await guarded('/some/repo', 'repo')).status).toBe(400);
    expect((await guarded('http://localhost:3000')).status).toBe(400);
    expect((await guarded('http://127.0.0.1:8080')).status).toBe(400);
    expect((await guarded('http://10.0.0.5')).status).toBe(400);
    expect((await guarded('http://192.168.1.10')).status).toBe(400);
    expect((await guarded('ftp://example.com')).status).toBe(400);
    // A public https URL passes the guard.
    resetRateLimit();
    expect((await guarded('https://example.com')).status).toBe(202);
  });

  it('rate limits rapid repeat calls', async () => {
    resetRateLimit();
    const call = () => handleCreateScan({ target: { type: 'url', value: 'https://rl-test.example.com' } }, noopQueue, { allowPrivateTargets: false, clientIp: '9.9.9.9' });
    const codes: number[] = [];
    for (let i = 0; i < config.rateLimitMax + 2; i++) codes.push((await call()).status);
    expect(codes.filter((c) => c === 202).length).toBe(config.rateLimitMax);
    expect(codes.at(-1)).toBe(429);
  });
});
