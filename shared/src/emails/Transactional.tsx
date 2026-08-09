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

/** Account-deleted confirmation — sent after a user permanently deletes their account. */
export function AccountDeleted() {
  return (
    <Layout preview="Your Veilguard account has been deleted">
      <Heading>Your account has been deleted</Heading>
      <Paragraph>
        Your Veilguard account and everything in it — your scans, findings, connections and monitoring —
        have been permanently deleted. Any active plan has been cancelled and you won't be charged again.
      </Paragraph>
      <Paragraph muted>
        If you didn't request this, contact us right away — this action can't be undone from your side, but
        we can help. Otherwise, thanks for trying Veilguard; you're always welcome back.
      </Paragraph>
    </Layout>
  );
}

/** Guard activated — sent when a subscription becomes active. */
export function GuardActivated({ ctaUrl }: { ctaUrl: string }) {
  return (
    <Layout preview="You're on Veilguard Guard — everything's unlocked">
      <Heading>You're on Guard 🛡️</Heading>
      <Paragraph>
        Your subscription is active. Every fix is unlocked (copy-paste code + AI prompts), and you can now
        run GitHub repo scans, upload folders, and turn on continuous monitoring so we re-check your app
        and alert you the moment a new hole appears.
      </Paragraph>
      <Section style={{ padding: '8px 0 4px' }}>
        <Btn href={ctaUrl}>Open your dashboard</Btn>
      </Section>
      <Paragraph muted>Manage or cancel anytime from Settings → Billing. Thanks for supporting Veilguard.</Paragraph>
    </Layout>
  );
}

/** Payment failed (dunning) — sent when a subscription goes past_due. */
export function PaymentFailed({ ctaUrl }: { ctaUrl: string }) {
  return (
    <Layout preview="Your Veilguard payment didn't go through">
      <Heading>Your payment didn't go through</Heading>
      <Paragraph>
        We couldn't charge your card for Veilguard Guard. Don't worry — your access is still on for now
        while we retry. Please update your payment method to avoid losing your fixes and monitoring.
      </Paragraph>
      <Section style={{ padding: '8px 0 4px' }}>
        <Btn href={ctaUrl}>Update payment method</Btn>
      </Section>
      <Paragraph muted>If the card keeps failing, your plan will drop back to Free and monitoring will pause.</Paragraph>
    </Layout>
  );
}

/** Subscription canceled — confirms access continues until the period end. */
export function SubscriptionCanceled({ endsOn, ctaUrl }: { endsOn?: string; ctaUrl: string }) {
  return (
    <Layout preview="Your Veilguard Guard plan is set to cancel">
      <Heading>Your plan is set to cancel</Heading>
      <Paragraph>
        We've scheduled your Veilguard Guard subscription to cancel{endsOn ? ` on ${endsOn}` : ' at the end of your billing period'}.
        You keep full access — all fixes and monitoring — until then. After that your account returns to Free.
      </Paragraph>
      <Section style={{ padding: '8px 0 4px' }}>
        <Btn href={ctaUrl}>Changed your mind? Resume Guard</Btn>
      </Section>
      <Paragraph muted>No further charges. Thanks for giving Veilguard a try.</Paragraph>
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
