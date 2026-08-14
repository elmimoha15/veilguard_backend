/**
 * Slice 8 — Claude-tailored fixes for DEEP (repo/upload) findings.
 *
 * The engine ships a canned `fix`/`fixPrompt` for every finding. For the top
 * findings of a Guard user's deep scan we replace those with a fix written for
 * the user's ACTUAL code: a plain-English explanation, the corrected snippet in
 * their own identifiers, and a copy-paste prompt for their AI tool.
 *
 * Guarantees this module upholds:
 *  - Guard-only by construction: only the deep-scan worker calls it, and deep
 *    scans are already paid-gated. Free/URL findings never reach here.
 *  - Never ships a broken fix: malformed / empty / off-topic model output →
 *    `null`, and the caller keeps the canned fix.
 *  - Privacy: the code snippet is sent to Anthropic to generate the fix and is
 *    NEVER persisted — only the generated text is stored/cached.
 *  - Cost: cached by hash(ruleId + normalized snippet) so identical findings
 *    (across users, and re-scans of unchanged code) reuse one result, no call.
 */
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './firestore.js';
import { config } from './config.js';

/** A tailored fix: corrected code + plain-English explanation + AI-tool prompt. */
export interface AiFix {
  fix: string; // corrected code for their snippet
  fixPrompt: string; // copy-paste prompt for Lovable/Cursor
  explanation: string; // plain-English, non-technical
}

/** Just what generateFix needs from a finding (keeps it decoupled from the engine type). */
export interface FixInput {
  ruleId: string;
  category?: string;
  severity: string;
  title: string;
  whyItMatters?: string;
  where?: string;
}

/**
 * An account-level failure (no credits, bad key, rate limit) — as opposed to bad
 * model output. It affects EVERY call this scan, so the caller stops trying and
 * keeps canned fixes for the rest instead of hammering the API per finding.
 */
export class AiFixUnavailableError extends Error {}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!config.aiFixEnabled) return null;
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 60_000, maxRetries: 1 });
  return client;
}

/** Stable, whitespace-insensitive key so trivial reformatting still hits cache. */
function normalizeSnippet(snippet: string): string {
  return snippet
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

export function fixCacheKey(ruleId: string, snippet: string): string {
  return createHash('sha256').update(`${ruleId}\n${normalizeSnippet(snippet)}`).digest('hex');
}

const cacheRef = (key: string) => getDb().collection('fixCache').doc(key);

export async function readFixCache(key: string): Promise<AiFix | null> {
  const snap = await cacheRef(key).get();
  if (!snap.exists) return null;
  const d = snap.data() as Partial<AiFix>;
  return d.fix && d.fixPrompt && d.explanation ? { fix: d.fix, fixPrompt: d.fixPrompt, explanation: d.explanation } : null;
}

export async function writeFixCache(key: string, fix: AiFix, model: string): Promise<void> {
  await cacheRef(key).set({ ...fix, model, createdAt: new Date().toISOString() });
}

const SYSTEM = [
  'You are a senior application-security engineer writing a fix for a specific vulnerability in a founder\'s own code.',
  'You are given one finding and the exact code snippet it was found in.',
  'Return ONLY a single JSON object (no prose, no markdown fences) with exactly these string fields:',
  '  "explanation": 2-4 sentences a non-technical founder understands — what the risk is and why it matters, in plain language.',
  '  "code": the corrected version of THEIR snippet. Reuse their real variable/table/file/function names from the snippet. Keep it minimal and safe — fix only this issue, invent no APIs, add no unrelated changes.',
  '  "aiPrompt": a short copy-paste instruction they can hand to an AI coding tool (Lovable/Cursor) to apply this fix to their codebase.',
  'Be conservative and correct. If you are unsure, prefer the smallest safe change. Output must be valid JSON and nothing else.',
].join('\n');

function buildUserPrompt(input: FixInput, snippet: string): string {
  return [
    `Finding: ${input.title}`,
    `Rule: ${input.ruleId}  Severity: ${input.severity}${input.category ? `  Category: ${input.category}` : ''}`,
    input.whyItMatters ? `Why it matters: ${input.whyItMatters}` : '',
    input.where ? `Location: ${input.where}` : '',
    '',
    'Vulnerable code snippet:',
    '```',
    snippet.slice(0, 6000),
    '```',
  ]
    .filter(Boolean)
    .join('\n');
}

/** First JSON object embedded in a text blob (tolerates stray prose / fences). */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Word tokens (len>=4) that carry meaning, for a light "did it address the snippet?" check. */
function identifiers(s: string): Set<string> {
  return new Set((s.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).map((w) => w.toLowerCase()));
}

/** Validate the model's output; return a clean AiFix or null (→ caller uses canned). */
function validate(raw: unknown, snippet: string): AiFix | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const code = typeof o.code === 'string' ? o.code.trim() : '';
  const explanation = typeof o.explanation === 'string' ? o.explanation.trim() : '';
  const aiPrompt = typeof o.aiPrompt === 'string' ? o.aiPrompt.trim() : '';
  if (!code || !explanation || !aiPrompt) return null;
  if (explanation.length < 12 || code.length < 8) return null;
  // Light relevance check: the corrected code should share at least one real
  // identifier with the snippet (so an off-topic/generic answer is rejected).
  const snipIds = identifiers(snippet);
  if (snipIds.size > 0) {
    const codeIds = identifiers(code);
    let overlap = false;
    for (const id of codeIds) if (snipIds.has(id)) { overlap = true; break; }
    if (!overlap) return null;
  }
  return { fix: code, fixPrompt: aiPrompt, explanation };
}

/** Raw model call → joined text. Throws AiFixUnavailableError on ACCOUNT-level failure. */
async function rawText(model: string, system: string, user: string, maxTokens = 2048): Promise<string | null> {
  const c = getClient();
  if (!c) return null;
  let resp: Anthropic.Message;
  try {
    resp = await c.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  } catch (e) {
    // Any API/transport error is account-level for this scan — signal "stop".
    throw new AiFixUnavailableError(e instanceof Error ? e.message : String(e));
  }
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Call one model. Returns an AiFix (valid) or null (unusable OUTPUT → the caller
 * may escalate). Throws AiFixUnavailableError on an ACCOUNT-level API failure
 * (no credits / bad key / rate limit), which escalation can't help.
 */
async function callModel(model: string, input: FixInput, snippet: string): Promise<AiFix | null> {
  const text = await rawText(model, SYSTEM, buildUserPrompt(input, snippet));
  return text == null ? null : validate(extractJson(text), snippet); // null = bad output → escalate
}

/**
 * Generate a tailored fix for one finding+snippet. Tries the cheap model first;
 * if its OUTPUT fails validation, escalates ONCE to the stronger model. Returns
 * null when disabled or when both models produce unusable output. Throws
 * AiFixUnavailableError on an account-level failure so the caller can stop the
 * whole scan's AI-fix pass (escalating/retrying wouldn't help).
 */
export async function generateFix(input: FixInput, snippet: string): Promise<AiFix | null> {
  if (!config.aiFixEnabled) return null;
  const primary = await callModel(config.aiFixModel, input, snippet); // may throw
  if (primary) return primary;
  if (config.aiFixEscalateModel && config.aiFixEscalateModel !== config.aiFixModel) {
    return callModel(config.aiFixEscalateModel, input, snippet); // may throw
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* On-demand generation (post-scan) — NO source snippet available             */
/*                                                                            */
/* The scanned source is wiped after each scan, so when a Guard user opens a  */
/* finding whose fix wasn't Claude-tailored at scan time, we generate from the */
/* finding's stored details + the engine's canned fix as reference. Lower      */
/* fidelity than the snippet path (can't reference exact source lines), but    */
/* still tailored to the specific issue. No snippet-relevance check.           */
/* -------------------------------------------------------------------------- */

const SYSTEM_META = [
  'You are a senior application-security engineer writing a fix for one vulnerability in a founder\'s app.',
  'You are given the finding details and the security scanner\'s generic fix. The exact source code is NOT available.',
  'Return ONLY a single JSON object (no prose, no markdown fences) with exactly these string fields:',
  '  "explanation": 2-4 sentences a non-technical founder understands — the risk and why it matters, in plain language.',
  '  "code": a concrete corrected code/config example that shows how to fix this issue for this stack (Supabase/Firebase/Next.js/Stripe as relevant). Keep it minimal and safe; invent no APIs.',
  '  "aiPrompt": a short copy-paste instruction they can hand to an AI coding tool (Lovable/Cursor) to apply this fix to their codebase.',
  'Be conservative and correct. Prefer the smallest safe change. Output must be valid JSON and nothing else.',
].join('\n');

function buildMetaPrompt(input: FixInput, evidence?: string, canned?: { fix?: string; fixPrompt?: string }): string {
  return [
    `Finding: ${input.title}`,
    `Rule: ${input.ruleId}  Severity: ${input.severity}${input.category ? `  Category: ${input.category}` : ''}`,
    input.whyItMatters ? `Why it matters: ${input.whyItMatters}` : '',
    input.where ? `Location: ${input.where}` : '',
    evidence ? `Redacted evidence from the app:\n${evidence.slice(0, 2000)}` : '',
    canned?.fix ? `Scanner's generic fix (improve on this, make it specific):\n${canned.fix.slice(0, 2000)}` : '',
    canned?.fixPrompt ? `Scanner's generic prompt:\n${canned.fixPrompt.slice(0, 1000)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Validate model output WITHOUT a snippet-relevance check (there's no snippet). */
function validateMeta(raw: unknown): AiFix | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const code = typeof o.code === 'string' ? o.code.trim() : '';
  const explanation = typeof o.explanation === 'string' ? o.explanation.trim() : '';
  const aiPrompt = typeof o.aiPrompt === 'string' ? o.aiPrompt.trim() : '';
  if (!code || !explanation || !aiPrompt) return null;
  if (explanation.length < 12 || code.length < 8) return null;
  return { fix: code, fixPrompt: aiPrompt, explanation };
}

async function callModelMeta(model: string, input: FixInput, evidence?: string, canned?: { fix?: string; fixPrompt?: string }): Promise<AiFix | null> {
  const text = await rawText(model, SYSTEM_META, buildMetaPrompt(input, evidence, canned));
  return text == null ? null : validateMeta(extractJson(text));
}

/**
 * Generate a tailored fix for a finding from its stored details (no source
 * snippet). Cheap model first, escalate once on bad output. Returns null when
 * disabled or unusable; throws AiFixUnavailableError on account-level failure.
 */
export async function generateFixFromFinding(input: FixInput, evidence?: string, canned?: { fix?: string; fixPrompt?: string }): Promise<AiFix | null> {
  if (!config.aiFixEnabled) return null;
  const primary = await callModelMeta(config.aiFixModel, input, evidence, canned); // may throw
  if (primary) return primary;
  if (config.aiFixEscalateModel && config.aiFixEscalateModel !== config.aiFixModel) {
    return callModelMeta(config.aiFixEscalateModel, input, evidence, canned); // may throw
  }
  return null;
}

/**
 * Compose ONE organized master prompt from every finding's fix (Guard "copy all
 * fixes"). Single Claude call. Returns null when disabled/unusable or on
 * account-level failure — the caller then falls back to a deterministic prompt.
 */
export async function generateCombinedPrompt(items: { title: string; severity: string; where?: string; fix?: string; fixPrompt?: string; explanation?: string }[]): Promise<string | null> {
  if (!config.aiFixEnabled || items.length === 0) return null;
  const system = [
    'You are a senior security engineer preparing a single set of instructions a non-technical founder will paste into their AI coding tool (Lovable/Cursor) to fix every security issue in their app at once.',
    'You are given a list of findings, each with its fix. Produce ONE clear, organized prompt (plain text, no JSON, no markdown fences) that:',
    '  - opens with one short sentence of context,',
    '  - groups related fixes together and orders them worst-first (critical → high → medium → low),',
    '  - for each issue: a short heading, one plain-English line on the risk, and the concrete change to make,',
    '  - ends with a one-line instruction to apply all changes and re-test.',
    'Keep it tight and copy-pasteable. Do not invent issues beyond those given.',
  ].join('\n');
  const user = items
    .map((it, i) => [
      `${i + 1}. [${it.severity.toUpperCase()}] ${it.title}${it.where ? ` (${it.where})` : ''}`,
      it.explanation ? `   Risk: ${it.explanation}` : '',
      it.fix ? `   Fix:\n${it.fix.slice(0, 1500)}` : '',
      it.fixPrompt ? `   Prompt: ${it.fixPrompt.slice(0, 800)}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n');
  // Use the stronger model for synthesis quality; may throw AiFixUnavailableError.
  const model = config.aiFixEscalateModel || config.aiFixModel;
  const text = await rawText(model, system, `Findings and their fixes:\n\n${user}`.slice(0, 24000), 3000);
  return text && text.trim().length > 0 ? text.trim() : null;
}
