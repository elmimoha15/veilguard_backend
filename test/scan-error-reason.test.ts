/**
 * The worker classifies every scan failure into a coarse, client-mappable
 * `errorReason` (drives the friendly UI + transient-only auto-retry). This locks
 * that mapping so the frontend copy stays reliable.
 */
import { describe, it, expect } from 'vitest';
import { classifyError, ScanTimeoutError } from '../worker/src/runScan.js';
import { NeedsReconnectError } from '../worker/src/deepScan.js';

describe('classifyError → errorReason', () => {
  it('maps each failure kind to its coarse reason', () => {
    expect(classifyError(new ScanTimeoutError(120_000))).toBe('timeout');
    expect(classifyError(new NeedsReconnectError('reconnect Supabase'))).toBe('needs-reconnect');
    expect(classifyError(new Error('target URL unreachable: https://x.dev'))).toBe('unreachable');
    expect(classifyError(new Error('uploaded archive contained no scannable files'))).toBe('empty-upload');
    expect(classifyError(new Error('uploaded archive not found'))).toBe('not-found');
    expect(classifyError(new Error('repo path not found: /tmp/x'))).toBe('not-found');
    expect(classifyError(new Error('some engine blew up'))).toBe('engine-error');
    expect(classifyError('a bare string')).toBe('engine-error');
  });
});
