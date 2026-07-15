import type { Target } from '../../shared/src/types.js';

export interface GuardResult {
  ok: boolean;
  error?: string;
}

const PRIVATE_HOSTNAMES = /^(localhost|.*\.local|.*\.localhost|ip6-localhost)$/i;

/** IPv4 literal → true if in a private / reserved / loopback range. */
function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true; // 10/8, loopback, this-host
  if (a === 169 && b === 254) return true; // link-local
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '::1' || h === '::' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd');
}

/**
 * Validate a target submitted to the PUBLIC (free, unauthenticated) createScan.
 * Only http/https URLs to public hosts are allowed. Repo/white-box targets need
 * a code connection (Slice 5), so they are rejected here with a clear message.
 *
 * `allowPrivateTargets` is a test/local-dev seam (default false = secure): it
 * permits localhost/private IPs so the dev harness + e2e tests can scan a local
 * test server. Production leaves it false.
 */
export function guardPublicTarget(target: Target, allowPrivateTargets = false): GuardResult {
  if (target.type !== 'url') {
    return {
      ok: false,
      error: 'Only URL scans are available on the free tier. Connect your code for a deep scan (coming soon).',
    };
  }

  let url: URL;
  try {
    url = new URL(target.value);
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Unsupported URL scheme "${url.protocol}". Use http or https.` };
  }

  if (!allowPrivateTargets) {
    const host = url.hostname;
    if (PRIVATE_HOSTNAMES.test(host) || isPrivateIpv4(host) || isPrivateIpv6(host)) {
      return { ok: false, error: 'That host is not scannable (localhost / private addresses are blocked).' };
    }
  }

  return { ok: true };
}
