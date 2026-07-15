/**
 * Slice-5 testing gate (A–I) — connected deep scans. Runs inside
 * `firebase emulators:exec --only firestore,auth`. Prints GATE RESULTS.
 *   npm run gate
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { execa } from 'execa';
import { doc, collection, getDoc, getDocs } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { getScan, getUser, listFindings, getEncryptedSecret, setConnection, createDeepScanDoc } from '../shared/src/firestore.js';
import { encryptJson, looksEncrypted } from '../shared/src/crypto.js';
import { config } from '../shared/src/config.js';
import { runScanJob } from '../worker/src/runScan.js';
import { workspacePath } from '../worker/src/deepScan.js';
import { QUICKCART_PATH, waitForTerminal } from './harness.js';
import { authedClient, isPermissionDenied, type AuthedClientHandle } from './client.js';

const ROOT = process.cwd();
const results: { id: string; label: string; pass: boolean; detail: string }[] = [];
const record = (id: string, label: string, pass: boolean, detail: string) => results.push({ id, label, pass, detail });

let server: Server;
let baseUrl: string;
let m = 0;
const email = () => `g5-${Date.now()}-${++m}@test.dev`;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const connectGh = (t: string, repoPath = QUICKCART_PATH) => post('/connectGitHub', { repoPath }, t);
async function deepScan(t: string, sources: Record<string, unknown> = { github: true }) {
  const r = await post('/createDeepScan', sources, t);
  if (r.status === 202) await waitForTerminal(r.body.scanId);
  return r;
}
const denied = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch (e) { return isPermissionDenied(e); } };

async function gateA() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    await connectGh(A.token);
    const blob = await getEncryptedSecret(A.uid, 'github');
    const enc = !!blob && looksEncrypted(blob) && !blob.includes(QUICKCART_PATH);
    const secretDenied = await denied(() => getDoc(doc(A.db, 'secrets', A.uid)));
    const meta = (await getDoc(doc(A.db, 'users', A.uid))).data() as any;
    const metaOk = meta.connections?.github?.writeAccess === false && !JSON.stringify(meta.connections.github).includes(QUICKCART_PATH);
    record('A', 'connect stores encrypted, client-unreadable credential', enc && secretDenied && metaOk, `ciphertext=${enc}, client secret-read denied=${secretDenied}, metadata-only=${metaOk}`);
  } catch (e) { record('A', 'connect encrypted', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateB() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    await connectGh(A.token);
    const scanId = (await deepScan(A.token)).body.scanId;
    const d = await getScan(scanId);
    const ids = new Set((await listFindings(scanId)).map((f) => f.ruleId));
    const crits = ['SECRETS_STRIPE_SECRET_KEY', 'INJECTION_SQL', 'API_WEBHOOK_UNVERIFIED'].every((i) => ids.has(i)) && [...ids].some((i) => i.startsWith('DATABASE_RLS'));
    record('B', 'deep scan finds white-box criticals (QuickCart)', d?.grade === 'F' && d?.counts?.critical === 13 && crits, `grade=${d?.grade}, critical=${d?.counts?.critical}, key white-box findings present=${crits}`);
  } catch (e) { record('B', 'white-box criticals', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateC() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    await connectGh(A.token);
    const okScan = (await deepScan(A.token)).body.scanId;
    const cleanAfterOk = !existsSync(workspacePath(okScan));
    const findings = await listFindings(okScan);
    const redacted = findings.every((f) => !f.evidence || f.evidence.length < 200);
    // Error path: broken credential → build throws → finally must still clean up.
    await setConnection(A.uid, 'github', { repo: 'x/y', scopes: ['contents:read'], writeAccess: false, mock: true }, encryptJson({ mock: true, repoPath: '/no/such/path' }));
    const errScan = await createDeepScanDoc(A.uid, { github: true });
    await runScanJob({ scanId: errScan });
    const errDoc = await getScan(errScan);
    const cleanAfterErr = errDoc?.status === 'error' && !existsSync(workspacePath(errScan));
    record('C', 'source NEVER persisted (success + error paths)', cleanAfterOk && redacted && cleanAfterErr, `ws-gone(ok)=${cleanAfterOk}, findings-redacted=${redacted}, ws-gone(error)=${cleanAfterErr}`);
  } catch (e) { record('C', 'source never persisted', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateD() {
  let a: AuthedClientHandle | undefined, b: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    const B = (b = await authedClient(email(), 'password123'));
    await connectGh(A.token);
    const scanId = (await deepScan(A.token)).body.scanId;
    const fid = (await getDocs(collection(A.db, 'scans', scanId, 'findings'))).docs[0]?.id;
    const checks = [
      await denied(() => getDoc(doc(B.db, 'secrets', A.uid))),
      await denied(() => getDoc(doc(B.db, 'users', A.uid))),
      await denied(() => getDoc(doc(B.db, 'scans', scanId))),
      fid ? await denied(() => getDoc(doc(B.db, 'scans', scanId, 'findings', fid))) : true,
      (await post('/createDeepScan', { github: true }, B.token)).status === 409, // B has no connection
    ];
    record('D', 'isolation (connections + deep scans)', checks.every(Boolean), `B denied [secret, profile, scan, finding] + cannot scan A's connection = ${checks.map((c) => (c ? '✓' : '✗')).join('')}`);
  } catch (e) { record('D', 'isolation', false, (e as Error).message); }
  finally { await a?.close(); await b?.close(); }
}

async function gateE() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    await connectGh(A.token);
    const before = (await getEncryptedSecret(A.uid, 'github')) !== null;
    const disc = (await post('/disconnect', { provider: 'github' }, A.token)).status;
    const after = (await getEncryptedSecret(A.uid, 'github')) === null;
    const metaGone = ((await getUser(A.uid)) as any).connections?.github === undefined;
    const scanFails = (await post('/createDeepScan', { github: true }, A.token)).status === 409;
    record('E', 'revoke deletes the credential', before && disc === 200 && after && metaGone && scanFails, `had-cred=${before}, disconnect=${disc}, cred-gone=${after}, meta-gone=${metaGone}, later-scan=${scanFails ? '409' : 'NOT 409'}`);
  } catch (e) { record('E', 'revoke', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateF() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    await connectGh(A.token);
    const scanId = (await deepScan(A.token)).body.scanId;
    const fid = (await getDocs(collection(A.db, 'scans', scanId, 'findings'))).docs[0]!.id;
    const pub = (await getDoc(doc(A.db, 'scans', scanId, 'findings', fid))).data() as any;
    const noFix = pub.fix === undefined && pub.fixPrompt === undefined;
    const privDenied = await denied(() => getDoc(doc(A.db, 'scans', scanId, 'findings', fid, 'private', 'fix')));
    record('F', 'deep-scan fixes stay locked (free plan)', noFix && privDenied, `public has no fix=${noFix}, owner private-read denied=${privDenied}`);
  } catch (e) { record('F', 'fixes locked', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateG() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    const r = await connectGh(A.token);
    const scopes: string[] = r.body.scopes || [];
    const readOnly = r.body.writeAccess === false && scopes.length > 0 && !scopes.some((s) => /write|admin|delete/i.test(s));
    const singleRepo = typeof r.body.repo === 'string' && r.body.repo.length > 0;
    record('G', 'read-only, least-privilege', readOnly && singleRepo, `scopes=[${scopes.join(', ')}], writeAccess=${r.body.writeAccess}, single-repo=${singleRepo}`);
  } catch (e) { record('G', 'read-only least-privilege', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateH() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    // bad credential
    await setConnection(A.uid, 'github', { repo: 'x/y', scopes: ['contents:read'], writeAccess: false, mock: true }, encryptJson({ mock: true, repoPath: '/no/such/path' }));
    const bad = await createDeepScanDoc(A.uid, { github: true });
    await runScanJob({ scanId: bad });
    const badOk = (await getScan(bad))?.status === 'error' && !existsSync(workspacePath(bad));
    // oversized (temporarily tiny cap)
    await connectGh(A.token);
    const orig = config.deepScanMaxBytes;
    (config as any).deepScanMaxBytes = 10;
    const big = await createDeepScanDoc(A.uid, { github: true });
    await runScanJob({ scanId: big });
    const bigDoc = await getScan(big);
    (config as any).deepScanMaxBytes = orig;
    const bigOk = bigDoc?.status === 'error' && /size cap/i.test(bigDoc?.error ?? '') && !existsSync(workspacePath(big));
    record('H', 'resilience (bad/oversized → clean error, cleaned up)', badOk && bigOk, `bad-cred error+cleaned=${badOk}, size-cap error+cleaned=${bigOk}`);
  } catch (e) { record('H', 'resilience', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateI() {
  const details: string[] = [];
  let pass = true;
  const readme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : '';
  const readmeOk = ['dev:all', 'firebase emulators', 'npm test', 'npm run gate'].every((s) => readme.includes(s)) &&
    /deep scan/i.test(readme) && /disconnect/i.test(readme) && /encrypt/i.test(readme) && /MOCK/i.test(readme) && /Before first deploy/i.test(readme) && /scope/i.test(readme);
  if (!readmeOk) pass = false;
  details.push(`README=${readmeOk}`);

  const ui = readFileSync(join(ROOT, 'dev-ui/index.html'), 'utf8');
  const uiDeep = /connect github/i.test(ui) && /connect supabase/i.test(ui) && /deep scan/i.test(ui) && /not the product/i.test(ui);
  if (!uiDeep) pass = false;
  details.push(`dev-ui deep controls=${uiDeep}`);

  const tc = await execa('npx', ['tsc', '--noEmit'], { cwd: ROOT, reject: false });
  const build = await execa('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, reject: false });
  if (tc.exitCode !== 0 || build.exitCode !== 0) pass = false;
  details.push(`typecheck=${tc.exitCode === 0}`, `build=${build.exitCode === 0}`);

  const secretsOk = !hasSecret(ROOT);
  if (!secretsOk) pass = false;
  details.push(`no-secrets=${secretsOk}`);

  const s1 = await execa('npm', ['run', 'gate'], { cwd: join(ROOT, '../veilguard-scanner'), reject: false });
  const s234 = await execa('npx', ['vitest', 'run', 'test/scan-service.test.ts', 'test/free-scan.test.ts', 'test/auth.test.ts'], { cwd: ROOT, reject: false });
  if (s1.exitCode !== 0 || s234.exitCode !== 0) pass = false;
  details.push(`slice1-gate=${s1.exitCode === 0}`, `slice2/3/4-tests=${s234.exitCode === 0}`);

  record('I', 'DX + no regressions (dev-ui, README, build, slice1–4)', pass, details.join('; '));
}

const DANGEROUS = /sk_live_[A-Za-z0-9]{6}|sk_test_[A-Za-z0-9]{6}|sb_secret_[A-Za-z0-9]{6}|whsec_[A-Za-z0-9]{6}|BEGIN (RSA )?PRIVATE KEY|AKIA[0-9A-Z]{16}/;
const SKIP = new Set(['node_modules', 'dist', '.jre', '.git', '.firebase', 'coverage', 'test-fixtures']);
function hasSecret(dir: string): boolean {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (hasSecret(p)) return true; }
    else if (st.size < 500_000 && /\.(ts|js|json|md|html|env|example|yaml|yml|rules)$|Dockerfile$|\.env/.test(e)) {
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

  await gateA(); await gateB(); await gateC(); await gateD(); await gateE(); await gateF(); await gateG(); await gateH(); await gateI();

  await new Promise<void>((r) => server.close(() => r()));

  const green = '\x1b[32m', red = '\x1b[31m', reset = '\x1b[0m';
  console.log('\n══════════════ GATE RESULTS (Slice 5) ══════════════');
  for (const r of results) {
    console.log(`  ${r.id})  ${r.pass ? green + 'PASS' : red + 'FAIL'}${reset}  ${r.label}`);
    console.log(`         ${r.detail}`);
  }
  const allPass = results.every((r) => r.pass);
  console.log('═════════════════════════════════════════════════════');
  console.log(allPass ? `${green}  ALL GATES PASS ✓${reset}\n` : `${red}  SOME GATES FAILED ✗${reset}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
