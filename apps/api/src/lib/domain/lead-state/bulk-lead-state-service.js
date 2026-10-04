/**
 * BULK LEAD-STATE ACTIONS — one server authority for the Inbox bulk bar.
 *
 *   action      patch (canonical, through patchUniversalLeadState)
 *   stage       lifecycle_stage ∈ S1–S6; S7+ is closing territory (Closing Desk) → refused
 *   status      operational_status ∈ the operator-settable statuses
 *   follow_up   follow_up_at = <date>  (a date on the thread — NO message is sent)
 *   snooze      snoozed_until = <until> (default +24 h)
 *   unsnooze    snoozed_until = null
 *   read        is_read = true   (an explicit Mark Read — the only bulk read write)
 *   unread      is_read = false
 *
 * Every item goes through the ONE canonical writer, so its guards apply per
 * item exactly as for a single action: the projection fence and transition
 * rules (a regression without the operator's reason is refused and reported),
 * the closed-won gate, the suppression tuple, the audit trail
 * (universal_lead_state_events, source_view 'bulk_lead_state', operator id).
 * Nothing here suppresses, opts out, archives or sends. "Not interested" stays
 * the seller flow's 30-day nurture — this bar never writes a disposition.
 *
 * Per item: bounded concurrency, a 20 s answer deadline ('unconfirmed', never a
 * silent failure), one result per id.
 */

export const BULK_LEAD_STATE_ACTIONS = Object.freeze(['stage', 'status', 'follow_up', 'snooze', 'unsnooze', 'read', 'unread'])
export const BULK_STAGE_ALLOWED = Object.freeze(['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract'])
export const BULK_STATUS_ALLOWED = Object.freeze(['new_reply', 'active_communication', 'waiting_on_seller', 'follow_up_due', 'needs_review', 'paused'])
export const BULK_MAX_IDS = 100
export const ITEM_TIMEOUT_MS = 20_000
const CONCURRENCY = 4
const DAY = 86_400_000
const CANONICAL_E164 = /^\+1\d{10}$/

export class BulkLeadStateError extends Error {
  constructor(code, status, message) {
    super(message)
    this.code = code
    this.status = status
  }
}

const clean = (v) => String(v ?? '').trim()

function parseDate(value, { minMs, maxMs }) {
  const ms = Date.parse(clean(value))
  if (!Number.isFinite(ms)) return null
  if (ms < minMs || ms > maxMs) return null
  return new Date(ms).toISOString()
}

/** Validate the request and resolve it to ONE canonical patch for every item. */
export function parseBulkLeadStateRequest(body, now = Date.now()) {
  const bad = (msg) => new BulkLeadStateError('invalid_request', 400, msg)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object')
  const action = clean(body.action)
  if (!BULK_LEAD_STATE_ACTIONS.includes(action)) throw bad(`action must be one of ${BULK_LEAD_STATE_ACTIONS.join(', ')}`)
  if (!Array.isArray(body.ids) || !body.ids.length) throw bad('ids must be a non-empty array')
  const ids = [...new Set(body.ids.map(clean).filter(Boolean))]
  if (!ids.length) throw bad('ids must be a non-empty array')
  if (ids.length > BULK_MAX_IDS) throw bad(`at most ${BULK_MAX_IDS} ids per request`)
  const value = body.value
  let patch
  if (action === 'stage') {
    const stage = clean(value).toLowerCase()
    if (['disposition', 'under_contract', 'prepared_to_close', 'closed'].includes(stage)) {
      throw new BulkLeadStateError('stage_needs_closing_desk', 400, 'S7 and later are set through Closing Desk, not a bulk move.')
    }
    if (!BULK_STAGE_ALLOWED.includes(stage)) throw bad('value must be a stage S1–S6')
    patch = { lifecycle_stage: stage }
  } else if (action === 'status') {
    const status = clean(value).toLowerCase()
    if (!BULK_STATUS_ALLOWED.includes(status)) throw bad(`value must be one of ${BULK_STATUS_ALLOWED.join(', ')}`)
    patch = { operational_status: status }
  } else if (action === 'follow_up') {
    const at = parseDate(value, { minMs: now - DAY, maxMs: now + 366 * DAY })
    if (!at) throw bad('value must be a follow-up date within the next year')
    patch = { follow_up_at: at }
  } else if (action === 'snooze') {
    const until = value == null || value === '' ? new Date(now + DAY).toISOString() : parseDate(value, { minMs: now, maxMs: now + 90 * DAY })
    if (!until) throw bad('value must be a time in the next 90 days')
    patch = { snoozed_until: until }
  } else if (action === 'unsnooze') {
    patch = { snoozed_until: null }
  } else {
    patch = { is_read: action === 'read' }
  }
  const reason = clean(body.reason).slice(0, 240) || null
  return { action, ids, patch, reason }
}

const done = (id, outcome, extra = {}) => ({ id, ok: true, outcome, ...extra })
const blocked = (id, reason, message) => ({ id, ok: false, outcome: 'blocked', reason, message })
const failed = (id, reason, message) => ({ id, ok: false, outcome: 'failed', reason, message })

const GUARD_MESSAGES = {
  canonical_stage_transition_refused: 'The deal\'s stage rules refuse this move (a step back or a skip needs a reason — set it on the conversation).',
  manual_stage_lock_blocked_stage_write: 'This stage is locked by an earlier manual move.',
  closing_blocked: 'Closed is set by the closing, in Closing Desk.',
}

async function runItem(ports, id, parsed, ctx) {
  if (!CANONICAL_E164.test(id)) return failed(id, 'invalid_thread_key', 'Not a canonical thread key (+1XXXXXXXXXX).')
  const result = await ports.patchLeadState({
    threadKey: id,
    patch: parsed.patch,
    meta: {
      change_source: 'manual',
      source_view: 'bulk_lead_state',
      operator_id: ctx.operatorId,
      updated_by: ctx.operatorId,
      // the operator's own reason only — never a manufactured one (see the projection fence)
      reason: parsed.reason || null,
      metadata: { bulk_action: parsed.action },
    },
  })
  if (!result?.ok) return failed(id, clean(result?.reason) || 'thread_state_write_failed', 'The conversation was not changed.')
  if (result.blocked) {
    const reason = clean(result.reason) || 'blocked'
    return blocked(id, reason, GUARD_MESSAGES[reason] || `Refused by the lead-state rules (${reason}).`)
  }
  const extra = {}
  if (result.opportunity_stage_sync && result.opportunity_stage_sync.ok === false && result.opportunity_stage_sync.reason !== 'no_linked_opportunity') {
    extra.note = `The conversation moved; the deal did not follow (${result.opportunity_stage_sync.reason}).`
  }
  return done(id, 'changed', extra)
}

async function mapBounded(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export function summarize(results) {
  const s = { requested: results.length, changed: 0, unchanged: 0, blocked: 0, failed: 0 }
  for (const r of results) {
    if (r.outcome === 'changed') s.changed += 1
    else if (r.outcome === 'unchanged') s.unchanged += 1
    else if (r.outcome === 'blocked') s.blocked += 1
    else if (r.outcome === 'unconfirmed') s.unconfirmed = (s.unconfirmed || 0) + 1
    else s.failed += 1
  }
  return s
}

export function createBulkLeadStateService(ports) {
  return {
    async run(parsed, operatorId) {
      if (!operatorId) throw new BulkLeadStateError('operator_unknown', 401, 'The signed-in operator could not be identified.')
      const itemTimeoutMs = ports.itemTimeoutMs ?? ITEM_TIMEOUT_MS
      const ctx = { operatorId }
      const results = await mapBounded(parsed.ids, CONCURRENCY, async (id) => {
        let timer = null
        try {
          return await Promise.race([
            runItem(ports, id, parsed, ctx),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve({ id, ok: false, outcome: 'unconfirmed', reason: 'item_timeout', message: `Still writing after ${Math.round(itemTimeoutMs / 1000)} s — it may complete; check again shortly.` }), itemTimeoutMs)
            }),
          ])
        } catch (error) {
          return failed(id, 'item_failed', clean(error?.message) || 'Unexpected error.')
        } finally {
          if (timer) clearTimeout(timer)
        }
      })
      const summary = summarize(results)
      return { action: parsed.action, operator_id: operatorId, summary, partial: summary.blocked + summary.failed + (summary.unconfirmed || 0) > 0, results }
    },
  }
}

export async function createDefaultBulkLeadStatePorts() {
  const [{ supabase }, { patchUniversalLeadState }] = await Promise.all([
    import('@/lib/supabase/client.js'),
    import('@/lib/domain/lead-state/patch-universal-lead-state.js'),
  ])
  return { patchLeadState: (args) => patchUniversalLeadState({ ...args, supabase }) }
}
