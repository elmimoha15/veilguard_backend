/**
 * Slice-2 testing gate. Runs inside `firebase emulators:exec` (so
 * FIRESTORE_EMULATOR_HOST is set) and prints GATE RESULTS (A–G).
 *   npm run gate
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { FindingSchema } from '../shared/src/types.js';
import { getDb, getScan, listFindings } from '../shared/src/firestore.js';
import { runScanJob } from '../worker/src/runScan.js';
import {
  QUICKCART_PATH,
  createScan,
  runFullScan,
  waitForTerminal,
  startStaticServer,
  sleep,
} from './harness.js';

const ROOT = process.cwd();
const results: { id: string; label: string; pass: boolean; detail: string }[] = [];
const record = (id: string, label: string, pass: boolean, detail: string) => results.push({ id, label, pass, detail });

async function gateA() {
  try {
    const { doc, findings } = await runFullScan({ type: 'repo', value: QUICKCART_PATH });
    const schemaOk = findings.every((f) => FindingSchema.safeParse(f).success);
    const pass = doc.status === 'done' && doc.grade === 'F' && doc.counts?.critical === 13 && findings.length >= 12 && schemaOk;
    record('A', 'create→queue→run→done (QuickCart)', pass, `status=${doc.status}, grade=${doc.grade}, critical=${doc.counts?.critical}, findings=${findings.length}, schemaOk=${schemaOk}`);
  } catch (e) {
    record('A', 'create→queue→run→done (QuickCart)', false, (e as Error).message);
  }
}

async function gateB() {
  try {
    const res = await createScan({ type: 'repo', value: QUICKCART_PATH });
    const { scanId } = res.body as { scanId: string };
    const progress: number[] = [];
    const sizes: number[] = [];
    const db = getDb();
    const u1 = db.collection('scans').doc(scanId).onSnapshot((s) => {
      const d = s.data() as { progress?: { done: number } } | undefined;
      if (d?.progress) progress.push(d.progress.done);
    });
    const u2 = db.collection('scans').doc(scanId).collection('findings').onSnapshot((s) => sizes.push(s.size));
    await waitForTerminal(scanId);
    await sleep(150);
    u1();
    u2();
    const distinct = new Set(progress).size;
    const finalSize = Math.max(...sizes, 0);
    const sawPartial = sizes.some((n) => n > 0 && n < finalSize);
    const pass = distinct >= 2 && sawPartial;
    record('B', 'live streaming (incremental writes)', pass, `distinct progress steps=${distinct}, partial finding snapshots=${sawPartial} (final=${finalSize})`);
  } catch (e) {
    record('B', 'live streaming (incremental writes)', false, (e as Error).message);
  }
}

async function gateC() {
  try {
    const t0 = Date.now();
    const res = await createScan({ type: 'repo', value: QUICKCART_PATH });
    const ms = Date.now() - t0;
    const { scanId } = res.body as { scanId: string };
    const doc = await getScan(scanId);
    const pass = res.status === 202 && ms < 500 && doc?.status === 'queued';
    record('C', 'fast API, non-blocking', pass, `returned in ${ms}ms, status-at-return=${doc?.status}`);
    await waitForTerminal(scanId);
  } catch (e) {
    record('C', 'fast API, non-blocking', false, (e as Error).message);
  }
}

async function gateD() {
  try {
    const bad = await runFullScan({ type: 'repo', value: '/definitely/not/a/real/repo' });
    const url = await runFullScan({ type: 'url', value: 'http://127.0.0.1:59997' });
    const pass = bad.doc.status === 'error' && !!bad.doc.error && url.doc.status === 'error' && !!url.doc.finishedAt;
    record('D', 'error handling (bad target → error)', pass, `repo: ${bad.doc.status} "${bad.doc.error}"; url: ${url.doc.status} "${url.doc.error}"`);
  } catch (e) {
    record('D', 'error handling (bad target → error)', false, (e as Error).message);
  }
}

async function gateE() {
  try {
    const { scanId, doc, findings } = await runFullScan({ type: 'repo', value: QUICKCART_PATH });
    const finishedAt = doc.finishedAt;
    await runScanJob({ scanId }); // second call
    const doc2 = await getScan(scanId);
    const findings2 = await listFindings(scanId);
    const pass = doc2?.status === 'done' && doc2?.finishedAt === finishedAt && findings2.length === findings.length;
    record('E', 'idempotency (2nd /runScan no-ops)', pass, `finishedAt stable=${doc2?.finishedAt === finishedAt}, findings ${findings.length}→${findings2.length}`);
  } catch (e) {
    record('E', 'idempotency (2nd /runScan no-ops)', false, (e as Error).message);
  }
}

async function gateF() {
  const server = await startStaticServer();
  try {
    const { doc, findings } = await runFullScan({ type: 'url', value: server.url });
    const webConfig = findings.filter((f) => f.category === 'web_config').length;
    const pass = doc.status === 'done' && webConfig > 0 && findings.every((f) => f.mode === 'blackbox');
    record('F', 'black-box URL path', pass, `status=${doc.status}, web_config findings=${webConfig}`);
  } catch (e) {
    record('F', 'black-box URL path', false, (e as Error).message);
  } finally {
    await server.close();
  }
}

async function gateG() {
  const details: string[] = [];
  let pass = true;

  // README references.
  const readme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : '';
  const readmeOk = ['firebase emulators:start', 'npm test', 'npm run gate'].every((s) => readme.includes(s)) && /worker/i.test(readme);
  if (!readmeOk) pass = false;
  details.push(`README refs=${readmeOk}`);

  // typecheck + build.
  const tc = await execa('npx', ['tsc', '--noEmit'], { cwd: ROOT, reject: false });
  const tcOk = tc.exitCode === 0;
  const build = await execa('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, reject: false });
  const buildOk = build.exitCode === 0;
  if (!tcOk || !buildOk) pass = false;
  details.push(`typecheck=${tcOk}`, `build=${buildOk}`);

  // Dockerfile present (build deferred — no Docker daemon in this environment).
  const dockerfileOk = existsSync(join(ROOT, 'worker/Dockerfile'));
  if (!dockerfileOk) pass = false;
  details.push(`Dockerfile present=${dockerfileOk} (build deferred: no local Docker daemon)`);

  // No committed secrets.
  const secretsOk = !hasCommittedSecret(ROOT);
  if (!secretsOk) pass = false;
  details.push(`no-secrets=${secretsOk}`);

  record('G', 'DX: README, typecheck, build, Dockerfile, no secrets', pass, details.join('; '));
}

const DANGEROUS = /sk_live_[A-Za-z0-9]{6}|sk_test_[A-Za-z0-9]{6}|sb_secret_[A-Za-z0-9]{6}|whsec_[A-Za-z0-9]{6}|BEGIN (RSA )?PRIVATE KEY|AKIA[0-9A-Z]{16}/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.jre', '.git', '.firebase']);
function hasCommittedSecret(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (hasCommittedSecret(p)) return true;
    } else if (st.size < 500_000 && /\.(ts|js|json|md|env|example|yaml|yml|rules|Dockerfile)$|Dockerfile$|\.env/.test(entry)) {
      if (DANGEROUS.test(readFileSync(p, 'utf8'))) {
        console.error(`  secret-like content in ${p}`);
        return true;
      }
    }
  }
  return false;
}

async function main() {
  // Run gates sequentially so their Firestore listeners don't interfere.
  await gateA();
  await gateB();
  await gateC();
  await gateD();
  await gateE();
  await gateF();
  await gateG();

  const green = '\x1b[32m';
  const red = '\x1b[31m';
  const reset = '\x1b[0m';
  console.log('\n══════════════ GATE RESULTS (Slice 2) ══════════════');
  for (const r of results) {
    console.log(`  ${r.id})  ${r.pass ? green + 'PASS' : red + 'FAIL'}${reset}  ${r.label}`);
    console.log(`         ${r.detail}`);
  }
  const allPass = results.every((r) => r.pass);
  console.log('═════════════════════════════════════════════════════');
  console.log(allPass ? `${green}  ALL GATES PASS ✓${reset}\n` : `${red}  SOME GATES FAILED ✗${reset}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
