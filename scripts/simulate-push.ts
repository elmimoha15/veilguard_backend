/**
 * DEV: simulate a GitHub "push" against the RUNNING dev server so a
 * 'push'-cadence app re-scans — the exact path a real push takes, minus the
 * public tunnel + GitHub-App webhook config. The re-scan itself is real (it
 * clones + scans whatever repo the app has connected) and writes a real
 * monitorEvents doc, so the result shows up in the app just like production.
 *
 * Run the stack first:  npm run dev:all      (emulator + server + worker on :8787)
 * Then in another shell:
 *   npm run simulate:push               # auto-fires for every push-monitored app
 *   npm run simulate:push -- owner/repo # force one repository full_name
 *
 * (The npm script points FIRESTORE_EMULATOR_HOST at the already-running emulator,
 * so this connects to the SAME data your app uses — it does not boot a new one.)
 */
import { createHmac } from 'node:crypto';
import { config } from '../shared/src/config.js';
import { getScan, getDb } from '../shared/src/firestore.js';
import { listMonitoredApps } from '../shared/src/monitor.js';
import type { MonitorEvent } from '../shared/src/types.js';

const SERVER = process.env.DEV_SERVER_URL || 'http://127.0.0.1:8787';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fireWebhook(repo: string) {
  // Minimal push payload — the handler only needs repository.full_name.
  const payload = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: repo } });
  const signature = `sha256=${createHmac('sha256', config.githubWebhookSecret).update(payload).digest('hex')}`;
  const res = await fetch(`${SERVER}/githubWebhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-hub-signature-256': signature,
    },
    body: payload,
  });
  const body = (await res.json().catch(() => ({}))) as {
    repo?: string;
    enqueued?: { uid: string; appId: string; scanId: string }[];
    error?: string;
    ignored?: string;
  };
  return { status: res.status, body };
}

async function eventForScan(scanId: string): Promise<MonitorEvent | null> {
  const snap = await getDb().collection('monitorEvents').where('scanId', '==', scanId).limit(1).get();
  return snap.empty ? null : (snap.docs[0]!.data() as MonitorEvent);
}

async function waitForResult(scanId: string, timeoutMs = 90_000) {
  const start = Date.now();
  for (;;) {
    const scan = await getScan(scanId);
    if (scan && (scan.status === 'done' || scan.status === 'error')) return scan;
    if (Date.now() - start > timeoutMs) return scan; // return whatever we have
    await sleep(1000);
  }
}

async function main() {
  const argRepo = process.argv[2];

  let repos: string[];
  if (argRepo) {
    repos = [argRepo.toLowerCase()];
  } else {
    const monitored = await listMonitoredApps();
    repos = [
      ...new Set(
        monitored
          .filter((m) => m.app.monitoring?.cadence === 'push' && m.app.githubRepo)
          .map((m) => m.app.githubRepo!.toLowerCase()),
      ),
    ];
    if (repos.length === 0) {
      console.log(
        '\nNo push-monitored apps found.\n' +
          'In the app: connect a GitHub repo → run a Deep scan → Monitoring → "After every push".\n' +
          'Or force one:  npm run simulate:push -- owner/repo\n',
      );
      process.exit(0);
    }
  }

  console.log(`\n▶ Simulating push for: ${repos.join(', ')}  → ${SERVER}/githubWebhook\n`);

  for (const repo of repos) {
    const { status, body } = await fireWebhook(repo);
    if (status === 401) {
      console.log(`✗ ${repo}: 401 invalid signature — is the server on the emulator (dev secret)? ${JSON.stringify(body)}`);
      continue;
    }
    const enqueued = body.enqueued ?? [];
    console.log(`• ${repo}: ${status} — enqueued ${enqueued.length} re-scan(s)${body.ignored ? ` (ignored: ${body.ignored})` : ''}`);

    for (const e of enqueued) {
      const scan = await waitForResult(e.scanId);
      const c = scan?.counts;
      console.log(
        `   ↳ scan ${e.scanId}: ${scan?.status ?? '?'} · grade ${scan?.grade ?? '—'} · ` +
          `${c?.critical ?? 0} critical / ${(c?.high ?? 0) + (c?.medium ?? 0) + (c?.low ?? 0)} warnings`,
      );
      const ev = await eventForScan(e.scanId);
      if (ev) {
        console.log(
          `     event: +${ev.newFindings.length} new / -${ev.resolvedFindings.length} resolved · ` +
            `grade ${ev.gradeBefore ?? '—'} → ${ev.gradeAfter ?? '—'}${ev.alerted ? ' · alert sent' : ''}`,
        );
      }
    }
  }

  console.log('\n✓ Done. Open the app → Monitoring to see the new scan in the timeline/alerts.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
