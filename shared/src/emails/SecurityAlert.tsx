import * as React from 'react';
import { Text } from '@react-email/components';
import { Layout, Btn, Heading, Paragraph } from './components.js';
import { BRAND } from './brand.js';

export interface AlertFinding {
  severity: string;
  title: string;
  whyItMatters?: string;
  where?: string;
}

export interface SecurityAlertProps {
  appName: string;
  findings: AlertFinding[];
  gradeBefore?: string | null;
  gradeAfter?: string | null;
  viewUrl: string;
  unsubscribeUrl?: string;
}

/** The security-alert email — the most important one. Plain, specific, actionable. */
export function SecurityAlert({ appName, findings, gradeBefore, gradeAfter, viewUrl, unsubscribeUrl }: SecurityAlertProps) {
  const count = findings.length;
  const gradeChanged = !!gradeBefore && !!gradeAfter && gradeBefore !== gradeAfter;
  return (
    <Layout preview={`New security issue on ${appName}`} unsubscribeUrl={unsubscribeUrl}>
      <Heading>New security {count === 1 ? 'issue' : 'issues'} on {appName}</Heading>
      <Paragraph>
        We re-scanned {appName} after your latest change and found {count === 1 ? 'a new issue' : `${count} new issues`} that {count === 1 ? "wasn't" : "weren't"} there before.
        {gradeChanged ? ` Your grade went from ${gradeBefore} to ${gradeAfter}.` : ''}
      </Paragraph>

      {findings.map((f, i) => (
        <Text key={i} style={{ fontSize: '15px', lineHeight: '1.6', color: BRAND.text, margin: '0 0 14px' }}>
          {count > 1 ? `${i + 1}. ` : ''}
          <strong>{f.severity.charAt(0).toUpperCase() + f.severity.slice(1).toLowerCase()} — {f.title}.</strong>
          {f.whyItMatters ? ` ${f.whyItMatters}` : ''}
          {f.where ? ` (${f.where})` : ''}
        </Text>
      ))}

      <Btn href={viewUrl}>View the fix</Btn>

      <Paragraph muted>
        Nothing to panic about, we caught it early and the exact fix is waiting for you in the dashboard.
      </Paragraph>
    </Layout>
  );
}
