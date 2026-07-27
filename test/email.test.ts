import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createDevServer } from '../functions/src/local-server.js';
import {
  getEmailTransport, setEmailTransport, ConsoleEmailTransport, ResendEmailTransport,
  type EmailMessage, type EmailTransport,
} from '../shared/src/email.js';
import { sendAlert } from '../shared/src/emails/senders.js';
import { authedClient } from './client.js';

let server: Server;
let baseUrl: string;
let n = 0;
const email = () => `e${Date.now()}-${++n}@test.dev`;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

beforeAll(async () => {
  await new Promise<void>((done) => {
    const app = createDevServer();
    server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      done();
    });
  });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

// Gate A — provider selection (no RESEND_API_KEY under the emulator → console).
describe('A — transport selection', () => {
  it('defaults to the capturing console transport when no key is set', () => {
    expect(getEmailTransport()).toBeInstanceOf(ConsoleEmailTransport);
    expect(() => new ResendEmailTransport()).not.toThrow(); // keyed branch is constructable
  });
});

// Gates B (alert content) + Part-3 A/B/C (brand hexes, html+text, content).
describe('B — security-alert email', () => {
  const outbox: EmailMessage[] = [];
  const capture: EmailTransport = { async send(m) { outbox.push(m); } };
  beforeAll(() => setEmailTransport(capture));
  afterAll(() => setEmailTransport(new ConsoleEmailTransport()));

  it('renders html + text with brand/severity hexes, logo, and the finding content', async () => {
    outbox.length = 0;
    await sendAlert({
      to: 'founder@test.dev',
      appName: 'fox-on-the-go',
      findings: [{ severity: 'critical', title: 'Anyone can read your users table', whyItMatters: 'Any visitor to your site can read this table without logging in.', where: 'supabase:users' }],
      gradeBefore: 'B',
      gradeAfter: 'D',
      viewUrl: 'https://veilguard.dev/scan?scan=demo',
    });
    expect(outbox.length).toBe(1);
    const m = outbox[0]!;
    // both parts present
    expect(m.html && m.html.length).toBeTruthy();
    expect(m.text && m.text.length).toBeTruthy();
    // from = alert sender on the verified subdomain
    expect(m.from).toContain('alerts@send.veilguard.dev');
    expect(m.subject).toMatch(/new security issue/i);
    // brand + severity hexes (must be the real frontend values)
    expect(m.html).toContain('#F3C500'); // brand
    expect(m.html).toContain('#E5352B'); // critical + grade D (red)
    expect(m.html).toContain('logos/logo-mark.png'); // hosted logo
    // content intact
    expect(m.html).toContain('fox-on-the-go');
    expect(m.html).toContain('Anyone can read your users table');
    expect(m.html).toContain('Any visitor to your site can read this table');
    expect(m.html).toContain('View in Veilguard');
    expect(m.text).toContain('fox-on-the-go');
    // List-Unsubscribe + tag set for an alert
    expect(m.listUnsubscribe).toBeTruthy();
    expect(m.tags?.some((t) => t.name === 'type' && t.value === 'alert')).toBe(true);
    // no Resend key shape leaked into the body
    expect(m.html).not.toMatch(/re_[A-Za-z0-9]{10,}/);
  });
});

// Gate — verify/reset endpoints (branded, enumeration-safe).
describe('C — auth email endpoints', () => {
  it('sendReset returns 200 even for an unknown email (no account enumeration)', async () => {
    const res = await post('/auth/sendReset', { email: `nobody-${Date.now()}@test.dev` });
    expect(res.status).toBe(200);
  });
  it('sendReset returns 200 for a real account', async () => {
    const addr = email();
    const a = await authedClient(addr, 'password123');
    const res = await post('/auth/sendReset', { email: addr });
    expect(res.status).toBe(200);
    await a.close();
  });
  it('sendVerification requires auth (401 without a token)', async () => {
    const res = await post('/auth/sendVerification', {});
    expect(res.status).toBe(401);
  });
});
