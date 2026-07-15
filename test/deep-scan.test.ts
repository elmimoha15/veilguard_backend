import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { doc, collection, getDoc, getDocs } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { getScan, getUser, listFindings, getEncryptedSecret, setConnection, createDeepScanDoc } from '../shared/src/firestore.js';
import { encryptJson, looksEncrypted } from '../shared/src/crypto.js';
import { config } from '../shared/src/config.js';
import { runScanJob } from '../worker/src/runScan.js';
import { workspacePath } from '../worker/src/deepScan.js';
import { QUICKCART_PATH, waitForTerminal } from './harness.js';
import { authedClient, isPermissionDenied } from './client.js';

const SUPABASE_FIXTURE = resolve(process.cwd(), 'test-fixtures/supabase-broken-rls');
let server: Server;
let baseUrl: string;
let m = 0;
const email = () => `d${Date.now()}-${++m}@test.dev`;

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

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function connectGh(token: string, repoPath = QUICKCART_PATH) {
  return post('/connectGitHub', { repoPath }, token);
}
async function deepScan(token: string, sources: Record<string, unknown> = { github: true }) {
  const r = await post('/createDeepScan', sources, token);
  if (r.status === 202) await waitForTerminal(r.body.scanId);
  return r;
}

describe('A — connect stores an ENCRYPTED, client-unreadable credential', () => {
  it('secret encrypted server-side; client denied; metadata says connected', async () => {
    const a = await authedClient(email(), 'password123');
    const r = await connectGh(a.token);
    expect(r.status).toBe(200);

    // Server-side: the stored credential is ciphertext, not plaintext.
    const blob = await getEncryptedSecret(a.uid, 'github');
    expect(blob && looksEncrypted(blob)).toBe(true);
    expect(blob).not.toContain(QUICKCART_PATH); // path is inside the encrypted blob, not readable

    // Client SDK: reading the secrets doc is DENIED.
    let denied = false;
    try { await getDoc(doc(a.db, 'secrets', a.uid)); } catch (e) { denied = isPermissionDenied(e); }
    expect(denied).toBe(true);

    // Client-readable metadata shows "connected" with NO secret.
    const u = (await getDoc(doc(a.db, 'users', a.uid))).data() as any;
    expect(u.connections.github.repo).toBeTruthy();
    expect(u.connections.github.writeAccess).toBe(false);
    expect(JSON.stringify(u.connections.github)).not.toContain(QUICKCART_PATH);
    await a.close();
  });
});

describe('B — deep scan finds white-box criticals (QuickCart)', () => {
  it('grade F with hardcoded secret, SQLi, unverified webhook, broken RLS', async () => {
    const a = await authedClient(email(), 'password123');
    await connectGh(a.token);
    const r = await deepScan(a.token, { github: true });
    expect(r.status).toBe(202);
    const scanId = r.body.scanId;

    const d = await getScan(scanId);
    expect(d?.type).toBe('deep');
    expect(d?.grade).toBe('F');
    expect(d?.counts?.critical).toBe(13);

    const ids = new Set((await listFindings(scanId)).map((f) => f.ruleId));
    expect(ids.has('SECRETS_STRIPE_SECRET_KEY')).toBe(true);
    expect(ids.has('INJECTION_SQL')).toBe(true);
    expect(ids.has('API_WEBHOOK_UNVERIFIED')).toBe(true);
    expect([...ids].some((i) => i.startsWith('DATABASE_RLS'))).toBe(true);
    await a.close();
  });
});

describe('C — source is NEVER persisted (success + error path)', () => {
  it('workspace deleted after a successful scan; only redacted findings stored', async () => {
    const a = await authedClient(email(), 'password123');
    await connectGh(a.token);
    const r = await deepScan(a.token, { github: true });
    const scanId = r.body.scanId;
    // Ephemeral workspace is gone.
    expect(existsSync(workspacePath(scanId))).toBe(false);
    // Findings carry only short/redacted evidence — never whole-file contents.
    const findings = await listFindings(scanId);
    expect(findings.every((f) => !f.evidence || f.evidence.length < 200)).toBe(true);
    await a.close();
  });

  it('workspace deleted even when the scan errors mid-run (finally cleanup)', async () => {
    const a = await authedClient(email(), 'password123');
    // Craft a broken connection whose repo path no longer exists → build throws.
    await setConnection(a.uid, 'github', { repo: 'ghost/repo', scopes: ['contents:read'], writeAccess: false, mock: true }, encryptJson({ mock: true, repoPath: '/definitely/not/here' }));
    const scanId = await createDeepScanDoc(a.uid, { github: true });
    await runScanJob({ scanId }); // run worker directly
    const d = await getScan(scanId);
    expect(d?.status).toBe('error');
    expect(existsSync(workspacePath(scanId))).toBe(false); // cleaned up despite error
    await a.close();
  });
});

describe('D — isolation holds for connections + deep scans', () => {
  it('B cannot read A’s secrets/connections/deep-scan/findings, nor scan A’s connection', async () => {
    const a = await authedClient(email(), 'password123');
    const b = await authedClient(email(), 'password123');
    await connectGh(a.token);
    const scanId = (await deepScan(a.token)).body.scanId;
    const fid = (await getDocs(collection(a.db, 'scans', scanId, 'findings'))).docs[0]?.id;

    const denied = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch (e) { return isPermissionDenied(e); } };
    expect(await denied(() => getDoc(doc(b.db, 'secrets', a.uid)))).toBe(true);
    expect(await denied(() => getDoc(doc(b.db, 'users', a.uid)))).toBe(true);
    expect(await denied(() => getDoc(doc(b.db, 'scans', scanId)))).toBe(true);
    if (fid) expect(await denied(() => getDoc(doc(b.db, 'scans', scanId, 'findings', fid)))).toBe(true);
    // B triggering a deep scan hits B's own (absent) connection → 409, never A's.
    expect((await post('/createDeepScan', { github: true }, b.token)).status).toBe(409);
    await a.close(); await b.close();
  });
});

describe('E — revoke deletes the credential', () => {
  it('disconnect removes the encrypted secret; later deep scan fails "not connected"', async () => {
    const a = await authedClient(email(), 'password123');
    await connectGh(a.token);
    expect(await getEncryptedSecret(a.uid, 'github')).not.toBeNull();

    expect((await post('/disconnect', { provider: 'github' }, a.token)).status).toBe(200);
    expect(await getEncryptedSecret(a.uid, 'github')).toBeNull(); // gone, not hidden

    const meta = (await getUser(a.uid)) as any;
    expect(meta.connections?.github).toBeUndefined();
    expect((await post('/createDeepScan', { github: true }, a.token)).status).toBe(409);
    await a.close();
  });
});

describe('F — deep-scan fixes stay locked (free plan)', () => {
  it('owner cannot read private/fix of a deep finding', async () => {
    const a = await authedClient(email(), 'password123');
    await connectGh(a.token);
    const scanId = (await deepScan(a.token)).body.scanId;
    const fid = (await getDocs(collection(a.db, 'scans', scanId, 'findings'))).docs[0]!.id;
    const pub = (await getDoc(doc(a.db, 'scans', scanId, 'findings', fid))).data() as any;
    expect(pub.fix).toBeUndefined();
    let denied = false;
    try { await getDoc(doc(a.db, 'scans', scanId, 'findings', fid, 'private', 'fix')); } catch (e) { denied = isPermissionDenied(e); }
    expect(denied).toBe(true);
    await a.close();
  });
});

describe('G — read-only, least-privilege', () => {
  it('connect requests only read scopes, single repo, no write access', async () => {
    const a = await authedClient(email(), 'password123');
    const r = await connectGh(a.token);
    expect(r.body.writeAccess).toBe(false);
    expect(r.body.scopes).toEqual(['contents:read', 'metadata:read']);
    expect(r.body.scopes.some((s: string) => /write|admin|delete/i.test(s))).toBe(false);
    expect(typeof r.body.repo).toBe('string'); // a single repo, not org-wide
    await a.close();
  });
});

describe('H — resilience (bad/oversized/nonexistent → clean error)', () => {
  it('bad credential → error, workspace cleaned, not stuck running', async () => {
    const a = await authedClient(email(), 'password123');
    await setConnection(a.uid, 'github', { repo: 'x/y', scopes: ['contents:read'], writeAccess: false, mock: true }, encryptJson({ mock: true, repoPath: '/no/such/path' }));
    const scanId = await createDeepScanDoc(a.uid, { github: true });
    await runScanJob({ scanId });
    const d = await getScan(scanId);
    expect(d?.status).toBe('error');
    expect(d?.finishedAt).toBeTruthy();
    expect(existsSync(workspacePath(scanId))).toBe(false);
    await a.close();
  });

  it('oversized workspace → error (size cap), workspace cleaned', async () => {
    const a = await authedClient(email(), 'password123');
    await connectGh(a.token);
    const orig = config.deepScanMaxBytes;
    try {
      (config as any).deepScanMaxBytes = 10; // 10 bytes — QuickCart exceeds it
      const scanId = await createDeepScanDoc(a.uid, { github: true });
      await runScanJob({ scanId });
      const d = await getScan(scanId);
      expect(d?.status).toBe('error');
      expect(d?.error).toMatch(/size cap/i);
      expect(existsSync(workspacePath(scanId))).toBe(false);
    } finally {
      (config as any).deepScanMaxBytes = orig;
    }
    await a.close();
  });
});

describe('supabase mock connection also feeds RLS rules', () => {
  it('connecting Supabase fixture yields broken-RLS findings', async () => {
    // Sanity that the supabase mock path works too (fixture has broken RLS).
    if (!existsSync(SUPABASE_FIXTURE)) { mkdirSync(SUPABASE_FIXTURE, { recursive: true }); writeFileSync(resolve(SUPABASE_FIXTURE, '0001.sql'), 'create table public.t (id uuid primary key);'); }
    const a = await authedClient(email(), 'password123');
    expect((await post('/connectSupabase', { policiesPath: SUPABASE_FIXTURE, projectRef: 'demo' }, a.token)).status).toBe(200);
    const scanId = (await deepScan(a.token, { supabase: true })).body.scanId;
    const ids = new Set((await listFindings(scanId)).map((f) => f.ruleId));
    expect([...ids].some((i) => i.startsWith('DATABASE_RLS'))).toBe(true);
    await a.close();
  });
});
