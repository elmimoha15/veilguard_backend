/**
 * Local monitoring cron. Run inside the emulator:
 *   npm run schedules
 *
 * Enumerates monitored apps, enqueues a re-scan for each that's due (reusing the
 * in-process worker), and prints what it enqueued. In production a Cloud
 * Scheduler job POSTs /runSchedules with the x-veilguard-cron secret instead.
 */
import { makeQueue } from '../shared/src/queue.js';
import { runScanJob } from '../worker/src/runScan.js';
import { runDueSchedules } from '../functions/src/runSchedules.js';

async function main() {
  const queue = makeQueue(runScanJob); // memory queue → in-process worker
  const result = await runDueSchedules(queue);
  console.log(`\n▶ schedules: due=${result.due} enqueued=${result.enqueued.length} skipped=${result.skipped}`);
  for (const e of result.enqueued) console.log(`   • ${e.appId} (${e.uid}) → scan ${e.scanId}`);
  // Give the in-process worker a moment to run the enqueued scans before exit.
  await new Promise((r) => setTimeout(r, 3000));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
