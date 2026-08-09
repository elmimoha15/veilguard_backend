/**
 * Slice 6 — Polar billing gate (B–K). Emulator + simulated *signed* webhooks
 * (standard-webhooks, same secret transform Polar uses) + a mocked Polar client
 * for checkout/portal + the capturing email transport. Money & access control.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { Webhook } from 'standardwebhooks';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import type { Polar } from '@polar-sh/sdk';
import { createDevServer } from '../functions/src/local-server.js';
import { getPlan, getUser, getDb, getTeaserFindingId, readPrivateFix } from '../shared/src/firestore.js';
import { canUseMonitoring } from '../shared/src/monitor.js';
import { setPolarClient } from '../shared/src/polar.js';
import { getSentEmails, resetSentEmails } from '../shared/src/email.js';
import { QUICKCART_PATH, runFullScan } from './harness.js';
import { authedClient, clientDb, isPermissionDenied } from './client.js';

const SECRET = 'test-polar-secret';
let server: Server;
let baseUrl: string;
let m = 0;
const email = () => `b${Date.now()}-${++m}@test.dev`;

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Sign a Polar webhook exactly as Polar does (base64 of the secret). */
function polarHeaders(body: string, id: string): Record<string, string> {
  const wh = new Webhook(Buffer.from(SECRET, 'utf-8').toString('base64'));
  const ts = new Date();
  const signature = wh.sign(id, ts, body);
  return { 'webhook-id': id, 'webhook-timestamp': Math.floor(ts.getTime() / 1000).toString(), 'webhook-signature': signature };
}
async function postWebhook(payload: unknown, opts: { sign?: boolean; id?: string } = {}) {
  const body = JSON.stringify(payload);
  const id = opts.id ?? `msg_${Date.now()}_${++m}`;
  const headers: Record<string, string> =
    opts.sign === false
      ? { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': Math.floor(Date.now() / 1000).toString(), 'webhook-signature': 'v1,deadbeefdeadbeef' }
      : { 'content-type': 'application/json', ...polarHeaders(body, id) };
  const res = await fetch(`${baseUrl}/polarWebhook`, { method: 'POST', headers, body });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** A snake_case subscription payload straight off the Polar wire. */
const subEvent = (type: string, uid: string, over: Record<string, unknown> = {}) => ({
  type,
  data: {
    id: 'sub_1',
    status: 'active',
    current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
    cancel_at_period_end: false,
    product_id: 'prod_guard',
    customer: { id: 'cus_1', external_id: uid, email: `cust-${uid}@test.dev` },
    ...over,
  },
});

// Mocked Polar client so checkout/portal never hit the network; records the last
// checkout args so we can assert the uid link + the successUrl `next`.
let lastCheckout: { externalCustomerId?: string; successUrl?: string } = {};
// Configurable billing-management state (orders / subscriptions).
type MockOrder = { id: string; createdAt: string; totalAmount: number; currency: string; status: string; paid: boolean; billingReason: string; invoiceNumber: string | null; isInvoiceGenerated: boolean };
let ordersByExternal: Record<string, MockOrder[]> = {};
let activeSubByExternal: Record<string, string> = {}; // externalId → subscription id
const generatedInvoices: string[] = [];
const subUpdateCalls: { id: string; cancelAtPeriodEnd?: boolean }[] = [];
function resetBillingMocks() { ordersByExternal = {}; activeSubByExternal = {}; generatedInvoices.length = 0; subUpdateCalls.length = 0; }
const allOrders = () => Object.values(ordersByExternal).flat();

const fakePolar = {
  checkouts: { create: async (args: { externalCustomerId?: string; successUrl?: string }) => { lastCheckout = args; return { url: `https://sandbox.polar.sh/checkout/${args.externalCustomerId}` }; } },
  customerSessions: { create: async (args: { customerId: string }) => ({ customerPortalUrl: `https://sandbox.polar.sh/portal/${args.customerId}` }) },
  // No stored id → portal resolves by external id; default to 404 (no customer yet).
  customers: { getExternal: async () => { throw Object.assign(new Error('not found'), { error: 'ResourceNotFound' }); } },
  orders: {
    list: async ({ externalCustomerId }: { externalCustomerId: string }) => ({ result: { items: ordersByExternal[externalCustomerId] ?? [], pagination: { totalCount: 0, maxPage: 1 } } }),
    get: async ({ id }: { id: string }) => {
      const o = allOrders().find((x) => x.id === id);
      if (!o) throw Object.assign(new Error('not found'), { error: 'ResourceNotFound' });
      return o;
    },
    generateInvoice: async ({ id }: { id: string }) => { generatedInvoices.push(id); return {}; },
    invoice: async ({ id }: { id: string }) => ({ url: `https://sandbox.polar.sh/invoice/${id}` }),
  },
  subscriptions: {
    list: async ({ externalCustomerId }: { externalCustomerId: string }) => ({ result: { items: activeSubByExternal[externalCustomerId] ? [{ id: activeSubByExternal[externalCustomerId] }] : [], pagination: { totalCount: 0, maxPage: 1 } } }),
    update: async ({ id, subscriptionUpdate }: { id: string; subscriptionUpdate: { cancelAtPeriodEnd?: boolean } }) => { subUpdateCalls.push({ id, cancelAtPeriodEnd: subscriptionUpdate.cancelAtPeriodEnd }); return { id }; },
  },
} as unknown as Polar;

beforeAll(async () => {
  process.env.POLAR_ACCESS_TOKEN = 'test-token';
  process.env.POLAR_WEBHOOK_SECRET = SECRET;
  process.env.GUARD_MONTHLY = 'prod_guard';
  setPolarClient(fakePolar);
  await new Promise<void>((done) => {
    const app = createDevServer();
    server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      done();
    });
  });
});
afterAll(async () => {
  delete process.env.POLAR_ACCESS_TOKEN; delete process.env.POLAR_WEBHOOK_SECRET; delete process.env.GUARD_MONTHLY;
  setPolarClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => resetSentEmails());

describe('A — checkout', () => {
  it('/createCheckout returns a hosted URL tied to the uid; never grants a plan', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    const r = await post('/createCheckout', {}, a.token);
    expect(r.status).toBe(200);
    expect(String(r.body.url)).toContain(a.uid); // tied to the user
    expect(await getPlan(a.uid)).toBe('free');     // checkout alone never upgrades
    await a.close();
  });

  it('carries a valid `next` on the success URL and rejects an unsafe one', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);

    const nextOf = () => decodeURIComponent((lastCheckout.successUrl ?? '').split('next=')[1] ?? '');
    await post('/createCheckout', { next: '/finding?scan=x&id=y' }, a.token);
    expect(lastCheckout.successUrl).toContain('/billing/success?next=');
    expect(nextOf()).toBe('/finding?scan=x&id=y');

    // Open-redirect attempts fall back to /dashboard.
    for (const evil of ['https://evil.com', '//evil.com', 'javascript:alert(1)']) {
      await post('/createCheckout', { next: evil }, a.token);
      expect(nextOf()).toBe('/dashboard');
    }
    await a.close();
  });
});

describe('A2 — subscription management (history, invoices, cancel/resume)', () => {
  const order = (over: Partial<MockOrder> = {}): MockOrder => ({
    id: `ord_${++m}`, createdAt: new Date().toISOString(), totalAmount: 1900, currency: 'usd',
    status: 'paid', paid: true, billingReason: 'subscription_cycle', invoiceNumber: 'INV-1', isInvoiceGenerated: true, ...over,
  });

  it('lists the caller\'s transactions newest-first, empty for a user with no orders', async () => {
    resetBillingMocks();
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);

    // No orders yet.
    let r = await post('/billingTransactions', {}, a.token);
    expect(r.status).toBe(200);
    expect(r.body.transactions).toEqual([]);

    // Two orders → returned newest-first, normalized.
    ordersByExternal[a.uid] = [
      order({ id: 'ord_old', createdAt: '2026-01-01T00:00:00.000Z' }),
      order({ id: 'ord_new', createdAt: '2026-06-01T00:00:00.000Z', billingReason: 'subscription_create' }),
    ];
    r = await post('/billingTransactions', {}, a.token);
    expect(r.status).toBe(200);
    const txns = r.body.transactions as Array<{ id: string; amount: number; reason: string; hasInvoice: boolean }>;
    expect(txns.map((t) => t.id)).toEqual(['ord_new', 'ord_old']);
    expect(txns[0]).toMatchObject({ amount: 1900, reason: 'subscription_create', hasInvoice: true });
    await a.close();
  });

  it('returns an invoice URL for an OWNED order, 202 pending when not generated, 404 for another user\'s order', async () => {
    resetBillingMocks();
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    ordersByExternal[a.uid] = [order({ id: 'ord_ready', isInvoiceGenerated: true }), order({ id: 'ord_pending', isInvoiceGenerated: false })];

    const ready = await post('/billingInvoice', { orderId: 'ord_ready' }, a.token);
    expect(ready.status).toBe(200);
    expect(String(ready.body.url)).toContain('ord_ready');

    const pending = await post('/billingInvoice', { orderId: 'ord_pending' }, a.token);
    expect(pending.status).toBe(202);
    expect(pending.body.pending).toBe(true);
    expect(generatedInvoices).toContain('ord_pending'); // generation was triggered

    // An order that exists but belongs to someone else → 404 (ownership guard).
    ordersByExternal['someone-else'] = [order({ id: 'ord_theirs' })];
    const theirs = await post('/billingInvoice', { orderId: 'ord_theirs' }, a.token);
    expect(theirs.status).toBe(404);

    // Missing orderId → 400.
    expect((await post('/billingInvoice', {}, a.token)).status).toBe(400);
    await a.close();
  });

  it('cancels at period end and resumes; only calls Polar (webhook persists state)', async () => {
    resetBillingMocks();
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);

    // No active subscription yet → 409.
    expect((await post('/billingCancel', {}, a.token)).status).toBe(409);

    // Become guard via a verified webhook (stores subscriptionId = 'sub_1').
    await postWebhook(subEvent('subscription.active', a.uid));
    expect(await getPlan(a.uid)).toBe('guard');

    // Cancel → Polar update with cancelAtPeriodEnd:true; plan unchanged locally (webhook is authority).
    const cancel = await post('/billingCancel', {}, a.token);
    expect(cancel.status).toBe(200);
    expect(subUpdateCalls.at(-1)).toEqual({ id: 'sub_1', cancelAtPeriodEnd: true });
    expect(await getPlan(a.uid)).toBe('guard'); // still guard until the webhook/period end

    // Resume → cancelAtPeriodEnd:false.
    const resume = await post('/billingReactivate', {}, a.token);
    expect(resume.status).toBe(200);
    expect(subUpdateCalls.at(-1)).toEqual({ id: 'sub_1', cancelAtPeriodEnd: false });
    await a.close();
  });

  it('resolves the subscription by external id when none is stored', async () => {
    resetBillingMocks();
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    activeSubByExternal[a.uid] = 'sub_ext'; // active on Polar, but never stored on the user doc

    const cancel = await post('/billingCancel', {}, a.token);
    expect(cancel.status).toBe(200);
    expect(subUpdateCalls.at(-1)).toEqual({ id: 'sub_ext', cancelAtPeriodEnd: true });
    await a.close();
  });

  it('rejects unauthenticated management calls', async () => {
    for (const p of ['/billingTransactions', '/billingCancel', '/billingReactivate']) {
      expect((await post(p, {})).status).toBe(401);
    }
    expect((await post('/billingInvoice', { orderId: 'x' })).status).toBe(401);
  });
});

describe('B — webhook is the ONLY source of truth', () => {
  it('a user becomes guard only after a verified subscription webhook', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    expect(await getPlan(a.uid)).toBe('free');

    // A forged (unsigned) webhook must NOT upgrade.
    expect((await postWebhook(subEvent('subscription.active', a.uid), { sign: false })).status).toBe(401);
    expect(await getPlan(a.uid)).toBe('free');

    // A verified webhook upgrades.
    expect((await postWebhook(subEvent('subscription.active', a.uid))).status).toBe(200);
    expect(await getPlan(a.uid)).toBe('guard');
    await a.close();
  });
});

describe('C — signature + idempotency', () => {
  it('unverified → 401; the same delivery id applies once', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);

    expect((await postWebhook(subEvent('subscription.active', a.uid), { sign: false })).status).toBe(401);

    const id = `dup_${a.uid}`;
    const first = await postWebhook(subEvent('subscription.active', a.uid), { id });
    expect(first.body.ok).toBe(true);
    resetSentEmails();
    const second = await postWebhook(subEvent('subscription.active', a.uid), { id }); // same delivery id
    expect(second.body.deduped).toBe(true);
    expect(getSentEmails().length).toBe(0); // no double-grant, no second email
    expect(await getPlan(a.uid)).toBe('guard');
    await a.close();
  });
});

describe('D — lifecycle transitions', () => {
  it('active → past_due (grace) → canceled (until period end) → revoked (free)', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);

    await postWebhook(subEvent('subscription.active', a.uid));
    let u = await getUser(a.uid);
    expect(u?.plan).toBe('guard'); expect(u?.status).toBe('active');

    await postWebhook(subEvent('subscription.past_due', a.uid, { status: 'past_due' }));
    u = await getUser(a.uid);
    expect(u?.plan).toBe('guard'); expect(u?.status).toBe('past_due'); // access kept in grace

    await postWebhook(subEvent('subscription.canceled', a.uid, { cancel_at_period_end: true }));
    u = await getUser(a.uid);
    expect(u?.plan).toBe('guard'); expect(u?.cancelAtPeriodEnd).toBe(true); // still access until period end

    await postWebhook(subEvent('subscription.revoked', a.uid));
    u = await getUser(a.uid);
    expect(u?.plan).toBe('free'); expect(u?.status).toBe('expired'); // access ends
    expect(await canUseMonitoring(a.uid)).toBe(false);
    await a.close();
  });
});

describe('F — entitlements enforced server-side (teaser fix)', () => {
  it('private fix denied to clients; free gets teaser only; guard gets all; downgrade re-locks', async () => {
    const { scanId } = await runFullScan({ type: 'repo', value: QUICKCART_PATH });
    const snap = await getDb().collection('scans').doc(scanId).collection('findings').get();
    const withFix: string[] = [];
    for (const d of snap.docs) if (await readPrivateFix(scanId, d.id)) withFix.push(d.id);
    expect(withFix.length).toBeGreaterThan(0);
    const teaser = (await getTeaserFindingId(scanId))!;
    expect(teaser).toBeTruthy();
    const nonTeaser = withFix.find((id) => id !== teaser);

    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);

    // Direct client read of the private fix is denied by rules (any plan).
    const denied = await (async () => { try { await getDoc(doc(a.db, 'scans', scanId, 'findings', teaser, 'private', 'fix')); return false; } catch (e) { return isPermissionDenied(e); } })();
    expect(denied).toBe(true);

    // Free: the teaser fix unlocks (200); any other finding is 402.
    expect((await post('/findingFix', { scanId, findingId: teaser }, a.token)).status).toBe(200);
    if (nonTeaser) expect((await post('/findingFix', { scanId, findingId: nonTeaser }, a.token)).status).toBe(402);

    // Guard (set via a webhook — the only path): every fix unlocks.
    await postWebhook(subEvent('subscription.active', a.uid));
    if (nonTeaser) expect((await post('/findingFix', { scanId, findingId: nonTeaser }, a.token)).status).toBe(200);

    // Downgrade re-locks the non-teaser fix.
    await postWebhook(subEvent('subscription.revoked', a.uid));
    if (nonTeaser) expect((await post('/findingFix', { scanId, findingId: nonTeaser }, a.token)).status).toBe(402);
    await a.close();
  });
});

describe('G — monitoring gated on the paid plan', () => {
  it('free cannot use monitoring; guard can', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    expect(await canUseMonitoring(a.uid)).toBe(false);
    await postWebhook(subEvent('subscription.active', a.uid));
    expect(await canUseMonitoring(a.uid)).toBe(true);
    await a.close();
  });
});

describe('H — customer portal', () => {
  it('409 without a customer, URL once a customer exists', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    expect((await post('/billingPortal', {}, a.token)).status).toBe(409); // no customer yet
    await postWebhook(subEvent('subscription.active', a.uid)); // sets polarCustomerId
    const r = await post('/billingPortal', {}, a.token);
    expect(r.status).toBe(200);
    expect(String(r.body.url)).toContain('cus_1');
    await a.close();
  });
});

describe('I — billing emails on the right transitions', () => {
  it('activated / payment-failed / canceled email; no email on renewal', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    const typesSince = () => getSentEmails().flatMap((e) => e.tags?.map((t) => t.value) ?? []);

    resetSentEmails();
    await postWebhook(subEvent('subscription.active', a.uid));
    expect(typesSince()).toContain('billing-activated');

    resetSentEmails();
    await postWebhook(subEvent('subscription.updated', a.uid)); // renewal-ish
    expect(getSentEmails().length).toBe(0);

    resetSentEmails();
    await postWebhook(subEvent('subscription.past_due', a.uid, { status: 'past_due' }));
    expect(typesSince()).toContain('billing-payment-failed');

    resetSentEmails();
    await postWebhook(subEvent('subscription.canceled', a.uid, { cancel_at_period_end: true }));
    expect(typesSince()).toContain('billing-canceled');
    await a.close();
  });
});

describe('J — isolation / security', () => {
  it('a client cannot write billing fields to its own user doc', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    const c = clientDb(); // rules-subject client
    // Forging a paid status is denied…
    const deniedBilling = await (async () => { try { await updateDoc(doc(a.db, 'users', a.uid), { status: 'active', subscriptionId: 'sub_hacker' }); return false; } catch (e) { return isPermissionDenied(e); } })();
    expect(deniedBilling).toBe(true);
    // …but an ordinary profile edit still works.
    await updateDoc(doc(a.db, 'users', a.uid), { onboarded: true });
    expect((await getUser(a.uid))?.onboarded).toBe(true);
    expect(await getPlan(a.uid)).toBe('free'); // never upgraded via the client
    await c.close(); await a.close();
  });
});

describe('paid gate — free users blocked (402) server-side', () => {
  it('deep scan / connect / connect-begin all 402 for a free user', async () => {
    const a = await authedClient(email(), 'password123');
    await post('/me', {}, a.token);
    expect((await post('/createDeepScan', { github: true }, a.token)).status).toBe(402);
    expect((await post('/connectGitHub', { repoPath: QUICKCART_PATH }, a.token)).status).toBe(402);
    expect((await post('/connect/begin', { provider: 'github' }, a.token)).status).toBe(402);
    await a.close();
  });
});
