/**
 * Slice 8 (v3) — usage computed from the SOURCE OF TRUTH.
 *
 * The user-visible number (scans this month) is derived on read from the `scans`
 * collection — NOT from a fragile counter — so it's always accurate and survives
 * logout/login. Apps are unlimited; the only quota is a per-plan MONTHLY SCAN
 * cap (Free = 2, Guard = 30) that every scan type draws from. A failed (errored)
 * scan counts as neither used nor pending.
 *
 * The one thing we still can't derive from scans — the monthly Claude fix-
 * generation call count (cache hits don't create scans) — stays a real counter
 * in `usage/{uid}` (claudeCallsThisMonth), incremented by bumpClaudeCall.
 */
import { getDb, listUserScans } from './firestore.js';
import { config } from './config.js';
import type { UserDoc } from './types.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

/** Per-plan monthly scan allowance (every scan type draws from this pool). */
export function scanLimit(plan: string | undefined): number {
  return plan === 'guard' ? config.guardMaxScansPerMonth : config.freeMaxScansPerMonth;
}

/** Effective allowance: comp (owner/testing) accounts are effectively unlimited. */
export function effectiveScanLimit(plan: string | undefined, comp = false): number {
  return comp ? 1_000_000 : scanLimit(plan);
}

export interface UsageCounts {
  /** Completed (done) scans in the last 30 days — all types; the "used" number. */
  scansThisMonth: number;
  /** Non-errored scans (queued/running/done) in the window — what the cap checks. */
  activeScansThisMonth: number;
}

/** Compute usage from the user's scans (one scans read). */
export async function getUsageCounts(uid: string, now = Date.now()): Promise<UsageCounts> {
  const scans = await listUserScans(uid);
  const since = now - THIRTY_DAYS_MS;
  let scansThisMonth = 0;
  let activeScansThisMonth = 0;

  for (const s of scans) {
    if (new Date(s.createdAt).getTime() < since) continue;
    if (s.status === 'error') continue; // failed → counts as neither used nor pending
    if (s.status === 'done') scansThisMonth++;
    activeScansThisMonth++; // queued/running/done all hold a slot against the cap
  }

  return { scansThisMonth, activeScansThisMonth };
}

/** May this user start another scan this 30-day window (any scan type)? */
export async function canScan(uid: string, plan: string | undefined, comp = false, now = Date.now()): Promise<boolean> {
  return (await getUsageCounts(uid, now)).activeScansThisMonth < effectiveScanLimit(plan, comp);
}

/* -------------------------------------------------------------------------- */
/* Claude fix-generation call counter (the one thing not derivable from scans) */
/* -------------------------------------------------------------------------- */

interface ClaudeUsageDoc { claudeCallsThisMonth: number; monthResetAt: string }
const usageRef = (uid: string) => getDb().collection('usage').doc(uid);
const freshClaude = (now: number): ClaudeUsageDoc => ({ claudeCallsThisMonth: 0, monthResetAt: new Date(now + THIRTY_DAYS_MS).toISOString() });

async function getClaudeUsage(uid: string, now: number): Promise<ClaudeUsageDoc> {
  const snap = await usageRef(uid).get();
  const d = snap.exists ? (snap.data() as Partial<ClaudeUsageDoc>) : null;
  if (!d || !d.monthResetAt || new Date(d.monthResetAt).getTime() <= now) return freshClaude(now);
  return { claudeCallsThisMonth: d.claudeCallsThisMonth ?? 0, monthResetAt: d.monthResetAt };
}

/** Is the user under their monthly Claude fix-generation cap? */
export async function underAiFixCap(uid: string, now = Date.now()): Promise<boolean> {
  return (await getClaudeUsage(uid, now)).claudeCallsThisMonth < config.aiFixMaxPerMonth;
}

/** Count one Claude fix-generation API call (cache hits must NOT call this). */
export async function bumpClaudeCall(uid: string, now = Date.now()): Promise<void> {
  const ref = usageRef(uid);
  await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? (snap.data() as Partial<ClaudeUsageDoc>) : null;
    const base = !d || !d.monthResetAt || new Date(d.monthResetAt).getTime() <= now ? freshClaude(now) : { claudeCallsThisMonth: d.claudeCallsThisMonth ?? 0, monthResetAt: d.monthResetAt };
    tx.set(ref, { claudeCallsThisMonth: base.claudeCallsThisMonth + 1, monthResetAt: base.monthResetAt });
  });
}

/**
 * The `/me` payload: user doc + real usage + the plan cap, so the UI renders
 * "Y/limit scans this month" with no second fetch. The scan count is computed
 * from the source of truth (only the Claude counter is a stored value).
 */
export async function meWithUsage(user: UserDoc): Promise<Record<string, unknown>> {
  const counts = await getUsageCounts(user.uid);
  return {
    ...user,
    usage: { scansThisMonth: counts.scansThisMonth },
    caps: { maxScansPerMonth: effectiveScanLimit(user.plan, user.comp) },
  };
}
