/**
 * Comp (owner/testing) allowlist: an email in COMP_GUARD_EMAILS gets free Guard
 * (plan stamped server-side, non-forgeable) + effectively-unlimited scans, while
 * everyone else stays on their real plan. Runs on the emulator.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createDevServer } from '../functions/src/local-server.js';
import { getDb } from '../shared/src/firestore.js';
import { effectiveScanLimit, canScan, scanLimit } from '../shared/src/usage.js';
import { authedClient } from './client.js';

const COMP_EMAIL = `comp-owner-${Date.now()}@test.dev`;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.COMP_GUARD_EMAILS = `${COMP_EMAIL}, someone-else@test.dev`;
  await new Promise<void>((done) => {
    const app = createDevServer();
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      done();
    });
  });
});

afterAll(async () => {
  delete process.env.COMP_GUARD_EMAILS;
  await new Promise<void>((r) => server.close(() => r()));
});

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function userDoc(uid: string) {
  return (await getDb().collection('users').doc(uid).get()).data() as { plan?: string; comp?: boolean } | undefined;
}

describe('effectiveScanLimit', () => {
  it('is the plan cap normally, and effectively-unlimited for comp', () => {
    expect(effectiveScanLimit('free', false)).toBe(scanLimit('free'));   // 2
    expect(effectiveScanLimit('guard', false)).toBe(scanLimit('guard')); // 30
    expect(effectiveScanLimit('guard', true)).toBe(1_000_000);
    expect(effectiveScanLimit('free', true)).toBe(1_000_000);            // comp overrides plan
  });
});

describe('comp allowlist via /me (ensureUser)', () => {
  it('stamps an allowlisted email with plan:guard + comp:true, and it shows in /me', async () => {
    const C = await authedClient(COMP_EMAIL, 'password123'); // no doc yet
    const me = await post('/me', {}, C.token);
    expect(me.status).toBe(200);
    expect(me.body.plan).toBe('guard');
    expect(me.body.comp).toBe(true);
    // caps in /me are effectively unlimited
    expect((me.body.caps as { maxScansPerMonth: number }).maxScansPerMonth).toBe(1_000_000);

    const d = await userDoc(C.uid);
    expect(d?.plan).toBe('guard');
    expect(d?.comp).toBe(true);

    // A comp user is never capped, even past the Guard pool.
    expect(await canScan(C.uid, 'guard', true)).toBe(true);
    await C.close();
  });

  it('a NON-allowlisted email stays Free with no comp flag, and is capped', async () => {
    const N = await authedClient(`regular-${Date.now()}@test.dev`, 'password123');
    const me = await post('/me', {}, N.token);
    expect(me.status).toBe(200);
    expect(me.body.plan).toBe('free');
    expect(me.body.comp).toBeUndefined();

    const d = await userDoc(N.uid);
    expect(d?.plan).toBe('free');
    expect(d?.comp).toBeUndefined();

    // Seed 2 done scans → at the Free cap → the next scan is blocked.
    const at = new Date().toISOString();
    for (const id of ['c1', 'c2']) {
      await getDb().collection('scans').doc(`${N.uid}-${id}`).set({
        id: `${N.uid}-${id}`, ownerUid: N.uid, type: 'url', status: 'done',
        createdAt: at, target: { type: 'url', value: `https://${id}.example.com` },
      });
    }
    expect(await canScan(N.uid, 'free', false)).toBe(false);
    await N.close();
  });
});
