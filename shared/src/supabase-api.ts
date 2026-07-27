import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

/**
 * Supabase Management API OAuth + read-only helpers — no external SDK, mirroring
 * github-app.ts. We exchange an authorization code for tokens (server-side only,
 * using the client secret), refresh them when they expire, and use the access
 * token to READ the project's schema + RLS policies through the Management API.
 * Read-only throughout: we never call a write/admin endpoint.
 *
 * MOCK mode (config.mockConnections): every network call is short-circuited so
 * the whole flow (begin → callback → store → scan → refresh → revoke) runs on
 * the emulator against a local .sql fixture, with no real Supabase round-trip.
 */

const API = 'https://api.supabase.com';

/**
 * The read-only Management API capabilities we rely on. NOTE: Supabase OAuth2
 * scopes are configured on the OAuth APP itself (the `scope` query param is
 * deprecated), so this is NOT sent in the authorize URL — set your app to
 * read-only in the Supabase dashboard. We ALSO self-restrict to read-only
 * Management API calls (never a write/admin endpoint). This constant documents
 * that posture and is surfaced in the UI + connection metadata.
 */
export const SUPABASE_READONLY_SCOPES = [
  'projects:read',
  'database:read',
  'secrets:read',
] as const;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry in epoch-ms (undefined = unknown/never). */
  expiresAt?: number;
}

export interface ProjectInfo {
  ref: string;
  name: string;
  organizationId?: string;
}

/** PKCE (recommended by Supabase): a high-entropy verifier + its S256 challenge. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the authorize URL the browser is redirected to. `state` is our CSRF
 * token; `codeChallenge` is the PKCE S256 challenge. Scopes are NOT passed here
 * (they're configured on the OAuth app — see SUPABASE_READONLY_SCOPES).
 */
export function authorizeUrl(state: string, redirectUri: string, codeChallenge: string): string {
  const q = new URLSearchParams({
    client_id: config.supabaseClientId || 'mock-client-id',
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${API}/v1/oauth/authorize?${q.toString()}`;
}

/** HTTP Basic header for the confidential client (server-side only). */
function basicAuth(): string {
  const raw = `${config.supabaseClientId}:${config.supabaseClientSecret}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

function tokenSetFrom(json: { access_token: string; refresh_token?: string; expires_in?: number }): TokenSet {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
  };
}

/**
 * Exchange an authorization code for tokens. Uses the client SECRET (Basic auth)
 * and therefore MUST run server-side only. Returns access + refresh tokens.
 */
export async function exchangeCodeForToken(code: string, redirectUri: string, codeVerifier?: string): Promise<TokenSet> {
  if (config.mockConnections) {
    // Deterministic mock tokens — no network. Encodes a short life so the
    // refresh path is exercisable; refresh token is "good" (renewable).
    return { accessToken: `mock-access-${code || 'code'}`, refreshToken: 'mock-refresh-good', expiresAt: Date.now() + 3600_000 };
  }
  const body: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirectUri };
  if (codeVerifier) body.code_verifier = codeVerifier; // PKCE
  const res = await fetch(`${API}/v1/oauth/token`, {
    method: 'POST',
    headers: { authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`Supabase token exchange failed: ${res.status} ${await res.text()}`);
  return tokenSetFrom((await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number });
}

/**
 * Renew an access token using the refresh token. Throws on failure so the caller
 * can mark the connection "needs reconnect" without crashing the scan.
 * MOCK: a refresh token containing "bad" (or "revoked") fails; anything else renews.
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  if (config.mockConnections) {
    if (/bad|revoked/i.test(refreshToken)) throw new Error('mock refresh rejected (token revoked)');
    return { accessToken: `mock-access-refreshed-${Date.now()}`, refreshToken, expiresAt: Date.now() + 3600_000 };
  }
  const res = await fetch(`${API}/v1/oauth/token`, {
    method: 'POST',
    headers: { authorization: basicAuth(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  if (!res.ok) throw new Error(`Supabase token refresh failed: ${res.status}`);
  return tokenSetFrom((await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number });
}

/**
 * Supabase exposes no OAuth token-revocation endpoint. Disconnect is enforced by
 * deleting our encrypted copy (below) so we can never use the token again; the
 * user can also revoke the app's access from their Supabase dashboard. Kept as a
 * no-op for call-site symmetry with the GitHub connector.
 */
export async function revokeToken(_token: string): Promise<void> {
  return;
}

/** The first project the grant covers (owner/ref + display name). */
export async function firstProject(accessToken: string): Promise<ProjectInfo> {
  const res = await fetch(`${API}/v1/projects`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Supabase list projects failed: ${res.status}`);
  const arr = (await res.json()) as { id?: string; ref?: string; name?: string; organization_id?: string }[];
  const p = arr?.[0];
  if (!p) throw new Error('the grant covers no Supabase project');
  return { ref: p.ref || p.id || 'project', name: p.name || 'project', organizationId: p.organization_id };
}

/** Run one read-only SQL statement via the Management API query endpoint. */
async function runReadOnlyQuery(accessToken: string, projectRef: string, query: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${API}/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, read_only: true }),
  });
  if (!res.ok) throw new Error(`Supabase query failed: ${res.status}`);
  return (await res.json()) as Record<string, unknown>[];
}

/**
 * Read the project's tables (+ rowsecurity flag) and policies, then reconstruct
 * them as .sql text the engine's existing RLS analyzer already understands. This
 * is connector glue feeding the analyzer — it does not re-implement detection.
 * The returned string is written into the ephemeral workspace and discarded.
 */
export async function fetchSchemaSql(accessToken: string, projectRef: string): Promise<string> {
  const tables = await runReadOnlyQuery(
    accessToken,
    projectRef,
    `select n.nspname as schema, c.relname as name, c.relrowsecurity as rls
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and n.nspname not in ('pg_catalog','information_schema','pg_toast')`,
  );
  const policies = await runReadOnlyQuery(
    accessToken,
    projectRef,
    `select schemaname, tablename, policyname, cmd, coalesce(qual,'') as qual
     from pg_policies where schemaname not in ('pg_catalog','information_schema')`,
  );

  const lines: string[] = ['-- Reconstructed read-only schema + RLS policies (ephemeral; never persisted).'];
  for (const t of tables) {
    const schema = String(t.schema ?? 'public');
    const name = String(t.name ?? '');
    if (!name) continue;
    lines.push(`create table ${schema}.${name} ();`);
    if (t.rls === true || t.rls === 't') lines.push(`alter table ${schema}.${name} enable row level security;`);
  }
  for (const p of policies) {
    const schema = String(p.schemaname ?? 'public');
    const table = String(p.tablename ?? '');
    const pol = String(p.policyname ?? 'policy');
    const cmd = String(p.cmd ?? 'select').toLowerCase();
    const qual = String(p.qual ?? '');
    if (!table) continue;
    lines.push(`create policy "${pol}" on ${schema}.${table} for ${cmd} using (${qual});`);
  }
  return lines.join('\n') + '\n';
}

/**
 * ACTIVE (read-only) anon-read probe: which tables can the anonymous role read
 * that it shouldn't? Returns table names that leak rows. Real mode fetches the
 * project's anon key + REST URL and reads one row per common table. MOCK mode
 * derives the answer from the fixture (tables with RLS disabled leak).
 *
 * This is a live confirmation of the static finding — read-only, no writes.
 */
export async function probeAnonReadableTables(accessToken: string, projectRef: string, schemaSql?: string): Promise<string[]> {
  if (config.mockConnections) {
    // A table is "leaky" if it's created but never has RLS enabled (fixture).
    const sql = schemaSql ?? '';
    const created = new Set<string>();
    const rls = new Set<string>();
    for (const m of sql.matchAll(/create\s+table\s+(?:public\.)?["']?([a-z_][a-z0-9_]*)/gi)) created.add(m[1]!.toLowerCase());
    for (const m of sql.matchAll(/alter\s+table\s+(?:public\.)?["']?([a-z_][a-z0-9_]*)["']?\s+enable\s+row\s+level\s+security/gi)) rls.add(m[1]!.toLowerCase());
    return [...created].filter((t) => !rls.has(t));
  }

  // Real: get the project's REST URL + anon key, then read one row per table.
  const keysRes = await fetch(`${API}/v1/projects/${projectRef}/api-keys`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!keysRes.ok) return [];
  const keys = (await keysRes.json()) as { name?: string; api_key?: string }[];
  const anon = keys.find((k) => k.name === 'anon')?.api_key;
  if (!anon) return [];
  const restBase = `https://${projectRef}.supabase.co/rest/v1`;

  const candidates = ['users', 'profiles', 'customers', 'orders', 'payments', 'invoices', 'subscriptions', 'accounts'];
  const leaked: string[] = [];
  await Promise.all(
    candidates.map(async (t) => {
      try {
        const r = await fetch(`${restBase}/${t}?select=*&limit=1`, { headers: { apikey: anon, authorization: `Bearer ${anon}` } });
        if (r.status !== 200) return;
        const rows = (await r.json()) as unknown;
        if (Array.isArray(rows) && rows.length > 0) leaked.push(t);
      } catch {
        /* table absent / network — ignore */
      }
    }),
  );
  return leaked;
}
