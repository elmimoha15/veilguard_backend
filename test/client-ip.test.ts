import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { configureTrustProxy, clientIp } from '../functions/src/client-ip.js';
import { rateLimit, resetRateLimit } from '../functions/src/rate-limit.js';

// The same trust-proxy setting the API uses, on a tiny app: X-Forwarded-For as
// Cloud Run's front end would send it (client entries first, real IP last).
const app = express();
configureTrustProxy(app);
app.get('/ip', (req, res) => res.json({ ip: clientIp(req) }));
app.get('/limited', (req, res) => {
  const r = rateLimit(`ip|${clientIp(req)}`, 2, 60_000);
  res.status(r.allowed ? 200 : 429).json({});
});
let server: Server;
let base = '';
const ready = new Promise<void>((done) => {
  server = app.listen(0, '127.0.0.1', () => {
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    done();
  });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => resetRateLimit());

const get = async (path: string, xff: string) => {
  await ready;
  return fetch(`${base}${path}`, { headers: { 'x-forwarded-for': xff } });
};

describe('client IP behind Cloud Run', () => {
  it('uses the entry the front end appended (the last one), not what the client sent', async () => {
    expect((await (await get('/ip', '9.9.9.9')).json()).ip).toBe('9.9.9.9');
    expect((await (await get('/ip', '1.2.3.4, 9.9.9.9')).json()).ip).toBe('9.9.9.9');
  });

  it('different visitors get separate rate-limit buckets', async () => {
    for (let i = 0; i < 2; i++) expect((await get('/limited', '10.0.0.1')).status).toBe(200);
    expect((await get('/limited', '10.0.0.1')).status).toBe(429);
    expect((await get('/limited', '10.0.0.2')).status).toBe(200); // someone else is unaffected
  });

  it('a spoofed left-most entry cannot escape the limit', async () => {
    for (let i = 0; i < 2; i++) expect((await get('/limited', `6.6.6.${i}, 10.0.0.3`)).status).toBe(200);
    expect((await get('/limited', '7.7.7.7, 10.0.0.3')).status).toBe(429);
  });
});
