import PDFDocument from 'pdfkit';
import { getScan, getUser, listUserScans, listFindingDocs, readPrivateFix } from '../../shared/src/firestore.js';
import { getUsageCounts, scanLimit } from '../../shared/src/usage.js';
import { userApps } from '../../shared/src/monitor.js';
import { canReadFix } from './entitlements.js';
import { requireAuth, AuthError } from './auth.js';
import { BRAND, gradeColor } from '../../shared/src/emails/brand.js';
import type { ScanDoc } from '../../shared/src/types.js';
import type { HttpResult } from './createScan.js';

/* ── Report models (pure data — unit-testable, no PDF/HTTP) ─────────────────── */

export interface ReportFinding {
  title: string;
  whyItMatters: string;
  severity: string;
  where?: string;
  /** Included ONLY when the caller is entitled to this finding's fix. */
  fix?: string;
  fixPrompt?: string;
}
export interface ScanReportModel {
  target: string;
  grade: string | null;
  score: number | null;
  counts: { critical: number; high: number; medium: number; low: number };
  date: string;
  findings: ReportFinding[];
  /** True if some fixes were withheld (Free plan) — the PDF shows an upgrade note. */
  fixesLocked: boolean;
}
export interface AccountReportModel {
  apps: { name: string; grade: string | null; openIssues: number }[];
  scansUsed: number;
  scanLimit: number;
  plan: string;
  date: string;
}

function openCount(s?: ScanDoc): { critical: number; high: number; medium: number; low: number } {
  const c = s?.counts;
  return { critical: c?.critical ?? 0, high: c?.high ?? 0, medium: c?.medium ?? 0, low: c?.low ?? 0 };
}
function targetLabel(s: ScanDoc): string {
  if (s.type === 'deep') return s.sources?.githubRepo ?? 'Connected repo';
  if (s.type === 'upload') return (s.target.value || '').replace(/^upload:/, '') || 'Uploaded folder';
  try { return new URL(s.target.value.startsWith('http') ? s.target.value : `https://${s.target.value}`).hostname; }
  catch { return s.target.value; }
}
function hostOf(v: string | undefined): string {
  if (!v) return '';
  try { return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return v.trim().toLowerCase(); }
}
function appKeyOf(s: ScanDoc): { key: string; label: string } {
  if (s.type === 'deep') return { key: `repo:${(s.sources?.githubRepo ?? 'repo').toLowerCase()}`, label: targetLabel(s) };
  if (s.type === 'upload') return { key: s.target.value, label: targetLabel(s) };
  return { key: `url:${hostOf(s.target.value)}`, label: targetLabel(s) };
}

/**
 * Build a per-scan report model. Public finding fields always included; each
 * finding's `fix`/`fixPrompt` are included ONLY when `canReadFix` allows (Guard =
 * all; Free = the single teaser finding). No private data leaks for the rest.
 */
export async function buildScanReport(uid: string, scanId: string, scan: ScanDoc): Promise<ScanReportModel> {
  const docs = await listFindingDocs(scanId);
  const findings: ReportFinding[] = [];
  let fixesLocked = false;
  // Sort by severity so the report leads with the worst.
  const rank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  docs.sort((a, b) => (rank[String((b.finding as { severity?: string }).severity)] ?? 0) - (rank[String((a.finding as { severity?: string }).severity)] ?? 0));
  for (const { id, finding } of docs) {
    const f = finding as { title?: string; whyItMatters?: string; severity?: string; location?: { file?: string; line?: number; url?: string } };
    const rf: ReportFinding = {
      title: f.title ?? 'Security issue',
      whyItMatters: f.whyItMatters ?? '',
      severity: f.severity ?? 'info',
      where: f.location?.file ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ''}` : f.location?.url,
    };
    if (await canReadFix(uid, scanId, id)) {
      const fix = await readPrivateFix(scanId, id);
      if (fix?.fix) rf.fix = fix.fix;
      if (fix?.fixPrompt) rf.fixPrompt = fix.fixPrompt;
    } else {
      fixesLocked = true;
    }
    findings.push(rf);
  }
  return {
    target: targetLabel(scan),
    grade: scan.grade ?? null,
    score: scan.score ?? null,
    counts: openCount(scan),
    date: scan.finishedAt ?? scan.createdAt,
    findings,
    fixesLocked,
  };
}

/** Build an account-wide summary model: each app's latest grade + open issues. */
export async function buildAccountReport(uid: string, now = Date.now()): Promise<AccountReportModel> {
  const [scans, user, usage] = await Promise.all([listUserScans(uid), getUser(uid), getUsageCounts(uid, now)]);
  const registryNames = new Map(userApps(user).map((a) => [a.githubRepo ? `repo:${a.githubRepo.toLowerCase()}` : a.url ? `url:${hostOf(a.url)}` : `app:${a.id}`, a.name]));
  const seen = new Map<string, { name: string; grade: string | null; openIssues: number }>();
  for (const s of scans) {
    if (s.status !== 'done') continue;
    const { key, label } = appKeyOf(s);
    if (seen.has(key)) continue; // scans are newest-first → first done is latest
    const oc = openCount(s);
    seen.set(key, { name: registryNames.get(key) ?? label, grade: s.grade ?? null, openIssues: oc.critical + oc.high + oc.medium + oc.low });
  }
  return {
    apps: [...seen.values()],
    scansUsed: usage.scansThisMonth,
    scanLimit: scanLimit(user?.plan),
    plan: user?.plan ?? 'free',
    date: new Date(now).toISOString(),
  };
}

/* ── PDF rendering ──────────────────────────────────────────────────────────── */

function pdfToBuffer(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Veilguard Security Report', Author: 'Veilguard' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { build(doc); doc.end(); } catch (e) { reject(e as Error); }
  });
}

const MARGIN = 50;
function contentWidth(doc: PDFKit.PDFDocument): number { return doc.page.width - MARGIN * 2; }

/** A full-width hairline at the current y (the Veilguard divider), with spacing
 *  before/after so sections read like the app's hairline-separated lists. */
function hairline(doc: PDFKit.PDFDocument, gapBefore = 10, gapAfter = 14): void {
  const y = doc.y + gapBefore;
  doc.save().moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).lineWidth(0.75).strokeColor(BRAND.border).stroke().restore();
  doc.y = y + gapAfter;
}
/** Start a new page if there isn't at least `needed` px left before the bottom margin. */
function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > doc.page.height - 55) doc.addPage();
}
/** Severity → the app's grade-language colors. */
function sevColor(sev: string): string {
  const s = sev.toLowerCase();
  if (s === 'critical' || s === 'high') return '#DC2626';
  if (s === 'medium') return '#D97706';
  return BRAND.label;
}

function header(doc: PDFKit.PDFDocument, subtitle: string): void {
  doc.rect(0, 0, doc.page.width, 4).fill(BRAND.yellow);
  doc.fillColor(BRAND.ink).font('Helvetica-Bold').fontSize(19).text('Veilguard', MARGIN, 44);
  doc.font('Helvetica').fontSize(10.5).fillColor(BRAND.muted).text(subtitle, MARGIN, 70, { width: contentWidth(doc) });
  doc.y = Math.max(doc.y, 90);
  hairline(doc, 2, 20);
}
function fmtDate(iso: string): string { try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return iso; } }

/** A labelled fix/prompt block: a small uppercase label + the body in mono,
 *  indented, flowing across page breaks (matches the app's fix presentation). */
function fixBlock(doc: PDFKit.PDFDocument, label: string, body: string): void {
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND.label).text(label.toUpperCase(), MARGIN, doc.y, { characterSpacing: 0.5 });
  doc.moveDown(0.25);
  doc.font('Courier').fontSize(9.5).fillColor(BRAND.text).text(body, MARGIN + 12, doc.y, { width: contentWidth(doc) - 12, lineGap: 1.5 });
}

function renderScanPdf(m: ScanReportModel): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    header(doc, `Security report · ${m.target}`);

    // Grade block
    doc.font('Helvetica-Bold').fontSize(46).fillColor(gradeColor(m.grade)).text(m.grade ?? '—', MARGIN, doc.y);
    doc.font('Helvetica').fontSize(11).fillColor(BRAND.muted)
      .text(`${m.counts.critical} critical · ${m.counts.high} high · ${m.counts.medium} medium · ${m.counts.low} low`, MARGIN, doc.y + 3);
    if (m.score != null) doc.font('Helvetica').fontSize(10).fillColor(BRAND.muted).text(`Score ${m.score} / 100`, MARGIN, doc.y + 2);
    doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.label).text(`Generated ${fmtDate(m.date)}`, MARGIN, doc.y + 2);
    hairline(doc, 14, 18);

    doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND.ink).text('What we found', MARGIN, doc.y);
    doc.moveDown(0.7);

    if (m.findings.length === 0) {
      doc.font('Helvetica').fontSize(11).fillColor(BRAND.muted).text('No issues found in this scan — nice work.', MARGIN, doc.y);
    }
    m.findings.forEach((f, i) => {
      ensureSpace(doc, 96);
      if (i > 0) hairline(doc, 8, 16);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(sevColor(f.severity)).text(f.severity.toUpperCase(), MARGIN, doc.y, { characterSpacing: 0.5 });
      doc.font('Helvetica-Bold').fontSize(12.5).fillColor(BRAND.ink).text(f.title, MARGIN, doc.y + 2, { width: contentWidth(doc) });
      if (f.whyItMatters) doc.font('Helvetica').fontSize(10.5).fillColor(BRAND.muted).text(f.whyItMatters, MARGIN, doc.y + 2, { width: contentWidth(doc), lineGap: 1 });
      if (f.where) doc.font('Helvetica-Oblique').fontSize(9).fillColor(BRAND.label).text(f.where, MARGIN, doc.y + 3, { width: contentWidth(doc) });
      if (f.fix) fixBlock(doc, 'The fix', f.fix);
      if (f.fixPrompt) fixBlock(doc, 'Prompt for your AI', f.fixPrompt);
    });

    if (m.fixesLocked) {
      hairline(doc, 12, 16);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.yellowDark)
        .text('Upgrade to Guard to unlock the exact fix and an AI prompt for every issue above.', MARGIN, doc.y, { width: contentWidth(doc) });
    }

    hairline(doc, 16, 12);
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.label).text('Generated by Veilguard · veilguard.dev', MARGIN, doc.y);
  });
}

function renderAccountPdf(m: AccountReportModel): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    header(doc, 'Account security summary');
    doc.font('Helvetica').fontSize(11).fillColor(BRAND.muted).text(`Plan: ${m.plan === 'guard' ? 'Guard' : 'Free'} · Scans used this month: ${m.scansUsed} / ${m.scanLimit}`, MARGIN, doc.y, { width: contentWidth(doc) });
    doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.label).text(`Generated ${fmtDate(m.date)}`, MARGIN, doc.y + 2);
    hairline(doc, 14, 18);

    doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND.ink).text('Your apps', MARGIN, doc.y);
    doc.moveDown(0.7);
    if (m.apps.length === 0) doc.font('Helvetica').fontSize(11).fillColor(BRAND.muted).text('No completed scans yet.', MARGIN, doc.y);
    m.apps.forEach((a, i) => {
      ensureSpace(doc, 40);
      if (i > 0) hairline(doc, 6, 12);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(gradeColor(a.grade)).text(`${a.grade ?? '—'}  `, MARGIN, doc.y, { continued: true });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.ink).text(a.name, { continued: true });
      doc.font('Helvetica').fontSize(10.5).fillColor(a.openIssues > 0 ? '#DC2626' : BRAND.muted).text(`    ${a.openIssues} open issue${a.openIssues === 1 ? '' : 's'}`);
    });

    hairline(doc, 16, 12);
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.label).text('Generated by Veilguard · veilguard.dev', MARGIN, doc.y);
  });
}

/* ── HTTP handlers ─────────────────────────────────────────────────────────── */

export type PdfResult = HttpResult | { status: 200; pdf: Buffer; filename: string };

/** POST /scanReport { scanId } → a branded PDF for one scan (owner-only). */
export async function handleScanReport(scanId: string | undefined, authHeader: string | undefined): Promise<PdfResult> {
  if (!scanId) return { status: 400, body: { error: 'scanId is required' } };
  let uid: string;
  try { uid = (await requireAuth(authHeader)).uid; }
  catch (e) { if (e instanceof AuthError) return { status: e.status, body: { error: e.message } }; throw e; }

  const scan = await getScan(scanId);
  if (!scan) return { status: 404, body: { error: 'scan not found' } };
  if (scan.ownerUid !== null && scan.ownerUid !== uid) return { status: 403, body: { error: 'not your scan' } };

  const model = await buildScanReport(uid, scanId, scan);
  const pdf = await renderScanPdf(model);
  return { status: 200, pdf, filename: `veilguard-report-${model.target.replace(/[^a-z0-9.-]/gi, '_')}.pdf` };
}

/** POST /accountReport → a branded account-wide summary PDF for the caller. */
export async function handleAccountReport(authHeader: string | undefined): Promise<PdfResult> {
  let uid: string;
  try { uid = (await requireAuth(authHeader)).uid; }
  catch (e) { if (e instanceof AuthError) return { status: e.status, body: { error: e.message } }; throw e; }
  const model = await buildAccountReport(uid);
  const pdf = await renderAccountPdf(model);
  return { status: 200, pdf, filename: 'veilguard-account-summary.pdf' };
}
