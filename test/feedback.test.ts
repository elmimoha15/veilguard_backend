import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { collection, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { getDb } from '../shared/src/firestore.js';
import { resetRateLimit } from '../functions/src/rate-limit.js';
import { getSentEmails, resetSentEmails, setEmailTransport, ConsoleEmailTransport } from '../shared/src/email.js';
import { clientDb, isPermissionDenied } from './client.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  setEmailTransport(new ConsoleEmailTransport()); // capture "sent" mail, no network
  await new Promise<void>((done) => {
    const app = createDevServer();
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      done();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => { resetRateLimit(); resetSentEmails(); });

async function submit(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { ok?: boolean; id?: string; error?: string } };
}

describe('POST /feedback', () => {
  it('an anonymous submission writes one feedback doc with the full context + status:new', async () => {
    const marker = `e2e-${Date.now()}-${Math.round(performance.now())}`;
    const res = await submit({
      type: 'bug',
      message: `something is broken ${marker}`,
      email: 'tester@example.com',
      page: '/findings',
      scanId: 'scan-123',
      userAgent: 'vitest',
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();

    const snap = await getDb().collection('feedback').doc(res.body.id!).get();
    expect(snap.exists).toBe(true);
    const d = snap.data() as Record<string, unknown>;
    expect(d.type).toBe('bug');
    expect(d.message).toBe(`something is broken ${marker}`);
    expect(d.email).toBe('tester@example.com');
    expect(d.userId).toBeNull();
    expect(d.page).toBe('/findings');
    expect(d.scanId).toBe('scan-123');
    expect(d.status).toBe('new');
    expect(d.createdAt).toBeTruthy(); // server timestamp populated

    // Owner is notified by email (captured by the console transport).
    expect(getSentEmails().some((m) => m.text.includes(marker))).toBe(true);
  });

  it('rejects an empty message, and an anonymous submission with no email', async () => {
    expect((await submit({ message: '   ' })).status).toBe(400);
    expect((await submit({ message: 'hi there' })).status).toBe(400); // anonymous + no email
  });

  it('unknown type normalizes to "other"', async () => {
    const res = await submit({ type: 'wat', message: 'idea!', email: 'x@y.com' });
    expect(res.status).toBe(200);
    const snap = await getDb().collection('feedback').doc(res.body.id!).get();
    expect((snap.data() as Record<string, unknown>).type).toBe('other');
  });

  it('a client CANNOT read, list, or write the feedback collection (rules deny)', async () => {
    // Seed one via the server so there is something to (fail to) read.
    await submit({ message: 'private note', email: 'x@y.com' });

    const { db, close } = clientDb();
    try {
      let listDenied = false;
      try { await getDocs(collection(db, 'feedback')); } catch (e) { listDenied = isPermissionDenied(e); }
      expect(listDenied).toBe(true);

      let writeDenied = false;
      try {
        await addDoc(collection(db, 'feedback'), { message: 'client spam', status: 'new', createdAt: serverTimestamp() });
      } catch (e) { writeDenied = isPermissionDenied(e); }
      expect(writeDenied).toBe(true);
    } finally {
      await close();
    }
  });
});
