/**
 * "Not an issue? Mark as false positive" — per-app finding dismissals.
 *
 *  - A dismissal is stored per user + app, keyed by a STABLE finding key (rule +
 *    location + title, no line number), so it survives code moving around and
 *    applies to every future scan of that app.
 *  - Dismissed findings stay in the scan (flag `dismissed: true`) so nothing is
 *    silently lost, but they never count toward the grade, counts, teaser fix or
 *    monitoring alerts. The grade is recomputed SERVER-side with the engine's own
 *    grade(), so a client can't tamper with it.
 *  - Every dismissal also files a report in `falsePositiveReports` (server-only)
 *    so it can be reviewed and turned into a corpus test in the scanner.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { grade as engineGrade, type Finding } from 'veilguard-scanner';
import { getDb, getScan, listFindingDocs, type PublicFinding } from './firestore.js';
import type { ScanDoc } from './types.js';
import { fpKey } from './fpkey.js';

export { fpKey };

function hostOf(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return value.trim().toLowerCase();
  }
}

/**
 * Every key a scan's app can be known by: the registry app id (monitor scans),
 * the URL host, and the GitHub repo. Dismissals are written under all of them
 * and read from the union, so they follow the app whichever way it's scanned.
 */
export function appKeysOf(scan: ScanDoc): string[] {
  const keys = new Set<string>();
  if (scan.appId) keys.add(`app:${scan.appId}`);
  const url = scan.sources?.url ?? (scan.type === 'url' ? scan.target.value : undefined);
  if (url) keys.add(`host:${hostOf(url)}`);
  if (scan.sources?.githubRepo) keys.add(`repo:${scan.sources.githubRepo.toLowerCase()}`);
  if (scan.type === 'upload') keys.add(`upload:${String(scan.target.value).toLowerCase()}`);
  return [...keys];
}

const docId = (uid: string, key: string) => `${uid}__${key.replace(/[/#?[\]]/g, '|')}`;
const dismissalsRef = (uid: string, key: string) => getDb().collection('appDismissals').doc(docId(uid, key));

interface DismissalEntry { reason?: string; ruleId: string; title: string; at: string }

/** The fpKeys the owner has dismissed for this scan's app (union over all its keys). */
export async function loadDismissedKeys(uid: string | null | undefined, scan: ScanDoc): Promise<Set<string>> {
  const out = new Set<string>();
  if (!uid) return out;
  const snaps = await Promise.all(appKeysOf(scan).map((k) => dismissalsRef(uid, k).get()));
  for (const s of snaps) for (const k of Object.keys((s.data()?.keys as Record<string, DismissalEntry>) ?? {})) out.add(k);
  return out;
}

/**
 * Recompute grade/score/counts for a scan from its NON-dismissed findings, with
 * the engine's own grading. Keeps counts.passed (passes don't change).
 */
export async function regradeScan(scanId: string): Promise<{ grade: string; score: number; counts: Record<string, number>; dismissedCount: number } | null> {
  const scan = await getScan(scanId);
  if (!scan || scan.status !== 'done') return null;
  const docs = await listFindingDocs(scanId);
  const active = docs.filter((d) => !(d.finding as PublicFinding & { dismissed?: boolean }).dismissed).map((d) => d.finding as unknown as Finding);
  const g = engineGrade(active);
  const counts = { ...g.counts, passed: scan.counts?.passed ?? 0 };
  const dismissedCount = docs.length - active.length;
  await getDb().collection('scans').doc(scanId).set({ grade: g.grade, score: g.score, counts, dismissedCount }, { merge: true });
  return { grade: g.grade, score: g.score, counts, dismissedCount };
}

export type DismissResult =
  | { ok: true; scanId: string; findingId: string; dismissed: boolean; grade: string; score: number }
  | { ok: false; status: number; error: string };

/** Owner-only: mark (or unmark) one finding as a false positive for its app. */
export async function setDismissed(
  uid: string,
  scanId: string,
  findingId: string,
  dismissed: boolean,
  reason?: string,
): Promise<DismissResult> {
  const scan = await getScan(scanId);
  if (!scan) return { ok: false, status: 404, error: 'scan not found' };
  if (scan.ownerUid !== uid) return { ok: false, status: 403, error: 'not your scan' };
  const ref = getDb().collection('scans').doc(scanId).collection('findings').doc(findingId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, status: 404, error: 'finding not found' };
  const f = snap.data() as PublicFinding;
  const key = fpKey(f);
  const at = new Date().toISOString();
  const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';

  const batch = getDb().batch();
  batch.set(ref, dismissed ? { dismissed: true, dismissedAt: at, ...(cleanReason ? { dismissReason: cleanReason } : {}) } : { dismissed: false }, { merge: true });
  for (const k of appKeysOf(scan)) {
    batch.set(
      dismissalsRef(uid, k),
      {
        uid,
        appKey: k,
        updatedAt: at,
        keys: { [key]: dismissed ? ({ ruleId: f.ruleId, title: f.title, at, ...(cleanReason ? { reason: cleanReason } : {}) } satisfies DismissalEntry) : FieldValue.delete() },
      },
      { merge: true },
    );
  }
  if (dismissed) {
    // Review queue: enough context to reproduce it as a scanner corpus test.
    // Evidence is already redacted by the engine; no fix text is included.
    batch.set(getDb().collection('falsePositiveReports').doc(), {
      uid,
      scanId,
      findingId,
      fpKey: key,
      appKeys: appKeysOf(scan),
      scanType: scan.type,
      target: scan.type === 'url' ? scan.target.value : scan.sources?.githubRepo ?? null,
      ruleId: f.ruleId,
      category: f.category,
      severity: f.severity,
      confidence: f.confidence,
      title: f.title,
      location: f.location ?? null,
      evidence: f.evidence ?? null,
      source: f.source ?? 'native',
      reason: cleanReason || null,
      status: 'new',
      createdAt: at,
    });
  }
  await batch.commit();

  const g = await regradeScan(scanId);
  return { ok: true, scanId, findingId, dismissed, grade: g?.grade ?? scan.grade ?? '', score: g?.score ?? scan.score ?? 0 };
}
