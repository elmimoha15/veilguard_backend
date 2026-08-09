import { getPlan, getTeaserFindingId } from '../../shared/src/firestore.js';

/**
 * Server-side entitlements for a user. `isGuard` (plan==='guard') is the single
 * paid gate — the Polar webhook keeps `plan` at 'guard' through grace + a
 * scheduled cancel, and drops it to 'free' only on revoke/expire. So monitoring
 * and full fix access follow `plan` automatically.
 */
export async function getEntitlements(uid: string): Promise<{ plan: 'free' | 'guard'; isGuard: boolean; canUseMonitoring: boolean }> {
  const plan = await getPlan(uid);
  const isGuard = plan === 'guard';
  return { plan, isGuard, canUseMonitoring: isGuard };
}

/**
 * May this user read the fix for (scanId, findingId)? Guard → any finding. Free →
 * only the scan's single teaser finding. Ownership is checked by the caller.
 */
export async function canReadFix(uid: string, scanId: string, findingId: string): Promise<boolean> {
  if ((await getEntitlements(uid)).isGuard) return true;
  return findingId === (await getTeaserFindingId(scanId));
}
