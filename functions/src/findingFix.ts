import { getScan, readPrivateFix, getPublicFinding, writeAiFixById, type PublicFinding } from '../../shared/src/firestore.js';
import { generateFixFromFinding, AiFixUnavailableError, type FixInput } from '../../shared/src/claude-fix.js';
import { underAiFixCap, bumpClaudeCall } from '../../shared/src/usage.js';
import { config } from '../../shared/src/config.js';
import { requireAuth, AuthError } from './auth.js';
import { canReadFix, getEntitlements } from './entitlements.js';
import type { HttpResult } from './createScan.js';

/** Map a public finding to the fields Claude needs. */
function toFixInput(f: PublicFinding): FixInput {
  const p = f as unknown as { ruleId: string; category?: string; severity: string; title: string; whyItMatters?: string; location?: { file?: string; line?: number; url?: string } };
  const where = p.location?.file ? `${p.location.file}${p.location.line ? `:${p.location.line}` : ''}` : p.location?.url;
  return { ruleId: p.ruleId, category: p.category, severity: p.severity, title: p.title, whyItMatters: p.whyItMatters, where };
}

/**
 * POST /findingFix { scanId, findingId } — return the fix content for a finding.
 * The fix/fixPrompt live in `scans/{id}/findings/{fid}/private/fix`, which
 * firestore.rules deny to every client — so this server endpoint is the only
 * read path, gated by ownership + entitlement. Guard users get every fix; free
 * users get ONLY the scan's single teaser fix (others → 402, locked panel).
 *
 * GUARD = Claude fixes: when a Guard user opens a finding whose stored fix isn't
 * already Claude-tailored (`ai:true`), we generate one on demand from the
 * finding's stored details + the canned fix (the source is gone by now), persist
 * it (so it's cached), and return it. Falls back to the canned fix if AI is
 * disabled, over the monthly cap, or generation fails.
 */
export async function handleFindingFix(
  scanId: string | undefined,
  findingId: string | undefined,
  authHeader: string | undefined,
): Promise<HttpResult> {
  if (!scanId || !findingId) {
    return { status: 400, body: { error: 'scanId and findingId are required' } };
  }

  let uid: string;
  try {
    uid = (await requireAuth(authHeader)).uid;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  const scan = await getScan(scanId);
  if (!scan) return { status: 404, body: { error: 'scan not found' } };
  // Only the owner (or an ownerless anon scan) may read the fix.
  if (scan.ownerUid !== null && scan.ownerUid !== uid) {
    return { status: 403, body: { error: 'not your scan' } };
  }
  // Fixes are a paid feature — free users get only the scan's teaser fix.
  if (!(await canReadFix(uid, scanId, findingId))) {
    return { status: 402, body: { error: 'Fixes are a Pro feature — upgrade to unlock.' } };
  }

  let fix = await readPrivateFix(scanId, findingId);

  // Guard on-demand Claude generation: tailor the fix if it isn't already AI.
  const ent = await getEntitlements(uid);
  if (ent.isGuard && (!fix || !fix.ai) && config.aiFixEnabled && (await underAiFixCap(uid))) {
    const pub = await getPublicFinding(scanId, findingId);
    if (pub) {
      const evidence = (pub as unknown as { evidence?: string }).evidence;
      try {
        const gen = await generateFixFromFinding(toFixInput(pub), evidence, fix ? { fix: fix.fix, fixPrompt: fix.fixPrompt } : undefined);
        if (gen) {
          await writeAiFixById(scanId, findingId, gen);
          await bumpClaudeCall(uid);
          fix = { ...gen, ai: true };
        }
      } catch (e) {
        // Account-level failure (no credits / bad key / rate limit) or any error:
        // keep whatever we have (canned) rather than failing the request.
        if (!(e instanceof AiFixUnavailableError)) {
          console.error('[findingFix] on-demand generation failed:', e instanceof Error ? e.message : e);
        }
      }
    }
  }

  if (!fix || (!fix.fix && !fix.fixPrompt)) return { status: 404, body: { error: 'no fix for this finding' } };
  // `explanation` is present only for Claude-tailored fixes; omitted for canned.
  return { status: 200, body: { fix: fix.fix, fixPrompt: fix.fixPrompt, ...(fix.explanation ? { explanation: fix.explanation } : {}) } };
}
