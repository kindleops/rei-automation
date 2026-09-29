/**
 * CLOSING → EMAIL COMMAND CONTRACT.
 *
 * Closing automation never sends email. It writes a request here; the email
 * system claims `pending_transport` rows, applies its own suppression,
 * identity and thread rules, sends, and writes the result back
 * (claimed → sent / failed, provider_message_id, delivery_status).
 *
 * One row per (closing, category, sequence): the request_key is the duplicate
 * guard, so a re-run tick can never ask for the same email twice. Every row in
 * a category shares thread_key (the title-open request's key), so follow-ups
 * belong to the same logical conversation.
 */

const clean = (v) => String(v ?? '').trim()

export const EMAIL_ACTIONS = Object.freeze({
  title_open: { role: 'title', template: 'closing.title_open', version: 'v1', thread: 'title' },
  title_followup: { role: 'title', template: 'closing.title_followup', version: 'v1', thread: 'title' },
  title_commitment_reminder: { role: 'title', template: 'closing.title_commitment_reminder', version: 'v1', thread: 'title' },
  clear_to_close_followup: { role: 'title', template: 'closing.clear_to_close_followup', version: 'v1', thread: 'title' },
  closing_confirmation: { role: 'title', template: 'closing.closing_confirmation', version: 'v1', thread: 'title' },
  settlement_request: { role: 'title', template: 'closing.settlement_request', version: 'v1', thread: 'title' },
  buyer_emd_reminder: { role: 'buyer', template: 'closing.buyer_emd_reminder', version: 'v1', thread: 'buyer' },
  buyer_agreement_followup: { role: 'buyer', template: 'closing.buyer_agreement_followup', version: 'v1', thread: 'buyer' },
})

export const threadKeyFor = (closingCaseId, thread) => `closing:${closingCaseId}:${thread}`

/**
 * Request one email. Idempotent on (case, category, sequence). A missing
 * recipient is recorded as `skipped` (so the operator is told), never as a
 * send to nobody.
 */
export async function requestClosingEmail(db, c, { action, category, sequence = 1, recipientEmail = null, dueAt = null, requestedBy, reason = null, payload = {} }) {
  const spec = EMAIL_ACTIONS[action]
  if (!spec) throw new Error(`unknown closing email action: ${action}`)
  const requestKey = `closing_email:${c.closing_case_id}:${category}:${sequence}`
  const row = {
    request_key: requestKey,
    closing_case_id: c.closing_case_id,
    opportunity_id: c.opportunity_id || null,
    property_id: c.property_id || null,
    title_company_key: c.title_company_key || null,
    action,
    category,
    sequence,
    recipient_role: spec.role,
    recipient_email: clean(recipientEmail) || null,
    template_key: spec.template,
    template_version: spec.version,
    thread_key: threadKeyFor(c.closing_case_id, spec.thread),
    status: clean(recipientEmail) ? 'pending_transport' : 'skipped',
    status_reason: clean(recipientEmail) ? reason : 'no_recipient_address',
    requested_by: clean(requestedBy) || 'closing_automation',
    due_at: dueAt,
    payload: {
      property_address: c.property_address || null,
      escrow_file_number: c.escrow_file_number || null,
      title_company_name: c.title_company_name || null,
      scheduled_closing_date: c.scheduled_closing_date || null,
      closing_tz: c.closing_tz || null,
      ...payload,
    },
  }
  const { error } = await db.from('closing_email_requests').insert(row)
  if (error && !(error.code === '23505' || /duplicate key/i.test(String(error.message || '')))) throw error
  return { requestKey, duplicate: Boolean(error), status: error ? null : row.status }
}

/** Stop condition: withdraw every not-yet-sent request (optionally for some categories). */
export async function cancelOpenEmailRequests(db, closingCaseId, reason, categories = null) {
  let q = db.from('closing_email_requests')
    .update({ status: 'cancelled', status_reason: reason, updated_at: new Date().toISOString() })
    .eq('closing_case_id', closingCaseId)
    .eq('status', 'pending_transport')
  if (categories?.length) q = q.in('category', categories)
  const { data, error } = await q.select('request_key')
  if (error) throw error
  return (data || []).length
}
