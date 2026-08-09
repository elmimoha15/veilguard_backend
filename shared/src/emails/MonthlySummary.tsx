import * as React from 'react';
import { Section, Row, Column, Text } from '@react-email/components';
import { Layout, Btn, Heading, Paragraph } from './components.js';
import { BRAND, gradeColor } from './brand.js';

export interface SummaryApp {
  name: string;
  grade?: string | null;
  openIssues: number;
  fixedThisMonth: number;
}

/**
 * Monthly security summary — one warm recap per user: each app's current grade,
 * issues fixed vs still open this month, and scans used. Reuses the shared Layout
 * + brand tokens so it matches every other Veilguard email.
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
      <Paragraph muted>
        A quick recap of how your {apps.length === 1 ? 'app is' : 'apps are'} holding up — grades, what got
        fixed, and what still needs attention.
      </Paragraph>

      <Section style={{ margin: '4px 0 8px' }}>
        {apps.map((a, i) => (
          <Row key={i} style={{ borderTop: i === 0 ? 'none' : `1px solid ${BRAND.border}`, padding: '12px 0' }}>
            <Column>
              <Text style={{ fontSize: '15px', fontWeight: 700, color: BRAND.ink, margin: 0 }}>{a.name}</Text>
              <Text style={{ fontSize: '13px', color: BRAND.muted, margin: '3px 0 0' }}>
                {a.openIssues} open · {a.fixedThisMonth} fixed this month
              </Text>
            </Column>
            <Column style={{ width: '48px', textAlign: 'right' as const }}>
              <Text style={{ fontSize: '22px', fontWeight: 800, color: gradeColor(a.grade), margin: 0 }}>
                {a.grade ?? '—'}
              </Text>
            </Column>
          </Row>
        ))}
      </Section>

      <Paragraph muted>Scans used this month: {scansUsed} / {scanLimit}.</Paragraph>

      <Section style={{ padding: '8px 0 4px' }}>
        <Btn href={ctaUrl}>Open your dashboard</Btn>
      </Section>
    </Layout>
  );
}
