import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { doc, getDoc, collection, getDocs } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { getScan, listFindingDocs, getDb } from '../shared/src/firestore.js';
import { startStaticServer, waitForTerminal } from './harness.js';
import { authedClient, isPermissionDenied } from './client.js';

let server: Server;
let baseUrl: string;
let target: { url: string; close: () => Promise<void> };
let n = 0;
const email = () => `fp${Date.now()}-${++n}@test.dev`;
const scanUrl = () => `${target.url}/?i=${++n}`;

beforeAll(async () => {
  target = await startStaticServer();
  await new Promise<void>((done) => {
    const app = createDevServer();
    server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      done();
    });
  });
  await getScan('warmup');
});

afterAll(async () => {
  await target.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function ownedScan(token: string) {
  const res = await post('/createScan', { target: { type: 'url', value: scanUrl() } }, token);
  const scanId = res.body.scanId as string;
  await waitForTerminal(scanId);
  return scanId;
}

const CSP = 'WEB_CONFIG_MISSING_CONTENT_SECURITY_POLICY';

describe('Mark as false positive', () => {
  it('dismiss: owner only, hides it from the grade, files a report, follows the app to future scans, and can be undone', async () => {
    const a = await authedClient(email(), 'password123');
    const b = await authedClient(email(), 'password123');

    const scanId = await ownedScan(a.token);
    const before = await getScan(scanId);
    const docs = await listFindingDocs(scanId);
    expect(docs.every((d) => typeof (d.finding as any).fpKey === 'string')).toBe(true);
    const csp = docs.find((d) => d.finding.ruleId === CSP)!;
    expect(csp).toBeTruthy();

    // Auth + ownership + input validation.
    expect((await post('/findings/dismiss', { scanId, findingId: csp.id })).status).toBe(401);
    expect((await post('/findings/dismiss', { scanId, findingId: csp.id }, b.token)).status).toBe(403);
    expect((await post('/findings/dismiss', { scanId }, a.token)).status).toBe(400);
    expect((await post('/findings/dismiss', { scanId, findingId: 'nope' }, a.token)).status).toBe(404);

    // Owner dismisses with a reason → flagged, regraded server-side.
    const r = await post('/findings/dismiss', { scanId, findingId: csp.id, reason: 'CSP is set by our CDN' }, a.token);
    expect(r.status).toBe(200);
    const after = await getScan(scanId);
    expect(((await listFindingDocs(scanId)).find((d) => d.id === csp.id)!.finding as any).dismissed).toBe(true);
    expect(after!.score).toBe(Math.min(100, before!.score! + 6)); // medium/high = 6 points
    expect(after!.counts!.medium).toBe(before!.counts!.medium - 1);
    expect((after as any).dismissedCount).toBe(1);

    // Review queue entry (server-only) with the context needed for a corpus test.
    const reports = await getDb().collection('falsePositiveReports').where('scanId', '==', scanId).get();
    expect(reports.size).toBe(1);
    const rep = reports.docs[0]!.data();
    expect(rep).toMatchObject({ uid: a.uid, ruleId: CSP, reason: 'CSP is set by our CDN', findingId: csp.id, status: 'new' });

    // Rules: owner can read their dismissals; nobody can read reports; others can't read dismissals.
    const host = '127.0.0.1';
    const own = await getDoc(doc(a.db, 'appDismissals', `${a.uid}__host:${host}`));
    expect(Object.keys(own.data()!.keys)).toHaveLength(1);
    expect(await getDoc(doc(b.db, 'appDismissals', `${a.uid}__host:${host}`)).then(() => false, isPermissionDenied)).toBe(true);
    expect(await getDocs(collection(a.db, 'falsePositiveReports')).then(() => false, isPermissionDenied)).toBe(true);

    // A NEW scan of the same app: the finding is stored but flagged, and not graded.
    const scan2 = await ownedScan(a.token);
    const s2 = await getScan(scan2);
    const csp2 = (await listFindingDocs(scan2)).find((d) => d.finding.ruleId === CSP)!;
    expect((csp2.finding as any).dismissed).toBe(true);
    expect(s2!.score).toBe(after!.score);
    expect(s2!.counts!.medium).toBe(after!.counts!.medium);

    // Another user's scan of the same host is unaffected.
    const scanB = await ownedScan(b.token);
    expect(((await listFindingDocs(scanB)).find((d) => d.finding.ruleId === CSP)!.finding as any).dismissed).toBeUndefined();

    // Undo restores it, and later scans count it again.
    expect((await post('/findings/undismiss', { scanId, findingId: csp.id }, a.token)).status).toBe(200);
    expect((await getScan(scanId))!.score).toBe(before!.score);
    const scan3 = await ownedScan(a.token);
    expect(((await listFindingDocs(scan3)).find((d) => d.finding.ruleId === CSP)!.finding as any).dismissed).toBeUndefined();
    expect((await getScan(scan3))!.score).toBe(before!.score);

    await a.close();
    await b.close();
  });
});
