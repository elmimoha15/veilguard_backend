import { createHash } from 'node:crypto';
import type { Finding } from 'veilguard-scanner';

/** Stable identity of a finding across scans of the same app (no line number). */
export function fpKey(f: Pick<Finding, 'ruleId' | 'title' | 'location'>): string {
  const title = f.title.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const where = f.location?.file ?? hostPath(f.location?.url) ?? '';
  return createHash('sha256').update(`${f.ruleId}|${where}|${title}`).digest('hex').slice(0, 20);
}

/** A URL without its query, and with hashed chunk names collapsed (bundles get new hashes per deploy). */
function hostPath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/_next\/static\/chunks\/[^/]+$/, '/_next/static/chunks/*')}`;
  } catch {
    return url;
  }
}

