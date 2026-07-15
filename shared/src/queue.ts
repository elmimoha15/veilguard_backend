import { config } from './config.js';
import type { ScanJob } from './types.js';

/** Decouples createScan from the worker. Swap implementations by env. */
export interface Queue {
  enqueue(job: ScanJob): Promise<void>;
}

/**
 * Local / test queue. Invokes the given worker handler out-of-band
 * (setImmediate) so `enqueue` returns instantly and the caller (createScan)
 * never blocks on the scan — mirroring a real queue's fire-and-forget.
 */
export class InMemoryQueue implements Queue {
  constructor(private readonly handler: (job: ScanJob) => Promise<void>) {}

  async enqueue(job: ScanJob): Promise<void> {
    setImmediate(() => {
      void this.handler(job).catch((err) => {
        console.error(`[InMemoryQueue] handler failed for ${job.scanId}:`, err);
      });
    });
  }
}

/**
 * Production queue: creates an HTTP Cloud Task targeting the worker's /runScan,
 * authenticated with an OIDC token. Loaded lazily so local runs need no GCP deps.
 */
export class CloudTasksQueue implements Queue {
  async enqueue(job: ScanJob): Promise<void> {
    const { CloudTasksClient } = await import('@google-cloud/tasks');
    const client = new CloudTasksClient();
    const parent = client.queuePath(config.projectId, config.cloudTasksLocation, config.cloudTasksQueue);
    await client.createTask({
      parent,
      task: {
        httpRequest: {
          httpMethod: 'POST',
          url: `${config.workerUrl}/runScan`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(job)).toString('base64'),
          oidcToken: config.workerInvokerSa
            ? { serviceAccountEmail: config.workerInvokerSa }
            : undefined,
        },
      },
    });
  }
}

/**
 * Build the queue for the current environment. For "memory" a worker handler
 * must be supplied (the in-process runScan). "cloudtasks" ignores it.
 */
export function makeQueue(handler?: (job: ScanJob) => Promise<void>): Queue {
  if (config.queueImpl === 'cloudtasks') return new CloudTasksQueue();
  if (!handler) {
    throw new Error('InMemoryQueue requires a worker handler. Pass runScanJob to makeQueue().');
  }
  return new InMemoryQueue(handler);
}
