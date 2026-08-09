import * as React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBoth } from '../shared/src/emails/senders.js';
import { SecurityAlert } from '../shared/src/emails/SecurityAlert.js';
import { Welcome, VerifyEmail, PasswordReset, Marketing, AccountDeleted, GuardActivated, PaymentFailed, SubscriptionCanceled } from '../shared/src/emails/Transactional.js';

const OUT = fileURLToPath(new URL('../tmp/email-preview/', import.meta.url));

const samples: Record<string, React.ReactElement> = {
  'security-alert': (
    <SecurityAlert
      appName="fox-on-the-go"
      findings={[
        { severity: 'critical', title: 'Anyone can read your "users" table', whyItMatters: 'Any visitor to your site can read this table without logging in.', where: 'supabase:users' },
        { severity: 'high', title: 'Stripe secret key exposed in your JS bundle', whyItMatters: 'Someone could charge cards or issue refunds using your account.', where: 'assets/index-4f2.js' },
      ]}
      gradeBefore="B"
      gradeAfter="D"
      viewUrl="https://veilguard.dev/scan?scan=demo"
      unsubscribeUrl="https://veilguard.dev/settings"
    />
  ),
  welcome: <Welcome ctaUrl="https://veilguard.dev/dashboard" />,
  verify: <VerifyEmail verifyUrl="https://veilguard.dev/verify?code=demo" />,
  'password-reset': <PasswordReset resetUrl="https://veilguard.dev/reset?code=demo" />,
  'account-deleted': <AccountDeleted />,
  'guard-activated': <GuardActivated ctaUrl="https://veilguard.dev/dashboard" />,
  'payment-failed': <PaymentFailed ctaUrl="https://veilguard.dev/billing" />,
  'subscription-canceled': <SubscriptionCanceled endsOn="Sep 14, 2026" ctaUrl="https://veilguard.dev/billing" />,
  marketing: <Marketing heading="What Veilguard shipped this month" body={'We added folder-upload scans and push-triggered monitoring.\n\nHere is what that means for you.'} ctaText="See what's new" ctaUrl="https://veilguard.dev" unsubscribeUrl="https://veilguard.dev/settings" />,
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const [name, el] of Object.entries(samples)) {
    const { html, text } = await renderBoth(el);
    writeFileSync(`${OUT}${name}.html`, html);
    writeFileSync(`${OUT}${name}.txt`, text);
    console.log(`wrote ${name}.html (${html.length} bytes) + ${name}.txt (${text.length} bytes)`);
  }
  console.log(`\nOpen: ${OUT}security-alert.html`);
}
main().catch((e) => { console.error(e); process.exit(1); });
