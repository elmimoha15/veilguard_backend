/**
 * Slice-4 testing gate (A–H) — auth & accounts. Runs inside
 * `firebase emulators:exec --only firestore,auth` so both emulators are up.
 *   npm run gate
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { execa } from 'execa';
import { doc, collection, query, where, orderBy, getDoc, getDocs } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { getScan, getUser } from '../shared/src/firestore.js';
import { startStaticServer, waitForTerminal } from './harness.js';
import { authedClient, clientDb, isPermissionDenied, type AuthedClientHandle } from './client.js';

const ROOT = process.cwd();
const results: { id: string; label: string; pass: boolean; detail: string }[] = [];
const record = (id: string, label: string, pass: boolean, detail: string) => results.push({ id, label, pass, detail });

let server: Server;
let baseUrl: string;
let target: { url: string; close: () => Promise<void> };
let n = 0;
const email = () => `g${Date.now()}-${++n}@test.dev`;
const scanUrl = () => `${target.url}/?i=${++n}`;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function ownedScan(token: string) {
  const scanId = (await post('/createScan', { target: { type: 'url', value: scanUrl() } }, token)).body.scanId as string;
  await waitForTerminal(scanId);
  return scanId;
}
const denied = async (fn: () => Promise<unknown>) => {
  try { await fn(); return false; } catch (e) { return isPermissionDenied(e); }
};

async function gateA() {
  let a: AuthedClientHandle | undefined, b: AuthedClientHandle | undefined;
  try {
    const e = email();
    a = await authedClient(e, 'password123');
    const me = await post('/me', {}, a.token);
    const created1 = (await getUser(a.uid))?.createdAt;
    b = await authedClient(e, 'password123');
    await post('/me', {}, b.token);
    const created2 = (await getUser(a.uid))?.createdAt;
    const own = await getDoc(doc(a.db, 'users', a.uid));
    record('A', 'sign-up creates users/{uid} (plan free, idempotent)', me.status === 200 && me.body.plan === 'free' && created1 === created2 && own.exists(), `plan=${me.body.plan}, idempotent=${created1 === created2}, self-readable=${own.exists()}`);
  } catch (e) { record('A', 'sign-up creates user', false, (e as Error).message); }
  finally { await a?.close(); await b?.close(); }
}

async function gateB() {
  let a: AuthedClientHandle | undefined;
  try {
    a = await authedClient(email(), 'password123');
    const scanId = await ownedScan(a.token);
    const owned = (await getScan(scanId))?.ownerUid === a.uid;
    const canRead = (await getDoc(doc(a.db, 'scans', scanId))).exists();
    const inList = (await getDocs(query(collection(a.db, 'scans'), where('ownerUid', '==', a.uid), orderBy('createdAt', 'desc')))).docs.some((d) => d.id === scanId);
    record('B', 'authenticated scan is owned + listable by owner', owned && canRead && inList, `ownerUid set=${owned}, owner can read=${canRead}, in my-scans=${inList}`);
  } catch (e) { record('B', 'owned scan', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateC() {
  let a: AuthedClientHandle | undefined, b: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    const B = (b = await authedClient(email(), 'password123'));
    const scanId = await ownedScan(A.token);
    await post('/me', {}, A.token);
    const fid = (await getDocs(collection(A.db, 'scans', scanId, 'findings'))).docs[0]?.id;
    const checks = [
      await denied(() => getDoc(doc(B.db, 'scans', scanId))),
      await denied(() => getDocs(collection(B.db, 'scans', scanId, 'findings'))),
      fid ? await denied(() => getDoc(doc(B.db, 'scans', scanId, 'findings', fid))) : true,
      await denied(() => getDoc(doc(B.db, 'users', A.uid))),
      await denied(() => getDocs(query(collection(B.db, 'scans'), where('ownerUid', '==', A.uid)))),
      await denied(() => getDocs(collection(B.db, 'scans'))),
    ];
    record('C', 'cross-user isolation (rules-enforced)', checks.every(Boolean), `B denied A's [scan, findings, finding, profile, owned-query, list-all] = ${checks.map((c) => (c ? '✓' : '✗')).join('')}`);
  } catch (e) { record('C', 'isolation', false, (e as Error).message); }
  finally { await a?.close(); await b?.close(); }
}

async function gateD() {
  try {
    const scanId = (await post('/createScan', { target: { type: 'url', value: scanUrl() } })).body.scanId as string;
    await waitForTerminal(scanId);
    const anonNull = (await getScan(scanId))?.ownerUid === null;
    const anon = clientDb();
    const byId = (await getDoc(doc(anon.db, 'scans', scanId))).exists();
    const listDenied = await denied(() => getDocs(collection(anon.db, 'scans')));
    await anon.close();
    record('D', 'anonymous scan unchanged (readable by id, not enumerable)', anonNull && byId && listDenied, `ownerUid=null=${anonNull}, readable-by-id=${byId}, list-denied=${listDenied}`);
  } catch (e) { record('D', 'anon still works', false, (e as Error).message); }
}

async function gateE() {
  let a: AuthedClientHandle | undefined, b: AuthedClientHandle | undefined;
  try {
    const scanId = (await post('/createScan', { target: { type: 'url', value: scanUrl() } })).body.scanId as string;
    await waitForTerminal(scanId);
    const A = (a = await authedClient(email(), 'password123'));
    const claimed = await post('/claimScan', { scanId }, A.token);
    const nowOwned = (await getScan(scanId))?.ownerUid === A.uid;
    const B = (b = await authedClient(email(), 'password123'));
    const reclaim = await post('/claimScan', { scanId }, B.token);
    const missing = await post('/claimScan', { scanId: 'nope' }, A.token);
    record('E', 'claim anonymous scan (owned; re-claim 409; missing 404)', claimed.status === 200 && nowOwned && reclaim.status === 409 && missing.status === 404, `claim=${claimed.status}, ownerUid set=${nowOwned}, other-user reclaim=${reclaim.status}, nonexistent=${missing.status}`);
  } catch (e) { record('E', 'claim flow', false, (e as Error).message); }
  finally { await a?.close(); await b?.close(); }
}

async function gateF() {
  let a: AuthedClientHandle | undefined;
  try {
    const A = (a = await authedClient(email(), 'password123'));
    const scanId = await ownedScan(A.token);
    const fid = (await getDocs(collection(A.db, 'scans', scanId, 'findings'))).docs[0]!.id;
    const pub = (await getDoc(doc(A.db, 'scans', scanId, 'findings', fid))).data() as any;
    const noFix = pub.fix === undefined && pub.fixPrompt === undefined;
    const privDenied = await denied(() => getDoc(doc(A.db, 'scans', scanId, 'findings', fid, 'private', 'fix')));
    record('F', 'fixes stay locked for authed owner on free plan', noFix && privDenied, `public has no fix=${noFix}, owner private-read denied=${privDenied}`);
  } catch (e) { record('F', 'fix still locked', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateG() {
  let a: AuthedClientHandle | undefined;
  try {
    a = await authedClient(email(), 'password123');
    const noTok = (await post('/me', {})).status;
    const badTok = (await post('/me', {}, 'bogus.token')).status;
    const goodTok = (await post('/me', {}, a.token)).status;
    const claimNoTok = (await post('/claimScan', { scanId: 'x' })).status;
    const scanBad = (await post('/createScan', { target: { type: 'url', value: scanUrl() } }, 'bad')).status;
    const scanAnon = (await post('/createScan', { target: { type: 'url', value: scanUrl() } })).status;
    record('G', 'token verification (401 on bad/missing, 200 on valid)', noTok === 401 && badTok === 401 && goodTok === 200 && claimNoTok === 401 && scanBad === 401 && scanAnon === 202, `/me no-token=${noTok}, bad=${badTok}, valid=${goodTok}; /claim no-token=${claimNoTok}; createScan bad=${scanBad}, anon=${scanAnon}`);
  } catch (e) { record('G', 'token verification', false, (e as Error).message); }
  finally { await a?.close(); }
}

async function gateH() {
  const details: string[] = [];
  let pass = true;
  const readme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : '';
  const readmeOk = ['dev:all', 'firebase emulators', 'npm test', 'npm run gate'].every((s) => readme.includes(s)) && /sign.?up|log.?in|auth/i.test(readme) && /claim/i.test(readme) && /throwaway/i.test(readme);
  if (!readmeOk) pass = false;
  details.push(`README=${readmeOk}`);

  const ui = readFileSync(join(ROOT, 'dev-ui/index.html'), 'utf8');
  const uiAuth = /sign ?up/i.test(ui) && /log ?in/i.test(ui) && /google/i.test(ui) && /github/i.test(ui) && /not the product/i.test(ui);
  if (!uiAuth) pass = false;
  details.push(`dev-ui auth controls + throwaway=${uiAuth}`);

  const tc = await execa('npx', ['tsc', '--noEmit'], { cwd: ROOT, reject: false });
  const build = await execa('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, reject: false });
  if (tc.exitCode !== 0 || build.exitCode !== 0) pass = false;
  details.push(`typecheck=${tc.exitCode === 0}`, `build=${build.exitCode === 0}`);

  const secretsOk = !hasSecret(ROOT);
  if (!secretsOk) pass = false;
  details.push(`no-secrets=${secretsOk}`);

  // No regressions: Slice 1 gate + Slice 2/3 integration tests (this emulator).
  const s1 = await execa('npm', ['run', 'gate'], { cwd: join(ROOT, '../veilguard-scanner'), reject: false });
  const s23 = await execa('npx', ['vitest', 'run', 'test/scan-service.test.ts', 'test/free-scan.test.ts'], { cwd: ROOT, reject: false });
  if (s1.exitCode !== 0 || s23.exitCode !== 0) pass = false;
  details.push(`slice1-gate=${s1.exitCode === 0}`, `slice2+3-tests=${s23.exitCode === 0}`);

  record('H', 'DX + no regressions (dev-ui auth, README, build, slice1/2/3)', pass, details.join('; '));
}

const DANGEROUS = /sk_live_[A-Za-z0-9]{6}|sk_test_[A-Za-z0-9]{6}|sb_secret_[A-Za-z0-9]{6}|whsec_[A-Za-z0-9]{6}|BEGIN (RSA )?PRIVATE KEY|AKIA[0-9A-Z]{16}/;
const SKIP = new Set(['node_modules', 'dist', '.jre', '.git', '.firebase', 'coverage']);
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

  await gateA(); await gateB(); await gateC(); await gateD(); await gateE(); await gateF(); await gateG(); await gateH();

  await new Promise<void>((r) => server.close(() => r()));
  await target.close();

  const green = '\x1b[32m', red = '\x1b[31m', reset = '\x1b[0m';
  console.log('\n══════════════ GATE RESULTS (Slice 4) ══════════════');
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
