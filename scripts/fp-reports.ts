/**
 * Review "Mark as false positive" reports so real ones become scanner corpus
 * tests (veilguard-scanner/test-fixtures/corpus/safe/<case>/ + cases.json).
 *
 *   GCLOUD_PROJECT=veilguard-d6710 npx tsx scripts/fp-reports.ts [--days 30] [--rule RULE_ID]
 *
 * Read-only. Groups reports by rule so the noisiest rules surface first.
 */
import { getDb } from '../shared/src/firestore.js';

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 30;
const ruleFilter = args.includes('--rule') ? args[args.indexOf('--rule') + 1] : undefined;

async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const snap = await getDb().collection('falsePositiveReports').where('createdAt', '>=', since).get();
  const byRule = new Map<string, FirebaseFirestore.DocumentData[]>();
  for (const d of snap.docs) {
    const r = d.data();
    if (ruleFilter && r.ruleId !== ruleFilter) continue;
    byRule.set(r.ruleId, [...(byRule.get(r.ruleId) ?? []), { id: d.id, ...r }]);
  }
  const rows = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`${snap.size} reports in the last ${days} days, ${rows.length} rules\n`);
  for (const [rule, reports] of rows) {
    console.log(`${rule}  (${reports.length})`);
    for (const r of reports.slice(0, 10)) {
      const where = r.location?.file ?? r.location?.url ?? '';
      console.log(`  - [${r.severity}/${r.confidence}] ${r.title}  @ ${where}${r.evidence ? `  ev: ${r.evidence}` : ''}${r.reason ? `\n      reason: ${r.reason}` : ''}`);
    }
    console.log('');
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
