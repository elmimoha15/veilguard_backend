import type { Request, Response, NextFunction } from 'express';
import { config } from '../../shared/src/config.js';

/**
 * Permissive CORS for LOCAL development only: lets the real frontend (a separate
 * origin, e.g. http://localhost:3000) call the dev-server. Reflects the request
 * origin and allows the Authorization header. In production the API and frontend
 * are configured explicitly; this middleware is fine for the emulator harness.
 */
export function devCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/**
 * Whether `origin` is a trusted frontend origin allowed to call the API from a
 * browser: the configured FRONTEND_URL host (+ its www.), the project's Firebase
 * Hosting domains (*.web.app / *.firebaseapp.com), and localhost for dev. Server-
 * to-server callers (webhooks) send no Origin and are unaffected.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    const feHost = new URL(config.frontendUrl).host; // e.g. veilguard.dev
    const bare = feHost.replace(/^www\./, '');
    return (
      host === feHost ||
      host === bare ||
      host === `www.${bare}` ||
      host.endsWith('.web.app') ||
      host.endsWith('.firebaseapp.com') ||
      host === 'localhost:3000' ||
      host === 'localhost'
    );
  } catch {
    return false;
  }
}

/**
 * Production CORS: reflect the Origin ONLY when it's a trusted frontend origin
 * (see isAllowedOrigin), otherwise send no Access-Control-Allow-Origin so the
 * browser blocks it. Handles the preflight (OPTIONS) itself. Authorization +
 * Content-Type are the only headers the client sends.
 */
export function prodCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  const allowed = isAllowedOrigin(origin);
  if (allowed && origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.status(allowed ? 204 : 403).end();
    return;
  }
  next();
}
