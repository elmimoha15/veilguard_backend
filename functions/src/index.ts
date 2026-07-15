import express, { type Request, type Response } from 'express';
import { config } from '../../shared/src/config.js';
import { makeQueue } from '../../shared/src/queue.js';
import { handleCreateScan } from './createScan.js';

/**
 * Express app hosting POST /createScan. In production this is deployed as a
 * Cloud Function / Cloud Run service with QUEUE_IMPL=cloudtasks (so the queue
 * needs no in-process worker handler). Locally, prefer wiring an InMemoryQueue
 * with the worker handler directly (see scripts/trigger-scan.ts).
 */
export function createApiApp() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  const queue = makeQueue(); // cloudtasks in prod; throws if memory w/o handler

  app.post('/createScan', async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const result = await handleCreateScan(req.body, queue, { clientIp: ip });
    res.status(result.status).json(result.body);
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = createApiApp();
  const port = Number(process.env.API_PORT) || 8080;
  app.listen(port, () => console.log(`[api] createScan on :${port} (queue=${config.queueImpl})`));
}
