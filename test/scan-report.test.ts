/**
 * PDF security report — POST /scanReport (per-scan) + /accountReport (summary).
 * Asserts: owner gets a real PDF (%PDF- magic), non-owner 403, unknown 404, no
 * token 401; and the report DATA honors entitlement — Guard includes every fix,
 * Free includes only the teaser finding's fix. Emulator; deterministic.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createDevServer } from '../functions/src/local-server.js';
import { getDb, getScan } from '../shared/src/firestore.js';
import { buildScanReport } from '../functions/src/scanReport.js';
import { authedClient } from './client.js';

let server: Server;
let baseUrl: string;
let n = 0;
const email = () => `rep-${Date.now()}-${++n}@test.dev`;

beforeAll(async () => {
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
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** Seed a done scan owned by uid with two findings (critical + low), both with a fix. */
async function seedScan(uid: string, scanId: string) {
  const db = getDb();
  await db.collection('scans').doc(scanId).set({
    id: scanId, ownerUid: uid, type: 'url', status: 'done', grade: 'C', score: 62,
    counts: { critical: 1, high: 0, medium: 0, low: 1, info: 0, passed: 4 },
    target: { type: 'url', value: 'https://report.example.com' }, createdAt: new Date().toISOString(),
  });
  const findings = db.collection('scans').doc(scanId).collection('findings');
  await findings.doc('f-crit').set({ title: 'Exposed API key', whyItMatters: 'Anyone can use your key.', severity: 'critical' });
  await findings.doc('f-crit').collection('private').doc('fix').set({ fix: 'Rotate the key and move it to env.', fixPrompt: 'Remove the hardcoded key…' });
  await findings.doc('f-low').set({ title: 'Missing header', whyItMatters: 'Minor hardening gap.', severity: 'low' });
  await findings.doc('f-low').collection('private').doc('fix').set({ fix: 'Add the header.', fixPrompt: 'Set the header…' });
}

async function postReport(scanId: string | undefined, token?: string) {
  return fetch(`${baseUrl}/scanReport`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ scanId }),
  });
}

describe('PDF scan report', () => {
  it('owner gets a real branded PDF; non-owner 403, unknown 404, no-token 401', async () => {
    const owner = await authedClient(email(), 'password123', 'guard');
    const other = await authedClient(email(), 'password123', 'guard');
    const scanId = `rep-${owner.uid}`;
    await seedScan(owner.uid, scanId);

    const ok = await postReport(scanId, owner.token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('application/pdf');
    const buf = Buffer.from(await ok.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    expect((await postReport(scanId, other.token)).status).toBe(403);   // not your scan
    expect((await postReport(`missing-${owner.uid}`, owner.token)).status).toBe(404);
    expect((await postReport(scanId)).status).toBe(401);                 // no token

    await owner.close(); await other.close();
  });

  it('the account summary PDF renders for the caller', async () => {
    const u = await authedClient(email(), 'password123', 'guard');
    await seedScan(u.uid, `acct-${u.uid}`);
    const res = await fetch(`${baseUrl}/accountReport`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString('ascii')).toBe('%PDF-');
    await u.close();
  });

  it('report data honors entitlement: Guard = all fixes, Free = teaser only', async () => {
    const guard = await authedClient(email(), 'password123', 'guard');
    const free = await authedClient(email(), 'password123', 'free');
    const gScan = `rep-g-${guard.uid}`; const fScan = `rep-f-${free.uid}`;
    await seedScan(guard.uid, gScan);
    await seedScan(free.uid, fScan);

    const gModel = await buildScanReport(guard.uid, gScan, (await getScan(gScan))!);
    expect(gModel.findings.every((f) => !!f.fix)).toBe(true); // Guard: every fix present
    expect(gModel.fixesLocked).toBe(false);

    const fModel = await buildScanReport(free.uid, fScan, (await getScan(fScan))!);
    expect(fModel.findings.filter((f) => !!f.fix).length).toBe(1); // Free: only the teaser
    expect(fModel.findings.find((f) => f.title === 'Exposed API key')?.fix).toBeTruthy(); // teaser = highest severity
    expect(fModel.fixesLocked).toBe(true);

    await guard.close(); await free.close();
  });
});
