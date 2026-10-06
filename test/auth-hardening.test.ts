import { describe, it, expect } from 'vitest';
import { getAuth } from 'firebase-admin/auth';
import { resolveAuth, requireFreshAuth, AuthError } from '../functions/src/auth.js';
import { handleRevokeSessions } from '../functions/src/revokeSessions.js';
import { prodCors } from '../functions/src/cors.js';
import { authedClient } from './client.js';
import { sleep } from './harness.js';

let seq = 0;
const email = () => `auth-harden-${Date.now()}-${++seq}@test.dev`;

describe('step-up reauth (requireFreshAuth)', () => {
  it('accepts a fresh sign-in and rejects a stale one with code reauth_required', async () => {
    const a = await authedClient(email(), 'password123');
    const header = `Bearer ${a.token}`;

    // Fresh (signed in just now) → passes a 10-minute window.
    const info = await requireFreshAuth(header, 600);
    expect(info.uid).toBe(a.uid);
    expect(typeof info.authTime).toBe('number');

    // Any non-trivial age exceeds a negative window → reauth required.
    await expect(requireFreshAuth(header, -1)).rejects.toMatchObject({
      status: 401,
      code: 'reauth_required',
    });
    await a.close();
  });
});

describe('kill switch (revocation)', () => {
  it('rejects a token after revokeRefreshTokens, and /auth/revokeSessions revokes', async () => {
    const a = await authedClient(email(), 'password123');
    const header = `Bearer ${a.token}`;

    // Valid before revoke.
    expect((await resolveAuth(header))?.uid).toBe(a.uid);

    // "Sign out of all devices" endpoint revokes this user's refresh tokens.
    await sleep(1100); // tokensValidAfterTime is second-granular — ensure iat < revokeTime
    const res = await handleRevokeSessions(header);
    expect(res.status).toBe(200);
    expect((res.body as { ok?: boolean }).ok).toBe(true);

    // The previously-valid token is now rejected (checkRevoked=true).
    await expect(resolveAuth(header)).rejects.toBeInstanceOf(AuthError);
    await a.close();
  });

  it('revokeRefreshTokens(uid) directly invalidates an existing token', async () => {
    const a = await authedClient(email(), 'password123');
    const header = `Bearer ${a.token}`;
    await sleep(1100);
    await getAuth().revokeRefreshTokens(a.uid);
    await expect(resolveAuth(header)).rejects.toBeInstanceOf(AuthError);
    await a.close();
  });
});

describe('CORS allowlist', () => {
  function run(origin: string): { allowOrigin: string | undefined; status: number } {
    const headers: Record<string, string> = {};
    let status = 200;
    const req = { headers: { origin }, method: 'GET' } as unknown as Parameters<typeof prodCors>[0];
    const res = {
      setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
      status: (s: number) => { status = s; return res; },
      end: () => {},
    } as unknown as Parameters<typeof prodCors>[1];
    prodCors(req, res, () => {});
    return { allowOrigin: headers['access-control-allow-origin'], status };
  }

  it('allows our domain, blocks unknown + wildcard Firebase origins, gates localhost to dev', () => {
    const origEnv = { fe: process.env.FRONTEND_URL, node: process.env.NODE_ENV };
    try {
      process.env.FRONTEND_URL = 'https://veilguard.dev';

      // Production: only our exact hosts.
      process.env.NODE_ENV = 'production';
      expect(run('https://veilguard.dev').allowOrigin).toBe('https://veilguard.dev');
      expect(run('https://www.veilguard.dev').allowOrigin).toBe('https://www.veilguard.dev');
      expect(run('https://evil.web.app').allowOrigin).toBeUndefined();          // wildcard removed
      expect(run('https://evil.firebaseapp.com').allowOrigin).toBeUndefined();  // wildcard removed
      expect(run('http://localhost:3000').allowOrigin).toBeUndefined();         // no localhost in prod

      // Development: localhost allowed.
      process.env.NODE_ENV = 'development';
      expect(run('http://localhost:3000').allowOrigin).toBe('http://localhost:3000');
    } finally {
      process.env.FRONTEND_URL = origEnv.fe;
      process.env.NODE_ENV = origEnv.node;
    }
  });
});

describe('dev-only server cannot run in production', () => {
  it('createDevServer throws under NODE_ENV=production', async () => {
    const { createDevServer } = await import('../functions/src/local-server.js');
    const orig = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => createDevServer()).toThrow(/production/i);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
