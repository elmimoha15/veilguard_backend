/**
 * Slice 7 — monitoring core: the shared logic behind scheduled + push-triggered
 * re-scans, finding diffs, monitoring events, and alerts. Deliberately reuses the
 * existing scan model (createScanDoc/createDeepScanDoc + the queue + the worker)
 * and connection layer — a monitoring scan is just a normal scan tagged
 * origin:'monitor' that the worker diffs + may alert on when it finishes.
 */
import { findingId } from 'veilguard-scanner';
import {
  getDb,
  getScan,
  getUser,
  getPlan,
  listUserScans,
  listFindings,
  hasConnection,
  createScanDoc,
  createDeepScanDoc,
  type PublicFinding,
} from './firestore.js';
import { sendAlert } from './emails/senders.js';
import { config } from './config.js';
import type { Queue } from './queue.js';
import type {
  Cadence,
  AppMonitoring,
  RegistryApp,
  MonitorEvent,
  MonitorFindingRef,
  ScanDoc,
  UserDoc,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Paid-plan gate (Slice 6 placeholder)                                        */
/* -------------------------------------------------------------------------- */

/**
 * THE SINGLE gate point for monitoring — a paid feature. Every scheduled/webhook
 * enqueue goes through here (see enqueueMonitorScan), so a free user's apps are
 * never auto-re-scanned even if a stale 'push' cadence lingers on their doc.
 * (devFakePaid unlocks it on the emulator for local testing.)
 */
export async function canUseMonitoring(uid: string): Promise<boolean> {
  return (await getPlan(uid)) !== 'free' || config.devFakePaid;
}

/* -------------------------------------------------------------------------- */
/* Cadence + due-ness                                                          */
/* -------------------------------------------------------------------------- */

const CADENCE_MS: Record<Exclude<Cadence, 'off' | 'push'>, number> = {
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  biweekly: 14 * 24 * 60 * 60_000,
  monthly: 30 * 24 * 60 * 60_000,
};

/** True if a time-cadence app is due for a scheduled scan given its last run. */
export function dueForSchedule(cadence: Cadence, lastScanAt: string | null | undefined, now = Date.now()): boolean {
  if (cadence === 'off' || cadence === 'push') return false; // push is event-driven, not time-due
  if (!lastScanAt) return true; // never scanned → due now
  const interval = CADENCE_MS[cadence];
  return now - new Date(lastScanAt).getTime() >= interval;
}

/* -------------------------------------------------------------------------- */
/* Registry apps (client-owned config on users/{uid}.apps)                     */
/* -------------------------------------------------------------------------- */

/** Bare, normalized host of a URL-ish string (matches the frontend `hostOf`). */
function hostOf(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return value.trim().toLowerCase();
  }
}

/** Read a user's app-registry array (raw — UserDocSchema isn't applied on read). */
export function userApps(user: UserDoc | null): RegistryApp[] {
  const apps = (user as unknown as { apps?: unknown })?.apps;
  return Array.isArray(apps) ? (apps as RegistryApp[]) : [];
}

/** Every monitored app across all users (cadence !== 'off'). */
export async function listMonitoredApps(): Promise<{ uid: string; user: UserDoc; app: RegistryApp }[]> {
  const snap = await getDb().collection('users').get();
  const out: { uid: string; user: UserDoc; app: RegistryApp }[] = [];
  for (const doc of snap.docs) {
    const user = doc.data() as UserDoc;
    for (const app of userApps(user)) {
      if (app.monitoring && app.monitoring.cadence && app.monitoring.cadence !== 'off') {
        out.push({ uid: doc.id, user, app });
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Run state (server-owned: monitorRuns/{uid}__{appId})                        */
/* -------------------------------------------------------------------------- */

export interface MonitorRun {
  uid: string;
  appId: string;
  lastScanId?: string;
  lastScanAt?: string;
  lastGrade?: string;
  lastRunAt?: string;
  lastPushEnqueuedAt?: string;
}

const runId = (uid: string, appId: string) => `${uid}__${appId}`;
const runRef = (uid: string, appId: string) => getDb().collection('monitorRuns').doc(runId(uid, appId));

export async function getMonitorRun(uid: string, appId: string): Promise<MonitorRun | null> {
  const snap = await runRef(uid, appId).get();
  return snap.exists ? (snap.data() as MonitorRun) : null;
}

async function patchMonitorRun(uid: string, appId: string, patch: Partial<MonitorRun>): Promise<void> {
  await runRef(uid, appId).set({ uid, appId, ...patch }, { merge: true });
}

/* -------------------------------------------------------------------------- */
/* Enqueue a monitoring scan                                                   */
/* -------------------------------------------------------------------------- */

/** True if a monitoring scan for this app is already queued/running (idempotency). */
async function hasActiveMonitorScan(uid: string, appId: string): Promise<boolean> {
  const snap = await getDb()
    .collection('scans')
    .where('ownerUid', '==', uid)
    .where('appId', '==', appId)
    .where('status', 'in', ['queued', 'running'])
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Enqueue an automatic scan for a monitored app. Deep scan when a repo is
 * connected; URL scan otherwise. Tagged origin:'monitor' + appId so the worker
 * diffs + alerts on completion. Returns the scanId, or null if skipped (gated
 * out, nothing to scan, or a scan is already in flight).
 */
export async function enqueueMonitorScan(uid: string, app: RegistryApp, queue: Queue): Promise<string | null> {
  if (!(await canUseMonitoring(uid))) return null;
  if (await hasActiveMonitorScan(uid, app.id)) return null;

  const tag = { origin: 'monitor' as const, appId: app.id };
  let scanId: string | null = null;

  const github = !!app.githubRepo && (await hasConnection(uid, 'github'));
  if (github) {
    const supabase = (await hasConnection(uid, 'supabase')) || undefined;
    scanId = await createDeepScanDoc(uid, { github: true, githubRepo: app.githubRepo, supabase, url: app.url }, tag);
  } else if (app.url) {
    scanId = await createScanDoc({ type: 'url', value: app.url }, uid, tag);
  } else {
    return null; // nothing scannable (url-less app with no connected repo)
  }

  await queue.enqueue({ scanId });
  await patchMonitorRun(uid, app.id, { lastRunAt: new Date().toISOString() });
  return scanId;
}

/** Mark a push enqueued now (webhook debounce). */
export async function markPushEnqueued(uid: string, appId: string): Promise<void> {
  await patchMonitorRun(uid, appId, { lastPushEnqueuedAt: new Date().toISOString() });
}

/* -------------------------------------------------------------------------- */
/* Finding diff + monitoring events + alerts                                   */
/* -------------------------------------------------------------------------- */

function whereOf(f: PublicFinding): string | undefined {
  const loc = f.location;
  if (!loc) return undefined;
  if (loc.file) return loc.line ? `${loc.file}:${loc.line}` : loc.file;
  return loc.url;
}

function toRef(f: PublicFinding): MonitorFindingRef {
  return { key: findingId(f as never), ruleId: f.ruleId, severity: f.severity, title: f.title, where: whereOf(f) };
}

const GRADE_RANK: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };
function gradeWorse(after: string | null, before: string | null): boolean {
  if (!after || !before) return false;
  return (GRADE_RANK[after] ?? -1) > (GRADE_RANK[before] ?? -1);
}

/** Does a finding's severity meet the alert threshold ('critical' | 'high')? */
function meetsThreshold(sev: string, threshold: 'critical' | 'high'): boolean {
  if (threshold === 'critical') return sev === 'critical';
  return sev === 'critical' || sev === 'high';
}

/** Two scans belong to the same app-lens (so their findings are comparable). */
function sameLensAndTarget(a: ScanDoc, b: ScanDoc): boolean {
  if (a.appId && b.appId) return a.appId === b.appId && (a.type === 'deep') === (b.type === 'deep');
  if (a.type === 'deep') return b.type === 'deep' && a.sources?.githubRepo === b.sources?.githubRepo;
  return b.type !== 'deep' && hostOf(a.target.value) === hostOf(b.target.value);
}

/**
 * Called by the worker after a monitoring scan finishes. Diffs the new findings
 * against the app's previous scan of the same lens, writes a monitoring event,
 * and — on a NEW critical/high (or a grade drop) — sends one alert email
 * (respecting the user's prefs). No-ops for non-monitoring scans. Never throws
 * into the worker (monitoring must not fail the scan itself).
 */
export async function recordMonitoringResult(scanId: string): Promise<MonitorEvent | null> {
  try {
    const scan = await getScan(scanId);
    if (!scan || scan.origin !== 'monitor' || !scan.ownerUid || scan.status !== 'done') return null;
    const uid = scan.ownerUid;
    const appId = scan.appId ?? '';

    // Previous done scan of the same lens/target (the diff baseline).
    const history = await listUserScans(uid); // newest-first
    const prev = history.find(
      (s) => s.id !== scan.id && s.status === 'done' && new Date(s.createdAt) < new Date(scan.createdAt) && sameLensAndTarget(scan, s),
    );

    const current = await listFindings(scanId);
    const prevFindings = prev ? await listFindings(prev.id) : [];
    const curByKey = new Map(current.map((f) => [findingId(f as never), f]));
    const prevKeys = new Set(prevFindings.map((f) => findingId(f as never)));

    // Only a genuine transition counts. With no baseline we record a baseline
    // event (no new/resolved) rather than flagging every existing finding "new".
    // Full new PublicFindings (carry whyItMatters/location) for the email body;
    // `newFindings` (refs) are what we persist on the event.
    const newFull = prev ? current.filter((f) => !prevKeys.has(findingId(f as never))) : [];
    const newFindings = newFull.map(toRef);
    const resolvedFindings = prev ? prevFindings.filter((f) => !curByKey.has(findingId(f as never))).map(toRef) : [];

    const gradeBefore = prev?.grade ?? null;
    const gradeAfter = scan.grade ?? null;

    // Alert prefs from the app's monitoring config.
    const user = await getUser(uid);
    const app = userApps(user).find((a) => a.id === appId);
    const mon: AppMonitoring | undefined = app?.monitoring;
    const threshold = mon?.severity ?? 'critical';
    const emailOn = mon?.emailAlerts !== false;

    const alertable = newFindings.some((f) => meetsThreshold(f.severity, threshold)) || gradeWorse(gradeAfter, gradeBefore);
    const willEmail = !!prev && emailOn && alertable;

    const now = new Date().toISOString();
    const eventRef = getDb().collection('monitorEvents').doc();
    const event: MonitorEvent = {
      id: eventRef.id,
      uid,
      appId,
      scanId,
      prevScanId: prev?.id ?? null,
      newFindings,
      resolvedFindings,
      gradeBefore,
      gradeAfter,
      alerted: willEmail,
      createdAt: now,
    };
    await eventRef.set(event);

    await patchMonitorRun(uid, appId, {
      lastScanId: scanId,
      lastScanAt: scan.finishedAt ?? scan.createdAt,
      lastGrade: gradeAfter ?? undefined,
    });

    if (willEmail) {
      const to = user?.alertEmail || user?.email;
      if (to) {
        const appName = app?.name || app?.githubRepo || app?.url || 'your app';
        const alertFindings = newFull
          .filter((f) => meetsThreshold(f.severity, threshold))
          .slice(0, 6)
          .map((f) => ({ severity: f.severity, title: f.title, whyItMatters: f.whyItMatters, where: whereOf(f) }));
        // Isolate delivery: a failed send must never lose the recorded event.
        try {
          await sendAlert({
            to,
            appName,
            findings: alertFindings,
            gradeBefore,
            gradeAfter,
            viewUrl: `${config.appBaseUrl}/scan?scan=${scanId}`,
            meta: { appId, scanId, gradeBefore, gradeAfter, newCount: newFindings.length },
          });
        } catch (e) {
          console.error(`[monitor] alert email failed for ${scanId}:`, e);
        }
      }
    }

    return event;
  } catch (err) {
    console.error(`[monitor] recordMonitoringResult failed for ${scanId}:`, err);
    return null;
  }
}
