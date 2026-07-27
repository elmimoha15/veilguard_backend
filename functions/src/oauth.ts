import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from '../../shared/src/config.js';
import { encryptJson } from '../../shared/src/crypto.js';
import { setConnection, setOAuthState, consumeOAuthState } from '../../shared/src/firestore.js';
import { firstInstallationRepo } from '../../shared/src/github-app.js';
import { authorizeUrl, exchangeCodeForToken, firstProject, newPkce, SUPABASE_READONLY_SCOPES } from '../../shared/src/supabase-api.js';
import type { GitHubSecret, GitHubConnectionMeta, SupabaseSecret, SupabaseConnectionMeta } from '../../shared/src/types.js';
import { requireAuth, AuthError } from './auth.js';
import { requirePaid } from './plan-gate.js';
import type { HttpResult } from './createScan.js';

const STATE_TTL_MS = 10 * 60 * 1000;

/** The redirect_uri Supabase sends the browser back to (must match the app config). */
function supabaseRedirectUri(): string {
  return `${config.oauthCallbackBase}/connect/supabase/callback`;
}

/**
 * The page served at the end of an OAuth callback. When opened in a POPUP it
 * messages the app window (postMessage, targeted at the frontend origin) and
 * closes itself — the SaaS updates in place, no full-page redirect. When opened
 * in a FULL WINDOW (no opener) it falls back to redirecting to the app's
 * /settings so the flow still completes gracefully.
 */
export function renderOAuthResult(query: string): string {
  const params = new URLSearchParams(query);
  const connected = params.get('connected') || '';
  const error = params.get('error') || '';
  const frontend = config.frontendUrl;
  let origin = frontend;
  try { origin = new URL(frontend).origin; } catch { /* keep as-is */ }
  const payload = JSON.stringify({ source: 'veilguard-oauth', connected, error });
  const fallbackUrl = JSON.stringify(`${frontend}/settings?${query}`);
  const label = connected
    ? `${connected[0]!.toUpperCase()}${connected.slice(1)} connected`
    : `Connection failed${error ? ` (${error})` : ''}`;
  const color = connected ? '#158a4f' : '#c0392f';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Veilguard</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#faf9f6;color:#1e1d1b}
.b{text-align:center}.d{font-size:15px;font-weight:600;color:${color}}.s{font-size:13px;color:#777;margin-top:8px}</style></head>
<body><div class="b"><div class="d">${label}</div><div class="s">You can close this window.</div></div>
<script>
(function(){
  var msg=${payload};
  try{
    if(window.opener&&!window.opener.closed){
      window.opener.postMessage(msg, ${JSON.stringify(origin)});
      setTimeout(function(){ window.close(); }, 300);
      return;
    }
  }catch(e){}
  // No opener (full-window flow): go back to the app.
  window.location.replace(${fallbackUrl});
})();
</script></body></html>`;
}

/**
 * POST /connect/begin { provider } — auth required. Creates a single-use CSRF
 * state bound to the caller's uid and returns the provider's authorize URL for
 * the browser to redirect to. Only GitHub is wired for real so far.
 */
export async function handleConnectBegin(rawBody: unknown, authHeader: string | undefined): Promise<HttpResult> {
  let uid: string;
  try {
    uid = (await requireAuth(authHeader)).uid;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  // Connecting a provider (for deep scans) is a paid feature.
  if (!(await requirePaid(uid))) {
    return { status: 402, body: { error: 'Connecting a repo/database is a Pro feature — upgrade to connect.' } };
  }

  const provider = (rawBody as { provider?: string })?.provider;

  if (provider === 'github') {
    if (!config.githubConfigured) {
      return { status: 501, body: { error: 'GitHub connection is not configured on the server (.env)' } };
    }
    const state = randomUUID();
    await setOAuthState(state, { uid, provider, createdAt: new Date().toISOString() });
    // Tolerate a slug pasted as a full URL (…/settings/apps/<slug>): take the
    // last non-empty path segment.
    const slug = config.githubAppSlug.split(/[?#]/)[0]!.split('/').filter(Boolean).pop() ?? '';
    // Install the App on a single repo; because "Request user authorization
    // during installation" is on, GitHub redirects to our callback with
    // ?code&installation_id&state.
    const redirectUrl = `https://github.com/apps/${slug}/installations/new?state=${state}`;
    return { status: 200, body: { redirectUrl, mock: config.mockConnections } };
  }

  if (provider === 'supabase') {
    // Works in MOCK mode (tests) without real creds; real mode needs them.
    if (!config.mockConnections && !config.supabaseConfigured) {
      return { status: 501, body: { error: 'Supabase connection is not configured on the server (set SUPABASE_OAUTH_CLIENT_ID/SECRET + OAUTH_CALLBACK_BASE)' } };
    }
    const state = randomUUID();
    const { verifier, challenge } = newPkce();
    await setOAuthState(state, { uid, provider, createdAt: new Date().toISOString(), codeVerifier: verifier });
    const redirectUrl = authorizeUrl(state, supabaseRedirectUri(), challenge);
    // scopes echoed for the UI (read-only posture); mock flag lets the UI decide
    // whether to redirect to Supabase (real) or auto-complete locally (tests).
    return { status: 200, body: { redirectUrl, scopes: [...SUPABASE_READONLY_SCOPES], mock: config.mockConnections } };
  }

  return { status: 400, body: { error: `provider "${provider}" is not available yet` } };
}

/**
 * GET /connect/github/callback — GitHub redirects here after install. Verifies
 * the state, resolves the installation's single repo, stores an encrypted
 * credential (installation id only — tokens are minted per scan), then bounces
 * the browser back to the frontend. Returns the URL to redirect to.
 */
export async function handleGitHubCallback(query: Record<string, unknown>): Promise<{ query: string }> {
  const back = (q: string) => ({ query: q });

  const state = typeof query.state === 'string' ? query.state : '';
  const installationId = Number(query.installation_id);
  if (!state) return back('error=missing_state');

  const st = await consumeOAuthState(state);
  if (!st || st.provider !== 'github') return back('error=bad_state');
  if (Date.now() - Date.parse(st.createdAt) > STATE_TTL_MS) return back('error=expired');
  if (!Number.isFinite(installationId)) return back('error=no_installation');

  try {
    const repo = await firstInstallationRepo(installationId);
    const secret: GitHubSecret = { mock: false, installationId, repo };
    const meta: Omit<GitHubConnectionMeta, 'connectedAt'> = {
      repo,
      scopes: ['contents:read', 'metadata:read'],
      writeAccess: false,
      mock: false,
    };
    await setConnection(st.uid, 'github', meta, encryptJson(secret));
    return back('connected=github');
  } catch {
    return back('error=github_failed');
  }
}

/**
 * GET /connect/supabase/callback — Supabase redirects here with ?code&state after
 * the user authorizes. Verifies the state (CSRF) + PKCE, exchanges the code for
 * tokens server-side (client secret never leaves the server), stores them
 * ENCRYPTED in secrets/{uid}, and records only non-secret metadata (project/org)
 * in users/{uid}.connections. Returns the query string to bounce the browser
 * back with (each route decides the base URL).
 */
export async function handleSupabaseCallback(query: Record<string, unknown>): Promise<{ query: string }> {
  const back = (q: string) => ({ query: q });

  const state = typeof query.state === 'string' ? query.state : '';
  const code = typeof query.code === 'string' ? query.code : '';
  // Supabase surfaces user-denied consent as ?error=access_denied.
  if (typeof query.error === 'string' && query.error) return back(`error=${encodeURIComponent(query.error)}`);
  if (!state) return back('error=missing_state');

  const st = await consumeOAuthState(state);
  if (!st || st.provider !== 'supabase') return back('error=bad_state');
  if (Date.now() - Date.parse(st.createdAt) > STATE_TTL_MS) return back('error=expired');
  if (!code) return back('error=no_code');

  try {
    const tokens = await exchangeCodeForToken(code, supabaseRedirectUri(), st.codeVerifier);

    let projectRef: string, projectName: string | undefined, org: string | undefined, policiesPath: string | undefined;
    if (config.mockConnections) {
      // No real project in mock mode — point the connection at the local fixture.
      projectRef = 'mock-project';
      projectName = 'Mock project';
      policiesPath = resolve(process.cwd(), config.mockSupabasePoliciesPath);
    } else {
      const p = await firstProject(tokens.accessToken);
      projectRef = p.ref;
      projectName = p.name;
      org = p.organizationId;
    }

    const secret: SupabaseSecret = {
      mode: 'oauth',
      mock: config.mockConnections,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      projectRef,
      policiesPath,
    };
    const meta: Omit<SupabaseConnectionMeta, 'connectedAt'> = {
      projectRef,
      projectName,
      org,
      access: 'read-only',
      scopes: [...SUPABASE_READONLY_SCOPES],
      mode: 'oauth',
      mock: config.mockConnections,
    };
    await setConnection(st.uid, 'supabase', meta, encryptJson(secret));
    return back('connected=supabase');
  } catch (e) {
    console.error('[oauth] supabase callback failed:', e instanceof Error ? e.message : e);
    return back('error=supabase_failed');
  }
}
