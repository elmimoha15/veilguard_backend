import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { config } from './config.js';

/**
 * App-level authenticated encryption for stored credentials (AES-256-GCM).
 *
 * The 32-byte key is derived (scrypt) from `ENCRYPTION_KEY` in the environment.
 * In production this should be a high-entropy secret from Secret Manager / KMS;
 * rotate by re-encrypting `secrets/*` under a new key (see README). Ciphertext
 * is stored only in the server-only `secrets/{uid}` collection, which
 * firestore.rules denies to all clients.
 *
 * Wire format (base64url, dot-separated): v1.<iv>.<authTag>.<ciphertext>
 */
const SALT = 'veilguard.creds.v1'; // static salt is fine for a single app key
const VERSION = 'v1';

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  if (!config.encryptionKey) {
    throw new Error('ENCRYPTION_KEY is not set — refusing to encrypt/decrypt credentials.');
  }
  cachedKey = scryptSync(config.encryptionKey, SALT, 32);
  return cachedKey;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(token: string): string {
  const [v, ivB, tagB, ctB] = token.split('.');
  if (v !== VERSION || !ivB || !tagB || !ctB) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
}

export function encryptJson(obj: unknown): string {
  return encrypt(JSON.stringify(obj));
}
export function decryptJson<T>(token: string): T {
  return JSON.parse(decrypt(token)) as T;
}

/** True if a stored value looks like our ciphertext (never plaintext creds). */
export function looksEncrypted(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(`${VERSION}.`) && v.split('.').length === 4;
}
