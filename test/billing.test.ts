import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { createDevServer } from '../functions/src/local-server.js';
import { getPlan, readPrivateFix, getDb } from '../shared/src/firestore.js';
import { canUseMonitoring } from '../shared/src/monitor.js';
import { QUICKCART_PATH, runFullScan } from './harness.js';
import { authedClient } from './client.js';

let server: Server;
let baseUrl: string;
let m = 0;
const email = () => `b${Date.now()}-${++m}@test.dev`;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

beforeAll(async () => {
  await new Promise<void>((done) => {
    const app = createDevServer();
    server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      done();
    });
  });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => { delete process.env.FAKE_BILLING; });

describe('paid gate — free users are blocked (402), server-side', () => {
  it('deep scan, connect (both providers) and connect/begin all 402 for a free user', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token); // ensure user doc (plan defaults free)
    expect((await post('/createDeepScan', { github: true }, a.token)).status).toBe(402);
    expect((await post('/connectGitHub', { repoPath: QUICKCART_PATH }, a.token)).status).toBe(402);
    expect((await post('/connectSupabase', { policiesPath: 'x' }, a.token)).status).toBe(402);
    expect((await post('/connect/begin', { provider: 'github' }, a.token)).status).toBe(402);
    await a.close();
  });

  it('monitoring is off for free users, on for paid', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    expect(await canUseMonitoring(a.uid)).toBe(false);
    await getDb().collection('users').doc(a.uid).set({ plan: 'guard' }, { merge: true });
    expect(await canUseMonitoring(a.uid)).toBe(true);
    await a.close();
  });
});

describe('fake billing — /billing/confirm grants a plan (guarded by FAKE_BILLING)', () => {
  it('confirm is 403 unless FAKE_BILLING is set; then it sets the plan server-side', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);

    // Disabled by default → 403, plan unchanged.
    expect((await post('/billing/confirm', { plan: 'guard' }, a.token)).status).toBe(403);
    expect(await getPlan(a.uid)).toBe('free');

    // Enabled → checkout echoes fake mode, confirm upgrades.
    process.env.FAKE_BILLING = '1';
    const co = await post('/billing/checkout', { plan: 'guard' }, a.token);
    expect(co.status).toBe(200);
    expect(co.body.mode).toBe('fake');

    const up = await post('/billing/confirm', { plan: 'guard' }, a.token);
    expect(up.status).toBe(200);
    expect(up.body.plan).toBe('guard');
    expect(await getPlan(a.uid)).toBe('guard');

    // Now a paid user clears the deep-scan paid gate (fails later on missing connection, not 402).
    expect((await post('/createDeepScan', { github: true }, a.token)).status).toBe(409);

    // Downgrade back to free re-locks.
    expect((await post('/billing/confirm', { plan: 'free' }, a.token)).body.plan).toBe('free');
    expect((await post('/createDeepScan', { github: true }, a.token)).status).toBe(402);
    await a.close();
  });

  it('rejects an invalid plan', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    process.env.FAKE_BILLING = '1';
    expect((await post('/billing/confirm', { plan: 'ultra' }, a.token)).status).toBe(400);
    await a.close();
  });
});

describe('paid fix content — /findingFix', () => {
  it('402 for a free owner, returns the fix once paid', async () => {
    // An anonymous repo scan produces findings with private fixes.
    const { scanId } = await runFullScan({ type: 'repo', value: QUICKCART_PATH });
    const snap = await getDb().collection('scans').doc(scanId).collection('findings').get();
    let fid: string | null = null;
    for (const d of snap.docs) {
      if (await readPrivateFix(scanId, d.id)) { fid = d.id; break; }
    }
    expect(fid).toBeTruthy();

    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    expect((await post('/findingFix', { scanId, findingId: fid }, a.token)).status).toBe(402);

    await getDb().collection('users').doc(a.uid).set({ plan: 'fixpack' }, { merge: true });
    const r = await post('/findingFix', { scanId, findingId: fid }, a.token);
    expect(r.status).toBe(200);
    expect(typeof r.body.fix === 'string' || typeof r.body.fixPrompt === 'string').toBe(true);
    await a.close();
  });
});
