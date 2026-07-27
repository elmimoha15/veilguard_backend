import * as React from 'react';
import { Section } from '@react-email/components';
import { Layout, Btn, Heading, Paragraph } from './components.js';

/** Welcome email — sent once, when a user's account is first created. */
export function Welcome({ ctaUrl }: { ctaUrl: string }) {
  return (
    <Layout preview="Welcome to Veilguard — let's find the holes before attackers do">
      <Heading>Welcome to Veilguard 👋</Heading>
      <Paragraph>
        Your AI built your app fast — and quietly left a few doors unlocked. Veilguard checks for the
        common ones (leaked keys, open databases, missing auth, injection) and hands you the exact fix,
        in plain English.
      </Paragraph>
      <Paragraph muted>Paste your app's URL to get an A–F security grade in about 60 seconds.</Paragraph>
      <Section style={{ padding: '8px 0 4px' }}>
        <Btn href={ctaUrl}>Run your first scan</Btn>
      </Section>
    </Layout>
  );
}

/** Email-verification — CTA is a Firebase Admin-generated verification link. */
export function VerifyEmail({ verifyUrl }: { verifyUrl: string }) {
  return (
    <Layout preview="Confirm your email to secure your Veilguard account">
      <Heading>Confirm your email</Heading>
      <Paragraph>Tap the button below to verify your email address and finish setting up your Veilguard account.</Paragraph>
      <Section style={{ padding: '8px 0 4px' }}>
        <Btn href={verifyUrl}>Verify my email</Btn>
      </Section>
      <Paragraph muted>If you didn't create a Veilguard account, you can safely ignore this email.</Paragraph>
    </Layout>
  );
}

/** Password-reset — CTA is a Firebase Admin-generated reset link. */
export function PasswordReset({ resetUrl }: { resetUrl: string }) {
  return (
    <Layout preview="Reset your Veilguard password">
      <Heading>Reset your password</Heading>
      <Paragraph>We got a request to reset your Veilguard password. Tap below to choose a new one — the link expires shortly.</Paragraph>
      <Section style={{ padding: '8px 0 4px' }}>
        <Btn href={resetUrl}>Reset password</Btn>
      </Section>
      <Paragraph muted>Didn't ask for this? Ignore this email and your password stays the same.</Paragraph>
    </Layout>
  );
}

/** Marketing / newsletter — generic branded template with a prominent unsubscribe. */
export function Marketing({ heading, body, ctaText, ctaUrl, unsubscribeUrl }: { heading: string; body: string; ctaText?: string; ctaUrl?: string; unsubscribeUrl: string }) {
  return (
    <Layout preview={heading} unsubscribeUrl={unsubscribeUrl}>
      <Heading>{heading}</Heading>
      {body.split('\n\n').map((para, i) => (
        <Paragraph key={i}>{para}</Paragraph>
      ))}
      {ctaText && ctaUrl ? (
        <Section style={{ padding: '8px 0 4px' }}>
          <Btn href={ctaUrl}>{ctaText}</Btn>
        </Section>
      ) : null}
    </Layout>
  );
}
