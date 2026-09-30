/**
 * CLOSING AUTOMATION — keeps the normal path moving, pulls the operator in
 * only for exceptions.
 *
 *   planClosingAutomation()  PURE: from one closing's canonical records +
 *                            its email requests + the clock → what to request,
 *                            what to cancel, what to escalate, what to notify
 *   runClosingAutomation()   applies plans for every open closing; writes the
 *                            heartbeat. Invoked by the Cloudflare scheduler.
 *
 * Rules that are not negotiable:
 *   - every follow-up has a STOP condition, checked every tick; satisfied →
 *     pending requests are cancelled, never sent late
 *   - cadence is bounded (max per category); exhausted → ESCALATE (operator),
 *     then silence for that category
 *   - bounded catch-up: a follow-up whose moment passed more than
 *     catchUpHours ago is not sent — the gap escalates instead
 *   - terminal / closed / paused closings get nothing new
 *   - an email can't be chased before it was actually sent
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { emitNotificationFromBusinessEvent } from '@/lib/domain/notifications/notification-emitter.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'
import { cancelOpenEmailRequests, requestClosingEmail } from './closing-email-requests.js'
import { DEFAULT_CADENCE, mergeCadence, planClosingAutomation } from './closing-automation-plan.js'

const clean = (v) => String(v ?? '').trim()

// The pure planner lives in closing-automation-plan.js (so the pure closing
// read model can forecast with the automation's own rules). Re-exported here
// so every existing import keeps working.
export { DEFAULT_CADENCE, mergeCadence, planClosingAutomation } from './closing-automation-plan.js'

/* ── executor ─────────────────────────────────────────────────────────── */

export async function runClosingAutomation({ now = Date.now(), dryRun = false } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const notify = deps.notify || emitNotificationFromBusinessEvent
  const readValue = deps.getSystemValue || getSystemValue
  const writeValues = deps.setSystemValues || setSystemValues
  const enabledRaw = await readValue('closing_automation_enabled').catch(() => null)
  const automationEnabled = String(enabledRaw ?? '').toLowerCase() === 'true'
  let cadence = DEFAULT_CADENCE
  try { const raw = await readValue('closing_automation_cadence'); if (raw) cadence = mergeCadence(typeof raw === 'string' ? JSON.parse(raw) : raw) } catch { /* default cadence */ }

  const { data: cases, error } = await db.from('closing_cases').select('*').is('closed_at', null).is('terminal_outcome', null).limit(300)
  if (error) throw error
  const summary = { scanned: 0, requested: 0, cancelled: 0, escalated: 0, notified: 0, skipped_paused: 0, errors: [] }
  for (const c of cases || []) {
    summary.scanned += 1
    try {
      const [offers, agreements, receipts, settlements, requests] = await Promise.all([
        c.opportunity_id ? db.from('buyer_offers').select('*').eq('opportunity_id', c.opportunity_id).limit(100).then((r) => r.data || []) : [],
        c.opportunity_id ? db.from('buyer_agreements').select('*').eq('opportunity_id', c.opportunity_id).limit(100).then((r) => r.data || []) : [],
        db.from('emd_receipts').select('*').eq('closing_case_id', c.closing_case_id).limit(100).then((r) => r.data || []),
        db.from('settlement_records').select('settlement_statement_reference, settlement_status').eq('closing_case_id', c.closing_case_id).limit(10).then((r) => r.data || []),
        db.from('closing_email_requests').select('*').eq('closing_case_id', c.closing_case_id).limit(500).then((r) => r.data || []),
      ])
      const closing = { ...c, __has_statement: settlements.some((s) => clean(s.settlement_statement_reference)) }
      const plan = planClosingAutomation({ closingCase: closing, offers, agreements, emdReceipts: receipts, requests, now, cadence, automationEnabled })
      if (plan.state === 'paused') summary.skipped_paused += 1
      if (dryRun) continue
      const escalations = { ...((c.automation_state && c.automation_state.escalations) || {}) }
      let escalationChanged = false
      for (const a of plan.actions) {
        if (a.type === 'email') {
          const r = await requestClosingEmail(db, c, { action: a.action, category: a.category, sequence: a.sequence, recipientEmail: a.recipientEmail, dueAt: a.dueAt, requestedBy: 'closing_automation', payload: a.payload })
          if (!r.duplicate) summary.requested += 1
        } else if (a.type === 'cancel') {
          summary.cancelled += await cancelOpenEmailRequests(db, c.closing_case_id, a.reason, a.categories)
        } else if (a.type === 'escalate' && !escalations[a.category]) {
          escalations[a.category] = { at: new Date(now).toISOString(), reason: a.reason, message: a.message }
          escalationChanged = true
          summary.escalated += 1
          await notify({ eventType: 'closing_party_unreachable', sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, title: `${a.message} — ${c.property_address || 'closing'}`, deduplicationKey: `closing_escalation:${c.closing_case_id}:${a.category}` })
          await db.from('closing_activity_events').insert({ closing_case_id: c.closing_case_id, event_type: 'automation_escalated', actor: 'closing_automation', source: 'closing_automation', detail: { category: a.category, reason: a.reason, message: a.message }, idempotency_key: `automation_escalated:${c.closing_case_id}:${a.category}` }).then(() => null, () => null)
        } else if (a.type === 'notify') {
          await notify({ eventType: a.eventType, severity: a.severity, sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, title: a.title, deduplicationKey: `${a.eventType}:${c.closing_case_id}:${a.key}` })
          summary.notified += 1
        }
      }
      if (escalationChanged) {
        await db.from('closing_cases').update({ automation_state: { ...(c.automation_state || {}), escalations } }).eq('closing_case_id', c.closing_case_id)
      }
    } catch (err) {
      summary.errors.push({ closing_case_id: c.closing_case_id, error: String(err?.message || err).slice(0, 200) })
    }
  }
  if (!dryRun) {
    await writeValues({
      closing_automation_heartbeat_at: new Date(now).toISOString(),
      closing_automation_last_summary: JSON.stringify({ ...summary, enabled: automationEnabled, errors: summary.errors.length }),
    }).catch(() => null)
  }
  return { ok: summary.errors.length === 0, enabled: automationEnabled, ...summary }
}
