import { FieldValue } from 'firebase-admin/firestore';
import { getDb, getPlan } from '../../shared/src/firestore.js';
import { config } from '../../shared/src/config.js';
import { getEmailTransport } from '../../shared/src/email.js';
import { rateLimit } from './rate-limit.js';
import type { AuthInfo } from './auth.js';
import type { HttpResult } from './createScan.js';

/** The coarse buckets the UI offers; anything else normalizes to 'other'. */
const TYPES = new Set(['bug', 'idea', 'help', 'other']);
const MAX_MESSAGE = 5000;

interface FeedbackBody {
  type?: string;
  message?: string;
  email?: string;
  /** Auto-captured context (the user never fills these). */
  page?: string;
  scanId?: string;
  userAgent?: string;
}

/**
 * POST /feedback — PUBLIC (anonymous allowed), rate-limited. Writes one
 * submission to the top-level `feedback` collection via the Admin SDK (so the
 * collection is fully locked to clients — see firestore.rules) and best-effort
 * notifies SUPPORT_EMAIL via the existing email transport. Firestore is the
 * source of truth the owner reviews; the email is just a ping.
 *
 * Server-owned fields (userId, plan, createdAt, status) are set here, never
 * trusted from the client. Context fields (page/scanId/userAgent) are recorded
 * verbatim for triage.
 */
export async function handleFeedback(
  rawBody: unknown,
  auth: AuthInfo | null,
  clientIp: string,
): Promise<HttpResult> {
  const b = (rawBody ?? {}) as FeedbackBody;

  const message = (b.message ?? '').trim();
  if (!message) return { status: 400, body: { error: 'Please add a message before sending.' } };
  if (message.length > MAX_MESSAGE) return { status: 400, body: { error: 'That message is too long — please shorten it.' } };

  const email = (b.email ?? auth?.email ?? '').trim();
  // Anonymous submitters must leave a way to reach them back.
  if (!auth && !email) return { status: 400, body: { error: 'Please add your email so we can reply.' } };

  const rl = rateLimit(`feedback|${clientIp}|${auth?.uid ?? email.toLowerCase() ?? 'anon'}`);
  if (!rl.allowed) return { status: 429, body: { error: 'Too many messages just now — please try again shortly.' } };

  const type = TYPES.has((b.type ?? '').toLowerCase()) ? (b.type as string).toLowerCase() : 'other';
  const plan = auth ? await getPlan(auth.uid).catch(() => null) : null;

  const submission = {
    type,
    message,
    email: email || null,
    userId: auth?.uid ?? null,
    plan: plan ?? null,
    page: typeof b.page === 'string' ? b.page.slice(0, 500) : null,
    scanId: typeof b.scanId === 'string' ? b.scanId.slice(0, 200) : null,
    userAgent: typeof b.userAgent === 'string' ? b.userAgent.slice(0, 500) : null,
    status: 'new' as const,
    createdAt: FieldValue.serverTimestamp(),
  };

  let id: string;
  try {
    const ref = await getDb().collection('feedback').add(submission);
    id = ref.id;
  } catch (e) {
    console.error('[feedback] write failed:', (e as Error)?.message);
    return { status: 502, body: { error: 'We couldn’t send that just now — please try again in a moment.' } };
  }

  // Best-effort owner notification — never fail the request if the email doesn't send.
  try {
    const label = type === 'bug' ? 'Bug' : type === 'idea' ? 'Feedback / idea' : type === 'help' ? 'Help request' : 'Feedback';
    await getEmailTransport().send({
      to: config.supportEmail,
      from: config.alertFromEmail,
      replyTo: email || undefined,
      subject: `[Veilguard] ${label} from ${email || 'an anonymous user'}`,
      text: [
        `Type: ${type}`,
        `From: ${email || '(anonymous, no email)'}`,
        `User: ${auth?.uid ?? 'anonymous'}${plan ? ` (${plan})` : ''}`,
        `Page: ${submission.page ?? '—'}`,
        submission.scanId ? `Scan: ${submission.scanId}` : null,
        '',
        message,
        '',
        `— feedback/${id}`,
      ].filter((l) => l !== null).join('\n'),
      tags: [{ name: 'type', value: 'feedback' }, { name: 'kind', value: type }],
      meta: { feedbackId: id, uid: auth?.uid ?? 'anon' },
    });
  } catch (e) {
    console.error('[feedback] notify email failed (submission saved):', (e as Error)?.message);
  }

  return { status: 200, body: { ok: true, id } };
}
