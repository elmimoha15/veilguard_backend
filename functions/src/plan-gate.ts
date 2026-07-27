import { getPlan } from '../../shared/src/firestore.js';
import { config } from '../../shared/src/config.js';

/**
 * THE server-side paid gate. A user may use paid features when their stored plan
 * is anything other than 'free' (any paid tier = full access), OR when the
 * emulator-only dev preview flag is on. This is the security boundary — the
 * client UI also hides paid features, but only this (server) check is trusted.
 */
export async function requirePaid(uid: string): Promise<boolean> {
  return (await getPlan(uid)) !== 'free' || config.devFakePaid;
}
