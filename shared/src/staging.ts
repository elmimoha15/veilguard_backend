import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
}

let _staging: StagingStore | null = null;

/** The staging store for the current environment (GCS in cloudtasks prod, else local FS). */
export function makeStaging(): StagingStore {
  if (_staging) return _staging;
  _staging = config.queueImpl === 'cloudtasks' ? new GcsStaging() : new LocalFsStaging();
  return _staging;
}
