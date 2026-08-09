/**
 * Slice 8 gate (A–H) — Claude-tailored fixes + per-plan caps + abuse fixes.
 * Runs on the emulator with mock connections. The Anthropic SDK is fully mocked
 * (no network): a module-level responder controls the "model" output and counts
 * calls, so we can assert tailoring, fallback, caching, and cost caps precisely.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { doc, getDoc } from 'firebase/firestore';

// ── Mock @anthropic-ai/sdk BEFORE anything imports it (hoisted) ─────────────
const ant = vi.hoisted(() => {
  // Deterministic valid responder: pull a real identifier from INSIDE the code
  // fence (not the labels) so validate()'s snippet-overlap check always passes —
  // otherwise cache entries are flaky and re-scans regenerate.
  const validFix = (prompt: string): string => {
    const fence = prompt.match(/```\n([\s\S]*?)\n```/);
    const snip = fence ? fence[1]! : prompt;
    const tok = (snip.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? ['value'])[0]!;
    return JSON.stringify({
      explanation: 'This is a tailored, plain-English explanation of the risk for a non-technical founder.',
      code: `// hardened\nconst ${tok} = sanitize(${tok});`,
      aiPrompt: `In my code, fix the "${tok}" issue by validating and sanitizing it before use.`,
    });
  };
  return { calls: 0, validFix, responder: validFix };
});
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: async (params: { model: string; messages: { content: string }[] }) => {
        ant.calls++;
        const text = ant.responder(params.messages[0]?.content ?? '');
        return { content: [{ type: 'text', text }] };
      },
    };
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic };
});

// AI fixes only run when a key is present — set one so config.aiFixEnabled is true.
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

import { createDevServer } from '../functions/src/local-server.js';
import { getDb, getScan } from '../shared/src/firestore.js';
import { config } from '../shared/src/config.js';
import { getUsageCounts, canScan, underAiFixCap } from '../shared/src/usage.js';
import { QUICKCART_PATH, waitForTerminal, startStaticServer } from './harness.js';
import { createScanPublic } from './harness.js';
import { authedClient, isPermissionDenied, type AuthedClientHandle } from './client.js';

let server: Server;
let baseUrl: string;
let n = 0;
const email = () => `s8-${Date.now()}-${++n}@test.dev`;

beforeAll(async () => {
  await new Promise<void>((done) => {
    const app = createDevServer();
    server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      done();
    });
  });
  await getScan('warmup');
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => vi.unstubAllEnvs());

/** Assert a client-SDK write/read was rejected by firestore.rules. */
async function expectDenied(p: Promise<unknown>): Promise<void> {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err, 'expected a permission-denied error').toBeTruthy();
  expect(isPermissionDenied(err)).toBe(true);
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const connectGh = (t: string, repoPath = QUICKCART_PATH) => post('/connectGitHub', { repoPath }, t);

/** All finding docs (with ids) for a scan (Admin — bypasses rules). */
async function findingDocs(scanId: string): Promise<{ id: string; severity: string }[]> {
  const snap = await getDb().collection('scans').doc(scanId).collection('findings').get();
  return snap.docs.map((d) => ({ id: d.id, severity: String((d.data() as { severity?: string }).severity ?? '') }));
}
async function privateFix(scanId: string, fid: string): Promise<Record<string, unknown> | null> {
  const s = await getDb().collection('scans').doc(scanId).collection('findings').doc(fid).collection('private').doc('fix').get();
  return s.exists ? (s.data() as Record<string, unknown>) : null;
}
/** Count fixes that were replaced by a Claude-tailored one (ai:true). */
async function aiFixCount(scanId: string): Promise<{ ai: number; total: number; sample: Record<string, unknown> | null }> {
  const fids = await findingDocs(scanId);
  let ai = 0;
  let sample: Record<string, unknown> | null = null;
  for (const f of fids) {
    const pf = await privateFix(scanId, f.id);
    if (pf?.ai === true) { ai++; if (!sample) sample = pf; }
  }
  return { ai, total: fids.length, sample };
}

/** Guard user, GitHub (mock) connected to QuickCart, then run a deep scan. */
async function guardDeepScan(A: AuthedClientHandle): Promise<string> {
  await post('/me', {}, A.token);
  await connectGh(A.token, QUICKCART_PATH);
  const r = await post('/createDeepScan', { github: true }, A.token);
  expect(r.status).toBe(202);
  const scanId = String(r.body.scanId);
  await waitForTerminal(scanId);
  return scanId;
}

/* ── C — fix quality / fallback: malformed model output → canned fix ───────── */
/* Runs FIRST so the fix cache is empty for QuickCart snippets (a null result is */
/* never cached), leaving B/D to populate + reuse the cache cleanly.            */
describe('C — malformed/empty Claude output falls back to the canned fix', () => {
  it('no ai:true fixes are written; calls were attempted (both models tried)', async () => {
    ant.responder = () => 'this is not json at all';
    const before = ant.calls;
    const A = await authedClient(email(), 'password123', 'guard');
    const scanId = await guardDeepScan(A);
    const { ai, total } = await aiFixCount(scanId);
    expect(total).toBeGreaterThan(0);
    expect(ai).toBe(0); // every generation failed validation → canned kept
    expect(ant.calls).toBeGreaterThan(before); // attempts were made (haiku + sonnet)
    await A.close();
  });
});

/* ── B + E(per-scan) — deep+Guard gets a tailored fix, capped at top-N ─────── */
describe('B — deep+Guard findings get a Claude-tailored fix (top-N only)', () => {
  it('top-N findings are ai:true + snippet-tailored; the rest stay canned; cap respected', async () => {
    ant.responder = ant.validFix; // C left it returning junk — restore the valid responder
    const before = ant.calls;
    const A = await authedClient(email(), 'password123', 'guard');
    const scanId = await guardDeepScan(A);
    const { ai, total, sample } = await aiFixCount(scanId);

    expect(ai).toBeGreaterThan(0); // at least one tailored fix
    expect(ai).toBeLessThanOrEqual(config.aiFixMaxPerScan); // never more than the per-scan cap
    expect(ai).toBeLessThan(total); // the rest keep canned fixes
    // Fresh (uncached) generations → one call each; bounded by the per-scan cap.
    expect(ant.calls - before).toBeLessThanOrEqual(config.aiFixMaxPerScan);
    // The stored fix carries the Claude fields (explanation + tailored code).
    expect(String(sample?.explanation ?? '')).toContain('founder');
    expect(String(sample?.fix ?? '')).toContain('sanitize');
    await A.close();
  });
});

/* ── D — caching: re-scan of unchanged code triggers zero new Claude calls ─── */
describe('D — cache: re-scanning identical code makes no new Claude calls', () => {
  it('second scan of the same repo reuses cached fixes (0 new calls)', async () => {
    const A = await authedClient(email(), 'password123', 'guard');
    await guardDeepScan(A); // warms cache for QuickCart snippets (from B's valid responder)
    const before = ant.calls;
    const scanId2 = await guardDeepScan(A); // identical snippets → all cache hits
    expect(ant.calls).toBe(before); // ZERO new calls
    const { ai } = await aiFixCount(scanId2);
    expect(ai).toBeGreaterThan(0); // fixes still applied — from cache
    await A.close();
  });
});

/* ── E — cost guard: monthly Claude cap short-circuits generation ──────────── */
describe('E — per-user monthly AI-fix cap enforced', () => {
  it('underAiFixCap flips false at the cap; over-cap deep scan makes no new calls', async () => {
    const A = await authedClient(email(), 'password123', 'guard');
    expect(await underAiFixCap(A.uid)).toBe(true);
    vi.stubEnv('AI_FIX_MAX_PER_MONTH', '0');
    expect(await underAiFixCap(A.uid)).toBe(false);
    const before = ant.calls;
    // Over the cap, generation is short-circuited — cache hits may still apply a
    // fix (no call), so we assert on CALLS, not on the ai-fix count.
    await guardDeepScan(A);
    expect(ant.calls).toBe(before); // cap 0 → zero new generation calls
    await A.close();
  });
});

/* ── F — plan limits: per-plan monthly SCAN cap (Free 2 / Guard 30) ─────────── */
describe('F — per-plan scan caps enforced server-side', () => {
  it('a Guard scan is blocked at the monthly limit (clear 429)', async () => {
    vi.stubEnv('GUARD_MAX_SCANS_PER_MONTH', '0');
    const A = await authedClient(email(), 'password123', 'guard');
    await post('/me', {}, A.token);
    await connectGh(A.token, QUICKCART_PATH);
    const r = await post('/createDeepScan', { github: true }, A.token);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('E_SCAN_LIMIT');
    expect(String(r.body.error)).toMatch(/limit reached/i);
    await A.close();
  });

  it('usage is computed from scans — done counts, errored excluded', async () => {
    const A = await authedClient(email(), 'password123', 'guard');
    const at = new Date().toISOString();
    const put = (id: string, over: Record<string, unknown>) =>
      getDb().collection('scans').doc(`${A.uid}-${id}`).set({
        id: `${A.uid}-${id}`, ownerUid: A.uid, type: 'url', status: 'done',
        createdAt: at, target: { type: 'url', value: 'https://alpha.example.com' }, ...over,
      });
    await put('1', {});                                    // done
    await put('2', {});                                    // done
    await put('3', { status: 'error' });                   // FAILED → neither used nor pending
    await put('4', { status: 'running' });                 // in-flight → holds a slot, not "used"

    const c = await getUsageCounts(A.uid);
    expect(c.scansThisMonth).toBe(2);       // two done scans; the errored one is not a scan
    expect(c.activeScansThisMonth).toBe(3); // done + running; the errored one excluded
    await A.close();
  });

  it('the Free cap (2/month) is enforced at scan time — a 3rd scan is a clear 429', async () => {
    vi.stubEnv('FREE_MAX_SCANS_PER_MONTH', '2');
    const A = await authedClient(email(), 'password123', 'free');
    await post('/me', {}, A.token);
    // Seed two completed scans this month so the Free user is at the cap.
    const at = new Date().toISOString();
    for (const id of ['s1', 's2']) {
      await getDb().collection('scans').doc(`${A.uid}-${id}`).set({
        id: `${A.uid}-${id}`, ownerUid: A.uid, type: 'url', status: 'done',
        createdAt: at, target: { type: 'url', value: `https://${id}.example.com` },
      });
    }
    expect(await canScan(A.uid, 'free')).toBe(false);
    // A third scan is blocked before any scan doc is created.
    const rNew = await post('/createScan', { target: { type: 'url', value: 'https://three.example.com' } }, A.token);
    expect(rNew.status).toBe(429);
    expect(rNew.body.code).toBe('E_SCAN_LIMIT');
    // Guard's higher pool (30) leaves the same user well under the cap.
    expect(await canScan(A.uid, 'guard')).toBe(true);
    await A.close();
  });
});

/* ── G — entitlements intact: free blocked, private/fix locked, no Claude call ─ */
describe('G — entitlements: free users blocked, no Claude call, fix locked', () => {
  it('a free user\'s deep scan is 402 and triggers no Claude call', async () => {
    const A = await authedClient(email(), 'password123', 'free');
    await post('/me', {}, A.token);
    const before = ant.calls;
    const r = await post('/createDeepScan', { github: true }, A.token);
    expect(r.status).toBe(402);
    expect(ant.calls).toBe(before); // never reached the worker
    await A.close();
  });

  it('a free URL scan uses canned fixes and never calls Claude', async () => {
    const site = await startStaticServer();
    const before = ant.calls;
    const res = await createScanPublic({ type: 'url', value: site.url }, { allowPrivateTargets: true });
    await waitForTerminal(String((res.body as { scanId: string }).scanId));
    expect(ant.calls).toBe(before); // URL scans never enter the AI-fix path
    await site.close();
  });

  it('private/fix is not client-readable (locked at the data layer)', async () => {
    const A = await authedClient(email(), 'password123', 'guard');
    const scanId = await guardDeepScan(A);
    const fids = await findingDocs(scanId);
    const fid = fids[0]!.id;
    await expectDenied(getDoc(doc(A.db, 'scans', scanId, 'findings', fid, 'private', 'fix')));
    await A.close();
  });
});

/* ── H — security/privacy: the code snippet is never persisted ─────────────── */
describe('H — snippet privacy: only generated text is stored, never the snippet', () => {
  it('fixCache + private/fix carry no raw snippet field', async () => {
    const A = await authedClient(email(), 'password123', 'guard');
    const scanId = await guardDeepScan(A);
    // private/fix docs
    for (const f of await findingDocs(scanId)) {
      const pf = await privateFix(scanId, f.id);
      if (pf) { expect(pf).not.toHaveProperty('snippet'); expect(pf).not.toHaveProperty('code_context'); }
    }
    // fixCache docs
    const cache = await getDb().collection('fixCache').limit(5).get();
    expect(cache.empty).toBe(false);
    for (const d of cache.docs) {
      const data = d.data();
      expect(data).not.toHaveProperty('snippet');
      expect(Object.keys(data).sort()).toEqual(['createdAt', 'explanation', 'fix', 'fixPrompt', 'model']);
    }
    await A.close();
  });
});
