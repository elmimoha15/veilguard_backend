import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { config } from '../../shared/src/config.js';
import { makeQueue } from '../../shared/src/queue.js';
import { runScanJob } from '../../worker/src/runScan.js';
import { ensureUser } from '../../shared/src/firestore.js';
import { meWithUsage } from '../../shared/src/usage.js';
import { sendWelcome } from '../../shared/src/emails/senders.js';
import { handleCreateScan } from './createScan.js';
import { handleClaimScan } from './claimScan.js';
import { handleCreateDeepScan } from './createDeepScan.js';
import { handleCreateUploadScan } from './createUploadScan.js';
import {
  handleCreateCheckout,
  handleBillingPortal,
  handleListTransactions,
  handleInvoiceUrl,
  handleCancelSubscription,
  handleReactivateSubscription,
} from './billing.js';
import { handleFindingFix } from './findingFix.js';
import { handleAllFixesPrompt } from './allFixesPrompt.js';
import { handlePolarWebhook, flattenHeaders } from './polarWebhook.js';
import { handleSendVerification, handleSendReset } from './authEmails.js';
import { handleFeedback } from './feedback.js';
import { handleConnectGitHub, handleConnectSupabase, handleDisconnect } from './connect.js';
import { handleDeleteAccount } from './deleteAccount.js';
import { handleDeleteApp } from './deleteApp.js';
import { handleListGitHubRepos } from './githubRepos.js';
import { handleConnectBegin, handleGitHubCallback, handleSupabaseCallback, renderOAuthResult } from './oauth.js';
import { handleRunSchedules } from './runSchedules.js';
import { handleRunMonthlySummary } from './runMonthlySummary.js';
import { handleScanReport, handleAccountReport } from './scanReport.js';
import { handleGitHubWebhook } from './githubWebhook.js';
import { resolveAuth, requireAuth, AuthError } from './auth.js';
import { devCors } from './cors.js';
import { loadEnv } from './loadEnv.js';

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
  loadEnv(); // pull backend-root .env (OAuth creds) into process.env before serving
  const app = express();
  app.use(devCors);

  const queue = makeQueue(runScanJob);

  // GitHub webhook: raw body BEFORE express.json (HMAC needs the exact bytes).
  app.post('/githubWebhook', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
    const r = await handleGitHubWebhook(req.body as Buffer, {
      signature: req.header('x-hub-signature-256'),
      event: req.header('x-github-event'),
      deliveryId: req.header('x-github-delivery'),
    }, queue);
    res.status(r.status).json(r.body);
  });

  // Upload scan: raw .zip body BEFORE express.json (json parser would reject it).
  app.post('/createUploadScan', express.raw({ type: ['application/zip', 'application/octet-stream'], limit: config.uploadMaxBytes }), async (req: Request, res: Response) => {
    const r = await handleCreateUploadScan(req.body as Buffer, req.query.name as string | undefined, queue, req.headers.authorization);
    res.status(r.status).json(r.body);
  });

  // Polar billing webhook: raw body BEFORE express.json (HMAC needs exact bytes).
  app.post('/polarWebhook', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
    const r = await handlePolarWebhook(req.body as Buffer, flattenHeaders(req.headers));
    res.status(r.status).json(r.body);
  });

  app.use(express.json({ limit: '64kb' }));

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
      const { user, created } = await ensureUser(auth);
      if (created && user.email) void sendWelcome(user.email).catch((e) => console.error('[email] welcome failed:', e));
      res.json(await meWithUsage(user));
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
  app.post('/account/delete', async (req: Request, res: Response) => {
    const r = await handleDeleteAccount(req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/app/delete', async (req: Request, res: Response) => {
    const r = await handleDeleteApp(req.body, req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/github/repos', async (req: Request, res: Response) => {
    const r = await handleListGitHubRepos(req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/createDeepScan', async (req: Request, res: Response) => {
    const r = await handleCreateDeepScan(req.body, queue, req.headers.authorization);
    res.status(r.status).json(r.body);
  });

  // --- Slice 6: billing (fake upgrade today; Polar later) + paid fix content ---
  app.post('/createCheckout', async (req: Request, res: Response) => {
    const r = await handleCreateCheckout(req.body, req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/billingPortal', async (req: Request, res: Response) => {
    const r = await handleBillingPortal(req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/billingTransactions', async (req: Request, res: Response) => {
    const r = await handleListTransactions(req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/billingInvoice', async (req: Request, res: Response) => {
    const r = await handleInvoiceUrl(req.body, req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/billingCancel', async (req: Request, res: Response) => {
    const r = await handleCancelSubscription(req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/billingReactivate', async (req: Request, res: Response) => {
    const r = await handleReactivateSubscription(req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/findingFix', async (req: Request, res: Response) => {
    const r = await handleFindingFix(req.body?.scanId, req.body?.findingId, req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/allFixesPrompt', async (req: Request, res: Response) => {
    const r = await handleAllFixesPrompt(req.body?.scanId, req.headers.authorization);
    res.status(r.status).json(r.body);
  });

  // --- Branded auth emails (verify + reset) via Resend, not Firebase's mailer ---
  app.post('/auth/sendVerification', async (req: Request, res: Response) => {
    const r = await handleSendVerification(req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/auth/sendReset', async (req: Request, res: Response) => {
    const r = await handleSendReset(req.body, req.ip || req.socket.remoteAddress || 'local');
    res.status(r.status).json(r.body);
  });

  // --- User feedback / help (anonymous allowed; stored server-side) ---
  app.post('/feedback', async (req: Request, res: Response) => {
    let auth = null;
    try { auth = await resolveAuth(req.headers.authorization); }
    catch (e) { if (e instanceof AuthError) return res.status(e.status).json({ error: e.message }); throw e; }
    const r = await handleFeedback(req.body, auth, req.ip || req.socket.remoteAddress || 'local');
    res.status(r.status).json(r.body);
  });

  // --- Slice 7: monitoring cron trigger (local + Cloud Scheduler) ---
  app.post('/runSchedules', async (req: Request, res: Response) => {
    const r = await handleRunSchedules(queue, req.header('x-veilguard-cron'));
    res.status(r.status).json(r.body);
  });
  app.post('/runMonthlySummary', async (req: Request, res: Response) => {
    const r = await handleRunMonthlySummary(req.header('x-veilguard-cron'));
    res.status(r.status).json(r.body);
  });
  app.post('/scanReport', async (req: Request, res: Response) => {
    const r = await handleScanReport((req.body as { scanId?: string })?.scanId, req.headers.authorization);
    if ('pdf' in r) res.status(200).type('application/pdf').setHeader('Content-Disposition', `attachment; filename="${r.filename}"`).send(r.pdf);
    else res.status(r.status).json(r.body);
  });
  app.post('/accountReport', async (req: Request, res: Response) => {
    const r = await handleAccountReport(req.headers.authorization);
    if ('pdf' in r) res.status(200).type('application/pdf').setHeader('Content-Disposition', `attachment; filename="${r.filename}"`).send(r.pdf);
    else res.status(r.status).json(r.body);
  });

  // --- Real connections (OAuth): begin flow + provider callbacks ---
  app.post('/connect/begin', async (req: Request, res: Response) => {
    const r = await handleConnectBegin(req.body, req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  // Serve the self-closing popup page (postMessage → app), with a full-window
  // redirect fallback baked in — see renderOAuthResult.
  app.get('/connect/github/callback', async (req: Request, res: Response) => {
    const { query } = await handleGitHubCallback(req.query as Record<string, unknown>);
    res.type('html').send(renderOAuthResult(query));
  });
  app.get('/connect/supabase/callback', async (req: Request, res: Response) => {
    const { query } = await handleSupabaseCallback(req.query as Record<string, unknown>);
    res.type('html').send(renderOAuthResult(query));
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
