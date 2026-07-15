import express, { type Request, type Response } from 'express';
import { config } from '../../shared/src/config.js';
import { runScanJob } from './runScan.js';

export function createWorkerApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Cloud Tasks (or the local queue) POSTs { scanId } here. We ACK immediately
  // conceptually, but since scans are bounded we run inline and return when done.
  app.post('/runScan', async (req: Request, res: Response) => {
    const scanId = req.body?.scanId;
    if (typeof scanId !== 'string' || !scanId) {
      res.status(400).json({ error: 'scanId required' });
      return;
    }
    try {
      await runScanJob({ scanId });
      res.status(200).json({ ok: true, scanId });
    } catch (err) {
      // runScanJob already records the error on the doc; never leak a 500 that
      // would make Cloud Tasks retry a poisoned job forever.
      console.error('[worker] /runScan unexpected error', err);
      res.status(200).json({ ok: false, scanId });
    }
  });

  return app;
}

// Only start listening when run directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = createWorkerApp();
  app.listen(config.port, () => {
    console.log(`[worker] listening on :${config.port} (project ${config.projectId})`);
  });
}
