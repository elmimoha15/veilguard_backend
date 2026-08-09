/**
 * Account deletion — POST /account/delete must permanently wipe EVERY Firestore
 * store keyed to the user (scans + findings + private fix, monitor events + runs,
 * secrets, the user doc) AND delete the Firebase Auth login. Runs on the emulator.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { getAuth } from 'firebase-admin/auth';
import type { Polar } from '@polar-sh/sdk';
import { createDevServer } from '../functions/src/local-server.js';
import { getDb, getScan } from '../shared/src/firestore.js';
import { setPolarClient } from '../shared/src/polar.js';
import { authedClient } from './client.js';

let server: Server;
let baseUrl: string;
let n = 0;
const email = () => `del-${Date.now()}-${++n}@test.dev`;

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

const post = async (path: string, token?: string) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: '{}',
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

describe('account deletion', () => {
  it('purges all user-scoped Firestore data and deletes the Auth login', async () => {
    const c = await authedClient(email(), 'password123', 'guard');
    const uid = c.uid;
    const db = getDb();

    // Seed every user-scoped store.
    await post('/me', c.token); // creates users/{uid}
    await db.collection('users').doc(uid).set({ apps: [{ id: 'app1' }], connections: { github: { repo: 'x/y' } } }, { merge: true });
    await db.collection('secrets').doc(uid).set({ github: 'enc-blob' });
    const scan = db.collection('scans').doc(`s-${uid}`);
    await scan.set({ id: scan.id, ownerUid: uid, type: 'url', status: 'done', createdAt: new Date().toISOString() });
    await scan.collection('findings').doc('f1').set({ id: 'f1', severity: 'high' });
    await scan.collection('findings').doc('f1').collection('private').doc('fix').set({ fix: 'secret' });
    await db.collection('monitorRuns').doc(`${uid}__app1`).set({ uid, appId: 'app1' });
    await db.collection('monitorEvents').doc(`ev-${uid}`).set({ uid, appId: 'app1' });
    await db.collection('oauthStates').doc(`st-${uid}`).set({ uid, provider: 'github', createdAt: new Date().toISOString() });

    // Delete.
    const res = await post('/account/delete', c.token);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Every store is empty for this uid.
    expect((await db.collection('users').doc(uid).get()).exists).toBe(false);
    expect((await db.collection('secrets').doc(uid).get()).exists).toBe(false);
    expect((await scan.get()).exists).toBe(false);
    expect((await scan.collection('findings').doc('f1').get()).exists).toBe(false);
    expect((await scan.collection('findings').doc('f1').collection('private').doc('fix').get()).exists).toBe(false);
    expect((await db.collection('scans').where('ownerUid', '==', uid).get()).empty).toBe(true);
    expect((await db.collection('monitorRuns').where('uid', '==', uid).get()).empty).toBe(true);
    expect((await db.collection('monitorEvents').where('uid', '==', uid).get()).empty).toBe(true);
    expect((await db.collection('oauthStates').where('uid', '==', uid).get()).empty).toBe(true);

    // The Firebase Auth login is gone.
    await expect(getAuth().getUser(uid)).rejects.toThrow();

    await c.close();
  });

  it('rejects an unauthenticated delete', async () => {
    const res = await post('/account/delete');
    expect(res.status).toBe(401);
  });

  it('deletes the Polar customer by external id (= uid), and still purges even if Polar throws', async () => {
    process.env.POLAR_ACCESS_TOKEN = 'test-token';
    process.env.POLAR_WEBHOOK_SECRET = 'test-secret';
    const deletedExternal: string[] = [];
    let mode: 'ok' | 'notfound' | 'throw' = 'ok';
    // 404 shaped like the Polar SDK's ResourceNotFound (a free user with no customer).
    const notFound = Object.assign(new Error('not found'), { error: 'ResourceNotFound' });
    setPolarClient({
      customers: {
        deleteExternal: async ({ externalId }: { externalId: string }) => {
          if (mode === 'notfound') throw notFound;
          if (mode === 'throw') throw new Error('polar down');
          deletedExternal.push(externalId);
        },
      },
    } as unknown as Polar);
    try {
      // Happy path: customer deleted by external id (= uid) — no stored polarCustomerId needed.
      const a = await authedClient(email(), 'password123');
      await post('/me', a.token);
      expect((await post('/account/delete', a.token)).status).toBe(200);
      expect(deletedExternal).toContain(a.uid);
      await a.close();

      // No Polar customer (free user, 404) → clean no-op, delete still succeeds.
      mode = 'notfound';
      const f = await authedClient(email(), 'password123');
      await post('/me', f.token);
      expect((await post('/account/delete', f.token)).status).toBe(200);
      expect((await getDb().collection('users').doc(f.uid).get()).exists).toBe(false);
      await f.close();

      // Resilient: a real Polar failure must NOT block the local purge.
      mode = 'throw';
      const b = await authedClient(email(), 'password123');
      await post('/me', b.token);
      expect((await post('/account/delete', b.token)).status).toBe(200);
      expect((await getDb().collection('users').doc(b.uid).get()).exists).toBe(false); // still purged
      await getAuth().getUser(b.uid).then(() => { throw new Error('auth user should be gone'); }, () => {});
      await b.close();
    } finally {
      setPolarClient(null);
      delete process.env.POLAR_ACCESS_TOKEN; delete process.env.POLAR_WEBHOOK_SECRET;
    }
  });
});
