import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { detectUrlStack } from '../worker/src/runScan.js';
import { runFullScan, startStaticServer } from './harness.js';

/** A local page that ships public Supabase client config, like a Lovable/Bolt app. */
function startSupabaseSite(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveP) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<!doctype html><html><head><title>app</title></head><body>' +
          '<script>const supabase = createClient("https://abcdefghijklmnopqrst.supabase.co", "sb_publishable_testtesttest");</script>' +
          '</body></html>',
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveP({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((c) => server.close(() => c())) });
    });
  });
}

describe('detectUrlStack', () => {
  it('maps recon config to non-secret booleans', () => {
    expect(detectUrlStack({ supabaseUrl: 'https://x.supabase.co' })).toEqual({ supabase: true });
    expect(detectUrlStack({ firebaseConfig: { apiKey: 'AIza' } })).toEqual({ firebase: true });
    expect(detectUrlStack({ supabaseUrl: 'u', firebaseConfig: {} })).toEqual({ supabase: true, firebase: true });
  });
  it('returns undefined when nothing was detected', () => {
    expect(detectUrlStack(undefined)).toBeUndefined();
    expect(detectUrlStack({})).toBeUndefined();
  });
});

describe('URL scans record the detected backend', () => {
  let supa: { url: string; close: () => Promise<void> };
  let plain: { url: string; close: () => Promise<void> };
  beforeAll(async () => { supa = await startSupabaseSite(); plain = await startStaticServer(); });
  afterAll(async () => { await supa.close(); await plain.close(); });

  it('saves stack.supabase for a page with Supabase config, never the URL or key', async () => {
    const { doc } = await runFullScan({ type: 'url', value: supa.url });
    expect(doc.status).toBe('done');
    expect(doc.stack).toEqual({ supabase: true });
    expect(JSON.stringify(doc)).not.toContain('abcdefghijklmnopqrst');
    expect(JSON.stringify(doc)).not.toContain('sb_publishable_');
  });

  it('saves no stack when the page ships no backend config', async () => {
    const { doc } = await runFullScan({ type: 'url', value: plain.url });
    expect(doc.status).toBe('done');
    expect(doc.stack).toBeUndefined();
  });
});
