/**
 * Slice 7 — email alerts, behind a transport interface so tests (and local runs)
 * need no real email provider. The console/in-memory transport records every
 * "sent" message so the gate can assert exactly what would be emailed. In prod,
 * setting RESEND_API_KEY switches the default transport to Resend automatically
 * (see `defaultTransport` below) — no startup wiring needed.
 */
import { Resend } from 'resend';
import { config } from './config.js';

export interface EmailTag { name: string; value: string }

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body (always sent alongside html for deliverability). */
  text: string;
  /** Branded HTML body (rendered from a React Email template). */
  html?: string;
  /** Override the from address (defaults to config.alertFromEmail on the transport). */
  from?: string;
  /** Reply-To address (e.g. support@). */
  replyTo?: string;
  /** URL for the List-Unsubscribe header (alert/marketing mail). */
  listUnsubscribe?: string;
  /** Resend tags for logging/filtering, e.g. [{name:'type',value:'alert'}]. */
  tags?: EmailTag[];
  /** Structured context — handy for tests and logging (never contains secrets). */
  meta?: Record<string, unknown>;
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Captured outbox — populated by the console transport; read/reset by tests. */
const sentEmails: EmailMessage[] = [];
export function getSentEmails(): readonly EmailMessage[] {
  return sentEmails;
}
export function resetSentEmails(): void {
  sentEmails.length = 0;
}

/** Default transport: log a one-liner and capture the message. No network. */
export class ConsoleEmailTransport implements EmailTransport {
  async send(msg: EmailMessage): Promise<void> {
    sentEmails.push(msg);
    console.log(`[email] → ${msg.to}: ${msg.subject}`);
  }
}

/**
 * Real transport: send via the Resend SDK. Active only when RESEND_API_KEY is
 * set. Sends html + text (+ reply-to, List-Unsubscribe, tags). Retries with
 * bounded backoff on rate-limit (429) / 5xx. Throws after retries; every caller
 * wraps sends in try/catch, so a delivery failure is logged without crashing the
 * scan/monitoring/auth flow.
 */
export class ResendEmailTransport implements EmailTransport {
  private client: Resend | null = null;
  private static readonly BACKOFF_MS = [300, 900, 2000];

  /** Build the SDK client lazily (its constructor throws without a key). */
  private sdk(): Resend {
    if (!this.client) this.client = new Resend(config.resendApiKey);
    return this.client;
  }

  async send(msg: EmailMessage): Promise<void> {
    const payload: Record<string, unknown> = {
      from: msg.from || config.alertFromEmail,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    };
    if (msg.html) payload.html = msg.html;
    if (msg.replyTo) payload.replyTo = msg.replyTo;
    if (msg.tags) payload.tags = msg.tags;
    if (msg.listUnsubscribe) {
      payload.headers = {
        'List-Unsubscribe': `<${msg.listUnsubscribe}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= ResendEmailTransport.BACKOFF_MS.length; attempt++) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await this.sdk().emails.send(payload as any);
        if (!error) return;
        lastErr = error;
        const status = (error as { statusCode?: number }).statusCode ?? 0;
        // Only retry transient failures; a 4xx (bad address, etc.) fails fast.
        if (status !== 429 && status < 500) throw new Error(`Resend send failed: ${(error as { message?: string }).message ?? 'unknown'}`);
      } catch (e) {
        lastErr = e;
      }
      const wait = ResendEmailTransport.BACKOFF_MS[attempt];
      if (wait !== undefined) await sleep(wait);
    }
    throw new Error(`Resend send failed after retries: ${String((lastErr as { message?: string })?.message ?? lastErr)}`);
  }
}

/** Pick the transport from env at first use: Resend when keyed, else console. */
function defaultTransport(): EmailTransport {
  return config.resendApiKey ? new ResendEmailTransport() : new ConsoleEmailTransport();
}

let transport: EmailTransport | null = null;

/** Current transport (Resend when RESEND_API_KEY is set, else console). */
export function getEmailTransport(): EmailTransport {
  if (!transport) transport = defaultTransport();
  return transport;
}

/** Override the transport (tests, or wiring a real provider at startup). */
export function setEmailTransport(t: EmailTransport): void {
  transport = t;
}
