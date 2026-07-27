import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Minimal .env loader (no dependency). Reads the backend-root `.env` into
 * process.env WITHOUT overriding anything already set (so shell / emulator-exec
 * vars win). Call once at dev-server startup. Tests never call this, so they
 * stay credential-free and on the mock path.
 */
export function loadEnv(): void {
  const path = fileURLToPath(new URL('../../.env', import.meta.url)); // functions/src → backend root
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      // Strip a trailing inline comment (" # …") from unquoted values.
      val = val.replace(/\s+#.*$/, '').trim();
    }
    if (val && !(key in process.env)) process.env[key] = val;
  }
}
