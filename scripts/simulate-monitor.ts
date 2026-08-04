/**
 * On-demand monitoring re-scan — the missing "re-scan now" for testing that
 * monitoring catches NEW holes. Works for URL apps (which have no UI trigger)
 * and connected repos. Ensures a monitored app record exists for the target,
 * enqueues a monitor scan through the in-process worker (so the worker runs
 * recordMonitoringResult → monitorEvents + alert), waits, and prints the diff.
 *
 *   npm run simulate:monitor -- --uid <uid> --url https://<ngrok>.ngrok-free.app
 *   npm run simulate:monitor -- --uid <uid> --repo owner/vuln-saas
 *   (add --paid to flip the user to a paid plan first; --severity high to alert on highs too)
 *
 * Run with the SAME Firebase env as the backend you're testing (emulator dev:all,
 * or dev:real with GCLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS). Monitoring is
 * a paid feature — use --paid, DEV_FAKE_PAID=1 (emulator), or a paid plan.
 */
import { loadEnv } from '../functions/src/loadEnv.js';
import { makeQueue } from '../shared/src/queue.js';
import { runScanJob } from '../worker/src/runScan.js';
import { enqueueMonitorScan, userApps } from '../shared/src/monitor.js';
import { getDb, getUser, getScan, setPlan } from '../shared/src/firestore.js';
import type { AlertSeverity, MonitorEvent } from '../shared/src/types.js';

// Pull GOOGLE_APPLICATION_CREDENTIALS (read lazily by the Admin SDK) from .env.
// GCLOUD_PROJECT is set by the npm script — config.ts reads it at import time.
loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function slug(s: string): string {
  return 'vs-' + s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

async function waitForScan(scanId: string, timeoutMs = 180_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const s = await getScan(scanId);
    if (s && (s.status === 'done' || s.status === 'error')) return s.status;
    if (Date.now() - start > timeoutMs) return 'timeout';
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const uid = arg('uid');
  const url = arg('url');
  const repo = arg('repo');
  const severity = (arg('severity') as AlertSeverity | undefined) ?? 'critical';
  if (!uid || (!url && !repo)) {
    console.error('usage: simulate:monitor --uid <uid> (--url <url> | --repo owner/name) [--paid] [--severity critical|high]');
    process.exit(1);
  }

  if (has('paid')) {
    await setPlan(uid, 'guard');
    console.log(`  set plan → guard for ${uid} (test-only)`);
  }

  const user = await getUser(uid);
  if (!user) { console.error(`  no user doc for ${uid}`); process.exit(1); }

  // Ensure a monitored app record for the target.
  const apps = userApps(user);
  const id = slug(url ?? repo!);
  const name = url ? hostOf(url) : repo!;
  let app = apps.find((a) => a.id === id) ?? apps.find((a) => (url ? a.url === url : a.githubRepo === repo));
  if (!app) {
    app = { id, name, createdAt: new Date().toISOString(), monitoring: { cadence: 'daily', emailAlerts: true, severity } };
    if (url) app.url = url; else app.githubRepo = repo!;
    apps.push(app);
  } else {
    app.monitoring = { cadence: 'daily', emailAlerts: true, severity };
    if (url) app.url = url; else app.githubRepo = repo!;
  }
  await getDb().collection('users').doc(uid).set({ apps }, { merge: true });
  console.log(`  app: ${app.id} (${url ? url : repo})  monitoring=daily severity=${severity}`);

  // Enqueue the monitor scan and let the in-process worker run it (+ diff/alert).
  const queue = makeQueue(runScanJob);
  const scanId = await enqueueMonitorScan(uid, app, queue);
  if (!scanId) {
    console.error('  enqueue skipped — either not a paid plan (use --paid / DEV_FAKE_PAID=1), a scan is already in flight, or nothing scannable (repo needs a GitHub connection).');
    process.exit(1);
  }
  console.log(`  enqueued monitor scan ${scanId} — waiting…`);
  const status = await waitForScan(scanId);
  console.log(`  scan ${scanId} → ${status}`);

  // The worker writes a monitorEvents doc keyed by scanId on completion.
  const ev = await getDb().collection('monitorEvents').where('scanId', '==', scanId).limit(1).get();
  if (ev.empty) {
    console.log('\n  no monitorEvents doc yet (baseline scans with no prior scan still record one shortly).');
  } else {
    const e = ev.docs[0]!.data() as MonitorEvent;
    console.log('\n──────── monitorEvents ────────');
    console.log(`  prevScanId : ${e.prevScanId ?? '(none — this is the BASELINE, no alert)'}`);
    console.log(`  grade      : ${e.gradeBefore ?? '—'} → ${e.gradeAfter ?? '—'}`);
    console.log(`  alerted    : ${e.alerted}`);
    console.log(`  NEW (${e.newFindings.length}):`);
    for (const f of e.newFindings) console.log(`     • [${f.severity}] ${f.title}${f.where ? ` — ${f.where}` : ''}`);
    console.log(`  resolved   : ${e.resolvedFindings.length}`);
    console.log('───────────────────────────────');
    console.log(e.alerted ? '\n  ✓ ALERT fired (check email: console transport, or Resend if RESEND_API_KEY set).' : '\n  (no alert — run once for a baseline, add a new hole, then re-run.)');
  }
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
