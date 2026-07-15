import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { doc, collection, query, where, orderBy, getDoc, getDocs } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { getScan, getUser, listFindings } from '../shared/src/firestore.js';
import { startStaticServer, waitForTerminal } from './harness.js';
import { authedClient, clientDb, isPermissionDenied } from './client.js';

let server: Server;
let baseUrl: string;
let target: { url: string; close: () => Promise<void> };
let n = 0;
const email = () => `u${Date.now()}-${++n}@test.dev`;
// Unique target per scan so the per-(ip,target) rate limit never collides
// across tests (the static server ignores the query string).
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
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

async function ownedScan(token: string) {
  const res = await post('/createScan', { target: { type: 'url', value: scanUrl() } }, token);
  const scanId = res.body.scanId as string;
  await waitForTerminal(scanId);
  return scanId;
}

describe('A — sign-up creates a user (idempotent)', () => {
  it('creates users/{uid} plan=free and does not duplicate on re-sign-in', async () => {
    const e = email();
    const a = await authedClient(e, 'password123');
    const me1 = await post('/me', {}, a.token);
    expect(me1.status).toBe(200);
    expect(me1.body.plan).toBe('free');
    expect(me1.body.uid).toBe(a.uid);

    const created1 = (await getUser(a.uid))!.createdAt;
    // Sign in again + call /me again — must not create a second/overwritten doc.
    const b = await authedClient(e, 'password123');
    await post('/me', {}, b.token);
    const created2 = (await getUser(a.uid))!.createdAt;
    expect(created2).toBe(created1);

    // The user can read their OWN user doc via the client SDK.
    const snap = await getDoc(doc(a.db, 'users', a.uid));
    expect(snap.exists() && (snap.data() as any).plan).toBe('free');
    await a.close(); await b.close();
  });
});

describe('B — authenticated scan is owned', () => {
  it('sets ownerUid, owner can read + list it', async () => {
    const a = await authedClient(email(), 'password123');
    const scanId = await ownedScan(a.token);
    expect((await getScan(scanId))?.ownerUid).toBe(a.uid);

    // Owner reads the scan + its findings via client SDK.
    const s = await getDoc(doc(a.db, 'scans', scanId));
    expect(s.exists()).toBe(true);
    const fs = await getDocs(collection(a.db, 'scans', scanId, 'findings'));
    expect(fs.size).toBeGreaterThan(0);

    // Owner lists THEIR scans.
    const mine = await getDocs(query(collection(a.db, 'scans'), where('ownerUid', '==', a.uid), orderBy('createdAt', 'desc')));
    expect(mine.docs.some((d) => d.id === scanId)).toBe(true);
    await a.close();
  });
});

describe('C — cross-user isolation (rules-enforced)', () => {
  it('user B cannot read A’s scan / findings / profile, nor enumerate', async () => {
    const a = await authedClient(email(), 'password123');
    const b = await authedClient(email(), 'password123');
    const scanId = await ownedScan(a.token);
    await post('/me', {}, a.token); // ensure A's user doc exists
    const fid = (await listFindings(scanId))[0] ? (await getDocs(collection(a.db, 'scans', scanId, 'findings'))).docs[0]!.id : '';

    const denied = async (fn: () => Promise<unknown>) => {
      try { await fn(); return false; } catch (e) { return isPermissionDenied(e); }
    };

    expect(await denied(() => getDoc(doc(b.db, 'scans', scanId)))).toBe(true);         // A's scan
    expect(await denied(() => getDocs(collection(b.db, 'scans', scanId, 'findings')))).toBe(true); // A's findings
    if (fid) expect(await denied(() => getDoc(doc(b.db, 'scans', scanId, 'findings', fid)))).toBe(true);
    expect(await denied(() => getDoc(doc(b.db, 'users', a.uid)))).toBe(true);           // A's profile
    // Query for A's scans is denied.
    expect(await denied(() => getDocs(query(collection(b.db, 'scans'), where('ownerUid', '==', a.uid))))).toBe(true);
    // Unconstrained list is denied.
    expect(await denied(() => getDocs(collection(b.db, 'scans')))).toBe(true);
    await a.close(); await b.close();
  });
});

describe('D — anonymous scans unchanged', () => {
  it('anon scan runs, readable by id, not enumerable', async () => {
    const res = await post('/createScan', { target: { type: 'url', value: scanUrl() } });
    const scanId = res.body.scanId as string;
    await waitForTerminal(scanId);
    expect((await getScan(scanId))?.ownerUid).toBeNull();

    const anon = clientDb();
    const s = await getDoc(doc(anon.db, 'scans', scanId));
    expect(s.exists()).toBe(true); // readable by id
    let listDenied = false;
    try { await getDocs(collection(anon.db, 'scans')); } catch (e) { listDenied = isPermissionDenied(e); }
    expect(listDenied).toBe(true); // not enumerable
    await anon.close();
  });
});

describe('E — claim an anonymous scan', () => {
  it('assigns ownership; re-claim denied; nonexistent errors', async () => {
    const anonRes = await post('/createScan', { target: { type: 'url', value: scanUrl() } });
    const scanId = anonRes.body.scanId as string;
    await waitForTerminal(scanId);

    const a = await authedClient(email(), 'password123');
    const claim = await post('/claimScan', { scanId }, a.token);
    expect(claim.status).toBe(200);
    expect((await getScan(scanId))?.ownerUid).toBe(a.uid);

    // Now it shows in A's list.
    const mine = await getDocs(query(collection(a.db, 'scans'), where('ownerUid', '==', a.uid)));
    expect(mine.docs.some((d) => d.id === scanId)).toBe(true);

    // A different user cannot claim it.
    const b = await authedClient(email(), 'password123');
    expect((await post('/claimScan', { scanId }, b.token)).status).toBe(409);

    // Nonexistent scan → 404.
    expect((await post('/claimScan', { scanId: 'nope-does-not-exist' }, a.token)).status).toBe(404);
    await a.close(); await b.close();
  });
});

describe('F — fixes stay locked even for an authenticated owner (free plan)', () => {
  it('owner cannot read private/fix; public doc has no fix', async () => {
    const a = await authedClient(email(), 'password123');
    const scanId = await ownedScan(a.token);
    const fid = (await getDocs(collection(a.db, 'scans', scanId, 'findings'))).docs[0]!.id;

    const pub = await getDoc(doc(a.db, 'scans', scanId, 'findings', fid));
    const data = pub.data() as any;
    expect(data.fix).toBeUndefined();
    expect(data.fixPrompt).toBeUndefined();

    let denied = false;
    try { await getDoc(doc(a.db, 'scans', scanId, 'findings', fid, 'private', 'fix')); } catch (e) { denied = isPermissionDenied(e); }
    expect(denied).toBe(true);
    await a.close();
  });
});

describe('G — token verification', () => {
  it('rejects missing/invalid tokens on authed endpoints; accepts valid', async () => {
    expect((await post('/me', {})).status).toBe(401);            // missing
    expect((await post('/me', {}, 'bogus.token.here')).status).toBe(401); // invalid
    expect((await post('/claimScan', { scanId: 'x' })).status).toBe(401); // missing on authed endpoint

    const a = await authedClient(email(), 'password123');
    expect((await post('/me', {}, a.token)).status).toBe(200);   // valid

    // createScan: invalid token rejected; no token = anonymous 202; valid = owned 202.
    expect((await post('/createScan', { target: { type: 'url', value: target.url } }, 'bad')).status).toBe(401);
    expect((await post('/createScan', { target: { type: 'url', value: scanUrl() } })).status).toBe(202);
    await a.close();
  });
});
