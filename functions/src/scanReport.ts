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

function header(doc: PDFKit.PDFDocument, subtitle: string): void {
  doc.rect(0, 0, doc.page.width, 6).fill(BRAND.yellow);
  doc.fillColor(BRAND.ink).font('Helvetica-Bold').fontSize(20).text('Veilguard', 50, 40);
  doc.font('Helvetica').fontSize(11).fillColor(BRAND.muted).text(subtitle, 50, 66);
  doc.moveDown(2);
  doc.fillColor(BRAND.ink);
}
function fmtDate(iso: string): string { try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return iso; } }

function renderScanPdf(m: ScanReportModel): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    header(doc, `Security report · ${m.target}`);
    // Grade + score
    doc.font('Helvetica-Bold').fontSize(48).fillColor(gradeColor(m.grade)).text(m.grade ?? '—', { continued: false });
    doc.font('Helvetica').fontSize(11).fillColor(BRAND.muted)
      .text(`${m.score != null ? `Score ${m.score} · ` : ''}${m.counts.critical} critical · ${m.counts.high} high · ${m.counts.medium} medium · ${m.counts.low} low`);
    doc.fontSize(10).fillColor(BRAND.label).text(`Generated ${fmtDate(m.date)}`);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND.ink).text('What we found');
    doc.moveDown(0.5);
    if (m.findings.length === 0) {
      doc.font('Helvetica').fontSize(11).fillColor(BRAND.muted).text('No issues found in this scan — nice work.');
    }
    for (const f of m.findings) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(gradeColor(f.severity === 'critical' || f.severity === 'high' ? 'F' : f.severity === 'medium' ? 'C' : 'A'))
        .text(f.severity.toUpperCase());
      doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.ink).text(f.title);
      if (f.whyItMatters) doc.font('Helvetica').fontSize(10.5).fillColor(BRAND.muted).text(f.whyItMatters);
      if (f.where) doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(BRAND.label).text(f.where);
      if (f.fix) { doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.ink).text('Fix:'); doc.font('Helvetica').fontSize(10).fillColor(BRAND.text).text(f.fix); }
      if (f.fixPrompt) { doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.ink).text('Prompt for your AI:'); doc.font('Helvetica').fontSize(10).fillColor(BRAND.text).text(f.fixPrompt); }
      doc.moveDown(0.8);
    }
    if (m.fixesLocked) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Oblique').fontSize(10).fillColor(BRAND.yellowDark)
        .text('Upgrade to Guard to unlock the exact fix (and an AI prompt) for every issue above.');
    }
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.label).text('Generated by Veilguard · veilguard.dev');
  });
}

function renderAccountPdf(m: AccountReportModel): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    header(doc, 'Account security summary');
    doc.font('Helvetica').fontSize(11).fillColor(BRAND.muted).text(`Plan: ${m.plan === 'guard' ? 'Guard' : 'Free'} · Scans used this month: ${m.scansUsed} / ${m.scanLimit}`);
    doc.fontSize(10).fillColor(BRAND.label).text(`Generated ${fmtDate(m.date)}`);
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND.ink).text('Your apps');
    doc.moveDown(0.5);
    if (m.apps.length === 0) doc.font('Helvetica').fontSize(11).fillColor(BRAND.muted).text('No completed scans yet.');
    for (const a of m.apps) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(gradeColor(a.grade)).text(`${a.grade ?? '—'}`, { continued: true });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND.ink).text(`  ${a.name}`, { continued: true });
      doc.font('Helvetica').fontSize(10.5).fillColor(BRAND.muted).text(`   — ${a.openIssues} open issue${a.openIssues === 1 ? '' : 's'}`);
      doc.moveDown(0.4);
    }
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.label).text('Generated by Veilguard · veilguard.dev');
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
