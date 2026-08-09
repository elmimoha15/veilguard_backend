import { getPlan } from '../../shared/src/firestore.js';

/**
 * THE server-side paid gate. A user may use paid features only when their stored
 * plan is 'guard' (the single paid tier). This is the security boundary — the
 * client UI also hides paid features, but only this (server) check is trusted.
 * The plan is set exclusively by the verified Polar webhook.
 */
export async function requirePaid(uid: string): Promise<boolean> {
  return (await getPlan(uid)) !== 'free';
}
