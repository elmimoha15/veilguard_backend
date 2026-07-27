import * as React from 'react';
import { Html, Head, Preview, Body, Container, Section, Row, Column, Img, Text, Link, Button } from '@react-email/components';
import { BRAND } from './brand.js';

/**
 * ONE shared branded shell every Veilguard email reuses — change the logo or a
 * color here and every template updates. Light card on the warm background, hosted
 * logo header, footer with site + optional manage/unsubscribe link. Inline styles
 * only; web-safe font; ~600px single column.
 */
export function Layout({ preview, unsubscribeUrl, children }: { preview: string; unsubscribeUrl?: string; children: React.ReactNode }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: BRAND.bg, margin: 0, padding: '24px 0', fontFamily: BRAND.font }}>
        <Container style={{ maxWidth: '600px', margin: '0 auto', padding: '0 16px' }}>
          <Section style={{ padding: '4px 4px 16px' }}>
            <Row>
              <Column style={{ width: '44px' }}>
                <Img src={BRAND.logoUrl} width="40" height="40" alt="Veilguard" style={{ borderRadius: '10px', display: 'block' }} />
              </Column>
              <Column>
                <Text style={{ fontSize: '18px', fontWeight: 800, color: BRAND.ink, margin: 0, letterSpacing: '-0.02em' }}>Veilguard</Text>
              </Column>
            </Row>
          </Section>

          <Section style={{ backgroundColor: BRAND.card, border: `1px solid ${BRAND.border}`, borderRadius: '16px', padding: '32px' }}>
            {children}
          </Section>

          <Section style={{ padding: '18px 8px' }}>
            <Text style={{ fontSize: '12px', lineHeight: '1.6', color: BRAND.label, margin: '0 0 4px' }}>
              Veilguard — plain-English security for vibe-coded apps.
            </Text>
            <Text style={{ fontSize: '12px', lineHeight: '1.6', color: BRAND.label, margin: 0 }}>
              <Link href={BRAND.site} style={{ color: BRAND.label, textDecoration: 'underline' }}>veilguard.dev</Link>
              {unsubscribeUrl ? (
                <>
                  {'  ·  '}
                  <Link href={unsubscribeUrl} style={{ color: BRAND.label, textDecoration: 'underline' }}>Manage alerts</Link>
                </>
              ) : null}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/** Brand-colored primary button. */
export function Btn({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: BRAND.yellow,
        color: BRAND.ink,
        fontWeight: 700,
        fontSize: '15px',
        textDecoration: 'none',
        padding: '13px 22px',
        borderRadius: '10px',
        display: 'inline-block',
      }}
    >
      {children}
    </Button>
  );
}

export function Heading({ children }: { children: React.ReactNode }) {
  return <Text style={{ fontSize: '22px', fontWeight: 800, color: BRAND.ink, margin: '0 0 8px', letterSpacing: '-0.02em', lineHeight: '1.25' }}>{children}</Text>;
}

export function Paragraph({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <Text style={{ fontSize: '15px', lineHeight: '1.6', color: muted ? BRAND.muted : BRAND.text, margin: '0 0 16px' }}>{children}</Text>;
}
