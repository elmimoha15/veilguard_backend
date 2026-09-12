import * as React from 'react';
import { Html, Head, Preview, Body, Container, Section, Text, Link, Button } from '@react-email/components';
import { BRAND } from './brand.js';

/**
 * ONE shared shell every Veilguard email reuses. Deliberately plain: it should
 * read like a normal email someone typed in Gmail, NOT a designed HTML template.
 * White background, no card/box/panel, a small "Veilguard" wordmark at the top,
 * plain paragraphs, and a one-line footer. The only styled element is <Btn>.
 * Inline styles only; web-safe font; ~600px single column.
 */
export function Layout({ preview, unsubscribeUrl, children }: { preview: string; unsubscribeUrl?: string; children: React.ReactNode }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: '#F5F6F8', margin: 0, padding: '32px 0', fontFamily: BRAND.font }}>
        <Container style={{ maxWidth: '600px', margin: '0 auto', padding: '0 16px' }}>
          {/* wordmark above the card — plain ink, no color accent */}
          <Text style={{ fontSize: '16px', fontWeight: 700, color: BRAND.ink, margin: '0 0 16px', padding: '0 4px', letterSpacing: '-0.01em' }}>Veilguard</Text>

          {/* clean white card */}
          <Section style={{ backgroundColor: '#ffffff', border: '1px solid #E6E6E6', borderRadius: '8px', padding: '36px 40px' }}>
            {children}

            <Text style={{ fontSize: '12.5px', lineHeight: '1.6', color: BRAND.label, margin: '24px 0 0' }}>
              Veilguard, plain-English security for apps built with AI.{' '}
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

/** The one styled element: a brand-colored button. */
export function Btn({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Section style={{ padding: '4px 0 8px' }}>
      <Button
        href={href}
        style={{
          backgroundColor: BRAND.yellow,
          color: BRAND.ink,
          fontWeight: 700,
          fontSize: '15px',
          textDecoration: 'none',
          padding: '12px 20px',
          borderRadius: '8px',
          display: 'inline-block',
        }}
      >
        {children}
      </Button>
    </Section>
  );
}

/** A plain bold line — reads like the first line of a typed email, not a banner. */
export function Heading({ children }: { children: React.ReactNode }) {
  return <Text style={{ fontSize: '18px', fontWeight: 700, color: BRAND.ink, margin: '0 0 16px', lineHeight: '1.4' }}>{children}</Text>;
}

export function Paragraph({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <Text style={{ fontSize: '15px', lineHeight: '1.6', color: muted ? BRAND.muted : BRAND.text, margin: '0 0 16px' }}>{children}</Text>;
}
