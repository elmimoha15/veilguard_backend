import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSign } from 'node:crypto';
import { config } from './config.js';

/**
 * GitHub App auth helpers — no external SDK. We sign a short-lived App JWT with
 * the App's private key (RS256), exchange it for an INSTALLATION access token
 * (repo-scoped, ~1h, minted fresh per use — never stored), and use that to read
 * the single repo the user granted. Read-only throughout.
 */

let cachedKey: string | null = null;
function privateKey(): string {
  if (cachedKey) return cachedKey;
  cachedKey = readFileSync(resolve(process.cwd(), config.githubPrivateKeyPath), 'utf8');
  return cachedKey;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** A ~9-minute App JWT (iss = App ID), signed with the App private key. */
export function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.githubAppId }));
  const data = `${header}.${payload}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey()).toString('base64url');
  return `${data}.${sig}`;
}

const GH = 'https://api.github.com';
const ghHeaders = (auth: string) => ({
  authorization: auth,
  accept: 'application/vnd.github+json',
  'user-agent': 'veilguard',
  'x-github-api-version': '2022-11-28',
});

/** Mint a fresh installation access token (repo-scoped, short-lived). */
export async function installationToken(installationId: number): Promise<string> {
  const res = await fetch(`${GH}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: ghHeaders(`Bearer ${appJwt()}`),
  });
  if (!res.ok) throw new Error(`GitHub installation token failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { token: string };
  return json.token;
}

/** The first repository the installation was granted (owner/name). */
export async function firstInstallationRepo(installationId: number): Promise<string> {
  const token = await installationToken(installationId);
  const res = await fetch(`${GH}/installation/repositories?per_page=1`, { headers: ghHeaders(`token ${token}`) });
  if (!res.ok) throw new Error(`GitHub list repos failed: ${res.status}`);
  const json = (await res.json()) as { repositories?: { full_name: string }[] };
  const repo = json.repositories?.[0]?.full_name;
  if (!repo) throw new Error('the installation was not granted any repository');
  return repo;
}

/** Non-secret repo summary returned to the client for the repo picker. */
export interface RepoSummary {
  fullName: string;
  private: boolean;
  language?: string;
  pushedAt?: string;
  defaultBranch?: string;
}

/**
 * Every repository the installation can access (read-only). Paginates through
 * `GET /installation/repositories` up to a sane cap so a huge account can't hang
 * the request. Uses a fresh installation token (never stored).
 */
export async function listInstallationRepos(installationId: number, maxRepos = 300): Promise<RepoSummary[]> {
  const token = await installationToken(installationId);
  const perPage = 100;
  const out: RepoSummary[] = [];
  for (let page = 1; out.length < maxRepos; page++) {
    const res = await fetch(`${GH}/installation/repositories?per_page=${perPage}&page=${page}`, {
      headers: ghHeaders(`token ${token}`),
    });
    if (!res.ok) throw new Error(`GitHub list repos failed: ${res.status}`);
    const json = (await res.json()) as {
      repositories?: { full_name: string; private: boolean; language?: string | null; pushed_at?: string; default_branch?: string }[];
    };
    const batch = json.repositories ?? [];
    for (const r of batch) {
      out.push({
        fullName: r.full_name,
        private: !!r.private,
        language: r.language ?? undefined,
        pushedAt: r.pushed_at,
        defaultBranch: r.default_branch,
      });
    }
    if (batch.length < perPage) break; // last page
  }
  // Newest activity first — a friendly default order for the picker.
  return out.slice(0, maxRepos).sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}

/** True if the installation actually has access to `fullName` (owner/name). Guards against scanning arbitrary repos. */
export async function installationHasRepo(installationId: number, fullName: string): Promise<boolean> {
  const repos = await listInstallationRepos(installationId);
  const needle = fullName.toLowerCase();
  return repos.some((r) => r.fullName.toLowerCase() === needle);
}
