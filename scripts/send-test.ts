/**
 * Send EVERY email type (welcome, verify, password-reset, security-alert,
 * marketing) to one address, using the real Resend transport when
 * RESEND_API_KEY is set — so you can confirm delivery + rendering in a real
 * inbox. With no key set it falls back to the console transport (logs only).
 *
 *   npm run email:send-test -- you@example.com
 *
 * Loads .env itself so it works no matter how the app normally boots.
 */
try { process.loadEnvFile(); } catch { /* no .env — rely on ambient env */ }

import {
  sendWelcome,
  sendVerify,
  sendPasswordReset,
  sendAlert,
  sendMarketing,
  sendAccountDeleted,
  sendGuardActivated,
  sendPaymentFailed,
  sendSubscriptionCanceled,
} from '../shared/src/emails/senders.js';
import { config } from '../shared/src/config.js';

const to = process.argv[2];
if (!to || !to.includes('@')) {
  console.error('usage: npm run email:send-test -- <to-email>');
  process.exit(1);
}

const base = config.appBaseUrl;

const steps: { name: string; run: () => Promise<void> }[] = [
  { name: 'welcome', run: () => sendWelcome(to) },
  { name: 'verify', run: () => sendVerify(to, `${base}/verify?code=demo-token`) },
  { name: 'password-reset', run: () => sendPasswordReset(to, `${base}/reset?code=demo-token`) },
  { name: 'account-deleted', run: () => sendAccountDeleted(to) },
  { name: 'guard-activated', run: () => sendGuardActivated(to) },
  { name: 'payment-failed', run: () => sendPaymentFailed(to) },
  { name: 'subscription-canceled', run: () => sendSubscriptionCanceled(to, 'Sep 14, 2026') },
  {
    name: 'security-alert',
    run: () => sendAlert({
      to,
      appName: 'demo-app',
      findings: [
        { severity: 'critical', title: 'Anyone can read your "users" table', whyItMatters: 'Any visitor can read this table without logging in.', where: 'supabase:users' },
        { severity: 'high', title: 'Stripe secret key exposed in your JS bundle', whyItMatters: 'Someone could charge cards or issue refunds using your account.', where: 'assets/index-4f2.js' },
      ],
      gradeBefore: 'B',
      gradeAfter: 'D',
      viewUrl: `${base}/scan?scan=demo`,
    }),
  },
  {
    name: 'marketing',
    run: () => sendMarketing({
      to,
      subject: 'What Veilguard shipped this month',
      heading: 'What Veilguard shipped this month',
      body: 'We added folder-upload scans and push-triggered monitoring.\n\nWhenever you ship, we re-scan and email you the moment a new hole appears — with the exact fix.',
      ctaText: "See what's new",
      ctaUrl: base,
    }),
  },
];

console.log(`Sending ${steps.length} test emails to ${to}`);
console.log(`Transport: ${config.resendApiKey ? 'Resend (real send)' : 'console (no RESEND_API_KEY — logs only)'}`);
console.log(`From (alerts): ${config.alertFromEmail} · (transactional): ${config.emailFrom}\n`);

let failed = 0;
for (const s of steps) {
  try {
    await s.run();
    console.log(`  ✓ ${s.name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${s.name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(failed ? `\nDone with ${failed} failure(s).` : '\nAll emails dispatched. Check your inbox.');
process.exit(failed ? 1 : 0);
