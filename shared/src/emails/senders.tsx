import * as React from 'react';
import { render } from '@react-email/render';
import { getEmailTransport } from '../email.js';
import { config } from '../config.js';
import { SecurityAlert, type AlertFinding } from './SecurityAlert.js';
import { Welcome, VerifyEmail, PasswordReset, Marketing, AccountDeleted, GuardActivated, PaymentFailed, SubscriptionCanceled } from './Transactional.js';
import { MonthlySummary, type SummaryApp } from './MonthlySummary.js';

/** Render a template to BOTH html and plain-text (always send both). */
export async function renderBoth(el: React.ReactElement): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })]);
  return { html, text };
}

/** Where users manage / turn off alerts (also the List-Unsubscribe target for now). */
const manageUrl = (): string => `${config.appBaseUrl}/settings`;

export async function sendAlert(args: {
  to: string;
  appName: string;
  findings: AlertFinding[];
  gradeBefore?: string | null;
  gradeAfter?: string | null;
  viewUrl: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const unsubscribeUrl = manageUrl();
  const { html, text } = await renderBoth(
    <SecurityAlert
      appName={args.appName}
      findings={args.findings}
      gradeBefore={args.gradeBefore}
      gradeAfter={args.gradeAfter}
      viewUrl={args.viewUrl}
      unsubscribeUrl={unsubscribeUrl}
    />,
  );
  const subject = `⚠️ New security ${args.findings.length === 1 ? 'issue' : 'issues'} in ${args.appName}`;
  await getEmailTransport().send({
    to: args.to,
    subject,
    html,
    text,
    from: config.alertFromEmail,
    replyTo: config.emailReplyTo,
    listUnsubscribe: unsubscribeUrl,
    tags: [{ name: 'type', value: 'alert' }],
    meta: args.meta,
  });
}

export async function sendWelcome(to: string): Promise<void> {
  const { html, text } = await renderBoth(<Welcome ctaUrl={`${config.appBaseUrl}/dashboard`} />);
  await getEmailTransport().send({
    to, subject: 'Welcome to Veilguard', html, text,
    from: config.emailFrom, replyTo: config.emailReplyTo, tags: [{ name: 'type', value: 'welcome' }],
  });
}

export async function sendVerify(to: string, verifyUrl: string): Promise<void> {
  const { html, text } = await renderBoth(<VerifyEmail verifyUrl={verifyUrl} />);
  await getEmailTransport().send({
    to, subject: 'Confirm your email', html, text,
    from: config.emailFrom, replyTo: config.emailReplyTo, tags: [{ name: 'type', value: 'verify' }],
  });
}

export async function sendPasswordReset(to: string, resetUrl: string): Promise<void> {
  const { html, text } = await renderBoth(<PasswordReset resetUrl={resetUrl} />);
  await getEmailTransport().send({
    to, subject: 'Reset your Veilguard password', html, text,
    from: config.emailFrom, replyTo: config.emailReplyTo, tags: [{ name: 'type', value: 'reset' }],
  });
}

export async function sendAccountDeleted(to: string): Promise<void> {
  const { html, text } = await renderBoth(<AccountDeleted />);
  await getEmailTransport().send({
    to, subject: 'Your Veilguard account has been deleted', html, text,
    from: config.emailFrom, replyTo: config.emailReplyTo, tags: [{ name: 'type', value: 'account-deleted' }],
  });
}

export async function sendGuardActivated(to: string): Promise<void> {
  const { html, text } = await renderBoth(<GuardActivated ctaUrl={`${config.appBaseUrl}/dashboard`} />);
  await getEmailTransport().send({
    to, subject: "You're on Veilguard Guard", html, text,
    from: config.emailFrom, replyTo: config.emailReplyTo, tags: [{ name: 'type', value: 'billing-activated' }],
  });
}

export async function sendPaymentFailed(to: string): Promise<void> {
  const { html, text } = await renderBoth(<PaymentFailed ctaUrl={`${config.appBaseUrl}/billing`} />);
  await getEmailTransport().send({
    to, subject: 'Your Veilguard payment failed — action needed', html, text,
    from: config.emailFrom, replyTo: config.emailReplyTo, tags: [{ name: 'type', value: 'billing-payment-failed' }],
  });
}

export async function sendSubscriptionCanceled(to: string, endsOn?: string): Promise<void> {
  const { html, text } = await renderBoth(<SubscriptionCanceled endsOn={endsOn} ctaUrl={`${config.appBaseUrl}/billing`} />);
  await getEmailTransport().send({
    to, subject: 'Your Veilguard Guard plan is set to cancel', html, text,
    from: config.emailFrom, replyTo: config.emailReplyTo, tags: [{ name: 'type', value: 'billing-canceled' }],
  });
}

export async function sendMonthlySummary(args: { to: string; apps: SummaryApp[]; scansUsed: number; scanLimit: number }): Promise<void> {
  const unsubscribeUrl = manageUrl();
  const { html, text } = await renderBoth(
    <MonthlySummary apps={args.apps} scansUsed={args.scansUsed} scanLimit={args.scanLimit} ctaUrl={`${config.appBaseUrl}/dashboard`} unsubscribeUrl={unsubscribeUrl} />,
  );
  await getEmailTransport().send({
    to: args.to,
    subject: 'Your monthly Veilguard security summary',
    html,
    text,
    from: config.emailFrom,
    replyTo: config.emailReplyTo,
    listUnsubscribe: unsubscribeUrl,
    tags: [{ name: 'type', value: 'summary' }],
  });
}

export async function sendMarketing(args: { to: string; subject: string; heading: string; body: string; ctaText?: string; ctaUrl?: string }): Promise<void> {
  const unsubscribeUrl = manageUrl();
  const { html, text } = await renderBoth(
    <Marketing heading={args.heading} body={args.body} ctaText={args.ctaText} ctaUrl={args.ctaUrl} unsubscribeUrl={unsubscribeUrl} />,
  );
  await getEmailTransport().send({
    to: args.to, subject: args.subject, html, text,
    from: config.marketingFromEmail, replyTo: config.emailReplyTo, listUnsubscribe: unsubscribeUrl,
    tags: [{ name: 'type', value: 'marketing' }],
  });
}
