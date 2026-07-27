/**
 * Dev helper: send ONE branded marketing email (console transport unless
 * RESEND_API_KEY is set). Bulk campaigns use Resend Audiences/Broadcasts — this
 * previews/sends a single message with the same branded template + unsubscribe.
 *   tsx scripts/send-marketing.ts <to-email>
 */
import { sendMarketing } from '../shared/src/emails/senders.js';

const to = process.argv[2];
if (!to) {
  console.error('usage: tsx scripts/send-marketing.ts <to-email>');
  process.exit(1);
}

await sendMarketing({
  to,
  subject: 'What Veilguard shipped this month',
  heading: 'What Veilguard shipped this month',
  body: 'This month we added folder-upload scans and push-triggered monitoring.\n\nWhenever you ship, we re-scan and email you the moment a new hole appears — with the exact fix.',
  ctaText: "See what's new",
  ctaUrl: 'https://veilguard.dev',
});
console.log(`marketing email dispatched to ${to}`);
