/**
 * Per-app deletion — POST /app/delete must permanently wipe EVERYTHING tied to
 * ONE app (its scans + findings + private/fix, monitoring run + events, and its
 * registry entry) while LEAVING account-level data (other apps, provider
 * connections/secrets, the plan) intact. Ownership is enforced. Runs on the emulator.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createDevServer } from '../functions/src/local-server.js';
import { getDb, getScan } from '../shared/src/firestore.js';
import { authedClient } from './client.js';

let server: Server;
let baseUrl: string;
let n = 0;
const email = () => `delapp-${Date.now()}-${++n}@test.dev`;

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

const post = async (path: string, body: unknown, token?: string) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

/** Seed a scan (+ a finding + its private fix) for uid. */
async function seedScan(uid: string, id: string, doc: Record<string, unknown>) {
  const db = getDb();
  const ref = db.collection('scans').doc(id);
  await ref.set({ id, ownerUid: uid, status: 'done', createdAt: new Date().toISOString(), ...doc });
  await ref.collection('findings').doc('f1').set({ id: 'f1', severity: 'high' });
  await ref.collection('findings').doc('f1').collection('private').doc('fix').set({ fix: 'secret' });
  return ref;
}

describe('per-app deletion', () => {
  it('purges one app entirely and leaves the account + other apps + connections intact', async () => {
    const c = await authedClient(email(), 'password123', 'guard');
    const uid = c.uid;
    const db = getDb();

    // The user has TWO registry apps (both repos) + a connection.
    await post('/me', {}, c.token);
    await db.collection('users').doc(uid).set({
      apps: [
        { id: 'app-keep', name: 'other/keeper', githubRepo: 'other/keeper', createdAt: new Date().toISOString() },
        { id: 'app-del', name: 'acme/target', githubRepo: 'acme/target', createdAt: new Date().toISOString() },
      ],
      connections: { github: { repo: 'x/y' } },
    }, { merge: true });
    await db.collection('secrets').doc(uid).set({ github: 'enc-blob' });

    // Scans: two for the doomed app (a user-initiated deep scan with NO appId +
    // a monitor scan tagged with appId), one for the app we keep.
    await seedScan(uid, `del-user-${uid}`, { type: 'deep', sources: { githubRepo: 'acme/target' } });
    await seedScan(uid, `del-mon-${uid}`, { type: 'deep', origin: 'monitor', appId: 'app-del', sources: { githubRepo: 'acme/target' } });
    await seedScan(uid, `keep-${uid}`, { type: 'deep', sources: { githubRepo: 'other/keeper' } });
    // Monitoring run + events for the doomed app + one for the kept app.
    await db.collection('monitorRuns').doc(`${uid}__app-del`).set({ uid, appId: 'app-del' });
    await db.collection('monitorRuns').doc(`${uid}__app-keep`).set({ uid, appId: 'app-keep' });
    await db.collection('monitorEvents').doc(`ev-del-${uid}`).set({ uid, appId: 'app-del' });
    await db.collection('monitorEvents').doc(`ev-keep-${uid}`).set({ uid, appId: 'app-keep' });

    // Delete the target app.
    const res = await post('/app/delete', { appId: 'app-del', githubRepo: 'acme/target' }, c.token);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.scans).toBe(2);
    expect(res.body.registryRemoved).toBe(true);

    // Doomed app: every scan (both) + findings + private fix gone.
    for (const id of [`del-user-${uid}`, `del-mon-${uid}`]) {
      const ref = db.collection('scans').doc(id);
      expect((await ref.get()).exists).toBe(false);
      expect((await ref.collection('findings').doc('f1').get()).exists).toBe(false);
      expect((await ref.collection('findings').doc('f1').collection('private').doc('fix').get()).exists).toBe(false);
    }
    // Its monitoring run + events gone.
    expect((await db.collection('monitorRuns').doc(`${uid}__app-del`).get()).exists).toBe(false);
    expect((await db.collection('monitorEvents').where('uid', '==', uid).where('appId', '==', 'app-del').get()).empty).toBe(true);
    // Registry now has only the kept app.
    const user = (await db.collection('users').doc(uid).get()).data() as { apps?: { id?: string }[] };
    expect(user.apps?.map((a) => a.id)).toEqual(['app-keep']);

    // Untouched: the KEPT app's scan + monitoring, the connection/secret, the plan.
    expect((await db.collection('scans').doc(`keep-${uid}`).get()).exists).toBe(true);
    expect((await db.collection('monitorRuns').doc(`${uid}__app-keep`).get()).exists).toBe(true);
    expect((await db.collection('monitorEvents').doc(`ev-keep-${uid}`).get()).exists).toBe(true);
    expect((await db.collection('secrets').doc(uid).get()).exists).toBe(true);
    const kept = (await db.collection('users').doc(uid).get()).data() as { connections?: unknown; plan?: string };
    expect(kept.connections).toBeTruthy();
    expect(kept.plan).toBe('guard');

    await c.close();
  });

  it('deletes a derived URL app by host (no appId, no registry entry)', async () => {
    const c = await authedClient(email(), 'password123', 'free');
    const uid = c.uid;
    const db = getDb();
    await post('/me', {}, c.token);
    await seedScan(uid, `url-${uid}`, { type: 'url', target: { type: 'url', value: 'https://acme.example.com/login' } });

    const res = await post('/app/delete', { url: 'https://acme.example.com' }, c.token);
    expect(res.status).toBe(200);
    expect(res.body.scans).toBe(1);
    expect((await db.collection('scans').doc(`url-${uid}`).get()).exists).toBe(false);
    await c.close();
  });

  it('a user cannot delete another user’s app (only their own scans match)', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    const b = await authedClient(email(), 'password123', 'guard');
    const db = getDb();
    await post('/me', {}, a.token);
    await post('/me', {}, b.token);
    // Both users have a scan for the same repo name.
    await seedScan(a.uid, `a-${a.uid}`, { type: 'deep', sources: { githubRepo: 'shared/repo' } });
    await seedScan(b.uid, `b-${b.uid}`, { type: 'deep', sources: { githubRepo: 'shared/repo' } });

    // B deletes "shared/repo" → only B's scan is removed; A's is untouched.
    const res = await post('/app/delete', { githubRepo: 'shared/repo' }, b.token);
    expect(res.status).toBe(200);
    expect(res.body.scans).toBe(1);
    expect((await db.collection('scans').doc(`b-${b.uid}`).get()).exists).toBe(false);
    expect((await db.collection('scans').doc(`a-${a.uid}`).get()).exists).toBe(true);
    await a.close(); await b.close();
  });

  it('rejects an unauthenticated delete (401) and a bodyless delete (400)', async () => {
    expect((await post('/app/delete', { appId: 'x' })).status).toBe(401);
    const c = await authedClient(email(), 'password123', 'guard');
    expect((await post('/app/delete', {}, c.token)).status).toBe(400);
    await c.close();
  });
});
