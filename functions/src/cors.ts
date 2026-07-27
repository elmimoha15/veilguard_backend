import type { Request, Response, NextFunction } from 'express';

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
