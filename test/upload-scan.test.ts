import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, statSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { zipSync } from 'fflate';
import { createDevServer } from '../functions/src/local-server.js';
import { getScan, listFindings, getDb } from '../shared/src/firestore.js';
import { workspacePath } from '../worker/src/deepScan.js';
import { safeUnzip } from '../worker/src/uploadScan.js';
import { QUICKCART_PATH, waitForTerminal } from './harness.js';
import { authedClient } from './client.js';

const IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
let server: Server;
let baseUrl: string;
let m = 0;
const email = () => `u${Date.now()}-${++m}@test.dev`;

/** Zip a directory tree into a single archive (skipping ignored dirs / huge files). */
function zipDir(root: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) walk(join(dir, e.name), childRel);
      } else if (e.isFile()) {
        const p = join(dir, e.name);
        if (statSync(p).size < 2_000_000) files[childRel] = new Uint8Array(readFileSync(p));
      }
    }
  };
  walk(root, '');
  return zipSync(files);
}

async function postZip(zip: Uint8Array, token: string | undefined, name = 'proj') {
  const res = await fetch(`${baseUrl}/createUploadScan?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: Buffer.from(zip),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** Ensure the user doc exists, then make them Pro (only the server may do this). */
async function makePaid(token: string, uid: string) {
  await fetch(`${baseUrl}/me`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  await getDb().collection('users').doc(uid).set({ plan: 'guard' }, { merge: true });
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
  await getScan('warmup');
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('safeUnzip — extraction guards (pure)', () => {
  it('writes normal files, skips traversal / oversized / ignored entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'vg-unzip-'));
    try {
      const zip = zipSync({
        'src/index.ts': new Uint8Array(Buffer.from('const x = 1;')),
        'package.json': new Uint8Array(Buffer.from('{"name":"t"}')),
        '../escape.txt': new Uint8Array(Buffer.from('pwned')),          // path traversal
        'node_modules/dep/index.js': new Uint8Array(Buffer.from('x')),  // ignored dir
        'big.bin': new Uint8Array(3_000_000),                            // oversized (≥2MB)
      });
      const res = safeUnzip(Buffer.from(zip), root);

      expect(existsSync(join(root, 'src/index.ts'))).toBe(true);
      expect(existsSync(join(root, 'package.json'))).toBe(true);
      // Traversal never escapes the root.
      expect(existsSync(resolve(root, '..', 'escape.txt'))).toBe(false);
      expect(existsSync(join(root, 'node_modules/dep/index.js'))).toBe(false);
      expect(existsSync(join(root, 'big.bin'))).toBe(false);
      expect(res.files).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('POST /createUploadScan', () => {
  it('free plan is rejected (402 Pro-only)', async () => {
    const a = await authedClient(email(), 'password123');
    const r = await postZip(zipDir(QUICKCART_PATH), a.token);
    expect(r.status).toBe(402);
    await a.close();
  });

  it('a non-zip body is rejected (400)', async () => {
    const a = await authedClient(email(), 'password123');
    await makePaid(a.token, a.uid);
    const res = await fetch(`${baseUrl}/createUploadScan?name=x`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', authorization: `Bearer ${a.token}` },
      body: Buffer.from('not a zip'),
    });
    expect(res.status).toBe(400);
    await a.close();
  });

  it('Pro user uploading QuickCart gets a white-box grade + criticals, source wiped', async () => {
    const a = await authedClient(email(), 'password123');
    await makePaid(a.token, a.uid);
    const r = await postZip(zipDir(QUICKCART_PATH), a.token, 'quickcart');
    expect(r.status).toBe(202);
    const scanId = r.body.scanId as string;

    const doc = await waitForTerminal(scanId);
    expect(doc.type).toBe('upload');
    expect(doc.status).toBe('done');
    expect(doc.grade).toBe('F');
    expect((doc.counts?.critical ?? 0)).toBeGreaterThan(0);

    const ids = new Set((await listFindings(scanId)).map((f) => f.ruleId));
    expect(ids.has('SECRETS_STRIPE_SECRET_KEY')).toBe(true);
    expect(ids.has('INJECTION_SQL')).toBe(true);

    // Privacy: extracted workspace AND the staged upload are both gone.
    expect(existsSync(workspacePath(scanId))).toBe(false);
    expect(existsSync(join(tmpdir(), 'veilguard-uploads', `${scanId}.zip`))).toBe(false);
    await a.close();
  });
});
