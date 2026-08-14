import { getScan, listFindingDocs, readPrivateFix, type PublicFinding } from '../../shared/src/firestore.js';
import { generateCombinedPrompt, AiFixUnavailableError } from '../../shared/src/claude-fix.js';
import { underAiFixCap, bumpClaudeCall } from '../../shared/src/usage.js';
import { config } from '../../shared/src/config.js';
import { requireAuth, AuthError } from './auth.js';
import { requirePaid } from './plan-gate.js';
import type { HttpResult } from './createScan.js';

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

interface FixItem { title: string; severity: string; where?: string; fix?: string; fixPrompt?: string; explanation?: string }

function whereOf(f: PublicFinding): string | undefined {
  const p = f as unknown as { location?: { file?: string; line?: number; url?: string } };
  return p.location?.file ? `${p.location.file}${p.location.line ? `:${p.location.line}` : ''}` : p.location?.url;
}

/** Deterministic fallback prompt (no Claude) — always available. */
function composeFallback(items: FixItem[]): string {
  const lines = [
    'Apply the following security fixes to my app. Work through them worst-first and re-test after each.',
    '',
  ];
  items.forEach((it, i) => {
    lines.push(`${i + 1}. [${it.severity.toUpperCase()}] ${it.title}${it.where ? ` — ${it.where}` : ''}`);
    if (it.explanation) lines.push(`   Why it matters: ${it.explanation}`);
    if (it.fixPrompt) lines.push(`   Do this: ${it.fixPrompt}`);
    if (it.fix) lines.push('   Fix:\n' + it.fix.split('\n').map((l) => '   ' + l).join('\n'));
    lines.push('');
  });
  lines.push('Apply all of the above, then re-scan to confirm every issue is resolved.');
  return lines.join('\n');
}

/**
 * POST /allFixesPrompt { scanId } — GUARD-only. Assemble every finding's fix for
 * a scan into ONE organized master prompt the user pastes into their AI coding
 * tool to apply everything at once. Claude synthesizes the prompt; if AI is
 * disabled or over the monthly cap, a deterministic concatenation is returned so
 * the feature always works. Ownership + paid gated.
 */
export async function handleAllFixesPrompt(scanId: string | undefined, authHeader: string | undefined): Promise<HttpResult> {
  if (!scanId) return { status: 400, body: { error: 'scanId is required' } };

  let uid: string;
  try {
    uid = (await requireAuth(authHeader)).uid;
  } catch (e) {
    if (e instanceof AuthError) return { status: e.status, body: { error: e.message } };
    throw e;
  }

  const scan = await getScan(scanId);
  if (!scan) return { status: 404, body: { error: 'scan not found' } };
  if (scan.ownerUid !== null && scan.ownerUid !== uid) return { status: 403, body: { error: 'not your scan' } };
  if (!(await requirePaid(uid))) {
    return { status: 402, body: { error: 'Copy-all-fixes is a Guard feature — upgrade to unlock.' } };
  }

  // Gather each finding + its stored fix (Claude where already tailored, else canned).
  const docs = await listFindingDocs(scanId);
  const items: FixItem[] = [];
  for (const { id, finding } of docs) {
    const fix = await readPrivateFix(scanId, id);
    if (!fix || (!fix.fix && !fix.fixPrompt)) continue; // nothing to apply
    const f = finding as unknown as { title?: string; severity?: string };
    items.push({ title: f.title ?? 'Security issue', severity: f.severity ?? 'info', where: whereOf(finding), fix: fix.fix, fixPrompt: fix.fixPrompt, explanation: fix.explanation });
  }
  if (items.length === 0) return { status: 404, body: { error: 'no fixes available for this scan yet' } };
  items.sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));

  // Prefer a Claude-composed prompt; fall back to a deterministic one.
  if (config.aiFixEnabled && (await underAiFixCap(uid))) {
    try {
      const composed = await generateCombinedPrompt(items);
      if (composed) {
        await bumpClaudeCall(uid);
        return { status: 200, body: { prompt: composed, count: items.length } };
      }
    } catch (e) {
      if (!(e instanceof AiFixUnavailableError)) {
        console.error('[allFixesPrompt] compose failed:', e instanceof Error ? e.message : e);
      }
      // fall through to deterministic
    }
  }
  return { status: 200, body: { prompt: composeFallback(items), count: items.length } };
}
