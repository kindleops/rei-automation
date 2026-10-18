// FOLLOW-UP EXECUTION LIFECYCLE (owner P0 directive 2026-10-17). THE one materialization and dispatch
// lifecycle for every deferred follow-up. Storage + every transition: PROPOSED_20261017120000_
// followup_intent_lifecycle.sql (public.followup_intents, its audit, the send_queue sync triggers).
//
//   WRITE      planFollowUpIntent(): one durable intent per thread × property × kind × due (or the inbound
//              that set it), through followup_intent_plan() — a newer plan supersedes the older live one,
//              inbox_thread_state.follow_up_at is projected in the SAME transaction. A writer that cannot
//              schedule records recordNonExecutableFollowUp() with an actionable reason instead.
//   MATERIALIZE runFollowUpMaterialization() at due − MATERIALIZE_LEAD_MS: claim (SKIP LOCKED + lease),
//              re-check eligibility fresh (newer inbound, thread suppression, the automation-hold registry
//              incl. Hartford / Maxwell, the send-time contact guard: STOP / opt-out / suppression /
//              wrong number / contact_property_resolution property denial; stage policy; already sent),
//              resolve the CURRENTLY approved sms_templates row for use case + language + persona and
//              render it with the conversation context (the same resolver dispatch used to run after
//              claim), validate (shared outbound validator, no em / en dash, no unfilled placeholder,
//              length), pick the send instant (recipient-local window with the conservative zone
//              intersection, never more than 2 texts per rolling 24 h), and only THEN write ONE
//              send_queue row with a NONEMPTY body through the canonical writer (enqueueSendQueueItem:
//              21610 suppression, the hold chokepoint, the DB hold trigger). The DB binds the intent to
//              the row (→ ready) in the insert's own transaction, and refuses a row from anyone but the
//              current lease holder or with an empty body.
//   FAIL       transient (lookups, routing, guard read) ⇒ planned again with bounded exponential backoff
//              (max_attempts, then a visible `failed`); terminal ⇒ not_executable{reason}; needs a person ⇒
//              held{reason}. Nothing is ever marked completed or counted as scheduled without a row.
//   DISPATCH   evaluateFollowUpIntentRowGate() inside process-send-queue (after the claim, before any
//              other gate): the intent must still be `ready` and bound to this row, its template still
//              approved (revoked ⇒ cancel + rematerialize, audited), no newer inbound (⇒ superseded), no
//              collision. The rendered body is never re-rendered. The dispatch-time empty-body
//              prohibition in the loader is unchanged.
//   OUTCOME    every send_queue status change from ANY path (claim, provider accept, delivery callback,
//              failure, cancellation, pause) reconciles the intent and follow_up_at in the same
//              transaction (DB trigger). Next action: await_reply / human_review_no_resend / retry / none.
//   RECONCILE  reconcileFollowUpLifecycle(): two-way — every intent has a live record or a reason, every
//              pending follow-up row has an intent. Report-only unless explicitly applied.
//
// BORN OFF: system_control.followup_execution_mode must be 'live' (absent / invalid ⇒ off). Off ⇒ every
// writer behaves exactly as before and nothing here runs.
import crypto from 'node:crypto'

export const FOLLOWUP_LIFECYCLE_VERSION = 'followup-lifecycle.v1'
export const LIFECYCLE_MODE_KEY = 'followup_execution_mode' // the same switch as 8.5.21-A (no new key)
export const MATERIALIZE_LEAD_MS = 30 * 60_000
export const MATERIALIZE_LEASE_SECONDS = 300
export const MAX_TEXTS_PER_24H = 2
export const MAX_FOLLOWUP_SEGMENTS = 3
export const LIFECYCLE_SOURCE = 'followup_lifecycle'

export const INTENT_STATES = Object.freeze({
  PLANNED: 'planned', MATERIALIZING: 'materializing', READY: 'ready', DISPATCHED: 'dispatched',
  PROVIDER_ACCEPTED: 'provider_accepted', DELIVERED: 'delivered', FAILED: 'failed',
  NOT_EXECUTABLE: 'not_executable', CANCELLED: 'cancelled', SUPERSEDED: 'superseded', HELD: 'held',
})
const S = INTENT_STATES
export const EXECUTABLE_STATES = Object.freeze([S.PLANNED, S.MATERIALIZING, S.READY, S.DISPATCHED])

/** Materialization result codes (also the audit `reason` prefixes). */
export const MATERIALIZE_CODES = Object.freeze({
  OFF: 'LIFECYCLE_OFF',
  MATERIALIZED: 'MATERIALIZED',
  RETRY: 'RETRY_SCHEDULED',
  NOT_EXECUTABLE: 'NOT_EXECUTABLE',
  HELD: 'HELD',
  SUPERSEDED: 'SUPERSEDED',
  LEASE_LOST: 'LEASE_LOST',
})
const M = MATERIALIZE_CODES

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const iso = (ms) => new Date(ms).toISOString()
const toMs = (v) => { const t = Date.parse(clean(v)); return Number.isFinite(t) ? t : null }
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

// ── property × contact blocks (owner rules 2026-10-17) ───────────────────────
/**
 * "No thanks" to the ownership question: declined engagement, ownership UNVERIFIED. A PROPERTY-SCOPED
 * no-recontact hold — never a nurture / follow-up for that property × contact, blocking exactly like a
 * property denial, and never recorded as non-ownership. The state constant lands on rc-8.5.21 with the
 * integration (owner decision 2026-10-17); this is its exact name until then.
 */
export const OWNERSHIP_DECLINED_UNVERIFIED = 'ownership_declined_unverified'
const PAIR_DENIAL_ROLES = new Set(['not_owner', 'non_owner', 'property_specific_non_owner', 'former_owner', 'former_owner_respondent', 'wrong_person', 'never_owned'])
const phoneTail = (v) => { const d = clean(v).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }
/**
 * Pure. Is THIS property × contact closed to follow-ups? (STOP is contact-wide and lives in the send-time
 * guard; "No" to SELLING is the 30-day nurture and is NOT a block.)
 * @returns {{ blocked: boolean, reason: string|null, kind: 'property_denial'|'ownership_declined_unverified'|null, state?: 'not_executable'|'held' }}
 *   a denial is not_executable; "No thanks" (declined, unverified) is HELD (deferred: an operator may release it)
 */
export function propertyContactBlock({ property_id = null, phone = null, thread = null, resolutions = [] } = {}) {
  const pid = clean(property_id)
  const tail = phoneTail(phone)
  const mine = (resolutions || []).filter((r) => (!tail || phoneTail(r.contact_phone_e164) === tail) && pid && clean(r.property_id) === pid)
  const declined = (r) => [r.contact_property_role, r.rejection_reason, r.suppression_scope, r.ownership_state].map(lower).includes(OWNERSHIP_DECLINED_UNVERIFIED)
  if (mine.some(declined)) return { blocked: true, reason: `${OWNERSHIP_DECLINED_UNVERIFIED}:no_recontact_hold`, kind: OWNERSHIP_DECLINED_UNVERIFIED, state: 'held' }
  const denial = mine.find((r) => clean(r.rejected_at) && PAIR_DENIAL_ROLES.has(lower(r.contact_property_role)) && (!clean(r.suppression_scope) || lower(r.suppression_scope) === 'contact_property_pair'))
  if (denial) return { blocked: true, reason: 'property_denial:contact_property_resolution', kind: 'property_denial', state: 'not_executable' }
  const t = thread || {}
  const tstates = [t.disposition, t.last_intent, t.contactability_status, t.ownership_status, t.operational_status].map(lower)
  // the thread's own state: its property, or (property unknown) conservatively this one
  if (tstates.includes(OWNERSHIP_DECLINED_UNVERIFIED) && (!clean(t.property_id) || !pid || clean(t.property_id) === pid)) {
    return { blocked: true, reason: `${OWNERSHIP_DECLINED_UNVERIFIED}:no_recontact_hold`, kind: OWNERSHIP_DECLINED_UNVERIFIED, state: 'held' }
  }
  return { blocked: false, reason: null, kind: null }
}

// ── mode ─────────────────────────────────────────────────────────────────────
export function resolveLifecycleMode(raw) {
  const v = lower(raw)
  return ['off', 'dry_run', 'live'].includes(v) ? v : 'off'
}
/** Is the lifecycle the writer of record? Never throws: an unreadable switch is OFF (legacy path). */
export async function lifecycleLive({ readSwitch = null, supabase = null } = {}) {
  try {
    if (typeof readSwitch === 'function') return resolveLifecycleMode(await readSwitch(LIFECYCLE_MODE_KEY)) === 'live'
    if (!supabase?.from) return false
    const r = await supabase.from('system_control').select('value').eq('key', LIFECYCLE_MODE_KEY).maybeSingle()
    if (r?.error) return false
    return resolveLifecycleMode(r?.data?.value) === 'live'
  } catch {
    return false
  }
}

// ── identity ─────────────────────────────────────────────────────────────────
/** The follow-up kind of a scheduler intent (+ its context). */
export function followUpKindFor(intent, context = {}) {
  const c = obj(context)
  if (clean(c.followup_kind)) return clean(c.followup_kind)
  const i = lower(intent)
  const nr = obj(c.no_response_followup)
  if (clean(nr.kind)) return `no_response_${lower(nr.kind)}`
  if (i === 'not_interested') return 'not_interested_nurture'
  if (i === 'seller_callback' || i === 'need_time') return 'seller_requested_callback'
  if (i === 'stage_no_reply') return 'stage_silence'
  return `nurture_${i || 'unclear'}`
}

/**
 * One key per thread × property × kind × due. A follow-up set by a specific inbound (or a caller-declared
 * scope, e.g. a no-response chain step) is keyed by that cause instead of the clock, so a replay of the
 * same inbound / delivery collapses onto the same intent.
 */
export function followUpIntentKey({ thread_key, property_id = null, kind, due_at, cause = null }) {
  const due = toMs(due_at)
  const basis = clean(cause) ? `cause:${clean(cause)}` : `due:${due == null ? '' : iso(due)}`
  return `fi1.${crypto.createHash('sha256').update(`${FOLLOWUP_LIFECYCLE_VERSION}|${clean(thread_key)}|${clean(property_id)}|${clean(kind)}|${basis}`).digest('hex').slice(0, 40)}`
}

async function rpc(supabase, fn, args) {
  if (!supabase || typeof supabase.rpc !== 'function') throw Object.assign(new Error('followup_lifecycle_no_client'), { code: 'NO_CLIENT', transient: true })
  const r = await supabase.rpc(fn, args)
  if (r?.error) throw Object.assign(new Error(clean(r.error.message) || `${fn}_failed`), { code: r.error.code || null })
  return r?.data
}

// ── the ONE writer API ───────────────────────────────────────────────────────
/**
 * @param {{ thread_key: string, property_id?: string|null, master_owner_id?: string|null, prospect_id?: string|null,
 *           kind: string, intent: string, use_case?: string|null, due_at: string, writer: string, cause?: string|null,
 *           row_spec?: object, state?: 'planned'|'not_executable'|'held', reason?: string|null, actor?: string|null }} input
 * @returns {Promise<{ ok: boolean, replay?: boolean, intent?: object, follow_up_at?: string|null, reason?: string }>}
 */
export async function planFollowUpIntent(input = {}, { supabase } = {}) {
  const thread_key = clean(input.thread_key)
  const kind = clean(input.kind)
  const due = toMs(input.due_at)
  if (!thread_key || !kind || due == null || !clean(input.intent) || !clean(input.writer)) return { ok: false, reason: 'followup_intent_input_incomplete' }
  const p = {
    intent_key: clean(input.intent_key) || followUpIntentKey({ thread_key, property_id: input.property_id, kind, due_at: iso(due), cause: input.cause }),
    thread_key, property_id: clean(input.property_id) || null, master_owner_id: clean(input.master_owner_id) || null, prospect_id: clean(input.prospect_id) || null,
    kind, intent: clean(input.intent), use_case: clean(input.use_case) || null, due_at: iso(due), writer: clean(input.writer),
    row_spec: obj(input.row_spec), state: clean(input.state) || 'planned', reason: clean(input.reason) || null, actor: clean(input.actor) || clean(input.writer),
  }
  try {
    const data = obj(await rpc(supabase, 'followup_intent_plan', { p }))
    return { ok: data.ok === true, replay: data.replay === true, superseded: Number(data.superseded || 0), intent: data.intent || null, follow_up_at: data.follow_up_at || null }
  } catch (error) {
    return { ok: false, reason: 'followup_intent_plan_failed', error: clean(error?.message).slice(0, 200) }
  }
}

/** A writer that cannot schedule: a documented non-executable outcome (never a bare date). */
export function recordNonExecutableFollowUp(input = {}, deps = {}) {
  if (!clean(input.reason)) return Promise.resolve({ ok: false, reason: 'followup_non_executable_reason_required' })
  return planFollowUpIntent({ ...input, state: S.NOT_EXECUTABLE }, deps)
}

/** Cancel / supersede a thread's live intents and their unsent rows (fresh inbound, STOP, operator). */
export async function closeFollowUpIntentsForThread({ thread_key, state = S.CANCELLED, reason, actor = null, property_id = null, kinds = null, keep_kinds = null, created_before = null } = {}, { supabase } = {}) {
  if (!clean(thread_key) || !clean(reason)) return { ok: false, reason: 'thread_key_and_reason_required' }
  try {
    const data = obj(await rpc(supabase, 'followup_intent_close_for_thread', {
      p: { thread_key: clean(thread_key), state, reason: clean(reason), actor: clean(actor) || null, property_id: clean(property_id) || null, kinds: Array.isArray(kinds) ? kinds : null, keep_kinds: Array.isArray(keep_kinds) ? keep_kinds : null, created_before: clean(created_before) || null },
    }))
    return { ok: data.ok === true, closed: Number(data.closed || 0), rows_cancelled: Number(data.rows_cancelled || 0) }
  } catch (error) {
    return { ok: false, reason: 'followup_intent_close_failed', error: clean(error?.message).slice(0, 200) }
  }
}

/**
 * The writer path for seller-followup-scheduler.scheduleFollowUp in live mode: the row it would have
 * written body-less becomes the intent's row_spec; the row is written by materialization, rendered.
 */
export async function planFollowUpFromScheduler({ intent, plan = {}, payload = {}, context = {}, supabase }) {
  const c = obj(context)
  const kind = followUpKindFor(intent, c)
  const cause = clean(c.followup_dedupe_scope) || clean(c.inbound_message_event_id) || clean(c.source_inbound_event_id) || null
  const due_at = clean(payload.scheduled_for) || clean(plan.scheduled_for)
  // a property-scoped block (property denial / ownership declined, unverified) is recorded as a documented
  // non-executable outcome — never a nurture / follow-up intent. A failed read plans normally: the
  // materializer re-checks the same facts before anything becomes claimable.
  let block = { blocked: false }
  try { block = await loadPropertyContactBlock({ supabase, thread_key: payload.thread_key, phone: payload.to_phone_number, property_id: payload.property_id }) } catch { block = { blocked: false } }
  const r = await planFollowUpIntent({
    thread_key: payload.thread_key, property_id: payload.property_id, master_owner_id: payload.master_owner_id, prospect_id: c.prospect_id || null,
    kind, intent, use_case: payload.use_case_template, due_at, writer: clean(c.writer) || clean(payload.metadata?.source) || 'seller_followup_scheduler', cause,
    row_spec: payload,
    ...(block.blocked ? { state: block.state === S.HELD ? S.HELD : S.NOT_EXECUTABLE, reason: block.reason } : {}),
  }, { supabase })
  if (!r.ok) return { ok: false, skipped: true, reason: r.reason || 'followup_intent_plan_failed', error: r.error || null, thread_key: payload.thread_key, lifecycle: true }
  if (block.blocked) return { ok: false, skipped: true, followup_created: false, lifecycle: true, reason: block.reason, followup_intent_id: r.intent?.id || null, followup_intent_state: r.intent?.state || null, thread_key: payload.thread_key }
  return {
    ok: true, followup_created: !r.replay, lifecycle: true, scheduled_for: r.intent?.due_at || due_at, reason: plan.reason || null,
    thread_key: payload.thread_key, queue_row_id: null, followup_intent_id: r.intent?.id || null, followup_intent_state: r.intent?.state || null,
    idempotent_replay: r.replay === true, ...(r.replay ? { reason: 'duplicate_followup_exists' } : {}),
  }
}

// ── materialization helpers (pure) ───────────────────────────────────────────
const TRANSIENT_GUARD = new Set(['send_time_guard_read_failed'])
// rc-8.5.21 integration contract: the send-time guard's deferral for "No thanks" to ownership
export const OWNERSHIP_DECLINED_UNVERIFIED_GUARD_REASON = 'ownership_declined_unverified_hold'
const HOLD_GUARD = new Set(['automation_hold_active', 'ownership_denial_property_unresolved', OWNERSHIP_DECLINED_UNVERIFIED_GUARD_REASON])
/** A send-time contact guard verdict → lifecycle state. */
export function classifyGuardBlock(reason) {
  const r = clean(reason)
  if (TRANSIENT_GUARD.has(r)) return { to: S.PLANNED, transient: true }
  if (HOLD_GUARD.has(r)) return { to: S.HELD, transient: false }
  return { to: S.NOT_EXECUTABLE, transient: false }
}

/** Bounded exponential backoff for transient materialization failures: 5 min · 2^(attempt-1), ≤ 6 h. */
export function backoffMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1)
  return Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** (n - 1))
}

const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\[\[[^\]]*\]\]|\{[a-z_]+\}|\$\{[^}]*\}/i
const DASH_RE = /[–—]/
/** The materialized body: nonempty, no unfilled placeholder, no em / en dash, ≤ MAX_FOLLOWUP_SEGMENTS. */
export function validateMaterializedBody(body) {
  const text = clean(body)
  if (!text) return { ok: false, reason: 'empty_body' }
  if (PLACEHOLDER_RE.test(text)) return { ok: false, reason: 'unfilled_placeholder' }
  if (DASH_RE.test(text)) return { ok: false, reason: 'em_or_en_dash' }
  const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€]*$/.test(text)
  const per = gsm ? 153 : 67
  const segments = text.length <= (gsm ? 160 : 70) ? 1 : Math.ceil(text.length / per)
  if (segments > MAX_FOLLOWUP_SEGMENTS) return { ok: false, reason: 'body_too_long', segments }
  return { ok: true, reason: null, segments }
}

/**
 * The send instant: the first instant ≥ max(due, now) that is inside the recipient-local window in EVERY
 * zone (conservative intersection) and keeps every rolling 24 h window at ≤ MAX_TEXTS_PER_24H texts
 * including this one. `others` = instants of other texts to the same phone (sent, or pending rows).
 * @param {{ due: number, now: number, zones: string[], others?: number[], lawful: (atIso: string, zones: string[]) => { lawful: boolean, next_permitted_at: string|null } }} a
 */
export function planSendInstant({ due, now, zones, others = [], lawful }) {
  const DAY = 24 * 3_600_000
  const sorted = [...others].filter(Number.isFinite).sort((a, b) => a - b)
  // with MAX_TEXTS_PER_24H = 2: no two other texts may share any 24 h window with this one
  const collides = (c) => {
    const near = sorted.filter((x) => x > c - DAY && x < c + DAY)
    for (let a = 0; a < near.length; a += 1) {
      for (let b = a + 1; b < near.length; b += 1) {
        if (Math.max(near[b], c) - Math.min(near[a], c) < DAY) return near
      }
    }
    return null
  }
  const start = Math.max(due, now)
  let t = start
  for (let i = 0; i < 24; i += 1) {
    const w = lawful(iso(t), zones)
    if (!w.lawful) {
      const next = toMs(w.next_permitted_at)
      if (next == null || next <= t) return { ok: false, reason: 'no_lawful_window' }
      t = next
      continue
    }
    const near = collides(t)
    if (!near) return { ok: true, at: iso(t), deferred: t > start, collision_deferred: i > 0 && t > start }
    const later = near.map((x) => x + DAY + 60_000).filter((x) => x > t)
    if (!later.length) return { ok: false, reason: 'collision_unresolvable' }
    t = Math.min(...later)
  }
  return { ok: false, reason: 'collision_unresolvable' }
}

/** Fresh reads for propertyContactBlock (contact_property_resolution + the thread). Throws on a read error. */
export async function loadPropertyContactBlock({ supabase, thread_key, phone = null, property_id = null } = {}) {
  if (!supabase?.from) throw new Error('no_client')
  const tail = phoneTail(phone || thread_key)
  const variants = tail ? [`+1${tail}`, `1${tail}`, tail] : []
  const q1 = variants.length ? await supabase.from('contact_property_resolution').select('property_id,contact_phone_e164,contact_property_role,rejected_at,rejection_reason,suppression_scope').in('contact_phone_e164', variants).limit(50) : { data: [] }
  if (q1?.error) throw q1.error
  const q2 = await supabase.from('inbox_thread_state').select('*').eq('thread_key', clean(thread_key)).limit(1)
  if (q2?.error) throw q2.error
  return propertyContactBlock({ property_id, phone: phone || thread_key, thread: (q2.data || [])[0] || null, resolutions: q1.data || [] })
}

/** The would-be deferred row the canonical resolver renders (exactly what the scheduler used to insert). */
export function virtualDeferredRow(intent = {}) {
  const spec = obj(intent.row_spec)
  return { ...spec, id: null, message_body: '', message_text: '', rendered_message: '', metadata: { ...obj(spec.metadata), deferred_message_resolution: true } }
}

const NO_TEMPLATE_REASONS = new Set(['no_renderable_followup_template', 'stage_no_reply_use_case_missing'])
const TRANSIENT_RENDER_REASONS = new Set(['template_lookup_failed', 'missing_supabase', 'no_response_resolution_failed'])

// ── materialization ──────────────────────────────────────────────────────────
/**
 * One materialization pass. Claims due intents (lease) and materializes each. Never throws for one
 * intent's failure; a claim read failure throws (the caller's job retries, bounded).
 */
export async function runFollowUpMaterialization(deps = {}) {
  const live = await lifecycleLive({ readSwitch: deps.readSwitch, supabase: deps.supabase })
  if (!live) return { code: M.OFF }
  const worker = clean(deps.worker) || `materializer:${process.pid}`
  const claimed = await deps.claim({ worker, limit: deps.limit || 25, lead_seconds: Math.round((deps.leadMs ?? MATERIALIZE_LEAD_MS) / 1000), lease_seconds: deps.leaseSeconds || MATERIALIZE_LEASE_SECONDS, intent_id: deps.intentId || null })
  const counts = { claimed: claimed.length, materialized: 0, retry: 0, not_executable: 0, held: 0, superseded: 0, lease_lost: 0 }
  const results = []
  for (const intent of claimed) {
    let r
    try {
      r = await materializeClaimedIntent(intent, deps)
    } catch (error) {
      r = await settle(intent, deps, { to: S.PLANNED, reason: `materialize_error:${clean(error?.message).slice(0, 80) || 'unknown'}`, transient: true })
    }
    results.push({ intent_id: intent.id, code: r.code, reason: r.reason || null })
    if (r.code === M.MATERIALIZED) counts.materialized += 1
    else if (r.code === M.RETRY) counts.retry += 1
    else if (r.code === M.NOT_EXECUTABLE) counts.not_executable += 1
    else if (r.code === M.HELD) counts.held += 1
    else if (r.code === M.SUPERSEDED) counts.superseded += 1
    else if (r.code === M.LEASE_LOST) counts.lease_lost += 1
  }
  return { code: 'MATERIALIZATION_PASS', counts, results }
}

async function settle(intent, deps, { to, reason, transient = false, retry_at = null, refund = false, detail = {} }) {
  const now = deps.now ? toMs(deps.now()) : Date.now()
  const retryAt = to === S.PLANNED ? (retry_at || iso(now + backoffMs(intent.attempts))) : null
  const r = await deps.transition({ id: intent.id, token: intent.lease_token, to, reason, retry_at: retryAt, refund, detail })
  if (r?.ok === false) return { code: M.LEASE_LOST, reason: r.reason || 'lease_lost' }
  const code = to === S.PLANNED ? M.RETRY : to === S.NOT_EXECUTABLE ? M.NOT_EXECUTABLE : to === S.HELD ? M.HELD : to === S.SUPERSEDED ? M.SUPERSEDED : M.NOT_EXECUTABLE
  return { code, reason, transient, retry_at: retryAt }
}

/** Materialize ONE claimed intent (state materializing, lease_token held by this worker). */
export async function materializeClaimedIntent(intent, deps = {}) {
  const now = deps.now ? toMs(deps.now()) : Date.now()
  const spec = obj(intent.row_spec)
  const thread_key = clean(intent.thread_key)
  const to_phone = clean(spec.to_phone_number) || thread_key

  // 0. the lifecycle is still on (a mid-flight OFF returns the intent untouched to planned, no attempt spent)
  if (!(await lifecycleLive({ readSwitch: deps.readSwitch, supabase: deps.supabase }))) {
    return settle(intent, deps, { to: S.PLANNED, reason: 'deferred:lifecycle_off', refund: true, retry_at: iso(now + 15 * 60_000) })
  }
  if (!Object.keys(spec).length || !to_phone) return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason: 'row_spec_missing' })

  // 1. the conversation moved on / the thread is suppressed
  const thread = await deps.loadThread(thread_key)
  if (thread?.is_suppressed === true) return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason: 'thread_suppressed' })
  const lastInbound = toMs(thread?.last_inbound_at)
  if (lastInbound != null && lastInbound > toMs(intent.created_at)) return settle(intent, deps, { to: S.SUPERSEDED, reason: 'superseded_by_newer_inbound' })

  // 2. the automation-hold registry (Hartford, Maxwell, operator holds); a lookup error is transient
  const hold = await deps.holdCheck({ thread_key, property_id: intent.property_id || spec.property_id || null, master_owner_id: intent.master_owner_id || spec.master_owner_id || null })
  if (hold?.held) {
    if (hold.fail_closed || hold.hold_type === 'lookup_error') return settle(intent, deps, { to: S.PLANNED, reason: `hold_lookup_failed:${clean(hold.reason).slice(0, 60)}`, transient: true })
    return settle(intent, deps, { to: S.HELD, reason: `automation_hold:${clean(hold.hold_type) || 'hold'}`, detail: { hold_ids: hold.hold_ids || [] } })
  }

  // 3. the send-time contact guard on the would-be row (STOP / opt-out / suppression / wrong number /
  //    property-scoped denial from contact_property_resolution / unresolved-ownership hold)
  const guard = await deps.guard.call(deps, { ...virtualDeferredRow(intent), thread_key, to_phone_number: to_phone })
  if (guard?.blocked) {
    const g = guard.detail?.hold_type === 'lookup_error' ? { to: S.PLANNED, transient: true } : classifyGuardBlock(guard.reason)
    return settle(intent, deps, { to: g.to, reason: `send_time_guard:${clean(guard.reason) || 'blocked'}`, transient: g.transient })
  }

  // 3b. property × contact: a property denial or "No thanks" to ownership (declined, unverified) closes THIS
  //     property to follow-ups (never contact-wide, never recorded as non-ownership)
  let pblock
  try { pblock = typeof deps.propertyBlock === 'function' ? await deps.propertyBlock(intent) : null } catch { return settle(intent, deps, { to: S.PLANNED, reason: 'property_block_read_failed', transient: true }) }
  if (pblock?.blocked) return settle(intent, deps, { to: pblock.state === S.HELD ? S.HELD : S.NOT_EXECUTABLE, reason: pblock.reason })

  // 4. already executed by another path (a follow-up of this use case sent after this intent was planned)
  if (await deps.alreadySent(intent)) return settle(intent, deps, { to: S.SUPERSEDED, reason: 'already_sent_by_other_path' })

  // 5. language + the CURRENTLY approved template; then render with the conversation context
  const language = clean(spec.language) || clean(obj(spec.metadata).language) || clean(await deps.languageFor(thread_key))
  if (!language) return settle(intent, deps, { to: S.HELD, reason: 'language_unknown' })
  const virtual = { ...virtualDeferredRow(intent), language }
  const candidates = deps.templateCandidates ? deps.templateCandidates(virtual) : null
  if (Array.isArray(candidates)) {
    let available
    try {
      available = await deps.templatesAvailable(candidates, language)
    } catch {
      return settle(intent, deps, { to: S.PLANNED, reason: 'template_lookup_failed', transient: true })
    }
    if (!candidates.length || !available) return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason: `no_approved_template:${candidates.join('|') || 'none'}:${language}` })
  }
  let rendered
  try {
    rendered = await deps.render(virtual)
  } catch (error) {
    return settle(intent, deps, { to: S.PLANNED, reason: `render_error:${clean(error?.message).slice(0, 60)}`, transient: true })
  }
  if (!rendered?.ok || !rendered.resolved) {
    const reason = clean(rendered?.reason) || 'render_failed'
    if (TRANSIENT_RENDER_REASONS.has(reason)) return settle(intent, deps, { to: S.PLANNED, reason, transient: true })
    if (reason === 'language_unknown') return settle(intent, deps, { to: S.HELD, reason })
    if (NO_TEMPLATE_REASONS.has(reason)) return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason: Array.isArray(candidates) ? 'unfillable_placeholder' : 'no_renderable_template' })
    return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason: `render:${reason}` })
  }
  const body = clean(rendered.message_body)
  const check = validateMaterializedBody(body)
  if (!check.ok) return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason: `invalid_body:${check.reason}` })

  // 6. stage policy for stage silences (enabled stage + the automated-follow-up ceiling)
  if (typeof deps.stagePolicy === 'function') {
    const sp = await deps.stagePolicy(intent)
    if (sp && sp.ok === false) return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason: `stage_policy:${clean(sp.reason)}` })
  }

  // 7. sender health: the thread's sticky sender is kept (persona + number continuity) and its health is
  //    recorded; the dispatcher's canonical sender authority re-validates it at send time and reroutes a
  //    cooling / blocked sender to the thread's eligible fallback, or blocks the row visibly.
  const from = clean(spec.from_phone_number) || null
  let sender_health = null
  if (from) {
    try { sender_health = lower(await deps.senderStatus(from)) || 'unknown_sender' } catch { return settle(intent, deps, { to: S.PLANNED, reason: 'sender_lookup_failed', transient: true }) }
  }

  // 8. contact window (recipient-local; property zone must be derivable like the dispatcher requires,
  //    the plausible-zone intersection is the conservative policy) + ≤ 2 texts per rolling 24 h
  const geo = await deps.propertyGeography(intent.property_id || spec.property_id || null)
  const tz = deps.resolveRecipientTimezone({ ...spec, to_phone_number: to_phone }, { propertyGeography: geo })
  if (!tz?.ok) return settle(intent, deps, { to: S.HELD, reason: 'recipient_timezone_unresolved' })
  const zones = deps.recipientZones({ recipientPhone: to_phone, propertyGeography: geo, storedTimezone: tz.iana })
  let others
  try { others = await deps.otherTexts({ thread_key, to_phone, intent_id: intent.id, around: Math.max(toMs(intent.due_at), now) }) } catch { return settle(intent, deps, { to: S.PLANNED, reason: 'collision_lookup_failed', transient: true }) }
  const when = planSendInstant({ due: toMs(intent.due_at), now, zones: [...new Set([tz.iana, ...zones])], others, lawful: deps.lawful })
  if (!when.ok) return settle(intent, deps, { to: S.HELD, reason: when.reason })

  // 9. ONE idempotent, nonempty, send-ready row through the canonical writer; the DB binds the intent
  const seq = Number(intent.materialize_seq) || 1
  const queue_key = `fui:${intent.id}:m${seq}`
  const metadata = {
    ...obj(spec.metadata),
    deferred_message_resolution: false,
    source: clean(obj(spec.metadata).source) || LIFECYCLE_SOURCE,
    followup_intent_id: intent.id,
    followup_intent_key: intent.intent_key,
    followup_kind: intent.kind,
    followup_materialize_token: intent.lease_token,
    followup_materialize_seq: seq,
    followup_materialized_at: iso(now),
    followup_due_at: intent.due_at,
    // the §11 dispatcher's derivable identity for this follow-up (queue_key is never identity)
    follow_up_id: `followup_intent:${intent.id}`,
    idempotency_key: queue_key,
    template_source: 'sms_templates',
    recipient_zones: zones,
    language: rendered.language || language,
    ...(sender_health ? { followup_sender_health: sender_health, ...(UNHEALTHY_SENDER.has(sender_health) ? { followup_sender_needs_reroute: true } : {}) } : {}),
    ...(when.deferred ? { followup_send_deferred: true } : {}),
    ...(rendered.render_context ? { deferred_render_context_resolved: Object.keys(rendered.render_context) } : {}),
  }
  const ctxFields = Object.fromEntries(['seller_first_name', 'property_address', 'agent_name'].filter((k) => clean(rendered.render_context?.[k])).map((k) => [k, rendered.render_context[k]]))
  const row = {
    ...spec,
    ...ctxFields,
    queue_key, queue_id: queue_key, dedupe_key: `followup_intent:${intent.id}:m${seq}`,
    thread_key, to_phone_number: to_phone, queue_status: 'scheduled',
    scheduled_for: when.at, scheduled_for_utc: when.at, scheduled_for_local: when.at,
    message_body: body, message_text: body, rendered_message: body, character_count: body.length,
    template_id: rendered.template_id || null, selected_template_id: rendered.template_id || null, template_source: 'sms_templates',
    use_case_template: rendered.use_case || spec.use_case_template, language: rendered.language || language,
    ...(tz.iana && !clean(spec.timezone) ? { timezone: tz.iana } : {}),
    metadata,
  }
  const validation = deps.validate(row)
  if (!validation.ok) return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason: `outbound_validator:${clean(validation.reason)}` })

  let w
  try {
    w = await deps.enqueue(row)
  } catch (error) {
    const msg = clean(error?.message)
    if (/FOLLOWUP_INTENT:/.test(msg)) return { code: M.LEASE_LOST, reason: msg.slice(0, 120) }
    return settle(intent, deps, { to: S.PLANNED, reason: `enqueue_error:${msg.slice(0, 60) || 'unknown'}`, transient: true })
  }
  if (w?.ok && !w.idempotent_replay) return { code: M.MATERIALIZED, queue_row_id: w.queue_row_id || null, send_at: when.at, template_id: rendered.template_id || null }
  const reason = clean(w?.reason) || 'enqueue_refused'
  if (w?.idempotent_replay) return { code: M.MATERIALIZED, queue_row_id: w.queue_row_id || null, send_at: when.at, replay: true }
  if (/FOLLOWUP_INTENT:/.test(reason)) return { code: M.LEASE_LOST, reason: reason.slice(0, 120) }
  if (reason === 'automation_hold') return settle(intent, deps, { to: S.HELD, reason: 'automation_hold:enqueue_chokepoint' })
  if (reason === 'automation_hold_lookup_failed') return settle(intent, deps, { to: S.PLANNED, reason, transient: true })
  if (reason === 'phone_suppressed_21610') return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason })
  if (/AUTOMATION_HOLD/.test(reason)) return settle(intent, deps, { to: S.HELD, reason: 'automation_hold:db_trigger' })
  if (/^(missing_|message_too_short|blank_greeting|entity_name|html_content|contradictory|live_execution)/.test(reason)) return settle(intent, deps, { to: S.NOT_EXECUTABLE, reason: `outbound_validator:${reason}` })
  return settle(intent, deps, { to: S.PLANNED, reason: `enqueue_refused:${reason.slice(0, 60)}`, transient: true })
}

const UNHEALTHY_SENDER = new Set(['disabled', 'inactive', 'failed', 'blocked', 'retired', 'paused', 'suspended', 'cooling', 'cooldown', 'quarantined'])

// ── dispatch-time gate (process-send-queue, after the claim) ─────────────────
export function isLifecycleRow(row = {}) {
  return Boolean(clean(obj(row?.metadata).followup_intent_id))
}

/**
 * @returns {Promise<{ applies: boolean, action: 'proceed'|'cancel'|'defer', reason: string|null, defer_until?: string|null }>}
 *   cancel ⇒ the caller cancels the row (the DB trigger closes / has closed the intent); defer ⇒ release
 *   the row to `defer_until` (collision). A revoked template has already been re-planned when this returns.
 */
export async function evaluateFollowUpIntentRowGate(row = {}, deps = {}) {
  if (!isLifecycleRow(row)) return { applies: false, action: 'proceed', reason: null }
  const id = clean(obj(row.metadata).followup_intent_id)
  let intent
  try { intent = await deps.loadIntent(id) } catch { return { applies: true, action: 'defer', reason: 'followup_intent_read_failed', defer_until: null } }
  if (!intent) return { applies: true, action: 'cancel', reason: 'followup_intent_missing' }
  if (clean(intent.send_queue_id) !== clean(row.id)) return { applies: true, action: 'cancel', reason: 'followup_intent_not_bound_to_row' }
  if (![S.READY, S.DISPATCHED].includes(intent.state)) return { applies: true, action: 'cancel', reason: `followup_intent_${intent.state}` }
  if (!clean(row.message_body || row.message_text)) return { applies: true, action: 'cancel', reason: 'empty_message_body' }
  // the automation-hold registry at the last second (Hartford / Maxwell / operator holds): a hold PAUSES the
  // row (the intent becomes held, visible); its release resumes it. A lookup failure defers.
  if (typeof deps.holdCheck === 'function') {
    let hold
    try { hold = await deps.holdCheck({ thread_key: clean(intent.thread_key), property_id: intent.property_id || row.property_id || null, master_owner_id: intent.master_owner_id || row.master_owner_id || null }) } catch { hold = { held: true, fail_closed: true } }
    if (hold?.held) return hold.fail_closed || hold.hold_type === 'lookup_error'
      ? { applies: true, action: 'defer', reason: 'automation_hold_lookup_failed', defer_until: null }
      : { applies: true, action: 'hold', reason: `automation_hold:${clean(hold.hold_type) || 'hold'}` }
  }
  // the conversation moved on since the intent was planned
  let thread = null
  try { thread = await deps.loadThread(clean(intent.thread_key)) } catch { return { applies: true, action: 'defer', reason: 'thread_read_failed', defer_until: null } }
  if (toMs(thread?.last_inbound_at) != null && toMs(thread.last_inbound_at) > toMs(intent.created_at)) {
    await deps.closeIntents({ thread_key: intent.thread_key, state: S.SUPERSEDED, reason: 'superseded_by_newer_inbound_at_dispatch', actor: 'dispatch_gate', kinds: [intent.kind] })
    return { applies: true, action: 'cancel', reason: 'superseded_by_newer_inbound' }
  }
  // the property × contact block, fresh (property denial / ownership declined unverified)
  if (typeof deps.propertyBlock === 'function') {
    let pb
    try { pb = await deps.propertyBlock(intent) } catch { return { applies: true, action: 'defer', reason: 'property_block_read_failed', defer_until: null } }
    if (pb?.blocked) return { applies: true, action: pb.state === S.HELD ? 'hold' : 'cancel', reason: pb.reason }
  }
  // the template is STILL approved (revoked ⇒ cancel this row and materialize again)
  const template_id = clean(row.template_id || row.selected_template_id)
  if (template_id) {
    let approved
    try { approved = await deps.templateApproved(template_id) } catch { return { applies: true, action: 'defer', reason: 'template_read_failed', defer_until: null } }
    if (!approved) {
      await deps.rematerialize({ id: intent.id, send_queue_id: row.id, reason: 'template_revoked_rematerialize' })
      return { applies: true, action: 'cancel', reason: 'template_revoked_rematerialize', rematerialized: true }
    }
  }
  // ≤ 2 texts per rolling 24 h at the real send instant
  const now = deps.now ? toMs(deps.now()) : Date.now()
  let sent = []
  try { sent = await deps.sentTexts({ to_phone: clean(row.to_phone_number) || clean(row.thread_key), since: iso(now - 24 * 3_600_000), exclude_row_id: row.id }) } catch { return { applies: true, action: 'defer', reason: 'collision_read_failed', defer_until: null } }
  const recent = sent.filter(Number.isFinite).sort((a, b) => a - b)
  if (recent.length >= MAX_TEXTS_PER_24H) {
    // the earliest instant at which only MAX − 1 of those texts remain inside the trailing 24 h
    const until = iso(recent[recent.length - MAX_TEXTS_PER_24H] + 24 * 3_600_000 + 60_000)
    return { applies: true, action: 'defer', reason: 'collision_max_texts_per_24h', defer_until: until }
  }
  return { applies: true, action: 'proceed', reason: 'followup_intent_ready' }
}

// ── reconciliation (two-way) ─────────────────────────────────────────────────
const LIVE_ROW = new Set(['queued', 'pending', 'approved', 'ready', 'scheduled', 'processing', 'sending', 'paused', 'paused_after_hours', 'held', 'approval'])
/**
 * Pure. Every intent has a live record or a reason; every pending follow-up row has an intent; every
 * thread follow_up_at is backed by an executable intent.
 * @param {{ intents: object[], rows: object[], threads: object[], now?: number, graceMs?: number }} a
 */
export function reconcileFollowUpLifecycle({ intents = [], rows = [], threads = [], now = Date.now(), graceMs = 6 * 3_600_000 } = {}) {
  const byId = new Map(intents.map((i) => [clean(i.id), i]))
  const rowById = new Map(rows.map((r) => [clean(r.id), r]))
  const out = {
    counts: { intents: intents.length, executable: 0, ready_without_row: 0, ready_row_not_live: 0, planned_overdue: 0, materializing_stale: 0, no_reason: 0,
      orphan_rows: 0, legacy_deferred_rows: 0, unbacked_follow_up_at: 0, projection_mismatch: 0, accepted_unconfirmed: 0 },
    ready_without_row: [], ready_row_not_live: [], planned_overdue: [], materializing_stale: [], no_reason: [], orphan_rows: [], legacy_deferred_rows: [], unbacked_follow_up_at: [], projection_mismatch: [], accepted_unconfirmed: [],
  }
  const push = (k, v) => { out.counts[k] += 1; out[k].push(v) }
  for (const i of intents) {
    if (EXECUTABLE_STATES.includes(i.state)) out.counts.executable += 1
    if ([S.FAILED, S.NOT_EXECUTABLE, S.CANCELLED, S.SUPERSEDED, S.HELD].includes(i.state) && !clean(i.reason)) push('no_reason', i.id)
    if ([S.READY, S.DISPATCHED].includes(i.state)) {
      const r = rowById.get(clean(i.send_queue_id))
      if (!r) push('ready_without_row', i.id)
      else if (!LIVE_ROW.has(lower(r.queue_status)) || r.sent_at) push('ready_row_not_live', i.id)
    }
    if (i.state === S.PLANNED && toMs(i.due_at) < now - graceMs) push('planned_overdue', i.id)
    if (i.state === S.MATERIALIZING && toMs(i.lease_until) < now) push('materializing_stale', i.id)
    if (i.state === S.PROVIDER_ACCEPTED && toMs(i.updated_at) < now - graceMs) push('accepted_unconfirmed', i.id)
  }
  for (const r of rows) {
    const m = obj(r.metadata)
    const live = LIVE_ROW.has(lower(r.queue_status)) && !r.sent_at
    const isFollowUp = lower(r.type) === 'followup' || lower(r.message_type) === 'followup'
    if (!live || !isFollowUp) continue
    if (clean(m.followup_intent_id)) {
      const i = byId.get(clean(m.followup_intent_id))
      if (!i || clean(i.send_queue_id) !== clean(r.id)) push('orphan_rows', r.id)
    } else if (m.deferred_message_resolution === true && !clean(r.message_body)) {
      push('legacy_deferred_rows', r.id) // body-less legacy row: never sendable; adopt into an intent
    } else push('orphan_rows', r.id)
  }
  const executableByThread = new Map()
  for (const i of intents) {
    if (!EXECUTABLE_STATES.includes(i.state)) continue
    const k = clean(i.thread_key)
    const due = toMs(i.due_at)
    if (!executableByThread.has(k) || due < executableByThread.get(k)) executableByThread.set(k, due)
  }
  for (const t of threads) {
    const f = toMs(t.follow_up_at)
    const k = clean(t.thread_key)
    if (f == null) continue
    if (!executableByThread.has(k)) push('unbacked_follow_up_at', k)
    else if (executableByThread.get(k) !== f) push('projection_mismatch', k)
  }
  return out
}

// ── monitoring (the ops supervisor's source) ────────────────────────────────
/** The health row + the top non-success reasons (codes and counts only: no thread keys, no phones). Throws when unreadable. */
export async function loadFollowUpLifecycleHealth({ supabase = null } = {}) {
  const sb = supabase || (await import('../../supabase/default-client.js')).getDefaultSupabaseClient()
  const h = await sb.from('v_followup_intent_health').select('*').limit(1)
  if (h?.error) throw Object.assign(new Error('followup_health_unreadable'), { code: 'FOLLOWUP_LIFECYCLE_UNAVAILABLE' })
  const row = Array.isArray(h.data) ? h.data[0] : h.data
  if (!row) throw Object.assign(new Error('followup_health_empty'), { code: 'FOLLOWUP_LIFECYCLE_UNAVAILABLE' })
  const r = await sb.from('v_followup_intent_reasons').select('state,kind,reason,writer,n').order('n', { ascending: false }).limit(20)
  const reasons = (Array.isArray(r?.data) ? r.data : []).map((x) => ({ state: x.state, kind: x.kind, reason: clean(x.reason).slice(0, 80), writer: clean(x.writer).slice(0, 60), n: Number(x.n) || 0 }))
  return { ...row, reasons }
}

// ── default IO ───────────────────────────────────────────────────────────────
async function rowsOf(q) {
  const r = await q
  if (r?.error) throw r.error
  return Array.isArray(r?.data) ? r.data : []
}

/**
 * Production composition. Every dependency is injectable (tests / the hotfix composition root).
 * @param {{ supabase: object, readSwitch?: Function, holdCheck?: Function, guard?: Function, enqueue?: Function, now?: Function }} o
 */
export function createFollowUpLifecycleDeps({ supabase, readSwitch = null, holdCheck = null, guard = null, enqueue = null, render = null, now = null, worker = null } = {}) {
  return {
    supabase, readSwitch, now, worker,
    async claim({ worker: w, limit, lead_seconds, lease_seconds, intent_id = null }) {
      const data = await rpc(supabase, 'followup_intent_claim', { p_worker: w, p_limit: limit, p_lead_seconds: lead_seconds, p_lease_seconds: lease_seconds, p_intent_id: intent_id })
      return Array.isArray(data) ? data : data ? [data] : []
    },
    async transition({ id, token, to, reason, retry_at = null, refund = false, detail = {} }) {
      return obj(await rpc(supabase, 'followup_intent_transition', { p_id: id, p_token: token, p_to: to, p_reason: reason, p_retry_at: retry_at, p_refund_attempt: refund, p_detail: detail, p_actor: 'materializer' }))
    },
    async loadThread(thread_key) {
      return (await rowsOf(supabase.from('inbox_thread_state').select('thread_key,is_suppressed,last_inbound_at,our_number,property_id').eq('thread_key', thread_key).limit(1)))[0] || null
    },
    holdCheck: holdCheck || (async (scope) => {
      const { resolveAutomationHold, HOLD_CAPABILITIES } = await import('../holds/automation-hold.js')
      for (const capability of [HOLD_CAPABILITIES.FOLLOW_UP, HOLD_CAPABILITIES.OUTBOUND_SEND]) {
        const r = await resolveAutomationHold(scope, { capability, supabase })
        if (r?.held !== false) return { held: true, fail_closed: r?.fail_closed === true || !r, hold_type: r?.fail_closed ? 'lookup_error' : (r?.holds?.[0]?.hold_type || 'hold'), reason: r?.reason || null, hold_ids: r?.hold_ids || [] }
      }
      return { held: false }
    }),
    // the send-time contact guard over fresh reads, its automation-hold fact bound to THIS composition's
    // hold authority (one answer for the materializer and the guard); a read failure fails closed
    guard: guard || (async function lifecycleGuard(row) {
      const m = await import('../queue/send-time-contact-guard.js')
      const own = this && typeof this.holdCheck === 'function' ? this.holdCheck : null
      const automationHoldChecker = own ? async (a) => {
        const r = await own({ thread_key: a.threadKey, property_id: a.propertyId, master_owner_id: a.masterOwnerId })
        return { held: r?.held === true, hold_type: r?.held ? (r.fail_closed ? 'lookup_error' : r.hold_type || 'hold') : null, reason: r?.reason || null, hold_id: r?.hold_ids?.[0] || null }
      } : null
      if (typeof m.loadSendTimeContactFacts === 'function' && typeof m.evaluateSendTimeContactGuard === 'function') {
        try {
          const facts = await m.loadSendTimeContactFacts(supabase, row, { automationHoldChecker })
          return m.evaluateSendTimeContactGuard(row, facts)
        } catch (error) {
          return { blocked: true, reason: 'send_time_guard_read_failed', detail: { error: clean(error?.message).slice(0, 120) } }
        }
      }
      return m.runSendTimeContactGuard(row, { supabase })
    }),
    async propertyBlock(intent) {
      const spec = obj(intent.row_spec)
      return loadPropertyContactBlock({ supabase, thread_key: intent.thread_key, phone: spec.to_phone_number || intent.thread_key, property_id: intent.property_id || spec.property_id || null })
    },
    async alreadySent(intent) {
      const spec = obj(intent.row_spec)
      const rows = await rowsOf(supabase.from('send_queue').select('id,queue_status,sent_at,use_case_template,created_at,metadata').eq('thread_key', intent.thread_key).limit(200))
      const since = toMs(intent.created_at)
      return rows.some((r) => r.sent_at && toMs(r.sent_at) > since && clean(obj(r.metadata).followup_intent_id) !== clean(intent.id) &&
        lower(r.use_case_template) === lower(spec.use_case_template) && (lower(obj(r.metadata).followup_kind) === lower(intent.kind) || clean(obj(r.metadata).followup_intent_id)))
    },
    async languageFor(thread_key) {
      const { latestIdentifiableSellerLanguage } = await import('../classification/seller-reply-language.js')
      const inbound = await rowsOf(supabase.from('message_events').select('message_body,language,direction,created_at').eq('thread_key', thread_key).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(20))
      return latestIdentifiableSellerLanguage(inbound) || null
    },
    templateCandidates(virtual) {
      // nurture + stage rows: the same candidate lists the resolver uses; no-response rows: the resolver decides
      const m = obj(virtual.metadata)
      if (m.no_response_followup && typeof m.no_response_followup === 'object' && m.no_response_followup.kind) return null
      const intent = lower(m.intent) || (lower(virtual.use_case_template).startsWith('nurture_') ? lower(virtual.use_case_template).slice(8) : '')
      if (intent === 'stage_no_reply') { const uc = lower(m.followup_use_case || virtual.use_case_template); return uc && uc !== 'stage_no_reply' ? [uc] : [] }
      return null // resolved below by NURTURE_TEMPLATE_CANDIDATES (see templatesAvailable)
    },
    async templatesAvailable(useCases, language) {
      const t = await rowsOf(supabase.from('sms_templates').select('id,use_case,language').eq('is_active', true).eq('safe_for_auto_reply', true).in('language', [language]).in('use_case', useCases).limit(5))
      return t.length > 0
    },
    render: render || (async (virtual) => {
      const { resolveDeferredQueueMessage } = await import('../queue/resolve-deferred-queue-message.js')
      return resolveDeferredQueueMessage(virtual, { supabase })
    }),
    async senderStatus(phone) {
      const t = await rowsOf(supabase.from('textgrid_numbers').select('status,phone_number').in('phone_number', [phone]).limit(1))
      return t[0] ? (clean(t[0].status) || 'active') : null
    },
    async propertyGeography(property_id) {
      if (!clean(property_id)) return null
      const { loadPropertyGeography } = await import('../queue/recipient-timezone.js')
      return (await loadPropertyGeography(supabase, [property_id])).get(clean(property_id)) || null
    },
    resolveRecipientTimezone: null, // bound below (sync import)
    recipientZones: null,
    lawful: null,
    async otherTexts({ thread_key, to_phone, intent_id, around }) {
      const since = iso(around - 24 * 3_600_000)
      const until = iso(around + 24 * 3_600_000)
      const sent = await rowsOf(supabase.from('send_queue').select('id,sent_at,queue_status,scheduled_for,metadata').eq('to_phone_number', to_phone).gte('sent_at', since).limit(50))
      const pending = await rowsOf(supabase.from('send_queue').select('id,sent_at,queue_status,scheduled_for,metadata').eq('to_phone_number', to_phone).in('queue_status', ['queued', 'pending', 'approved', 'ready', 'scheduled', 'processing', 'sending']).lte('scheduled_for', until).limit(50))
      const seen = new Set()
      const out = []
      for (const r of [...sent, ...pending]) {
        if (seen.has(r.id) || clean(obj(r.metadata).followup_intent_id) === clean(intent_id)) continue
        seen.add(r.id)
        const t = toMs(r.sent_at) ?? toMs(r.scheduled_for)
        if (t != null) out.push(t)
      }
      void thread_key
      return out
    },
    validate: null,
    enqueue: enqueue || (async (row) => {
      const { enqueueSendQueueItem } = await import('../../supabase/sms-engine.js')
      return enqueueSendQueueItem(row, { supabase })
    }),
    // dispatch gate
    async loadIntent(id) {
      return (await rowsOf(supabase.from('followup_intents').select('*').eq('id', id).limit(1)))[0] || null
    },
    async templateApproved(template_id) {
      const t = await rowsOf(supabase.from('sms_templates').select('id,template_id,is_active,safe_for_auto_reply').eq('template_id', template_id).limit(5))
      const byId = t.length ? t : await rowsOf(supabase.from('sms_templates').select('id,template_id,is_active,safe_for_auto_reply').eq('id', template_id).limit(5)).catch(() => [])
      return byId.some((x) => x.is_active === true && x.safe_for_auto_reply === true)
    },
    async rematerialize({ id, send_queue_id, reason }) {
      return obj(await rpc(supabase, 'followup_intent_rematerialize', { p_id: id, p_send_queue_id: send_queue_id, p_reason: reason, p_actor: 'dispatch_gate' }))
    },
    closeIntents: (a) => closeFollowUpIntentsForThread(a, { supabase }),
    async sentTexts({ to_phone, since, exclude_row_id }) {
      const sent = await rowsOf(supabase.from('send_queue').select('id,sent_at').eq('to_phone_number', to_phone).gte('sent_at', since).limit(50))
      return sent.filter((r) => clean(r.id) !== clean(exclude_row_id)).map((r) => toMs(r.sent_at))
    },
  }
}

/** Bind the synchronous helpers (kept out of the factory's import graph until first use). */
export async function withLifecycleHelpers(deps) {
  const [{ resolveRecipientTimezone }, { resolveRecipientZones, evaluateReplyTiming }, { validateOutboundSmsPayload }, { NURTURE_TEMPLATE_CANDIDATES }] = await Promise.all([
    import('../queue/recipient-timezone.js'), import('../queue/reply-timing.js'), import('../messaging/MessageValidationService.js'), import('../queue/resolve-deferred-queue-message.js'),
  ])
  const baseCandidates = deps.templateCandidates
  return {
    ...deps,
    resolveRecipientTimezone: deps.resolveRecipientTimezone || resolveRecipientTimezone,
    recipientZones: deps.recipientZones || ((a) => {
      const z = resolveRecipientZones(a)
      return z.certainty === 'unknown' ? [] : z.zones
    }),
    lawful: deps.lawful || ((at, zones) => evaluateReplyTiming({ purpose: 'outreach', at, zones })),
    validate: deps.validate || validateOutboundSmsPayload,
    templateCandidates: (virtual) => {
      const own = baseCandidates ? baseCandidates(virtual) : null
      if (Array.isArray(own)) return own
      const m = obj(virtual.metadata)
      if (m.no_response_followup && typeof m.no_response_followup === 'object' && m.no_response_followup.kind) return null
      const intent = lower(m.intent) || (lower(virtual.use_case_template).startsWith('nurture_') ? lower(virtual.use_case_template).slice(8) : 'unclear')
      return [...(NURTURE_TEMPLATE_CANDIDATES[intent] || NURTURE_TEMPLATE_CANDIDATES.unclear || [])]
    },
  }
}
