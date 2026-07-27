import * as React from 'react';
import { render } from '@react-email/render';
import { getEmailTransport } from '../email.js';
import { config } from '../config.js';
import { SecurityAlert, type AlertFinding } from './SecurityAlert.js';
import { Welcome, VerifyEmail, PasswordReset, Marketing } from './Transactional.js';

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
