import { timingSafeEqual } from 'node:crypto';
import { config } from '../../shared/src/config.js';
import type { Queue } from '../../shared/src/queue.js';
import { listMonitoredApps, dueForSchedule, getMonitorRun, enqueueMonitorScan } from '../../shared/src/monitor.js';
import type { HttpResult } from './createScan.js';

export interface ScheduleResult {
  enqueued: { uid: string; appId: string; scanId: string }[];
  due: number;
  skipped: number;
}

/**
 * Find every monitored app whose time cadence is due and enqueue a re-scan for
 * it, capped at config.monitorMaxPerRun so a burst never stampedes the worker.
 * Push-cadence apps are event-driven (githubWebhook), not time-due. Idempotent:
 * enqueueMonitorScan skips an app that already has a scan in flight.
 */
export async function runDueSchedules(queue: Queue, now = Date.now()): Promise<ScheduleResult> {
  const monitored = await listMonitoredApps();
  const enqueued: { uid: string; appId: string; scanId: string }[] = [];
  let due = 0;
  let skipped = 0;

  for (const { uid, app } of monitored) {
    const cadence = app.monitoring!.cadence;
    if (cadence === 'push' || cadence === 'off') continue;
    const run = await getMonitorRun(uid, app.id);
    if (!dueForSchedule(cadence, run?.lastScanAt, now)) continue;
    due++;
    if (enqueued.length >= config.monitorMaxPerRun) {
      skipped++;
      continue;
    }
    const scanId = await enqueueMonitorScan(uid, app, queue);
    if (scanId) enqueued.push({ uid, appId: app.id, scanId });
    else skipped++;
  }

  console.log(`[schedules] due=${due} enqueued=${enqueued.length} skipped=${skipped}`);
  return { enqueued, due, skipped };
}

/** Constant-time compare of the cron shared-secret header. */
function authorized(header: string | undefined): boolean {
  const expected = config.scheduleSecret;
  if (!expected) return false; // never allow when no secret is configured (prod)
  const got = header ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * HTTP entry for Cloud Scheduler → POST /runSchedules with header
 * `x-veilguard-cron: <SCHEDULE_SECRET>`. Rejects anything without the secret so
 * it can't be triggered by the public.
 */
export async function handleRunSchedules(queue: Queue, cronHeader: string | undefined): Promise<HttpResult> {
  if (!authorized(cronHeader)) return { status: 401, body: { error: 'unauthorized' } };
  const result = await runDueSchedules(queue);
  return { status: 200, body: result };
}
