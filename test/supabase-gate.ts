/**
 * Slice-5b testing gate (A–J) — Supabase OAuth connector. Runs inside
 * `firebase emulators:exec --only firestore,auth`. Prints GATE RESULTS.
 *   npm run gate:supabase
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { execa } from 'execa';
import { doc, getDoc } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import {
  getScan, getUser, listFindings, getEncryptedSecret, setConnection, createDeepScanDoc, setOAuthState,
} from '../shared/src/firestore.js';
import { encryptJson, decryptJson, looksEncrypted } from '../shared/src/crypto.js';
import { config } from '../shared/src/config.js';
import { runScanJob } from '../worker/src/runScan.js';
import { workspacePath } from '../worker/src/deepScan.js';
import { SUPABASE_READONLY_SCOPES } from '../shared/src/supabase-api.js';
import type { SupabaseSecret } from '../shared/src/types.js';
import { waitForTerminal } from './harness.js';
import { authedClient, isPermissionDenied, type AuthedClientHandle } from './client.js';

const ROOT = process.cwd();
const FIXTURE = resolve(ROOT, 'test-fixtures/supabase-broken-rls');
const results: { id: string; label: string; pass: boolean; detail: string }[] = [];
const record = (id: string, label: string, pass: boolean, detail: string) => results.push({ id, label, pass, detail });

let server: Server;
let baseUrl: string;
let m = 0;
const email = () => `gsb-${Date.now()}-${++m}@test.dev`;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function callback(qs: string) {
  const res = await fetch(`${baseUrl}/connect/supabase/callback?${qs}`, { redirect: 'manual' });
  return { status: res.status, body: await res.text() };
}
const stateOf = (u: string) => new URL(u).searchParams.get('state') || '';
async function connect(token: string) {
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
const denied = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch (e) { return isPermissionDenied(e); } };

async function gateA() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    const { begin, cb } = await connect(A.token);
    const meta = ((await getUser(A.uid)) as any).connections?.supabase;
    const ok = begin.status === 200 && begin.body.redirectUrl.includes('api.supabase.com/v1/oauth/authorize') &&
      cb.body.includes('connected=supabase') && meta?.mode === 'oauth' && !!meta?.projectRef;
    record('A', 'OAuth connect (mock): start → callback → token → stored', ok, `begin=${begin.status}, callback→connected=supabase, meta.mode=${meta?.mode}, project=${meta?.projectRef}`);
  } catch (e) { record('A', 'OAuth connect', false, (e as Error).message); } finally { await a?.close(); }
}

async function gateB() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    const missing = (await callback('code=x')).body.includes('error=missing_state');
    const unknown = (await callback('code=x&state=deadbeef')).body.includes('error=bad_state');
    await setOAuthState('gate-old', { uid: A.uid, provider: 'supabase', createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    const expired = (await callback('code=x&state=gate-old')).body.includes('error=expired');
    const { state, cb } = await connect(A.token);
    const reused = cb.body.includes('connected=supabase') && (await callback(`code=x&state=${state}`)).body.includes('error=bad_state');
    const ok = missing && unknown && expired && reused;
    record('B', 'state / CSRF (missing, unknown, expired, single-use)', ok, `missing=${missing}, unknown=${unknown}, expired=${expired}, reused-rejected=${reused}`);
  } catch (e) { record('B', 'state/CSRF', false, (e as Error).message); } finally { await a?.close(); }
}

async function gateC() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    await connect(A.token);
    const blob = await getEncryptedSecret(A.uid, 'supabase');
    const enc = !!blob && looksEncrypted(blob) && !blob.includes('mock-access') && !blob.includes('mock-refresh');
    const secretDenied = await denied(() => getDoc(doc(A.db, 'secrets', A.uid)));
    const meta = JSON.stringify(((await getUser(A.uid)) as any).connections.supabase);
    const noTokenInMeta = !meta.includes('mock-access') && !meta.includes('mock-refresh');
    const noClientSecret = !config.supabaseClientSecret || (!meta.includes(config.supabaseClientSecret) && !readFileSync(join(ROOT, 'dev-ui/app.js'), 'utf8').includes(config.supabaseClientSecret));
    const ok = enc && secretDenied && noTokenInMeta && noClientSecret;
    record('C', 'credentials encrypted, client-unreadable, secret never leaks', ok, `ciphertext=${enc}, client-read-denied=${secretDenied}, meta-token-free=${noTokenInMeta}, client-secret-absent=${noClientSecret}`);
  } catch (e) { record('C', 'credential security', false, (e as Error).message); } finally { await a?.close(); }
}

async function gateD() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    await connect(A.token);
    const scanId = (await deepScan(A.token)).body.scanId;
    const ids = new Set((await listFindings(scanId)).map((f) => f.ruleId));
    const d = await getScan(scanId);
    const want = ['DATABASE_RLS_DISABLED', 'DATABASE_RLS_PERMISSIVE_POLICY', 'DATABASE_SECURITY_DEFINER_VIEW', 'DATABASE_SUPABASE_RLS_OPEN_LIVE'];
    const have = want.filter((w) => ids.has(w));
    const ok = have.length === want.length && d?.grade === 'F';
    record('D', 'deep scan finds RLS issues via engine + anon-read probe', ok, `grade=${d?.grade}, findings=[${have.join(', ')}]`);
  } catch (e) { record('D', 'deep scan RLS', false, (e as Error).message); } finally { await a?.close(); }
}

async function gateE() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    const begin = await post('/connect/begin', { provider: 'supabase' }, A.token);
    const scopes: string[] = begin.body.scopes || [];
    const readOnly = scopes.length > 0 && !scopes.some((s) => /write|admin|delete|create|update/i.test(s));
    const u = new URL(begin.body.redirectUrl);
    // Supabase scopes are app-configured (deprecated as a URL param); we send PKCE.
    const pkce = u.searchParams.get('scope') === null && !!u.searchParams.get('code_challenge') && u.searchParams.get('code_challenge_method') === 'S256';
    const ok = readOnly && JSON.stringify(scopes) === JSON.stringify([...SUPABASE_READONLY_SCOPES]) && pkce;
    record('E', 'read-only posture + PKCE (no scope smuggled in URL)', ok, `scopes=[${scopes.join(' ')}] (read-only=${readOnly}), pkce+no-url-scope=${pkce}`);
  } catch (e) { record('E', 'least-privilege', false, (e as Error).message); } finally { await a?.close(); }
}

async function gateF() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    await connect(A.token);
    const okScan = (await deepScan(A.token)).body.scanId;
    const cleanOk = !existsSync(workspacePath(okScan));
    const redacted = (await listFindings(okScan)).every((f) => !f.evidence || f.evidence.length < 200);
    // error path
    const secret: SupabaseSecret = { mode: 'oauth', mock: true, accessToken: 'mock-access-x', refreshToken: 'mock-refresh-good', expiresAt: Date.now() + 3_600_000, projectRef: 'p', policiesPath: '/no/such/path' };
    await setConnection(A.uid, 'supabase', { projectRef: 'p', access: 'read-only', mode: 'oauth', mock: true }, encryptJson(secret));
    const errScan = await createDeepScanDoc(A.uid, { supabase: true });
    await runScanJob({ scanId: errScan });
    const cleanErr = (await getScan(errScan))?.status === 'error' && !existsSync(workspacePath(errScan));
    record('F', 'schema/policies never persisted (success + error)', cleanOk && redacted && cleanErr, `ws-gone(ok)=${cleanOk}, redacted=${redacted}, ws-gone(err)=${cleanErr}`);
  } catch (e) { record('F', 'never persisted', false, (e as Error).message); } finally { await a?.close(); }
}

async function gateG() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    await connect(A.token);
    const before = (await getEncryptedSecret(A.uid, 'supabase')) !== null;
    const disc = (await post('/disconnect', { provider: 'supabase' }, A.token)).status;
    const after = (await getEncryptedSecret(A.uid, 'supabase')) === null;
    const metaGone = ((await getUser(A.uid)) as any).connections?.supabase === undefined;
    const scanFails = (await post('/createDeepScan', { supabase: true }, A.token)).status === 409;
    record('G', 'revoke deletes the token + metadata', before && disc === 200 && after && metaGone && scanFails, `had=${before}, disconnect=${disc}, gone=${after}, meta-gone=${metaGone}, later-scan=${scanFails ? '409' : 'NOT 409'}`);
  } catch (e) { record('G', 'revoke', false, (e as Error).message); } finally { await a?.close(); }
}

async function gateH() {
  let a: AuthedClientHandle | undefined, b: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    const B = (b = await authedClient(email(), 'password123'));
    await connect(A.token);
    const scanId = (await deepScan(A.token)).body.scanId;
    const checks = [
      await denied(() => getDoc(doc(B.db, 'secrets', A.uid))),
      await denied(() => getDoc(doc(B.db, 'users', A.uid))),
      await denied(() => getDoc(doc(B.db, 'scans', scanId))),
      (await post('/createDeepScan', { supabase: true }, B.token)).status === 409,
    ];
    record('H', 'isolation (token / connection / findings / scan)', checks.every(Boolean), `B denied [secret, profile, scan] + cannot scan A's connection = ${checks.map((c) => (c ? '✓' : '✗')).join('')}`);
  } catch (e) { record('H', 'isolation', false, (e as Error).message); } finally { await a?.close(); await b?.close(); }
}

async function gateI() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    // good refresh
    const good: SupabaseSecret = { mode: 'oauth', mock: true, accessToken: 'mock-access-stale', refreshToken: 'mock-refresh-good', expiresAt: Date.now() - 1000, projectRef: 'p', policiesPath: FIXTURE };
    await setConnection(A.uid, 'supabase', { projectRef: 'p', access: 'read-only', mode: 'oauth', mock: true }, encryptJson(good));
    const s1 = await createDeepScanDoc(A.uid, { supabase: true });
    await runScanJob({ scanId: s1 });
    const refreshed = decryptJson<SupabaseSecret>((await getEncryptedSecret(A.uid, 'supabase'))!);
    const goodOk = (await getScan(s1))?.status === 'done' && refreshed.mode === 'oauth' && refreshed.accessToken.includes('refreshed');
    // bad refresh
    const bad: SupabaseSecret = { mode: 'oauth', mock: true, accessToken: 'mock-access-stale', refreshToken: 'mock-refresh-bad', expiresAt: Date.now() - 1000, projectRef: 'p', policiesPath: FIXTURE };
    await setConnection(A.uid, 'supabase', { projectRef: 'p', access: 'read-only', mode: 'oauth', mock: true }, encryptJson(bad));
    const s2 = await createDeepScanDoc(A.uid, { supabase: true });
    await runScanJob({ scanId: s2 }); // must resolve (no crash)
    const d2 = await getScan(s2);
    const badOk = d2?.status === 'error' && /reconnect/i.test(d2?.error ?? '') && ((await getUser(A.uid)) as any).connections.supabase.needsReconnect === true;
    record('I', 'token refresh (renew server-side; failed → needs reconnect, no crash)', goodOk && badOk, `refreshed-and-ran=${goodOk}, failed→needs-reconnect+clean-error=${badOk}`);
  } catch (e) { record('I', 'token refresh', false, (e as Error).message); } finally { await a?.close(); }
}

async function gateJ() {
  const details: string[] = [];
  let pass = true;

  const tc = await execa('npx', ['tsc', '--noEmit'], { cwd: ROOT, reject: false });
  const build = await execa('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, reject: false });
  if (tc.exitCode !== 0 || build.exitCode !== 0) pass = false;
  details.push(`typecheck=${tc.exitCode === 0}`, `build=${build.exitCode === 0}`);

  // firestore.rules must be unchanged (no staged/working diff, no diff vs HEAD).
  const st = await execa('git', ['status', '--porcelain', 'firestore.rules'], { cwd: ROOT, reject: false });
  const rulesUnchanged = st.stdout.trim() === '';
  if (!rulesUnchanged) pass = false;
  details.push(`firestore.rules-unchanged=${rulesUnchanged}`);

  const secretsOk = !hasSecret(ROOT);
  if (!secretsOk) pass = false;
  details.push(`no-secrets-committed=${secretsOk}`);

  // GitHub connector + slices 2/3/4 + this slice's tests, all on the running emulator.
  const vt = await execa('npx', ['vitest', 'run', 'test/deep-scan.test.ts', 'test/supabase-connect.test.ts', 'test/scan-service.test.ts', 'test/free-scan.test.ts', 'test/auth.test.ts'], { cwd: ROOT, reject: false });
  if (vt.exitCode !== 0) pass = false;
  details.push(`github+slices+supabase-tests=${vt.exitCode === 0}`);

  const s1 = await execa('npm', ['run', 'gate'], { cwd: join(ROOT, '../veilguard-scanner'), reject: false });
  if (s1.exitCode !== 0) pass = false;
  details.push(`scanner-slice1-gate=${s1.exitCode === 0}`);

  record('J', 'no regressions (typecheck/build, rules unchanged, no secrets, GitHub+slices green)', pass, details.join('; '));
}

const DANGEROUS = /sk_live_[A-Za-z0-9]{6}|sk_test_[A-Za-z0-9]{6}|sb_secret_[A-Za-z0-9]{6}|whsec_[A-Za-z0-9]{6}|BEGIN (RSA )?PRIVATE KEY|AKIA[0-9A-Z]{16}/;
const SKIP = new Set(['node_modules', 'dist', '.jre', '.git', '.firebase', 'coverage', 'test-fixtures']);
function hasSecret(dir: string): boolean {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e) || e === '.env' || e === '.env.local') continue; // .env is gitignored; never committed
    const p = join(dir, e);
    const stt = statSync(p);
    if (stt.isDirectory()) { if (hasSecret(p)) return true; }
    else if (stt.size < 500_000 && /\.(ts|js|json|md|html|example|yaml|yml|rules)$|Dockerfile$/.test(e)) {
      if (DANGEROUS.test(readFileSync(p, 'utf8'))) { console.error(`  secret-like content in ${p}`); return true; }
    }
  }
  return false;
}

async function main() {
  await new Promise<void>((done) => {
    const app = createDevServer();
    server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      done();
    });
  });
  await getScan('warmup');

  await gateA(); await gateB(); await gateC(); await gateD(); await gateE();
  await gateF(); await gateG(); await gateH(); await gateI(); await gateJ();

  await new Promise<void>((r) => server.close(() => r()));

  const green = '\x1b[32m', red = '\x1b[31m', reset = '\x1b[0m';
  console.log('\n════════════ GATE RESULTS (Slice 5b — Supabase OAuth) ════════════');
  for (const r of results) {
    console.log(`  ${r.id})  ${r.pass ? green + 'PASS' : red + 'FAIL'}${reset}  ${r.label}`);
    console.log(`         ${r.detail}`);
  }
  const allPass = results.every((r) => r.pass);
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(allPass ? `${green}  ALL GATES PASS ✓${reset}\n` : `${red}  SOME GATES FAILED ✗${reset}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
