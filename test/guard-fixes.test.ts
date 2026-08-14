/**
 * Guard = Claude fixes (on-demand) + "copy all fixes as one prompt".
 * - /findingFix: a Guard user opening a NON-AI finding gets a Claude-tailored fix
 *   generated on demand + cached (second call makes no new Claude call). Free gets
 *   only the teaser (canned, no Claude); free non-teaser → 402.
 * - /allFixesPrompt: Guard-only; composes one prompt (Claude, else deterministic).
 * Anthropic SDK fully mocked (no network).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';

const ant = vi.hoisted(() => {
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
  return { calls: 0, validFix, responder: validFix as (p: string) => string };
});
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: async (params: { model: string; messages: { content: string }[] }) => {
        ant.calls++;
        return { content: [{ type: 'text', text: ant.responder(params.messages[0]?.content ?? '') }] };
      },
    };
    constructor(_opts: unknown) {}
  }
  return { default: MockAnthropic };
});
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

import { createDevServer } from '../functions/src/local-server.js';
import { getDb, getScan } from '../shared/src/firestore.js';
import { authedClient } from './client.js';

let server: Server;
let baseUrl: string;
let n = 0;
const email = () => `gf-${Date.now()}-${++n}@test.dev`;

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
afterEach(() => { ant.responder = ant.validFix; vi.unstubAllEnvs(); });

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Seed a done scan owned by uid with a critical + a low finding, each with a CANNED fix. */
async function seedScan(uid: string, scanId: string) {
  const db = getDb();
  await db.collection('scans').doc(scanId).set({
    id: scanId, ownerUid: uid, type: 'url', status: 'done', grade: 'D',
    counts: { critical: 1, high: 0, medium: 0, low: 1, info: 0, passed: 3 },
    target: { type: 'url', value: 'https://fixes.example.com' }, createdAt: new Date().toISOString(),
  });
  const findings = db.collection('scans').doc(scanId).collection('findings');
  await findings.doc('f-crit').set({ ruleId: 'exposed-key', category: 'secrets', severity: 'critical', title: 'Exposed API key', whyItMatters: 'Anyone can use your key.', location: { file: 'src/app.ts', line: 12 } });
  await findings.doc('f-crit').collection('private').doc('fix').set({ fix: 'Move the key to a server env var.', fixPrompt: 'Remove the hardcoded key.' });
  await findings.doc('f-low').set({ ruleId: 'missing-header', category: 'headers', severity: 'low', title: 'Missing security header', whyItMatters: 'Minor hardening gap.', location: { file: 'next.config.js' } });
  await findings.doc('f-low').collection('private').doc('fix').set({ fix: 'Add the header.', fixPrompt: 'Set the header.' });
}

describe('Guard on-demand Claude fixes (/findingFix)', () => {
  it('Guard gets a Claude fix generated on demand + cached; Free gets only the teaser', async () => {
    const guard = await authedClient(email(), 'password123', 'guard');
    const free = await authedClient(email(), 'password123', 'free');
    await seedScan(guard.uid, `g-${guard.uid}`);
    await seedScan(free.uid, `f-${free.uid}`);

    // Guard opens the low finding (canned, not top-N) → on-demand Claude fix.
    const before = ant.calls;
    const r1 = await post('/findingFix', { scanId: `g-${guard.uid}`, findingId: 'f-low' }, guard.token);
    expect(r1.status).toBe(200);
    expect(r1.body.explanation).toBeTruthy();          // AI fix carries an explanation
    expect(ant.calls).toBe(before + 1);                 // one generation
    // Persisted as ai:true — a second open makes NO new Claude call.
    const r2 = await post('/findingFix', { scanId: `g-${guard.uid}`, findingId: 'f-low' }, guard.token);
    expect(r2.status).toBe(200);
    expect(r2.body.explanation).toBeTruthy();
    expect(ant.calls).toBe(before + 1);                 // cached — no new call

    // Free: the teaser (top-severity = f-crit) is the canned fix, no Claude call.
    const beforeFree = ant.calls;
    const teaser = await post('/findingFix', { scanId: `f-${free.uid}`, findingId: 'f-crit' }, free.token);
    expect(teaser.status).toBe(200);
    expect(teaser.body.fix).toBeTruthy();
    expect(teaser.body.explanation).toBeUndefined();    // canned → no explanation
    expect(ant.calls).toBe(beforeFree);                 // free never triggers Claude
    // Free non-teaser → 402 locked.
    const locked = await post('/findingFix', { scanId: `f-${free.uid}`, findingId: 'f-low' }, free.token);
    expect(locked.status).toBe(402);

    await guard.close(); await free.close();
  });
});

describe('Copy all fixes as one prompt (/allFixesPrompt)', () => {
  it('Guard gets a composed prompt; Free 402, non-owner 403, unknown 404, no-token 401', async () => {
    const guard = await authedClient(email(), 'password123', 'guard');
    const other = await authedClient(email(), 'password123', 'guard');
    const free = await authedClient(email(), 'password123', 'free');
    const scanId = `all-${guard.uid}`;
    await seedScan(guard.uid, scanId);
    const freeScan = `all-${free.uid}`;
    await seedScan(free.uid, freeScan); // free owns this one, so we hit the 402 (not 403)

    // Passthrough responder so the composed prompt echoes the assembled content.
    ant.responder = (p: string) => p;
    const ok = await post('/allFixesPrompt', { scanId }, guard.token);
    expect(ok.status).toBe(200);
    expect(typeof ok.body.prompt).toBe('string');
    expect(String(ok.body.prompt)).toContain('Exposed API key');   // a finding title
    expect(ok.body.count).toBe(2);

    expect((await post('/allFixesPrompt', { scanId: freeScan }, free.token)).status).toBe(402); // Guard-only (owns it)
    expect((await post('/allFixesPrompt', { scanId }, other.token)).status).toBe(403);          // not owner
    expect((await post('/allFixesPrompt', { scanId: `missing-${guard.uid}` }, guard.token)).status).toBe(404);
    expect((await post('/allFixesPrompt', { scanId })).status).toBe(401);               // no token

    await guard.close(); await other.close(); await free.close();
  });

  it('falls back to a deterministic prompt when AI is disabled', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ''); // aiFixEnabled=false → no Claude, deterministic compose
    const guard = await authedClient(email(), 'password123', 'guard');
    const scanId = `fb-${guard.uid}`;
    await seedScan(guard.uid, scanId);
    const before = ant.calls;
    const r = await post('/allFixesPrompt', { scanId }, guard.token);
    expect(r.status).toBe(200);
    expect(String(r.body.prompt)).toContain('Exposed API key');   // deterministic includes titles
    expect(ant.calls).toBe(before);                                // no Claude call
    await guard.close();
  });
});
