import * as React from 'react';
import { Text } from '@react-email/components';
import { Layout, Btn, Heading, Paragraph } from './components.js';
import { BRAND } from './brand.js';

export interface SummaryApp {
  name: string;
  grade?: string | null;
  openIssues: number;
  fixedThisMonth: number;
}

/**
 * Monthly security summary — one plain recap per user: each app's current grade,
 * issues fixed vs still open this month, and scans used. Reads like a normal
 * email; the shared Layout keeps it consistent with every other Veilguard email.
 */
export function MonthlySummary({
  apps,
  scansUsed,
  scanLimit,
  ctaUrl,
  unsubscribeUrl,
}: {
  apps: SummaryApp[];
  scansUsed: number;
  scanLimit: number;
  ctaUrl: string;
  unsubscribeUrl?: string;
}) {
  return (
    <Layout preview="Your monthly Veilguard security summary" unsubscribeUrl={unsubscribeUrl}>
      <Heading>Your security this month</Heading>
      <Paragraph>
        A quick recap of how your {apps.length === 1 ? 'app is' : 'apps are'} holding up, grades, what got
        fixed, and what still needs attention.
      </Paragraph>

      {apps.map((a, i) => (
        <Text key={i} style={{ fontSize: '15px', lineHeight: '1.6', color: BRAND.text, margin: '0 0 10px' }}>
          {a.name} — grade {a.grade ?? '—'}, {a.openIssues} open, {a.fixedThisMonth} fixed this month.
        </Text>
      ))}

      {/* The Free plan is unlimited (usage.ts UNLIMITED sentinel = 1,000,000). */}
      <Paragraph muted>Scans used this month: {scansUsed} / {scanLimit >= 1_000_000 ? 'Unlimited' : scanLimit}.</Paragraph>

      <Btn href={ctaUrl}>Open your dashboard</Btn>
    </Layout>
  );
}
