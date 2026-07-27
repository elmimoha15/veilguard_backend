/**
 * Slice 7 — Monitoring gate (A–J). Runs on the emulator with mock connections.
 * Reuses the QuickCart (broken) + clean-app fixtures to simulate "a new critical
 * appeared between scans". Email goes through the console transport, whose
 * captured outbox we assert against.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { doc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { getDb, getScan, listFindings } from '../shared/src/firestore.js';
import { canUseMonitoring, enqueueMonitorScan, getMonitorRun } from '../shared/src/monitor.js';
import { runDueSchedules } from '../functions/src/runSchedules.js';
import { getSentEmails, resetSentEmails } from '../shared/src/email.js';
import { config } from '../shared/src/config.js';
import { workspacePath } from '../worker/src/deepScan.js';
import { QUICKCART_PATH, waitForTerminal, localQueue, sleep } from './harness.js';
import { authedClient, isPermissionDenied, type AuthedClientHandle } from './client.js';
import type { RegistryApp, MonitorEvent } from '../shared/src/types.js';

const CLEAN_PATH = resolve(process.cwd(), '../veilguard-scanner/test-fixtures/safe/clean-app');

let server: Server;
let baseUrl: string;
let m = 0;
const email = () => `mon-${Date.now()}-${++m}@test.dev`;
const uniq = () => `${Date.now()}-${++m}`;

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
const connectGh = (t: string, repoPath = QUICKCART_PATH) => post('/connectGitHub', { repoPath }, t);
const setApps = (uid: string, apps: RegistryApp[]) => getDb().collection('users').doc(uid).set({ apps }, { merge: true });

function signPush(bodyStr: string): string {
  return `sha256=${createHmac('sha256', config.githubWebhookSecret).update(bodyStr).digest('hex')}`;
}
async function postWebhook(payload: unknown, opts: { sign?: boolean; event?: string } = {}) {
  const bodyStr = JSON.stringify(payload);
  const sig = opts.sign === false ? 'sha256=deadbeefdeadbeef' : signPush(bodyStr);
  const res = await fetch(`${baseUrl}/githubWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, 'x-github-event': opts.event ?? 'push' },
    body: bodyStr,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeout = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await sleep(100);
  }
}
async function eventForScan(scanId: string): Promise<MonitorEvent | null> {
  const snap = await getDb().collection('monitorEvents').where('scanId', '==', scanId).limit(1).get();
  return snap.empty ? null : (snap.docs[0]!.data() as MonitorEvent);
}
function app(over: Partial<RegistryApp>): RegistryApp {
  return { id: `app-${uniq()}`, name: 'Test App', createdAt: new Date().toISOString(), ...over };
}

/** Baseline (clean) → introduce-broken (quickcart) monitoring scans for one app. */
async function baselineThenBroken(A: AuthedClientHandle, a: RegistryApp) {
  await post('/me', {}, A.token);
  await setApps(A.uid, [a]);
  await connectGh(A.token, CLEAN_PATH);
  const baseId = (await enqueueMonitorScan(A.uid, a, localQueue()))!;
  await waitForTerminal(baseId);
  await waitFor(() => eventForScan(baseId)); // baseline event recorded
  await connectGh(A.token, QUICKCART_PATH); // "a new critical is introduced"
  const brokenId = (await enqueueMonitorScan(A.uid, a, localQueue()))!;
  await waitForTerminal(brokenId);
  const ev = await waitFor(() => eventForScan(brokenId));
  return { baseId, brokenId, ev };
}

describe('A — scheduled re-scan enqueues + completes, run state updates', () => {
  it('a due monitored app is scanned by the scheduler; lastScanId/lastGrade update', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    await post('/me', {}, a.token);
    await connectGh(a.token, QUICKCART_PATH);
    const reg = app({ githubRepo: `me/sched-${uniq()}`, monitoring: { cadence: 'daily', emailAlerts: true } });
    await setApps(a.uid, [reg]);

    const result = await runDueSchedules(localQueue());
    const mine = result.enqueued.find((e) => e.uid === a.uid && e.appId === reg.id);
    expect(mine).toBeTruthy();

    const d = await waitForTerminal(mine!.scanId);
    expect(d.type).toBe('deep');
    expect(d.origin).toBe('monitor');
    expect(d.appId).toBe(reg.id);

    const run = await waitFor(() => getMonitorRun(a.uid, reg.id).then((r) => (r?.lastScanId ? r : null)));
    expect(run.lastScanId).toBe(mine!.scanId);
    expect(run.lastGrade).toBe('F');
    await a.close();
  });
});

describe('B — deploy-triggered re-scan (verified webhook only)', () => {
  it('verified push enqueues a deep scan for the right app; spoofed push is rejected', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    await post('/me', {}, a.token);
    await connectGh(a.token, QUICKCART_PATH);
    const repo = `me/hook-${uniq()}`;
    const reg = app({ githubRepo: repo, monitoring: { cadence: 'push', emailAlerts: true } });
    await setApps(a.uid, [reg]);

    // Spoofed signature → rejected, nothing enqueued.
    const spoof = await postWebhook({ repository: { full_name: repo } }, { sign: false });
    expect(spoof.status).toBe(401);

    // Verified push → 202 + enqueued for A's app.
    const ok = await postWebhook({ repository: { full_name: repo } });
    expect(ok.status).toBe(202);
    const mine = (ok.body.enqueued as { uid: string; appId: string; scanId: string }[]).find((e) => e.uid === a.uid);
    expect(mine?.appId).toBe(reg.id);

    const d = await waitForTerminal(mine!.scanId);
    expect(d.origin).toBe('monitor');
    expect(d.type).toBe('deep');
    await a.close();
  });
});

describe('C — new-issue detection via diff', () => {
  it('a re-scan that introduces a new critical produces a new-findings event + grade drop; no-change = no new findings', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    const reg = app({ githubRepo: `me/diff-${uniq()}`, monitoring: { cadence: 'daily', emailAlerts: true } });
    const { brokenId, ev } = await baselineThenBroken(a, reg);

    expect(ev.gradeAfter).toBe('F');
    expect(ev.gradeBefore).not.toBe('F'); // clean baseline graded better → a drop
    expect(ev.newFindings.some((f) => f.severity === 'critical')).toBe(true);
    expect(ev.prevScanId).toBeTruthy();

    // A third scan with no code change → nothing new.
    const sameId = (await enqueueMonitorScan(a.uid, reg, localQueue()))!;
    await waitForTerminal(sameId);
    const ev3 = await waitFor(() => eventForScan(sameId));
    expect(ev3.newFindings.length).toBe(0);
    await a.close();
  });
});

describe('D — email alert on new critical, deduped', () => {
  it('one email on the new critical; a still-open finding does NOT re-alert', async () => {
    resetSentEmails();
    const a = await authedClient(email(), 'password123', 'guard');
    const reg = app({ githubRepo: `me/email-${uniq()}`, monitoring: { cadence: 'daily', emailAlerts: true } });
    const { ev } = await baselineThenBroken(a, reg);
    expect(ev.alerted).toBe(true);

    const sent = await waitFor(async () => (getSentEmails().length > 0 ? [...getSentEmails()] : null));
    const mine = sent.filter((e) => (e.meta?.appId as string) === reg.id);
    expect(mine.length).toBe(1);
    expect(mine[0]!.subject).toMatch(/new security issue/i);
    const countAfterFirst = getSentEmails().filter((e) => (e.meta?.appId as string) === reg.id).length;

    // Re-scan with the SAME broken code → the finding is still open, not NEW → no new email.
    const sameId = (await enqueueMonitorScan(a.uid, reg, localQueue()))!;
    await waitForTerminal(sameId);
    await waitFor(() => eventForScan(sameId));
    await sleep(300);
    const countAfterSecond = getSentEmails().filter((e) => (e.meta?.appId as string) === reg.id).length;
    expect(countAfterSecond).toBe(countAfterFirst); // deduped: no re-alert
    await a.close();
  });
});

describe('E — respects preferences (email off)', () => {
  it('with emailAlerts off, no email is sent but the in-app event is still recorded', async () => {
    resetSentEmails();
    const a = await authedClient(email(), 'password123', 'guard');
    const reg = app({ githubRepo: `me/pref-${uniq()}`, monitoring: { cadence: 'daily', emailAlerts: false } });
    const { ev } = await baselineThenBroken(a, reg);

    expect(ev.newFindings.some((f) => f.severity === 'critical')).toBe(true); // detected
    expect(ev.alerted).toBe(false); // but not alerted
    await sleep(300);
    expect(getSentEmails().filter((e) => (e.meta?.appId as string) === reg.id).length).toBe(0);
    await a.close();
  });
});

describe('F — isolation of monitoring data', () => {
  it('user B cannot read A’s monitorEvents / monitorRuns', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    const b = await authedClient(email(), 'password123', 'guard');
    const reg = app({ githubRepo: `me/iso-${uniq()}`, monitoring: { cadence: 'daily', emailAlerts: true } });
    const { brokenId, ev } = await baselineThenBroken(a, reg);

    const denied = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch (e) { return isPermissionDenied(e); } };
    expect(await denied(() => getDoc(doc(b.db, 'monitorEvents', ev.id)))).toBe(true);
    expect(await denied(() => getDoc(doc(b.db, 'monitorRuns', `${a.uid}__${reg.id}`)))).toBe(true);
    // A cross-user list query is not authorized either.
    expect(await denied(() => getDocs(query(collection(b.db, 'monitorEvents'), where('uid', '==', a.uid))))).toBe(true);
    void brokenId;
    await a.close(); await b.close();
  });
});

describe('G — safety: no source stored, workspace cleaned, pushes debounced', () => {
  it('monitoring deep scan leaves no workspace + redacted findings; rapid pushes debounce to one scan', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    await post('/me', {}, a.token);
    await connectGh(a.token, QUICKCART_PATH);
    const repo = `me/safe-${uniq()}`;
    const reg = app({ githubRepo: repo, monitoring: { cadence: 'push', emailAlerts: true } });
    await setApps(a.uid, [reg]);

    const first = await postWebhook({ repository: { full_name: repo } });
    const scanId = (first.body.enqueued as any[])[0].scanId as string;
    await waitForTerminal(scanId);
    expect(existsSync(workspacePath(scanId))).toBe(false); // ephemeral workspace gone
    const findings = await listFindings(scanId);
    expect(findings.every((f) => !f.evidence || f.evidence.length < 200)).toBe(true);

    // Immediate second push → debounced (nothing enqueued).
    const second = await postWebhook({ repository: { full_name: repo } });
    expect((second.body.enqueued as any[]).length).toBe(0);
    await a.close();
  });
});

describe('H — dashboard data readable by the owner', () => {
  it('owner can query its monitorEvents + read its monitorRun (client SDK)', async () => {
    const a = await authedClient(email(), 'password123', 'guard');
    const reg = app({ githubRepo: `me/dash-${uniq()}`, monitoring: { cadence: 'daily', emailAlerts: true } });
    await baselineThenBroken(a, reg);

    const events = await getDocs(query(collection(a.db, 'monitorEvents'), where('uid', '==', a.uid)));
    expect(events.size).toBeGreaterThan(0);
    const run = await getDoc(doc(a.db, 'monitorRuns', `${a.uid}__${reg.id}`));
    expect(run.exists()).toBe(true);
    expect((run.data() as any).lastGrade).toBe('F');
    await a.close();
  });
});

describe('I — monitoring is a paid feature (single gate point)', () => {
  it('canUseMonitoring is false for a free/unknown user, true once paid', async () => {
    const a = await authedClient(email(), 'password123'); // free by default
    expect(await canUseMonitoring(a.uid)).toBe(false);
    await getDb().collection('users').doc(a.uid).set({ plan: 'guard' }, { merge: true });
    expect(await canUseMonitoring(a.uid)).toBe(true);
    await a.close();
  });
});
