/**
 * Demonstrates: connect (mock GitHub) → deep scan QuickCart → white-box
 * findings → disconnect. Run against a running emulator (Auth + Firestore).
 */
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { createDevServer } from '../functions/src/local-server.js';
import { getScan, listFindings, getEncryptedSecret } from '../shared/src/firestore.js';
import { workspacePath } from '../worker/src/deepScan.js';
import { QUICKCART_PATH, waitForTerminal } from '../test/harness.js';
import { authedClient } from '../test/client.js';

async function main() {
  const app = createDevServer();
  const baseUrl: string = await new Promise((done) => {
    const s: Server = app.listen(0, '127.0.0.1', () => {
      const a = s.address();
      done(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
  const post = async (path: string, body: unknown, token: string): Promise<any> =>
    (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })).json();

  const u = await authedClient(`deep-${Date.now()}@test.dev`, 'password123');
  console.log(`\nSigned in: uid=${u.uid}`);

  console.log('\n1) Connect GitHub (mock → QuickCart fixture), read-only…');
  const conn = await post('/connectGitHub', { repoPath: QUICKCART_PATH }, u.token);
  if (!conn.scopes) { console.log('   connect response:', JSON.stringify(conn)); process.exit(1); }
  console.log(`   connected repo=${conn.repo}  scopes=[${conn.scopes.join(', ')}]  writeAccess=${conn.writeAccess}`);
  console.log(`   credential stored encrypted (client-unreadable): ${(await getEncryptedSecret(u.uid, 'github'))!.slice(0, 24)}…`);

  console.log('\n2) Run deep (white-box) scan…');
  const ds = await post('/createDeepScan', { github: true }, u.token);
  await waitForTerminal(ds.scanId);
  const d = await getScan(ds.scanId);
  console.log(`   grade=${d?.grade}  criticals=${d?.counts?.critical}  total findings=${(await listFindings(ds.scanId)).length}`);
  const crit = (await listFindings(ds.scanId)).filter((f) => f.severity === 'critical').slice(0, 5);
  crit.forEach((f) => console.log(`   • [CRITICAL] ${f.title} (${f.location?.file}${f.location?.line ? ':' + f.location.line : ''})`));

  console.log(`\n3) Ephemeral workspace deleted after scan: ${!existsSync(workspacePath(ds.scanId))}`);

  console.log('\n4) Disconnect (revoke)…');
  await post('/disconnect', { provider: 'github' }, u.token);
  console.log(`   credential gone: ${(await getEncryptedSecret(u.uid, 'github')) === null}`);
  const after = await post('/createDeepScan', { github: true }, u.token);
  console.log(`   deep scan after disconnect → ${after.error ? '"' + after.error + '"' : 'unexpectedly allowed'}`);

  await u.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
