import { runFullScan, QUICKCART_PATH } from '../test/harness.js';

const { doc, findings } = await runFullScan({ type: 'repo', value: QUICKCART_PATH });
console.log('=== scans/{scanId} ===');
console.log(JSON.stringify(doc, null, 2));
console.log(`\n=== ${findings.length} finding docs (showing 2) ===`);
const crit = findings.find((f) => f.severity === 'critical');
const bb = findings.find((f) => f.category === 'database') ?? findings[1];
console.log(JSON.stringify([crit, bb].filter(Boolean), null, 2));
process.exit(0);
