import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { doc, getDoc } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import {
  getScan, getUser, listFindings, getEncryptedSecret, setConnection, createDeepScanDoc, setOAuthState,
} from '../shared/src/firestore.js';
import { decryptJson, looksEncrypted } from '../shared/src/crypto.js';
import { config } from '../shared/src/config.js';
import { runScanJob } from '../worker/src/runScan.js';
import { workspacePath } from '../worker/src/deepScan.js';
import { SUPABASE_READONLY_SCOPES } from '../shared/src/supabase-api.js';
import type { SupabaseSecret } from '../shared/src/types.js';
import { waitForTerminal } from './harness.js';
import { authedClient, isPermissionDenied, type AuthedClientHandle } from './client.js';

const FIXTURE = resolve(process.cwd(), 'test-fixtures/supabase-broken-rls');
let server: Server;
let baseUrl: string;
let m = 0;
const email = () => `sb-${Date.now()}-${++m}@test.dev`;

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
/** GET the callback; it returns the popup result page whose body carries the outcome. */
async function callback(qs: string) {
  const res = await fetch(`${baseUrl}/connect/supabase/callback?${qs}`, { redirect: 'manual' });
  return { status: res.status, body: await res.text() };
}
const stateOf = (redirectUrl: string) => new URL(redirectUrl).searchParams.get('state') || '';

/** Full mock OAuth connect: begin → callback with the issued state. */
async function connectSupabaseOAuth(token: string) {
  const begin = await post('/connect/begin', { provider: 'supabase' }, token);
  const state = stateOf(begin.body.redirectUrl);
  const cb = await callback(`code=devmock&state=${state}`);
  return { begin, state, cb };
}
async function deepScan(token: string) {
  const r = await post('/createDeepScan', { supabase: true }, token);
  if (r.status === 202) await waitForTerminal(r.body.scanId);
  return r;
}

describe('A — OAuth connect (mock): start → callback → token exchanged → stored', () => {
  it('stores an oauth connection with project metadata', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    const { begin, cb } = await connectSupabaseOAuth(a.token);
    expect(begin.status).toBe(200);
    expect(begin.body.redirectUrl).toContain('api.supabase.com/v1/oauth/authorize');
    expect(cb.body).toContain('connected=supabase');

    const u = (await getUser(a.uid)) as any;
    expect(u.connections.supabase.mode).toBe('oauth');
    expect(u.connections.supabase.access).toBe('read-only');
    expect(u.connections.supabase.projectRef).toBeTruthy();
    await a.close();
  });
});

describe('B — state / CSRF', () => {
  it('rejects missing, unknown, expired, and reused state', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    // missing
    expect((await callback('code=x')).body).toContain('error=missing_state');
    // unknown
    expect((await callback('code=x&state=deadbeef')).body).toContain('error=bad_state');
    // expired (state older than the TTL)
    await setOAuthState('old-state', { uid: a.uid, provider: 'supabase', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    expect((await callback('code=x&state=old-state')).body).toContain('error=expired');
    // reused: a valid state is single-use — the second callback fails.
    const { state, cb } = await connectSupabaseOAuth(a.token);
    expect(cb.body).toContain('connected=supabase');
    expect((await callback(`code=x&state=${state}`)).body).toContain('error=bad_state');
    await a.close();
  });
});

describe('C — credential security (tokens encrypted, client-unreadable)', () => {
  it('tokens encrypted server-side; client denied; metadata carries no token/secret', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    await connectSupabaseOAuth(a.token);

    const blob = await getEncryptedSecret(a.uid, 'supabase');
    expect(blob && looksEncrypted(blob)).toBe(true);
    // The access/refresh tokens live only inside the ciphertext.
    expect(blob).not.toContain('mock-access');
    expect(blob).not.toContain('mock-refresh');
    const secret = decryptJson<SupabaseSecret>(blob!);
    expect(secret.mode).toBe('oauth');
    if (secret.mode === 'oauth') expect(secret.accessToken).toContain('mock-access');

    // Client SDK read of secrets/{uid} is denied.
    let denied = false;
    try { await getDoc(doc(a.db, 'secrets', a.uid)); } catch (e) { denied = isPermissionDenied(e); }
    expect(denied).toBe(true);

    // Client-readable metadata has NO token and NO client secret.
    const meta = JSON.stringify(((await getUser(a.uid)) as any).connections.supabase);
    expect(meta).not.toContain('mock-access');
    expect(meta).not.toContain('mock-refresh');
    if (config.supabaseClientSecret) expect(meta).not.toContain(config.supabaseClientSecret);
    await a.close();
  });
});

describe('D — deep scan finds RLS issues (via the engine) + anon-read probe', () => {
  it('reports RLS disabled, permissive policy, SECURITY DEFINER view, and a live anon-read', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    await connectSupabaseOAuth(a.token);
    const r = await deepScan(a.token);
    expect(r.status).toBe(202);
    const ids = new Set((await listFindings(r.body.scanId)).map((f) => f.ruleId));
    expect(ids.has('DATABASE_RLS_DISABLED')).toBe(true);
    expect(ids.has('DATABASE_RLS_PERMISSIVE_POLICY')).toBe(true);
    expect(ids.has('DATABASE_SECURITY_DEFINER_VIEW')).toBe(true);
    expect(ids.has('DATABASE_SUPABASE_RLS_OPEN_LIVE')).toBe(true); // active probe
    const d = await getScan(r.body.scanId);
    expect(d?.grade).toBe('F');
    await a.close();
  });
});

describe('E — read-only, least-privilege scopes', () => {
  it('authorize request carries only read-only scopes', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    const begin = await post('/connect/begin', { provider: 'supabase' }, a.token);
    const scopes: string[] = begin.body.scopes;
    expect(scopes).toEqual([...SUPABASE_READONLY_SCOPES]);
    expect(scopes.some((s) => /write|admin|delete|create|update/i.test(s))).toBe(false);
    // Supabase scopes are app-configured (not a URL param), and we use PKCE.
    const u = new URL(begin.body.redirectUrl);
    expect(u.searchParams.get('scope')).toBeNull(); // deprecated param not sent
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('response_type')).toBe('code');
    await a.close();
  });
});

describe('F — schema/policies NEVER persisted (success + error)', () => {
  it('workspace gone after success; findings carry no bulk schema', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    await connectSupabaseOAuth(a.token);
    const scanId = (await deepScan(a.token)).body.scanId;
    expect(existsSync(workspacePath(scanId))).toBe(false);
    const findings = await listFindings(scanId);
    expect(findings.every((f) => !f.evidence || f.evidence.length < 200)).toBe(true);
    await a.close();
  });

  it('workspace gone even when the fetch errors mid-run', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    const secret: SupabaseSecret = { mode: 'oauth', mock: true, accessToken: 'mock-access-x', refreshToken: 'mock-refresh-good', expiresAt: Date.now() + 3_600_000, projectRef: 'p', policiesPath: '/definitely/not/here' };
    await setConnection(a.uid, 'supabase', { projectRef: 'p', access: 'read-only', mode: 'oauth', mock: true }, (await import('../shared/src/crypto.js')).encryptJson(secret));
    const scanId = await createDeepScanDoc(a.uid, { supabase: true });
    await runScanJob({ scanId });
    const d = await getScan(scanId);
    expect(d?.status).toBe('error');
    expect(existsSync(workspacePath(scanId))).toBe(false);
    await a.close();
  });
});

describe('G — revoke deletes the token', () => {
  it('disconnect removes the encrypted token + metadata; later scan 409s', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    await connectSupabaseOAuth(a.token);
    expect(await getEncryptedSecret(a.uid, 'supabase')).not.toBeNull();
    expect((await post('/disconnect', { provider: 'supabase' }, a.token)).status).toBe(200);
    expect(await getEncryptedSecret(a.uid, 'supabase')).toBeNull();
    expect(((await getUser(a.uid)) as any).connections?.supabase).toBeUndefined();
    expect((await post('/createDeepScan', { supabase: true }, a.token)).status).toBe(409);
    await a.close();
  });
});

describe('H — isolation', () => {
  it('B cannot read A’s supabase token / connection / findings, nor scan A’s connection', async () => {
    let a: AuthedClientHandle | undefined, b: AuthedClientHandle | undefined;
    a = await authedClient(email(), 'password123', 'guard');
    b = await authedClient(email(), 'password123', 'guard');
    await connectSupabaseOAuth(a.token);
    const scanId = (await deepScan(a.token)).body.scanId;
    const denied = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch (e) { return isPermissionDenied(e); } };
    expect(await denied(() => getDoc(doc(b.db, 'secrets', a!.uid)))).toBe(true);
    expect(await denied(() => getDoc(doc(b.db, 'users', a!.uid)))).toBe(true);
    expect(await denied(() => getDoc(doc(b.db, 'scans', scanId)))).toBe(true);
    expect((await post('/createDeepScan', { supabase: true }, b.token)).status).toBe(409);
    await a.close(); await b.close();
  });
});

describe('I — token refresh', () => {
  const enc = async (s: SupabaseSecret) => (await import('../shared/src/crypto.js')).encryptJson(s);

  it('an expired access token is refreshed server-side and the scan runs', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    const secret: SupabaseSecret = { mode: 'oauth', mock: true, accessToken: 'mock-access-stale', refreshToken: 'mock-refresh-good', expiresAt: Date.now() - 1000, projectRef: 'p', policiesPath: FIXTURE };
    await setConnection(a.uid, 'supabase', { projectRef: 'p', access: 'read-only', mode: 'oauth', mock: true }, await enc(secret));
    const scanId = await createDeepScanDoc(a.uid, { supabase: true });
    await runScanJob({ scanId });
    expect((await getScan(scanId))?.status).toBe('done');
    // The refreshed token was persisted (re-encrypted).
    const after = decryptJson<SupabaseSecret>((await getEncryptedSecret(a.uid, 'supabase'))!);
    if (after.mode === 'oauth') expect(after.accessToken).toContain('refreshed');
    await a.close();
  });

  it('a failed refresh marks needs-reconnect without crashing the scan', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    const secret: SupabaseSecret = { mode: 'oauth', mock: true, accessToken: 'mock-access-stale', refreshToken: 'mock-refresh-bad', expiresAt: Date.now() - 1000, projectRef: 'p', policiesPath: FIXTURE };
    await setConnection(a.uid, 'supabase', { projectRef: 'p', access: 'read-only', mode: 'oauth', mock: true }, await enc(secret));
    const scanId = await createDeepScanDoc(a.uid, { supabase: true });
    await runScanJob({ scanId }); // resolves (no crash)
    const d = await getScan(scanId);
    expect(d?.status).toBe('error');
    expect(d?.error).toMatch(/reconnect/i);
    expect(((await getUser(a.uid)) as any).connections.supabase.needsReconnect).toBe(true);
    await a.close();
  });
});
