import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { getDb } from './firestore.js';

/**
 * Ephemeral transfer of an uploaded .zip from the create-time process to the
 * worker. Deliberately tiny (put / get / delete) and swappable by environment —
 * mirrors `makeQueue`. The staged object is deleted by the worker the instant it
 * has extracted it, so uploaded source is never stored beyond the scan.
 */
export interface StagingStore {
  put(id: string, bytes: Uint8Array): Promise<void>;
  get(id: string): Promise<Buffer>;
  delete(id: string): Promise<void>;
  /**
   * Mint an upload URL the BROWSER writes the zip to directly (bypassing our API,
   * so uploads aren't bounded by Cloud Run's ~32MB request cap). Prod → a GCS
   * resumable-session URI; local → a relative `/uploadBytes` path the dev server
   * writes to local FS. `origin` is the browser origin (for the GCS CORS grant).
   */
  createUploadSession(id: string, origin: string): Promise<string>;
  /** First `bytes` of the staged object (for a cheap zip magic-byte check). Throws if missing. */
  head(id: string, bytes: number): Promise<Buffer>;
  /** Size in bytes of the staged object. Throws if missing. */
  size(id: string): Promise<number>;
}

/**
 * Local filesystem staging: writes to `os.tmpdir()/veilguard-uploads/<id>.zip`.
 * Works when the API and worker share a filesystem — the in-process InMemoryQueue
 * used locally, and any single-host deploy. NOT valid for a multi-instance Cloud
 * Tasks deploy (the API and worker are different machines) — use GcsStaging there.
 */
export class LocalFsStaging implements StagingStore {
  private path(id: string): string {
    return join(tmpdir(), 'veilguard-uploads', `${id}.zip`);
  }
  async put(id: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(id);
    mkdirSync(join(tmpdir(), 'veilguard-uploads'), { recursive: true });
    writeFileSync(p, bytes);
  }
  async get(id: string): Promise<Buffer> {
    return readFileSync(this.path(id));
  }
  async delete(id: string): Promise<void> {
    try {
      rmSync(this.path(id), { force: true });
    } catch {
      /* best-effort */
    }
  }
  // Local dev has no GCS: the browser PUTs the zip to the dev server, which
  // writes it to local FS. Relative path → the frontend resolves it against its
  // configured API base.
  async createUploadSession(id: string): Promise<string> {
    return `/uploadBytes?scanId=${encodeURIComponent(id)}`;
  }
  async head(id: string, bytes: number): Promise<Buffer> {
    return readFileSync(this.path(id)).subarray(0, bytes);
  }
  async size(id: string): Promise<number> {
    return statSync(this.path(id)).size;
  }
}

/**
 * GCS staging: stores the zip at `uploads/<id>.zip` in `config.uploadBucket`.
 * Used for multi-instance prod (QUEUE_IMPL=cloudtasks) where API and worker don't
 * share disk. Reuses the Admin SDK (getDb() guarantees the app is initialized).
 */
export class GcsStaging implements StagingStore {
  /** Lazy-import the storage client so local/memory runs never load it. */
  private async object(id: string) {
    getDb(); // ensure the firebase-admin default app is initialized
    const { getStorage } = await import('firebase-admin/storage');
    return getStorage().bucket(config.uploadBucket).file(`uploads/${id}.zip`);
  }
  async put(id: string, bytes: Uint8Array): Promise<void> {
    const obj = await this.object(id);
    await obj.save(Buffer.from(bytes), { contentType: 'application/zip', resumable: false });
  }
  async get(id: string): Promise<Buffer> {
    const obj = await this.object(id);
    const [buf] = await obj.download();
    return buf;
  }
  async delete(id: string): Promise<void> {
    try {
      const obj = await this.object(id);
      await obj.delete({ ignoreNotFound: true });
    } catch {
      /* best-effort */
    }
  }
  async createUploadSession(id: string, origin: string): Promise<string> {
    const obj = await this.object(id);
    const [uri] = await obj.createResumableUpload({
      metadata: { contentType: 'application/zip' },
      origin,
    });
    return uri;
  }
  async head(id: string, bytes: number): Promise<Buffer> {
    const obj = await this.object(id);
    const [buf] = await obj.download({ start: 0, end: bytes - 1 });
    return buf;
  }
  async size(id: string): Promise<number> {
    const obj = await this.object(id);
    const [meta] = await obj.getMetadata();
    return Number(meta.size ?? 0);
  }
}

let _staging: StagingStore | null = null;

/** The staging store for the current environment (GCS in cloudtasks prod, else local FS). */
export function makeStaging(): StagingStore {
  if (_staging) return _staging;
  _staging = config.queueImpl === 'cloudtasks' ? new GcsStaging() : new LocalFsStaging();
  return _staging;
}
