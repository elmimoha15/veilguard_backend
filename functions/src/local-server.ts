import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { config } from '../../shared/src/config.js';
import { makeQueue } from '../../shared/src/queue.js';
import { runScanJob } from '../../worker/src/runScan.js';
import { ensureUser } from '../../shared/src/firestore.js';
import { handleCreateScan } from './createScan.js';
import { handleClaimScan } from './claimScan.js';
import { handleCreateDeepScan } from './createDeepScan.js';
import { handleConnectGitHub, handleConnectSupabase, handleDisconnect } from './connect.js';
import { resolveAuth, requireAuth, AuthError } from './auth.js';

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
    const fs = config.firestoreEmulatorHost || '127.0.0.1:8080';
    const authHost = config.authEmulatorHost || '127.0.0.1:9099';
    res.json({
      projectId: config.projectId,
      emulatorHost: fs.split(':')[0],
      emulatorPort: Number(fs.split(':')[1] || 8080),
      authEmulatorUrl: authHost.startsWith('http') ? authHost : `http://${authHost}`,
    });
  });

  app.post('/createScan', async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'local';
    try {
      // Anonymous is allowed; a valid token makes the scan owned.
      const auth = await resolveAuth(req.headers.authorization);
      if (auth) await ensureUser(auth);
      const result = await handleCreateScan(req.body, queue, {
        clientIp: ip,
        allowPrivateTargets: true,
        ownerUid: auth?.uid ?? null,
      });
      res.status(result.status).json(result.body);
    } catch (e) {
      if (e instanceof AuthError) return void res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // Create/return the caller's user record (auth required).
  app.post('/me', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req.headers.authorization);
      const user = await ensureUser(auth);
      res.json(user);
    } catch (e) {
      if (e instanceof AuthError) return void res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  app.post('/claimScan', async (req: Request, res: Response) => {
    const result = await handleClaimScan(req.body, req.headers.authorization);
    res.status(result.status).json(result.body);
  });

  // --- Slice 5: connections + deep scans ---
  app.post('/connectGitHub', async (req: Request, res: Response) => {
    const r = await handleConnectGitHub(req.body, req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/connectSupabase', async (req: Request, res: Response) => {
    const r = await handleConnectSupabase(req.body, req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/disconnect', async (req: Request, res: Response) => {
    const r = await handleDisconnect(req.body, req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/createDeepScan', async (req: Request, res: Response) => {
    const r = await handleCreateDeepScan(req.body, queue, req.headers.authorization);
    res.status(r.status).json(r.body);
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
