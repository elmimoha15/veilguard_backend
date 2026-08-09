/**
 * Global test setup. Vitest auto-loads `.env`, so a developer's real
 * RESEND_API_KEY would otherwise leak into the test process and flip the email
 * transport to real Resend — breaking every outbox-based assertion AND firing
 * real emails during `npm test`. Force the capturing console transport here so
 * tests are deterministic and never send real mail, regardless of `.env`.
 */
import { setEmailTransport, ConsoleEmailTransport } from '../shared/src/email.js';

delete process.env.RESEND_API_KEY;
setEmailTransport(new ConsoleEmailTransport());
