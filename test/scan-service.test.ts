import { describe, it, expect } from 'vitest';
import { FindingSchema } from '../shared/src/types.js';
import { getDb, getScan, listFindings } from '../shared/src/firestore.js';
import { runScanJob } from '../worker/src/runScan.js';
import {
  QUICKCART_PATH,
  createScan,
  runFullScan,
  waitForTerminal,
  startStaticServer,
  sleep,
} from './harness.js';

// The count Slice 1 produces for QuickCart (native-first, engines skipped).
const QUICKCART_CRITICAL = 13;

describe('A — create→queue→run→done happy path', () => {
  it('scans the QuickCart repo end to end', async () => {
    const { doc, findings } = await runFullScan({ type: 'repo', value: QUICKCART_PATH });

    expect(doc.status).toBe('done');
    expect(doc.grade).toBe('F');
    expect(doc.counts?.critical).toBe(QUICKCART_CRITICAL);
    expect(findings.length).toBeGreaterThanOrEqual(12);

    // Every finding validates against the engine's schema.
    for (const f of findings) {
      expect(() => FindingSchema.parse(f)).not.toThrow();
    }
    // Subcollection count matches the graded counts.
    const totalGraded =
      (doc.counts?.critical ?? 0) + (doc.counts?.high ?? 0) + (doc.counts?.medium ?? 0) + (doc.counts?.low ?? 0) + (doc.counts?.info ?? 0);
    expect(findings.length).toBe(totalGraded);
  });
});

describe('B — live streaming (incremental, not one terminal write)', () => {
  it('findings appear over multiple snapshots and progress advances', async () => {
    const res = await createScan({ type: 'repo', value: QUICKCART_PATH });
    const { scanId } = res.body as { scanId: string };

    const progressValues: number[] = [];
    const findingSizes: number[] = [];

    const db = getDb();
    const unsubDoc = db.collection('scans').doc(scanId).onSnapshot((s) => {
      const d = s.data() as { progress?: { done: number } } | undefined;
      if (d?.progress) progressValues.push(d.progress.done);
    });
    const unsubFind = db.collection('scans').doc(scanId).collection('findings').onSnapshot((s) => {
      findingSizes.push(s.size);
    });

    const doc = await waitForTerminal(scanId);
    await sleep(150); // let final snapshots flush
    unsubDoc();
    unsubFind();

    expect(doc.status).toBe('done');

    // Progress advanced through multiple distinct values (not a single jump).
    const distinctProgress = new Set(progressValues);
    expect(distinctProgress.size).toBeGreaterThanOrEqual(2);

    // Findings arrived incrementally: at least one snapshot observed a partial
    // count strictly between 0 and the final total.
    const finalSize = Math.max(...findingSizes, 0);
    const sawPartial = findingSizes.some((n) => n > 0 && n < finalSize);
    expect(sawPartial).toBe(true);
  });
});

describe('C — fast API, non-blocking', () => {
  it('returns { scanId } quickly without running the scan inline', async () => {
    const t0 = Date.now();
    const res = await createScan({ type: 'repo', value: QUICKCART_PATH });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(202);
    const { scanId } = res.body as { scanId: string };
    expect(scanId).toBeTruthy();
    expect(elapsed).toBeLessThan(500);

    // The worker runs on the next tick, so right now the scan is still queued.
    const doc = await getScan(scanId);
    expect(doc?.status).toBe('queued');

    await waitForTerminal(scanId); // don't leak a running scan into other tests
  });
});

describe('D — error handling', () => {
  it('marks a nonexistent repo path as error, never stuck running', async () => {
    const { doc } = await runFullScan({ type: 'repo', value: '/definitely/not/a/real/repo/path' });
    expect(doc.status).toBe('error');
    expect(doc.error).toMatch(/not found/i);
    expect(doc.finishedAt).toBeTruthy();
  });

  it('marks an unreachable URL as error', async () => {
    const { doc } = await runFullScan({ type: 'url', value: 'http://127.0.0.1:59997' });
    expect(doc.status).toBe('error');
    expect(doc.error).toMatch(/unreachable/i);
  });
});

describe('E — idempotency', () => {
  it('a second /runScan for the same scanId no-ops (no double findings, no re-run)', async () => {
    const { scanId, doc, findings } = await runFullScan({ type: 'repo', value: QUICKCART_PATH });
    expect(doc.status).toBe('done');
    const finishedAt = doc.finishedAt;
    const count1 = findings.length;

    await runScanJob({ scanId }); // second call — must no-op
    const doc2 = await getScan(scanId);
    const findings2 = await listFindings(scanId);

    expect(doc2?.status).toBe('done');
    expect(doc2?.finishedAt).toBe(finishedAt); // not re-run
    expect(findings2.length).toBe(count1); // not doubled
  });

  it('concurrent /runScan calls only run once', async () => {
    const res = await createScan({ type: 'repo', value: QUICKCART_PATH });
    const { scanId } = res.body as { scanId: string };
    await Promise.all([runScanJob({ scanId }), runScanJob({ scanId }), runScanJob({ scanId })]);
    const findings = await listFindings(scanId);
    const doc = await getScan(scanId);
    expect(doc?.status).toBe('done');
    expect(doc?.counts?.critical).toBe(QUICKCART_CRITICAL);
    expect(findings.length).toBe((doc?.counts?.critical ?? 0) + (doc?.counts?.high ?? 0) + (doc?.counts?.medium ?? 0) + (doc?.counts?.low ?? 0));
  });
});

describe('F — black-box URL path', () => {
  it('runs the black-box path against a local server and writes web-config findings', async () => {
    const server = await startStaticServer();
    try {
      const { doc, findings } = await runFullScan({ type: 'url', value: server.url });
      expect(doc.status).toBe('done');
      const webConfig = findings.filter((f) => f.category === 'web_config');
      expect(webConfig.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.mode === 'blackbox')).toBe(true);
    } finally {
      await server.close();
    }
  });
});
