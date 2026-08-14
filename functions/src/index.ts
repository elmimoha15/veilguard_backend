import express, { type Request, type Response } from 'express';
import { config } from '../../shared/src/config.js';
import { makeQueue } from '../../shared/src/queue.js';
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
import { prodCors } from './cors.js';
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

/**
 * Express app hosting POST /createScan. In production this is deployed as a
 * Cloud Function / Cloud Run service with QUEUE_IMPL=cloudtasks (so the queue
 * needs no in-process worker handler). Locally, prefer wiring an InMemoryQueue
 * with the worker handler directly (see scripts/trigger-scan.ts).
 */
export function createApiApp() {
  const app = express();

  // CORS for the browser frontend (veilguard.dev → api.veilguard.dev). Must run
  // before the routes so it also answers the preflight. Webhooks send no Origin
  // and are unaffected. Without this, the browser blocks every app→API call.
  app.use(prodCors);

  const queue = makeQueue(); // cloudtasks in prod; throws if memory w/o handler

  // GitHub webhook needs the RAW body to verify its HMAC signature, so it's
  // registered with a raw parser BEFORE express.json() claims the JSON body.
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

  app.post('/createScan', async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    try {
      const auth = await resolveAuth(req.headers.authorization);
      if (auth) await ensureUser(auth);
      const result = await handleCreateScan(req.body, queue, { clientIp: ip, ownerUid: auth?.uid ?? null });
      res.status(result.status).json(result.body);
    } catch (e) {
      if (e instanceof AuthError) return void res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  app.post('/me', async (req: Request, res: Response) => {
    try {
      const auth = await requireAuth(req.headers.authorization);
      const { user, created } = await ensureUser(auth);
      // First-ever creation → welcome email (fire-and-forget; never blocks /me).
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

  // Billing: real Polar checkout + hosted customer portal. Plan is granted ONLY
  // by the verified webhook above — never by these calls.
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

  // Branded auth emails (verify + reset) via Resend.
  app.post('/auth/sendVerification', async (req: Request, res: Response) => {
    const r = await handleSendVerification(req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.post('/auth/sendReset', async (req: Request, res: Response) => {
    const r = await handleSendReset(req.body, req.ip || req.socket.remoteAddress || 'unknown');
    res.status(r.status).json(r.body);
  });

  // User feedback / help — anonymous allowed; stored server-side (Admin SDK).
  app.post('/feedback', async (req: Request, res: Response) => {
    let auth = null;
    try { auth = await resolveAuth(req.headers.authorization); }
    catch (e) { if (e instanceof AuthError) return res.status(e.status).json({ error: e.message }); throw e; }
    const r = await handleFeedback(req.body, auth, req.ip || req.socket.remoteAddress || 'unknown');
    res.status(r.status).json(r.body);
  });

  // Monitoring cron entry (Cloud Scheduler → header x-veilguard-cron: SECRET).
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

  // Real connections (OAuth): begin flow + provider callbacks.
  app.post('/connect/begin', async (req: Request, res: Response) => {
    const r = await handleConnectBegin(req.body, req.headers.authorization);
    res.status(r.status).json(r.body);
  });
  app.get('/connect/github/callback', async (req: Request, res: Response) => {
    const { query } = await handleGitHubCallback(req.query as Record<string, unknown>);
    res.type('html').send(renderOAuthResult(query));
  });
  app.get('/connect/supabase/callback', async (req: Request, res: Response) => {
    const { query } = await handleSupabaseCallback(req.query as Record<string, unknown>);
    res.type('html').send(renderOAuthResult(query));
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = createApiApp();
  // Cloud Run injects PORT; honor it (fall back to API_PORT, then 8080).
  const port = Number(process.env.PORT || process.env.API_PORT) || 8080;
  app.listen(port, () => console.log(`[api] listening on :${port} (queue=${config.queueImpl})`));
}
