import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { config } from '../../shared/src/config.js';
import { makeQueue } from '../../shared/src/queue.js';
import { runScanJob } from '../../worker/src/runScan.js';
import { handleCreateScan } from './createScan.js';

const DEV_UI_DIR = fileURLToPath(new URL('../../dev-ui', import.meta.url));

/**
 * Combined LOCAL dev server for the throwaway harness: serves the dev-ui, hosts
 * POST /createScan, and runs the worker in-process via an InMemoryQueue. One
 * process, same origin (no CORS), against the Firestore emulator.
 *
 * NOTE: this local harness allows localhost/private targets so you can scan a
 * local test server. The deployed public endpoint (functions/src/index.ts)
 * keeps the SSRF guard on.
 */
export function createDevServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  const queue = makeQueue(runScanJob);

  // Config the browser UI needs to reach the Firestore emulator.
  app.get('/dev-config', (_req: Request, res: Response) => {
    res.json({
      projectId: config.projectId,
      emulatorHost: (config.firestoreEmulatorHost || '127.0.0.1:8080').split(':')[0],
      emulatorPort: Number((config.firestoreEmulatorHost || '127.0.0.1:8080').split(':')[1] || 8080),
    });
  });

  app.post('/createScan', async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'local';
    const result = await handleCreateScan(req.body, queue, { clientIp: ip, allowPrivateTargets: true });
    res.status(result.status).json(result.body);
  });

  app.use(express.static(DEV_UI_DIR));
  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = createDevServer();
  app.listen(config.devServerPort, () => {
    console.log(`\n  Veilguard dev harness → http://127.0.0.1:${config.devServerPort}`);
    console.log(`  (throwaway UI + createScan + in-process worker, project ${config.projectId})\n`);
  });
}
