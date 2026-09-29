/**
 * CANONICAL EMAIL TEMPLATE REGISTRY.
 *
 * Every automated email is rendered from a versioned template here — business
 * logic never carries body strings. A row in public.email_templates with the
 * same template_id + version and is_active=true overrides the code copy, so
 * wording can change without a deploy; the code copy is the fallback and the
 * contract (required variables, role, stage, approval class).
 *
 * Rendering is STRICT: a required variable that is missing refuses the render
 * (template_variables_incomplete). An automated email never goes out with a
 * blank where a price, date or address should be. Templates carry only facts
 * passed in from canonical state — nothing here invents terms, prices,
 * deadlines or wire details.
 *
 * Syntax: {{var}} substitution; {{#if var}}…{{/if}} optional sections.
 */

const clean = (v) => String(v ?? '').trim()

const SIGN_OFF = '\n\nThank you,\n{{sender_name}}'

export const TEMPLATES = Object.freeze({
  // ── seller (S1–S6) ───────────────────────────────────────────────────────
  // The seller brain chooses WHAT to say (the same sms_templates selection,
  // stage rules and facts as SMS); these only frame it as an email.
  'seller.reply': {
    version: 'v1', family: 'seller', role: 'seller', stage: 'S1-S6', purpose: 'Seller-brain reply delivered by email',
    required: ['message', 'sender_name'],
    subject: '{{subject}}',
    body: '{{#if first_name}}Hi {{first_name}},\n\n{{/if}}{{message}}' + '\n\n{{sender_name}}',
  },
  'seller.followup': {
    version: 'v1', family: 'seller', role: 'seller', stage: 'S1-S6', purpose: 'Gentle email follow-up when a seller goes quiet',
    required: ['sender_name', 'property_address'],
    subject: 'Re: {{property_address}}',
    body: '{{#if first_name}}Hi {{first_name}},\n\n{{/if}}Just checking back on {{property_address}}. Whenever you have a moment, I would be glad to pick up where we left off.' + '\n\n{{sender_name}}',
  },

  // ── closing / title ──────────────────────────────────────────────────────
  'closing.title_open': {
    version: 'v1', family: 'title', role: 'title', stage: 'S7', purpose: 'Open title on a contracted property',
    required: ['property_address', 'sender_name'],
    subject: 'New title order — {{property_address}}',
    body: 'Hello{{#if title_company_name}} {{title_company_name}} team{{/if}},\n\nPlease open title for the property below.\n\nProperty: {{property_address}}{{#if seller_name}}\nSeller: {{seller_name}}{{/if}}{{#if scheduled_closing_date}}\nTarget closing: {{scheduled_closing_date}}{{/if}}\n\nPlease reply to confirm receipt and share the escrow/file number and your expected title commitment date.' + SIGN_OFF,
  },
  'closing.title_followup': {
    version: 'v1', family: 'title', role: 'title', stage: 'S7', purpose: 'Follow up on an unacknowledged title order',
    required: ['property_address', 'sender_name', 'sequence'],
    subject: 'Re: New title order — {{property_address}}',
    body: 'Hello,\n\nFollowing up on the title order for {{property_address}}. Could you confirm it was received and share the file number?' + SIGN_OFF,
  },
  'closing.title_commitment_reminder': {
    version: 'v1', family: 'title', role: 'title', stage: 'S8', purpose: 'Request the title commitment',
    required: ['property_address', 'sender_name'],
    subject: 'Title commitment — {{property_address}}{{#if escrow_file_number}} (File {{escrow_file_number}}){{/if}}',
    body: 'Hello,\n\nChecking on the title commitment for {{property_address}}{{#if escrow_file_number}} (file {{escrow_file_number}}){{/if}}.{{#if commitment_due}} We have it expected by {{commitment_due}}.{{/if}} Please send it over when ready, or let us know of anything holding it up.' + SIGN_OFF,
  },
  'closing.clear_to_close_followup': {
    version: 'v1', family: 'title', role: 'title', stage: 'S9', purpose: 'Confirm clear-to-close ahead of closing',
    required: ['property_address', 'sender_name'],
    subject: 'Clear to close? — {{property_address}}',
    body: 'Hello,\n\n{{#if scheduled_closing_date}}We are scheduled to close on {{scheduled_closing_date}}. {{/if}}Can you confirm whether the file for {{property_address}} is clear to close, or list anything still outstanding?' + SIGN_OFF,
  },
  'closing.closing_confirmation': {
    version: 'v1', family: 'title', role: 'title', stage: 'S9', purpose: 'Confirm the scheduled closing',
    required: ['property_address', 'sender_name', 'scheduled_closing_date'],
    subject: 'Closing confirmation — {{property_address}}',
    body: 'Hello,\n\nConfirming closing for {{property_address}} on {{scheduled_closing_date}}. Please let us know if anything about the date, time or signing arrangements changes.' + SIGN_OFF,
  },
  'closing.settlement_request': {
    version: 'v1', family: 'settlement', role: 'title', stage: 'S9', purpose: 'Request the settlement statement',
    required: ['property_address', 'sender_name'],
    subject: 'Settlement statement — {{property_address}}',
    body: 'Hello,\n\nCould you send the settlement statement for {{property_address}} for our review?' + SIGN_OFF,
  },
  'closing.buyer_emd_reminder': {
    version: 'v1', family: 'emd', role: 'buyer', stage: 'S8', purpose: 'Remind the buyer to deposit earnest money',
    required: ['property_address', 'sender_name'],
    subject: 'Earnest money — {{property_address}}',
    body: 'Hello{{#if buyer_name}} {{buyer_name}}{{/if}},\n\nA reminder that the earnest money deposit for {{property_address}} is due{{#if emd_due}} by {{emd_due}}{{/if}}. Please send it to the title company directly using the instructions they provide — we never send or change wire instructions by email.' + SIGN_OFF,
  },
  'closing.buyer_agreement_followup': {
    version: 'v1', family: 'agreement', role: 'buyer', stage: 'S8', purpose: 'Follow up on an unsigned buyer agreement',
    required: ['property_address', 'sender_name'],
    subject: 'Assignment agreement — {{property_address}}',
    body: 'Hello{{#if buyer_name}} {{buyer_name}}{{/if}},\n\nFollowing up on the agreement for {{property_address}}. Let us know if you have any questions before signing.' + SIGN_OFF,
  },
})

/** Families the follow-up engine knows about (cadence lives with the owning planner). */
export const FOLLOW_UP_FAMILIES = Object.freeze(['seller', 'title', 'buyer', 'emd', 'agreement', 'lender', 'settlement'])

function renderString(tpl, vars) {
  let out = tpl.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, k, inner) => (clean(vars[k]) ? inner : ''))
  const missing = []
  out = out.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = clean(vars[k])
    if (!v) missing.push(k)
    return v
  })
  return { text: out, missing }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function textToHtml(text) {
  return clean(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

/**
 * Render a template. `override` is an active public.email_templates row
 * ({ subject, template_body, version }) for the same key, if any.
 */
export function renderTemplate(templateKey, vars = {}, override = null) {
  const spec = TEMPLATES[templateKey]
  if (!spec) return { ok: false, code: 'template_unknown', templateKey }
  const missingRequired = spec.required.filter((k) => !clean(vars[k]))
  if (missingRequired.length) return { ok: false, code: 'template_variables_incomplete', missing: missingRequired, templateKey }
  const subjectSrc = clean(override?.subject) || spec.subject
  const bodySrc = clean(override?.template_body) || spec.body
  const subject = renderString(subjectSrc, vars)
  const body = renderString(bodySrc, vars)
  const missing = [...new Set([...subject.missing, ...body.missing])]
  if (missing.length) return { ok: false, code: 'template_variables_incomplete', missing, templateKey }
  return {
    ok: true,
    templateKey,
    version: override?.version ? `db:${override.version}` : spec.version,
    subject: subject.text.replace(/\s+/g, ' ').trim(),
    text: body.text.trim(),
    html: textToHtml(body.text),
  }
}

/** Load active DB overrides for a set of keys (one query). */
export async function loadTemplateOverrides(db, keys = []) {
  if (!keys.length) return {}
  const { data, error } = await db.from('email_templates')
    .select('template_id, subject, template_body, version, is_active')
    .in('template_id', keys)
    .eq('is_active', true)
  if (error) return {}
  const out = {}
  for (const r of data || []) out[r.template_id] = r
  return out
}
