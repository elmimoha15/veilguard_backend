/**
 * Monthly summary email — POST /runMonthlySummary (Cloud Scheduler) must email a
 * branded recap ONLY to users opted in (notifications.summary !== false) who have
 * at least one app, and never to opted-out users. Secret-gated. Emulator + the
 * forced console transport (test/setup.ts) keep it network-free.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createDevServer } from '../functions/src/local-server.js';
import { getDb, getScan } from '../shared/src/firestore.js';
import { getSentEmails, resetSentEmails } from '../shared/src/email.js';
import { authedClient } from './client.js';

const CRON = 'dev-emulator-cron-secret'; // config.scheduleSecret emulator fallback

let server: Server;
let baseUrl: string;
let n = 0;
const email = () => `sum-${Date.now()}-${++n}@test.dev`;

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

const runSummary = async (header?: string) => {
  const res = await fetch(`${baseUrl}/runMonthlySummary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(header ? { 'x-veilguard-cron': header } : {}) },
    body: '{}',
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

/** Seed a user with an app + a completed scan for it. */
async function seedUserWithApp(uid: string, host: string, grade: string, summaryPref: boolean | undefined) {
  const db = getDb();
  const patch: Record<string, unknown> = {
    apps: [{ id: `app-${uid}`, name: host, url: `https://${host}`, createdAt: new Date().toISOString() }],
  };
  if (summaryPref !== undefined) patch.notifications = { summary: summaryPref };
  await db.collection('users').doc(uid).set(patch, { merge: true });
  await db.collection('scans').doc(`s-${uid}`).set({
    id: `s-${uid}`, ownerUid: uid, type: 'url', status: 'done', grade,
    counts: { critical: 0, high: 1, medium: 2, low: 0, info: 0, passed: 5 },
    target: { type: 'url', value: `https://${host}` }, createdAt: new Date().toISOString(),
  });
}

describe('monthly summary email', () => {
  it('emails opted-in users (with apps) and skips opted-out users; secret-gated', async () => {
    const inEmail = email(); const outEmail = email();
    const inUser = await authedClient(inEmail, 'password123', 'guard');
    const outUser = await authedClient(outEmail, 'password123', 'guard');
    await seedUserWithApp(inUser.uid, 'alpha-summary.example.com', 'B', true);   // opted in (explicit)
    await seedUserWithApp(outUser.uid, 'beta-summary.example.com', 'D', false);  // opted OUT

    // Wrong / missing secret → 401, no send.
    resetSentEmails();
    expect((await runSummary('nope')).status).toBe(401);
    expect((await runSummary()).status).toBe(401);
    expect(getSentEmails().length).toBe(0);

    // Authorized run.
    resetSentEmails();
    const r = await runSummary(CRON);
    expect(r.status).toBe(200);

    const sent = getSentEmails();
    const toIn = sent.filter((e) => e.to === inEmail);
    const toOut = sent.filter((e) => e.to === outEmail);
    expect(toIn.length).toBe(1);          // opted-in user got exactly one summary
    expect(toOut.length).toBe(0);         // opted-out user got none
    const mail = toIn[0]!;
    expect(mail.subject.toLowerCase()).toContain('monthly');
    expect(String(mail.html)).toContain('alpha-summary.example.com'); // app name
    expect(String(mail.html)).toContain('B');                          // its grade
    expect(String(mail.text).toLowerCase()).toContain('scans used');   // usage line
    expect(mail.listUnsubscribe).toBeTruthy();

    await inUser.close(); await outUser.close();
  });
});
