/**
 * Slice-3 testing gate (A–G). Runs inside `firebase emulators:exec` so
 * FIRESTORE_EMULATOR_HOST is set. Prints GATE RESULTS.  →  npm run gate
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { execa } from 'execa';
import { doc, collection, getDoc, getDocs, onSnapshot } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { handleCreateScan } from '../functions/src/createScan.js';
import { resetRateLimit } from '../functions/src/rate-limit.js';
import type { Queue } from '../shared/src/queue.js';
import { config } from '../shared/src/config.js';
import { getScan, listFindings, readPrivateFix, createScanDoc } from '../shared/src/firestore.js';
import { startStaticServer, waitForTerminal, sleep, localQueue } from './harness.js';
import { clientDb, isPermissionDenied } from './client.js';
import { runUiCheck } from './ui-check.js';

const ROOT = process.cwd();
const results: { id: string; label: string; pass: boolean; detail: string }[] = [];
const record = (id: string, label: string, pass: boolean, detail: string) => results.push({ id, label, pass, detail });

let server: Server;
let baseUrl: string;
let target: { url: string; close: () => Promise<void> };

async function createViaHttp(value: string) {
  const res = await fetch(`${baseUrl}/createScan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { type: 'url', value } }),
  });
  return { status: res.status, body: (await res.json()) as { scanId?: string; error?: string } };
}

/** Client-SDK stream capture with reliable admin-driven completion. */
async function watch(scanId: string) {
  const { db, close } = clientDb();
  const statuses: string[] = [];
  const progress: number[] = [];
  const sizes: number[] = [];
  const u1 = onSnapshot(doc(db, 'scans', scanId), (s) => { const d = s.data() as any; if (d) { statuses.push(d.status); if (d.progress) progress.push(d.progress.done); } }, () => {});
  const u2 = onSnapshot(collection(db, 'scans', scanId, 'findings'), (s) => sizes.push(s.size), () => {});
  await waitForTerminal(scanId, 30_000);
  await sleep(300);
  u1(); u2(); await close();
  return { statuses, progress, sizes };
}

async function gateA(): Promise<string | null> {
  try {
    const t0 = Date.now();
    const res = await createViaHttp(target.url);
    const ms = Date.now() - t0;
    const scanId = res.body.scanId!;
    const immediate = await getScan(scanId); // must not have finished inline
    await watch(scanId);
    const done = await getScan(scanId);
    const findings = await listFindings(scanId);
    const pass = res.status === 202 && ms < 1200 && ['queued', 'running'].includes(immediate?.status ?? '') && done?.status === 'done' && findings.length > 0;
    record('A', 'end-to-end via HTTP (browser-mirroring)', pass, `createScan ${ms}ms→202, at-return=${immediate?.status}, final=${done?.status}, findings=${findings.length}`);
    return scanId;
  } catch (e) {
    record('A', 'end-to-end via HTTP (browser-mirroring)', false, (e as Error).message);
    return null;
  }
}

async function gateB() {
  try {
    // Subscribe the CLIENT *before* the worker starts, so it reliably observes
    // the live progression (queued→running→done + findings appearing), even for
    // a fast black-box scan. Proves the browser would see a live stream.
    const scanId = await createScanDoc({ type: 'url', value: target.url });
    const { db, close } = clientDb();
    const statuses: string[] = [];
    const progress: number[] = [];
    const sizes: number[] = [];
    const u1 = onSnapshot(doc(db, 'scans', scanId), (s) => { const d = s.data() as any; if (d) { statuses.push(d.status); if (d.progress) progress.push(d.progress.done); } }, () => {});
    const u2 = onSnapshot(collection(db, 'scans', scanId, 'findings'), (s) => sizes.push(s.size), () => {});
    await sleep(150); // let the initial "queued" snapshot land before enqueue
    await localQueue().enqueue({ scanId });
    await waitForTerminal(scanId, 30_000);
    await sleep(300);
    u1(); u2(); await close();

    const distinctStatuses = new Set(statuses).size;
    const distinctProgress = new Set(progress).size;
    const finalSize = Math.max(...sizes, 0);
    const partial = sizes.some((n) => n > 0 && n < finalSize) || new Set(sizes.filter((n) => n > 0)).size >= 2;
    // Any of these proves live, over-time delivery (not one terminal batch).
    const pass = distinctStatuses >= 2 || distinctProgress >= 2 || partial;
    record('B', 'live stream to a subscribing client', pass, `client saw statuses=[${[...new Set(statuses)].join('→')}], ${distinctProgress} progress steps, incremental findings=${partial}`);
  } catch (e) {
    record('B', 'live stream to a subscribing client', false, (e as Error).message);
  }
}

async function gateC(scanId: string) {
  try {
    const fid = (await getDocs(collection(clientDb().db, 'scans', scanId, 'findings'))).docs[0]!.id;
    const { db, close } = clientDb();
    const pub = await getDoc(doc(db, 'scans', scanId, 'findings', fid));
    const data = pub.data() as any;
    const noFix = data.fix === undefined && data.fixPrompt === undefined && !!data.title;
    let denied = false;
    try { await getDoc(doc(db, 'scans', scanId, 'findings', fid, 'private', 'fix')); } catch (e) { denied = isPermissionDenied(e); }
    await close();
    const priv = await readPrivateFix(scanId, fid);
    const adminCanRead = !!(priv?.fix || priv?.fixPrompt);
    record('C', 'fix-locking at the data layer', noFix && denied && adminCanRead, `client public-fields-only=${noFix}, client private read denied=${denied}, admin can read=${adminCanRead}`);
  } catch (e) {
    record('C', 'fix-locking at the data layer', false, (e as Error).message);
  }
}

async function gateD(scanId: string) {
  try {
    const { db, close } = clientDb();
    let listDenied = false;
    try { await getDocs(collection(db, 'scans')); } catch (e) { listDenied = isPermissionDenied(e); }
    const known = await getDoc(doc(db, 'scans', scanId));
    const findings = await getDocs(collection(db, 'scans', scanId, 'findings'));
    await close();
    record('D', 'no enumeration (list denied, known id ok)', listDenied && known.exists() && findings.size > 0, `list scans denied=${listDenied}, read known scan=${known.exists()}, list its findings=${findings.size}`);
  } catch (e) {
    record('D', 'no enumeration (list denied, known id ok)', false, (e as Error).message);
  }
}

async function gateE() {
  try {
    const noop: Queue = { enqueue: async () => {} };
    const g = (value: string, type: 'url' | 'repo' = 'url') => handleCreateScan({ target: { type, value } }, noop, { allowPrivateTargets: false });
    const rejects =
      (await g('/repo', 'repo')).status === 400 &&
      (await g('http://localhost')).status === 400 &&
      (await g('http://127.0.0.1:8080')).status === 400 &&
      (await g('http://10.1.2.3')).status === 400 &&
      (await g('ftp://example.com')).status === 400;
    resetRateLimit();
    const codes: number[] = [];
    for (let i = 0; i < config.rateLimitMax + 2; i++) {
      codes.push((await handleCreateScan({ target: { type: 'url', value: 'https://rl.example.com' } }, noop, { allowPrivateTargets: false, clientIp: '9.9.9.9' })).status);
    }
    const rl = codes.filter((c) => c === 202).length === config.rateLimitMax && codes.at(-1) === 429;
    record('E', 'abuse guards (repo/localhost/private/scheme + rate limit)', rejects && rl, `bad targets rejected=${rejects}; rate-limited after ${config.rateLimitMax} (codes ${codes.join(',')})`);
  } catch (e) {
    record('E', 'abuse guards', false, (e as Error).message);
  }
}

async function gateF() {
  const r = await runUiCheck();
  record('F', 'throwaway UI free-scan flow (scripted browser-equivalent)', r.pass, r.detail);
}

async function gateG() {
  const details: string[] = [];
  let pass = true;
  const readme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : '';
  const readmeOk = ['dev:all', 'firebase emulators', 'npm test', 'npm run gate'].every((s) => readme.includes(s)) && /fix.?lock|locked/i.test(readme) && /throwaway/i.test(readme);
  if (!readmeOk) pass = false;
  details.push(`README=${readmeOk}`);

  const uiLabeled = /not the product/i.test(readFileSync(join(ROOT, 'dev-ui/index.html'), 'utf8'));
  if (!uiLabeled) pass = false;
  details.push(`dev-ui labeled throwaway=${uiLabeled}`);

  const tc = await execa('npx', ['tsc', '--noEmit'], { cwd: ROOT, reject: false });
  const build = await execa('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, reject: false });
  if (tc.exitCode !== 0 || build.exitCode !== 0) pass = false;
  details.push(`typecheck=${tc.exitCode === 0}`, `build=${build.exitCode === 0}`);

  const secretsOk = !hasSecret(ROOT);
  if (!secretsOk) pass = false;
  details.push(`no-secrets=${secretsOk}`);

  // No regressions: Slice 1 gate + Slice 2 integration tests (reuse this emulator).
  const s1 = await execa('npm', ['run', 'gate'], { cwd: join(ROOT, '../veilguard-scanner'), reject: false });
  const s1ok = s1.exitCode === 0;
  const s2 = await execa('npx', ['vitest', 'run', 'test/scan-service.test.ts'], { cwd: ROOT, reject: false });
  const s2ok = s2.exitCode === 0;
  if (!s1ok || !s2ok) pass = false;
  details.push(`slice1-gate=${s1ok}`, `slice2-tests=${s2ok}`);

  record('G', 'DX + no regressions (typecheck/build/README/secrets/slice1+2)', pass, details.join('; '));
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
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      done();
    });
  });
  await getScan('warmup');

  const scanId = await gateA();
  await gateB();
  if (scanId) { await gateC(scanId); await gateD(scanId); }
  else { record('C', 'fix-locking at the data layer', false, 'no scan'); record('D', 'no enumeration', false, 'no scan'); }
  await gateE();
  await gateF();
  await gateG();

  await new Promise<void>((r) => server.close(() => r()));
  await target.close();

  const green = '\x1b[32m', red = '\x1b[31m', reset = '\x1b[0m';
  console.log('\n══════════════ GATE RESULTS (Slice 3) ══════════════');
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
