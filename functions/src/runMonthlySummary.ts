import { timingSafeEqual } from 'node:crypto';
import { config } from '../../shared/src/config.js';
import { getDb, listUserScans } from '../../shared/src/firestore.js';
import { getUsageCounts, scanLimit } from '../../shared/src/usage.js';
import { userApps } from '../../shared/src/monitor.js';
import { sendMonthlySummary } from '../../shared/src/emails/senders.js';
import type { SummaryApp } from '../../shared/src/emails/MonthlySummary.js';
import type { UserDoc, ScanDoc, RegistryApp, MonitorEvent } from '../../shared/src/types.js';
import type { HttpResult } from './createScan.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

/** Constant-time compare of the cron shared-secret header (mirrors runSchedules). */
function authorized(header: string | undefined): boolean {
  const expected = config.scheduleSecret;
  if (!expected) return false; // never allow when no secret is configured (prod)
  const a = Buffer.from(header ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bare, normalized host (matches the frontend/monitor `hostOf`). */
function hostOf(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch { return value.trim().toLowerCase(); }
}

/** Does this scan belong to the given registry app? (mirrors delete/report grouping). */
function scanBelongsToApp(s: ScanDoc, app: RegistryApp): boolean {
  if (s.appId && s.appId === app.id) return true;
  if (app.githubRepo && s.type === 'deep' && s.sources?.githubRepo?.toLowerCase() === app.githubRepo.toLowerCase()) return true;
  if (app.url && s.type === 'url' && hostOf(s.target.value) === hostOf(app.url)) return true;
  return false;
}

function openIssues(s: ScanDoc | undefined): number {
  const c = s?.counts;
  if (!c) return 0;
  return (c.critical ?? 0) + (c.high ?? 0) + (c.medium ?? 0) + (c.low ?? 0);
}

/** Build one user's summary model: per-app grade/open/fixed + scans used. */
async function summarize(uid: string, user: UserDoc, now: number): Promise<{ apps: SummaryApp[]; scansUsed: number; scanLimit: number }> {
  const apps = userApps(user);
  const scans = await listUserScans(uid); // newest-first
  const since = now - THIRTY_DAYS_MS;

  // This-month resolved-finding counts per app (from monitoring events).
  const evSnap = await getDb().collection('monitorEvents').where('uid', '==', uid).get();
  const fixedByApp = new Map<string, number>();
  for (const doc of evSnap.docs) {
    const ev = doc.data() as MonitorEvent & { createdAt?: string };
    if (ev.createdAt && new Date(ev.createdAt).getTime() < since) continue;
    fixedByApp.set(ev.appId, (fixedByApp.get(ev.appId) ?? 0) + (ev.resolvedFindings?.length ?? 0));
  }

  const summaryApps: SummaryApp[] = apps.map((app) => {
    const latestDone = scans.find((s) => s.status === 'done' && scanBelongsToApp(s, app));
    return {
      name: app.name,
      grade: latestDone?.grade ?? null,
      openIssues: openIssues(latestDone),
      fixedThisMonth: fixedByApp.get(app.id) ?? 0,
    };
  });

  const counts = await getUsageCounts(uid, now);
  return { apps: summaryApps, scansUsed: counts.scansThisMonth, scanLimit: scanLimit(user.plan) };
}

export interface MonthlySummaryResult { sent: number; skipped: number }

/**
 * HTTP entry for Cloud Scheduler → POST /runMonthlySummary with header
 * `x-veilguard-cron: <SCHEDULE_SECRET>`. Sends a branded monthly security summary
 * to every user opted in (users/{uid}.notifications.summary !== false — default on)
 * who has at least one app and a real email. Respects the toggle; degrades to the
 * console transport when RESEND_API_KEY is unset (so tests/dev never hit network).
 */
export async function handleRunMonthlySummary(cronHeader: string | undefined, now = Date.now()): Promise<HttpResult> {
  if (!authorized(cronHeader)) return { status: 401, body: { error: 'unauthorized' } };

  const snap = await getDb().collection('users').get();
  let sent = 0, skipped = 0;
  for (const doc of snap.docs) {
    const user = doc.data() as UserDoc;
    const to = user.alertEmail || user.email;
    const optedIn = user.notifications?.summary !== false; // default ON
    if (!to || !optedIn) { skipped++; continue; }
    const model = await summarize(doc.id, user, now);
    if (model.apps.length === 0) { skipped++; continue; } // nothing to summarize
    try {
      await sendMonthlySummary({ to, apps: model.apps, scansUsed: model.scansUsed, scanLimit: model.scanLimit });
      sent++;
    } catch (e) {
      console.error(`[monthly-summary] send failed for ${doc.id}:`, e instanceof Error ? e.message : e);
      skipped++;
    }
  }
  console.log(`[monthly-summary] sent=${sent} skipped=${skipped}`);
  return { status: 200, body: { sent, skipped } };
}
