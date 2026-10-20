import type { Express, Request } from 'express';

/**
 * Real client IP behind Cloud Run.
 *
 * Cloud Run (incl. a custom domain mapping) sits behind Google's front end, which
 * APPENDS the address it saw to X-Forwarded-For. So the last entry is the real
 * client, and anything a client sends itself lands to the LEFT of it. Trusting
 * exactly that many proxy hops makes `req.ip` the real client and makes spoofing
 * impossible: a forged `X-Forwarded-For: 1.2.3.4` just becomes another ignored
 * left-hand entry. Without this, `req.ip` was the front end's own address, so
 * every visitor shared ONE rate-limit bucket.
 *
 * TRUST_PROXY_HOPS: 1 for Cloud Run (direct or domain mapping), 2 if an external
 * HTTPS load balancer is ever added in front.
 */
export function configureTrustProxy(app: Express): void {
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  app.set('trust proxy', Number.isInteger(hops) && hops >= 0 ? hops : 1);
}

export function clientIp(req: Request, fallback = 'unknown'): string {
  return req.ip || req.socket.remoteAddress || fallback;
}
