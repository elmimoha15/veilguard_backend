/**
 * Gate F — verifies the throwaway dev-ui free-scan flow WITHOUT a full browser
 * automation harness (headless-Chrome CDP driving proved unstable in this
 * sandbox). Instead it exercises the exact path the browser uses:
 *
 *   1. the dev-server serves the UI assets (index.html banner + app.js logic),
 *   2. POST /createScan (same call app.js makes) returns a scanId,
 *   3. the Firebase CLIENT SDK (identical to the browser) subscribes and sees
 *      the grade + findings stream in, with the fix locked at the data layer.
 *
 * The only thing not executed here is app.js's DOM painting — which is verified
 * statically (it renders findings + a 🔒 placeholder and never reads `fix`).
 * Manual browser steps are in the README (`npm run dev:all`).
 */
import type { Server } from 'node:http';
import { doc, collection, getDoc, getDocs, onSnapshot } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { startStaticServer, waitForTerminal, sleep } from './harness.js';
import { getScan, listFindings } from '../shared/src/firestore.js';
import { clientDb, isPermissionDenied } from './client.js';

export interface UiCheckResult {
  pass: boolean;
  detail: string;
}

export async function runUiCheck(): Promise<UiCheckResult> {
  const target = await startStaticServer();
  let server: Server | undefined;
  const checks: string[] = [];
  let pass = true;
  const fail = (msg: string) => {
    pass = false;
    checks.push(`✗ ${msg}`);
  };
  const ok = (msg: string) => checks.push(`✓ ${msg}`);

  try {
    const baseUrl = await new Promise<string>((done) => {
      const app = createDevServer();
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        done(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
      });
    });

    // 1. UI assets are served and correctly shaped.
    const html = await (await fetch(`${baseUrl}/`)).text();
    if (/not the product/i.test(html) && /Dev harness/i.test(html) && html.includes('app.js')) ok('index.html served + labeled throwaway');
    else fail('index.html missing throwaway label / app.js');

    const appJs = await (await fetch(`${baseUrl}/app.js`)).text();
    if (appJs.includes('connectFirestoreEmulator') && appJs.includes('🔒') && appJs.includes('onSnapshot')) ok('app.js streams via client SDK + renders locked placeholder');
    else fail('app.js missing streaming / locked-placeholder logic');

    const cfg = await (await fetch(`${baseUrl}/dev-config`)).json() as { projectId?: string; emulatorPort?: number };
    if (cfg.projectId && cfg.emulatorPort) ok(`/dev-config exposes emulator (${cfg.projectId}:${cfg.emulatorPort})`);
    else fail('/dev-config incomplete');

    // 2. The scan call app.js makes.
    const res = await fetch(`${baseUrl}/createScan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { type: 'url', value: target.url } }),
    });
    const body = (await res.json()) as { scanId?: string };
    if (res.status !== 202 || !body.scanId) {
      fail(`createScan returned ${res.status}`);
      return { pass: false, detail: checks.join('; ') };
    }
    const scanId = body.scanId;
    ok('createScan → 202 scanId (queued)');

    // 3. Browser-equivalent live stream via the CLIENT SDK (rules-enforced).
    const { db, close } = clientDb();
    const sizes: number[] = [];
    const unsub = onSnapshot(collection(db, 'scans', scanId, 'findings'), (s) => sizes.push(s.size), () => {});
    await waitForTerminal(scanId, 30_000);
    await sleep(300);
    unsub();

    const finalDoc = await getScan(scanId);
    const findings = await listFindings(scanId);
    if (finalDoc?.status === 'done' && finalDoc.grade) ok(`scan done — grade ${finalDoc.grade} (what the UI's #grade shows)`);
    else fail(`scan not done (status=${finalDoc?.status})`);
    if (findings.length > 0) ok(`${findings.length} findings streamed to the client`);
    else fail('no findings streamed');
    if (sizes.some((n) => n > 0 && n < Math.max(...sizes, 0))) ok('client observed findings arriving incrementally');

    // Fix locked at the data layer (the browser literally cannot read it).
    const fid = (await getDocs(collection(db, 'scans', scanId, 'findings'))).docs[0]?.id;
    if (fid) {
      const pub = await getDoc(doc(db, 'scans', scanId, 'findings', fid));
      const data = pub.data() as { fix?: unknown; fixPrompt?: unknown } | undefined;
      if (data && data.fix === undefined && data.fixPrompt === undefined) ok('public finding doc has NO fix/fixPrompt');
      else fail('fix leaked into client-readable finding doc');
      let denied = false;
      try {
        await getDoc(doc(db, 'scans', scanId, 'findings', fid, 'private', 'fix'));
      } catch (e) {
        denied = isPermissionDenied(e);
      }
      if (denied) ok('client read of private/fix is DENIED by rules');
      else fail('client could read the locked fix');
    }
    await close();

    return { pass, detail: checks.join('; ') };
  } catch (e) {
    return { pass: false, detail: `${checks.join('; ')}; ERROR ${(e as Error).message}` };
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await target.close();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runUiCheck().then((r) => {
    console.log(`\nUI check: ${r.pass ? 'PASS' : 'FAIL'}\n  ${r.detail.split('; ').join('\n  ')}\n`);
    process.exit(r.pass ? 0 : 1);
  });
}
