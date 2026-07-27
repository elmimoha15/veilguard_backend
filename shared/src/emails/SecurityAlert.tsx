import * as React from 'react';
import { Section, Row, Column, Text, Hr } from '@react-email/components';
import { Layout, Btn, Heading, Paragraph } from './components.js';
import { BRAND, gradeColor, severityColor } from './brand.js';

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

/** The security-alert email — the most important one. Calm, specific, actionable. */
export function SecurityAlert({ appName, findings, gradeBefore, gradeAfter, viewUrl, unsubscribeUrl }: SecurityAlertProps) {
  const count = findings.length;
  const gradeChanged = !!gradeBefore && !!gradeAfter && gradeBefore !== gradeAfter;
  return (
    <Layout preview={`New security issue on ${appName}`} unsubscribeUrl={unsubscribeUrl}>
      <Heading>New security {count === 1 ? 'issue' : 'issues'} on {appName}</Heading>
      <Paragraph muted>
        We re-scanned <strong style={{ color: BRAND.text }}>{appName}</strong> after your latest change and found{' '}
        {count === 1 ? 'a new issue' : `${count} new issues`} that {count === 1 ? "wasn't" : "weren't"} there before.
      </Paragraph>

      {gradeChanged && (
        <Section style={{ margin: '0 0 20px' }}>
          <Row>
            <Column style={{ width: '110px' }}>
              <Text style={{ fontSize: '12px', color: BRAND.label, margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Grade</Text>
              <Text style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>
                <span style={{ color: gradeColor(gradeBefore) }}>{gradeBefore}</span>
                <span style={{ color: BRAND.label }}> → </span>
                <span style={{ color: gradeColor(gradeAfter) }}>{gradeAfter}</span>
              </Text>
            </Column>
          </Row>
        </Section>
      )}

      <Section style={{ border: `1px solid ${BRAND.border}`, borderRadius: '12px', overflow: 'hidden' }}>
        {findings.map((f, i) => {
          const color = severityColor(f.severity);
          return (
            <Section key={i} style={{ padding: '14px 16px', borderTop: i === 0 ? 'none' : `1px solid ${BRAND.border}` }}>
              <Text
                style={{
                  display: 'inline-block',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color,
                  backgroundColor: `${color}22`,
                  padding: '3px 9px',
                  borderRadius: '999px',
                  margin: '0 0 6px',
                }}
              >
                {f.severity}
              </Text>
              <Text style={{ fontSize: '15px', fontWeight: 700, color: BRAND.ink, margin: '0 0 3px' }}>{f.title}</Text>
              {f.whyItMatters ? <Text style={{ fontSize: '13.5px', lineHeight: '1.55', color: BRAND.muted, margin: 0 }}>{f.whyItMatters}</Text> : null}
              {f.where ? <Text style={{ fontSize: '12px', color: BRAND.label, margin: '4px 0 0', fontFamily: 'monospace' }}>{f.where}</Text> : null}
            </Section>
          );
        })}
      </Section>

      <Section style={{ textAlign: 'center', padding: '24px 0 8px' }}>
        <Btn href={viewUrl}>View in Veilguard</Btn>
      </Section>

      <Hr style={{ borderColor: BRAND.border, margin: '8px 0 16px' }} />
      <Paragraph muted>
        Nothing to panic about — we caught it early and the exact fix is waiting for you in the dashboard.
      </Paragraph>
    </Layout>
  );
}
