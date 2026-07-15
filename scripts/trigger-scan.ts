/**
 * Local end-to-end demo. Run inside the emulator:
 *   npm run trigger            # scans the QuickCart fixture
 *   npm run trigger -- <url|path>
 *
 * It wires an InMemoryQueue → the in-process worker, calls createScan, then
 * tails the scan doc + findings subcollection live until the scan finishes.
 */
import { resolve } from 'node:path';
import { makeQueue } from '../shared/src/queue.js';
import { getDb, createScanDoc } from '../shared/src/firestore.js';
import { runScanJob } from '../worker/src/runScan.js';
import type { ScanDoc, Finding } from '../shared/src/types.js';

const DEFAULT_TARGET = resolve(process.cwd(), '../veilguard-scanner/test-fixtures/vulnerable/quickcart');

async function main() {
  const arg = process.argv[2] ?? DEFAULT_TARGET;
  const target = /^https?:\/\//.test(arg)
    ? { type: 'url' as const, value: arg }
    : { type: 'repo' as const, value: resolve(arg) };

  // Internal pipeline demo (bypasses the public URL-only guard so it can also
  // showcase a repo/white-box scan). The public browser path is the dev-ui.
  const queue = makeQueue(runScanJob); // memory queue → in-process worker
  const scanId = await createScanDoc(target);
  await queue.enqueue({ scanId });
  console.log(`\n▶ createScan → scanId=${scanId} (status should be queued)\n`);

  const db = getDb();
  const seen = new Set<string>();

  const unsubFindings = db
    .collection('scans')
    .doc(scanId)
    .collection('findings')
    .onSnapshot((snap) => {
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        const f = doc.data() as Finding;
        console.log(`   • [${f.severity.toUpperCase()}] ${f.title} ${loc(f)}`);
      }
    });

  await new Promise<void>((done) => {
    const unsubDoc = db
      .collection('scans')
      .doc(scanId)
      .onSnapshot((snap) => {
        const d = snap.data() as ScanDoc | undefined;
        if (!d) return;
        const p = d.progress ? ` [${d.progress.done}/${d.progress.total} ${d.progress.phase}]` : '';
        console.log(`   status=${d.status}${p}`);
        if (d.status === 'done' || d.status === 'error') {
          console.log(
            d.status === 'done'
              ? `\n✔ done — grade ${d.grade}, ${d.counts?.critical} critical / ${seen.size} findings\n`
              : `\n✖ error — ${d.error}\n`,
          );
          unsubDoc();
          done();
        }
      });
  });

  unsubFindings();
  process.exit(0);
}

function loc(f: Finding): string {
  if (f.location?.file) return `(${f.location.file}${f.location.line ? `:${f.location.line}` : ''})`;
  if (f.location?.url) return `(${f.location.url})`;
  return '';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
