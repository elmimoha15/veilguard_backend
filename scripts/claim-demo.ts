/**
 * Demonstrates: anonymous scan → sign up → claim → my-scans list.
 * Run against a running emulator (Auth + Firestore), e.g. via `npm run dev:all`
 * in one shell, or the background-emulator flow in the README.
 */
import type { Server } from 'node:http';
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import { createDevServer } from '../functions/src/local-server.js';
import { getScan } from '../shared/src/firestore.js';
import { startStaticServer, waitForTerminal } from '../test/harness.js';
import { authedClient } from '../test/client.js';

async function main() {
  const target = await startStaticServer();
  const app = createDevServer();
  const baseUrl: string = await new Promise((done) => {
    const s: Server = app.listen(0, '127.0.0.1', () => {
      const a = s.address();
      done(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
  const post = async (path: string, body: unknown, token?: string): Promise<any> =>
    (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();

  console.log('\n1) Anonymous free scan (no login)…');
  const { scanId } = await post('/createScan', { target: { type: 'url', value: target.url } });
  await waitForTerminal(scanId);
  const anon = await getScan(scanId);
  console.log(`   scanId=${scanId}  ownerUid=${anon?.ownerUid}  grade=${anon?.grade}`);

  console.log('\n2) User signs up…');
  const user = await authedClient(`demo-${Date.now()}@test.dev`, 'password123');
  const me = await post('/me', {}, user.token);
  console.log(`   uid=${user.uid}  plan=${me.plan}`);

  console.log('\n3) Claim the pre-signup scan…');
  const claim = await post('/claimScan', { scanId }, user.token);
  const owned = await getScan(scanId);
  console.log(`   claim ok=${claim.ok}  ownerUid now=${owned?.ownerUid}`);

  console.log('\n4) "My scans" (client query, ownerUid == me — rules-enforced)…');
  const snap = await getDocs(query(collection(user.db, 'scans'), where('ownerUid', '==', user.uid), orderBy('createdAt', 'desc')));
  snap.docs.forEach((d) => console.log(`   · ${d.id}  ${d.data().target.value}  grade ${d.data().grade}`));

  await user.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
