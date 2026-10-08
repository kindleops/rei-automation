/**
 * Seller portal — notifications through the canonical Brevo client.
 *
 * Only meaningful events: sign-in code; call scheduled, rescheduled, cancelled
 * and reminded; offer ready; message from Prominent; action needed; document
 * ready; closing scheduled or changed; closed. Each deep-links into the
 * authenticated portal; none asks the seller to call. Off unless
 * SELLER_PORTAL_EMAIL_ENABLED=1, and never logs codes or message bodies.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sendBrevoTransactionalEmail } from '@/lib/email/brevo-client.js';

const clean = (v) => String(v ?? '').trim();
const esc = (v) => clean(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function when(iso, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
}

export function renderSellerEmail({ kind, context = {} }, env = process.env) {
  const base = clean(env.SELLER_PORTAL_PUBLIC_BASE_URL) || 'https://www.prominentcashoffer.com';
  const link = (path) => `${base}${path}`;
  // Thunks: only the requested template is built, so a kind that has no
  // start time never evaluates another template's date.
  const table = {
    sign_in_code: () => ({ subject: `Your Prominent sign-in code: ${context.code}`, title: 'Your sign-in code', body: `Enter this code to open your Prominent account. It expires in ${context.minutes} minutes.`, code: context.code }),
    call_scheduled: () => ({ subject: 'Prominent will call you', title: 'Your call is scheduled.', body: `Prominent will call you ${when(context.start_at, context.timezone)}, about ${clean(context.reason).toLowerCase()}.`, cta: ['View or change your call', link('/account/schedule/')] }),
    call_rescheduled: () => ({ subject: 'Your call has a new time', title: 'Your call has a new time.', body: `Prominent will now call you ${when(context.start_at, context.timezone)}.`, cta: ['View or change your call', link('/account/schedule/')] }),
    call_cancelled: () => ({ subject: 'Your call is cancelled', title: 'Your call is cancelled.', body: `The call set for ${when(context.start_at, context.timezone)} is cancelled. You can choose another time whenever you like.`, cta: ['Choose another time', link('/account/schedule/')] }),
    call_reminder: () => ({ subject: context.offset_minutes >= 1440 ? 'Reminder: Prominent calls you tomorrow' : 'Reminder: Prominent calls you soon', title: 'A reminder about your call.', body: `Prominent will call you ${when(context.start_at, context.timezone)}, about ${clean(context.reason).toLowerCase()}.`, cta: ['View or change your call', link('/account/schedule/')] }),
    offer_ready: () => ({ subject: 'Your Prominent offer is ready', title: 'Your offer is ready.', body: 'Review the written terms in your Prominent account.', cta: ['Review your offer', link('/account/offer/')] }),
    message: () => ({ subject: 'A message from Prominent', title: 'You have a new message.', body: 'Prominent replied about your property.', cta: ['Read the message', link('/account/messages/')] }),
    action_needed: () => ({ subject: 'We need one item from you', title: 'We need one item from you.', body: clean(context.body) || 'Open your account for the details.', cta: ['See what is needed', link('/account/')] }),
    document_ready: () => ({ subject: 'A document is ready in your account', title: 'A document is ready.', body: clean(context.label) ? `${clean(context.label)} is ready in your Prominent account.` : 'A document is ready in your Prominent account.', cta: ['View documents', link('/account/documents/')] }),
    closing_scheduled: () => ({ subject: 'Your closing is scheduled', title: 'Your closing is scheduled.', body: context.start_at ? `Closing is set for ${when(context.start_at, context.timezone)}.` : 'Your closing details are ready.', cta: ['View closing', link('/account/closing/')] }),
    closing_changed: () => ({ subject: 'Your closing date changed', title: 'Your closing date changed.', body: context.start_at ? `Closing is now set for ${when(context.start_at, context.timezone)}.` : 'Your closing details were updated.', cta: ['View closing', link('/account/closing/')] }),
    closed: () => ({ subject: 'Your sale is closed', title: 'Your sale is closed.', body: 'Thank you for selling with Prominent. Your closing documents stay in your account.', cta: ['View your closing', link('/account/closing/')] }),
  };
  const t = table[kind]?.();
  if (!t) return null;
  const html = `<!doctype html><html><body style="margin:0;background:#fbf8f2;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#16140f">
<div style="max-width:520px;margin:0 auto;padding:40px 28px">
<p style="font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#a8823f;margin:0 0 28px">Prominent</p>
<h1 style="font-size:28px;line-height:1.1;margin:0 0 14px;font-weight:600">${esc(t.title)}</h1>
<p style="font-size:16px;line-height:1.6;color:#4a463f;margin:0 0 26px">${esc(t.body)}</p>
${t.code ? `<p style="font-size:36px;letter-spacing:.3em;font-weight:600;margin:0 0 26px">${esc(t.code)}</p>` : ''}
${t.cta ? `<a href="${esc(t.cta[1])}" style="display:inline-block;background:#16140f;color:#fbf8f2;text-decoration:none;padding:14px 22px;border-radius:999px;font-weight:600">${esc(t.cta[0])}</a>` : ''}
<p style="font-size:12px;color:#7a7367;margin:34px 0 0">If you didn't expect this email, you can ignore it.</p>
</div></body></html>`;
  const text = [t.title, t.body, t.code, t.cta ? `${t.cta[0]}: ${t.cta[1]}` : ''].filter(Boolean).join('\n\n');
  return { subject: t.subject, html, text };
}

/**
 * Staging capture sink: outside production (or with STAGING_CERTIFICATION=1),
 * SELLER_PORTAL_EMAIL_CAPTURE_DIR
 * makes the notifier write each rendered email to a JSON file instead of
 * sending it — rendering, dedupe and deep links are provable with zero
 * delivery risk. STAGING_EMAIL_RECIPIENT, when also set, receives a real copy
 * of each message (the seller address is never used in capture mode).
 */
function capture(env, kind, to, rendered) {
  const dir = clean(env.SELLER_PORTAL_EMAIL_CAPTURE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${kind}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify({ kind, to, subject: rendered.subject, text: rendered.text, html: rendered.html, at: new Date().toISOString() }, null, 2));
  return file;
}

export function createSellerNotifier(deps = {}) {
  const env = deps.env ?? process.env;
  const send = deps.send ?? sendBrevoTransactionalEmail;
  return async function notify({ kind, to, context }) {
    if (clean(env.SELLER_PORTAL_EMAIL_ENABLED) !== '1') return { sent: false, reason: 'seller_email_disabled' };
    const rendered = renderSellerEmail({ kind, context }, env);
    if (!rendered || !clean(to)) return { sent: false, reason: 'unrenderable' };
    // Capture only outside production, or in a staging production build whose
    // launcher proved staging identity (scripts/staging/run-api.sh). Leaking the
    // flag into production can only capture, never send to a seller.
    if (clean(env.SELLER_PORTAL_EMAIL_CAPTURE_DIR) && (clean(env.NODE_ENV) !== 'production' || clean(env.STAGING_CERTIFICATION) === '1')) {
      const file = capture(env, kind, to, rendered);
      const staged = clean(env.STAGING_EMAIL_RECIPIENT);
      if (staged) {
        try {
          await send({ to: staged, subject: `[staging → ${to}] ${rendered.subject}`, htmlContent: rendered.html, textContent: rendered.text, brand_key: 'prominent_cash_offer', tags: ['seller_portal', 'staging', kind] });
        } catch (error) {
          return { sent: true, captured: file, staging_copy: false, reason: error?.code || 'send_failed' };
        }
      }
      return { sent: true, captured: file, staging_copy: Boolean(staged) };
    }
    try {
      await send({ to, subject: rendered.subject, htmlContent: rendered.html, textContent: rendered.text, brand_key: 'prominent_cash_offer', tags: ['seller_portal', kind] });
      return { sent: true };
    } catch (error) {
      return { sent: false, reason: error?.code || 'send_failed' };
    }
  };
}
