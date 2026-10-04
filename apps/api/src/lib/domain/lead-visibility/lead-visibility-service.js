/**
 * LEAD VISIBILITY — one authority for "archive" across the Inbox and Pipeline.
 *
 * OWNER DECISIONS (2026-10-04):
 *   1. Archive is a shared VISIBILITY flag. It never changes stage, status,
 *      automation, nurture, suppression or read. (Pipeline Archive used to write
 *      opportunity_status='archived' — closed-lost family, automation cancelled,
 *      never reopened by a reply. That path is retired while this is enabled.)
 *   2. Archiving a deal whose conversation also carries another LIVE deal does
 *      not archive the conversation.
 *   3. A new inbound reply ALWAYS un-archives the conversation (the inbound
 *      handler already does). A linked archived deal is restored only when the
 *      reply is deterministically that deal's: exactly one archived linked deal,
 *      or the reply resolves to exactly one of them by property. Otherwise the
 *      deals stay archived and a PENDING-RESOLUTION marker is recorded ("reply
 *      on archived deals, property unclear") — never silence.
 *
 * STATE
 *   thread       inbox_thread_state.is_archived (+archive_scope/reason) — written
 *                only through patchUniversalLeadState (audit: universal_lead_state_events)
 *   opportunity  acquisition_opportunities.archived_at/by/reason/action_id (overlay;
 *                lifecycle columns, version and updated_at untouched; audit:
 *                acquisition_opportunity_history event 'visibility_changed')
 *   action       lead_visibility_actions (one row per operator/system action:
 *                idempotency by action_id, undo by undo_of, pending markers)
 *
 * SCOPE (the server decides; the UI never does)
 *   linked(T) = opportunities whose primary_thread_key (any spelling) or
 *   related_thread_keys names T.
 *   archive/unarchive thread T → T, plus linked deals: one → it; several → the
 *     one whose property is T's property; still ambiguous → `needs_scope` with
 *     the candidates and NOTHING written until the operator chooses.
 *   archive deal O → O; its thread too only when no other linked deal is live.
 *   unarchive deal O → O and its thread (a visible deal has a visible conversation).
 *
 * QUEUED SENDS (owner, 2026-10-04): on this path a queued or scheduled send
 * NEVER blocks archive and archive NEVER cancels it — follow-ups keep running.
 * The item reports an informational note instead ("Archived · 1 follow-up
 * still scheduled (Oct 30)"). The legacy status-based archive (flag off) keeps
 * its queued-sends guard, because that archive cancels automation.
 *
 * The pure planners are exported for tests; every I/O is an injected port.
 */
import { createHash, randomUUID } from 'node:crypto'

export const VISIBILITY_ACTIONS = Object.freeze(['archive', 'unarchive'])
export const VISIBILITY_SOURCES = Object.freeze(['inbox', 'pipeline', 'bulk', 'inbound_auto'])
const IDENTITY_ALIGNMENT = 'identity_alignment'
const CANONICAL_E164 = /^\+1\d{10}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_ITEMS = 100

const clean = (v) => String(v ?? '').trim()
const isArchivedOpp = (o) => Boolean(o?.archived_at)

export class LeadVisibilityError extends Error {
  constructor(code, status, message) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Every spelling a thread's phone is stored under (E.164, 1-prefixed digits, 10 digits). */
export function threadKeyVariants(threadKey) {
  const key = clean(threadKey)
  const digits = key.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (ten.length !== 10) return key ? [key] : []
  return [...new Set([key, `+1${ten}`, `1${ten}`, ten])]
}

/** A stable uuid from a string — makes system actions (one per inbound event) idempotent. */
export function deterministicActionId(seed) {
  const h = createHash('sha1').update(clean(seed)).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`
}

const candidateOf = (o) => ({
  opportunity_id: o.id,
  property_id: clean(o.primary_property_id) || null,
  address: clean(o.property_address_full) || null,
  stage: clean(o.acquisition_stage) || null,
})

/* ── pure planners ───────────────────────────────────────────────────── */

/**
 * Which linked deals follow a thread archive/unarchive.
 * @returns {{ opportunityIds: string[], needsScope: object[]|null }}
 */
export function planThreadAction({ action, thread, linked = [], scopeChoice = null }) {
  const pool = linked.filter((o) => (action === 'archive' ? !isArchivedOpp(o) : isArchivedOpp(o)))
  if (scopeChoice === 'conversation_only') return { opportunityIds: [], needsScope: null }
  if (Array.isArray(scopeChoice)) {
    const chosen = new Set(scopeChoice.map(clean))
    return { opportunityIds: pool.filter((o) => chosen.has(o.id)).map((o) => o.id), needsScope: null }
  }
  if (pool.length <= 1) return { opportunityIds: pool.map((o) => o.id), needsScope: null }
  const propertyId = clean(thread?.property_id)
  const matched = propertyId ? pool.filter((o) => clean(o.primary_property_id) === propertyId) : []
  if (matched.length === 1) return { opportunityIds: [matched[0].id], needsScope: null }
  return { opportunityIds: [], needsScope: pool.map(candidateOf) }
}

/**
 * Whether a deal archive/unarchive carries its conversation.
 * @returns {{ thread: 'archive'|'unarchive'|null, threadKept: string|null }}
 */
export function planOpportunityAction({ action, thread, siblings = [] }) {
  if (!thread) return { thread: null, threadKept: null }
  if (action === 'archive') {
    if (thread.is_archived === true) return { thread: null, threadKept: null }
    const liveSibling = siblings.find((s) => !isArchivedOpp(s))
    if (liveSibling) return { thread: null, threadKept: 'other_live_deal' }
    return { thread: 'archive', threadKept: null }
  }
  if (thread.is_archived === true && clean(thread.archive_scope).toLowerCase() !== IDENTITY_ALIGNMENT) {
    return { thread: 'unarchive', threadKept: null }
  }
  return { thread: null, threadKept: null }
}

/**
 * Owner rule 3 for archived deals linked to a thread that just got a reply.
 * @returns {{ restore: string[], pending: object[]|null }}
 */
export function planInboundReply({ archivedLinked = [], replyPropertyId = null }) {
  if (!archivedLinked.length) return { restore: [], pending: null }
  if (archivedLinked.length === 1) return { restore: [archivedLinked[0].id], pending: null }
  const pid = clean(replyPropertyId)
  const matched = pid ? archivedLinked.filter((o) => clean(o.primary_property_id) === pid) : []
  if (matched.length === 1) return { restore: [matched[0].id], pending: null }
  return { restore: [], pending: archivedLinked.map(candidateOf) }
}

/* ── request parsing ─────────────────────────────────────────────────── */

export function parseVisibilityRequest(body) {
  const bad = (msg) => new LeadVisibilityError('invalid_request', 400, msg)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object')
  const undoOf = clean(body.undo_of) || null
  if (undoOf && !UUID.test(undoOf)) throw bad('undo_of must be an action id')
  const action = clean(body.action)
  if (!undoOf && !VISIBILITY_ACTIONS.includes(action)) throw bad('action must be archive or unarchive')
  const list = (v) => (Array.isArray(v) ? [...new Set(v.map(clean).filter(Boolean))] : [])
  const threadKeys = list(body.thread_keys)
  const opportunityIds = list(body.opportunity_ids)
  if (!undoOf && !threadKeys.length && !opportunityIds.length) throw bad('thread_keys or opportunity_ids is required')
  if (threadKeys.length + opportunityIds.length > MAX_ITEMS) throw bad(`at most ${MAX_ITEMS} items per request`)
  const badKey = threadKeys.find((k) => !CANONICAL_E164.test(k))
  if (badKey) throw bad(`not a canonical thread key: ${badKey}`)
  const badId = opportunityIds.find((id) => !UUID.test(id))
  if (badId) throw bad(`not an opportunity id: ${badId}`)
  let scopeChoice = null
  if (body.scope_choice === 'conversation_only') scopeChoice = 'conversation_only'
  else if (Array.isArray(body.scope_choice)) scopeChoice = list(body.scope_choice)
  const actionId = clean(body.action_id) || null
  if (actionId && !UUID.test(actionId)) throw bad('action_id must be a uuid')
  const source = VISIBILITY_SOURCES.includes(clean(body.source)) ? clean(body.source) : 'inbox'
  return {
    action: action || null,
    threadKeys,
    opportunityIds,
    scopeChoice,
    reason: clean(body.reason).slice(0, 240) || null,
    actionId,
    undoOf,
    source,
  }
}

/* ── the service ─────────────────────────────────────────────────────── */

function summarize(results) {
  const s = { requested: results.length, changed: 0, unchanged: 0, blocked: 0, failed: 0, needs_scope: 0 }
  for (const r of results) {
    if (r.outcome === 'archived' || r.outcome === 'unarchived') s.changed += 1
    else if (r.outcome === 'unchanged') s.unchanged += 1
    else if (r.outcome === 'needs_scope') s.needs_scope += 1
    else if (r.outcome === 'blocked') s.blocked += 1
    else s.failed += 1
  }
  return s
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** "1 follow-up still scheduled (Oct 30)" — informational, never a block. */
export function scheduledSendsNote(info) {
  const count = Number(info?.count) || 0
  if (count <= 0) return null
  const when = info?.nextAt ? new Date(info.nextAt) : null
  const date = when && Number.isFinite(when.getTime())
    ? when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
    : null
  return {
    scheduled_sends: count,
    next_scheduled_at: info?.nextAt || null,
    note: `${plural(count, 'follow-up', 'follow-ups')} still scheduled${date ? ` (${date})` : ''}`,
    queue_link: '/queue',
  }
}

export function createLeadVisibilityService(ports) {
  const now = () => (ports.now ? ports.now() : new Date().toISOString())
  const scheduledNote = async (threadKey) => {
    try { return scheduledSendsNote(await ports.describeScheduledSends(threadKey)) } catch { return null }
  }

  async function writeThread(threadKey, action, ctx, cascadedFrom = null) {
    const res = await ports.patchLeadState({
      threadKey,
      patch: action === 'archive'
        ? { is_archived: true, archive_scope: 'conversation', archive_reason: ctx.reason || 'operator_archive' }
        : { is_archived: false },
      meta: {
        change_source: ctx.system ? 'system' : 'manual',
        source_view: 'lead_visibility',
        operator_id: ctx.operatorId,
        updated_by: ctx.operatorId,
        reason: ctx.reason || `lead_visibility_${action}`,
        metadata: { visibility_action_id: ctx.actionId, visibility_source: ctx.source, ...(cascadedFrom ? { cascaded_from: cascadedFrom } : {}) },
      },
    })
    if (!res?.ok || res?.blocked) return { kind: 'thread', id: threadKey, ok: false, outcome: 'failed', reason: clean(res?.reason) || 'thread_state_write_failed' }
    return { kind: 'thread', id: threadKey, ok: true, outcome: action === 'archive' ? 'archived' : 'unarchived', ...(cascadedFrom ? { cascaded_from: cascadedFrom } : {}) }
  }

  async function writeOpportunity(id, action, ctx, cascadedFrom = null) {
    const res = await ports.setOpportunityVisibility(id, {
      archived: action === 'archive',
      actor: ctx.operatorId,
      reason: ctx.reason || `lead_visibility_${action}`,
      actionId: ctx.actionId,
      source: ctx.source,
    })
    if (!res?.ok) return { kind: 'opportunity', id, ok: false, outcome: 'failed', reason: clean(res?.error) || 'opportunity_visibility_write_failed' }
    const outcome = res.changed === false ? 'unchanged' : action === 'archive' ? 'archived' : 'unarchived'
    return { kind: 'opportunity', id, ok: true, outcome, ...(cascadedFrom ? { cascaded_from: cascadedFrom } : {}) }
  }

  async function threadItem(threadKey, action, ctx, touched) {
    const thread = await ports.readThreadState(threadKey)
    if (!thread) return [{ kind: 'thread', id: threadKey, ok: false, outcome: 'failed', reason: 'not_found' }]
    const linked = await ports.listLinkedOpportunities(threadKey)
    const plan = planThreadAction({ action, thread, linked, scopeChoice: ctx.scopeChoice })
    if (plan.needsScope) {
      return [{
        kind: 'thread', id: threadKey, ok: false, outcome: 'needs_scope', reason: 'property_ambiguous',
        message: `This conversation carries ${plural(plan.needsScope.length, 'deal', 'deals')} and its property does not say which. Choose the deals, or the conversation only.`,
        candidates: plan.needsScope,
      }]
    }
    const scheduled = action === 'archive' ? await scheduledNote(threadKey) : null
    const out = []
    const threadNeedsWrite = action === 'archive' ? thread.is_archived !== true : thread.is_archived === true
    if (touched.has(`t:${threadKey}`)) {
      // already handled earlier in this action
    } else if (threadNeedsWrite) {
      touched.add(`t:${threadKey}`)
      const written = await writeThread(threadKey, action, ctx)
      out.push(scheduled && written.ok ? { ...written, ...scheduled } : written)
    } else {
      touched.add(`t:${threadKey}`)
      out.push({ kind: 'thread', id: threadKey, ok: true, outcome: 'unchanged' })
    }
    for (const id of plan.opportunityIds) {
      if (touched.has(`o:${id}`)) continue
      touched.add(`o:${id}`)
      out.push(await writeOpportunity(id, action, ctx, threadKey))
    }
    return out
  }

  async function opportunityItem(id, action, ctx, touched) {
    const opp = await ports.readOpportunity(id)
    if (!opp) return [{ kind: 'opportunity', id, ok: false, outcome: 'failed', reason: 'not_found' }]
    const threadKey = clean(opp.primary_thread_key)
    const canonicalKey = threadKeyVariants(threadKey).find((k) => CANONICAL_E164.test(k)) || null
    const thread = canonicalKey ? await ports.readThreadState(canonicalKey) : null
    const scheduled = action === 'archive' && canonicalKey ? await scheduledNote(canonicalKey) : null
    const siblings = canonicalKey ? (await ports.listLinkedOpportunities(canonicalKey)).filter((o) => o.id !== id) : []
    const out = []
    const oppNeedsWrite = action === 'archive' ? !isArchivedOpp(opp) : isArchivedOpp(opp)
    if (!touched.has(`o:${id}`)) {
      touched.add(`o:${id}`)
      const written = oppNeedsWrite ? await writeOpportunity(id, action, ctx) : { kind: 'opportunity', id, ok: true, outcome: 'unchanged' }
      out.push({ ...written, thread_key: canonicalKey, ...(scheduled && written.ok ? scheduled : {}) })
    }
    const plan = planOpportunityAction({ action, thread, siblings })
    if (plan.thread && canonicalKey && !touched.has(`t:${canonicalKey}`)) {
      touched.add(`t:${canonicalKey}`)
      out.push(await writeThread(canonicalKey, plan.thread, ctx, id))
    } else if (plan.threadKept) {
      const live = siblings.find((s) => !isArchivedOpp(s))
      if (out[0]) out[0] = { ...out[0], thread_kept: plan.threadKept, thread_key: canonicalKey, kept_for: live ? candidateOf(live) : null }
    }
    return out
  }

  async function finalize(actionId, results, extra = {}) {
    const summary = summarize(results)
    const status = summary.blocked + summary.failed + summary.needs_scope > 0
      ? (summary.changed > 0 ? 'partial' : 'refused')
      : 'applied'
    await ports.updateAction(actionId, { status, results, updated_at: now(), ...extra })
    return { summary, status }
  }

  async function resolvePendingFor(threadKeys, actionId) {
    for (const key of threadKeys) {
      try { await ports.resolvePending(key, actionId) } catch { /* the marker stays visible; never fails the action */ }
    }
  }

  return {
    /** An operator action (Inbox, Pipeline, bulk). */
    async apply(request, operatorId) {
      if (!operatorId) throw new LeadVisibilityError('operator_unknown', 401, 'The signed-in operator could not be identified.')
      const actionId = request.actionId || randomUUID()
      const existing = await ports.readAction(actionId)
      if (existing && existing.status !== 'pending') {
        return { action_id: actionId, action: existing.action, replayed: true, status: existing.status, results: existing.results || [], summary: summarize(existing.results || []) }
      }

      if (request.undoOf) return this.undo(request.undoOf, operatorId, actionId, existing)

      if (!existing) {
        await ports.insertAction({
          action_id: actionId,
          operator_id: operatorId,
          action: request.action,
          source: request.source || 'inbox',
          thread_key: request.threadKeys[0] || null,
          request: { thread_keys: request.threadKeys, opportunity_ids: request.opportunityIds, scope_choice: request.scopeChoice, reason: request.reason },
          status: 'pending',
        })
      }
      const ctx = { operatorId, reason: request.reason, actionId, source: request.source || 'inbox', scopeChoice: request.scopeChoice }
      const touched = new Set()
      const results = []
      for (const key of request.threadKeys) {
        try { results.push(...(await threadItem(key, request.action, ctx, touched))) } catch (error) {
          results.push({ kind: 'thread', id: key, ok: false, outcome: 'failed', reason: 'item_failed', message: clean(error?.message) })
        }
      }
      for (const id of request.opportunityIds) {
        try { results.push(...(await opportunityItem(id, request.action, ctx, touched))) } catch (error) {
          results.push({ kind: 'opportunity', id, ok: false, outcome: 'failed', reason: 'item_failed', message: clean(error?.message) })
        }
      }
      const { summary, status } = await finalize(actionId, results)
      // An operator decision on a deal answers any "property unclear" marker on its thread.
      const decidedThreads = new Set()
      for (const r of results) {
        if (r.kind === 'opportunity' && (r.outcome === 'archived' || r.outcome === 'unarchived')) {
          const key = r.cascaded_from && CANONICAL_E164.test(r.cascaded_from) ? r.cascaded_from : r.thread_key
          if (key) decidedThreads.add(key)
        }
        if (r.kind === 'thread' && r.cascaded_from) decidedThreads.add(r.id)
      }
      for (const key of request.threadKeys) if (request.scopeChoice) decidedThreads.add(key)
      if (decidedThreads.size) await resolvePendingFor([...decidedThreads], actionId)
      const needsScope = results.filter((r) => r.outcome === 'needs_scope')
      return { action_id: actionId, action: request.action, status, summary, results, ...(needsScope.length ? { needs_scope: needsScope } : {}), undo: summary.changed > 0 ? { undo_of: actionId } : null }
    },

    /** Reverse exactly the items an action changed — no re-planning, no guessing. */
    async undo(undoOf, operatorId, actionId = randomUUID(), existing = null) {
      const original = await ports.readAction(undoOf)
      if (!original) throw new LeadVisibilityError('action_not_found', 404, 'Nothing to undo: that action is not recorded.')
      const inverse = original.action === 'archive' ? 'unarchive' : 'archive'
      if (!existing) {
        await ports.insertAction({
          action_id: actionId, operator_id: operatorId, action: inverse, source: original.source || 'inbox',
          undo_of: undoOf, thread_key: original.thread_key || null, request: { undo_of: undoOf }, status: 'pending',
        })
      }
      const ctx = { operatorId, reason: `undo:${undoOf}`, actionId, source: original.source || 'inbox' }
      const results = []
      for (const item of original.results || []) {
        if (!(item.outcome === 'archived' || item.outcome === 'unarchived')) continue
        try {
          results.push(item.kind === 'thread' ? await writeThread(item.id, inverse, ctx) : await writeOpportunity(item.id, inverse, ctx))
        } catch (error) {
          results.push({ kind: item.kind, id: item.id, ok: false, outcome: 'failed', reason: 'item_failed', message: clean(error?.message) })
        }
      }
      const { summary, status } = await finalize(actionId, results)
      return { action_id: actionId, action: inverse, undo_of: undoOf, status, summary, results, undo: null }
    },

    /**
     * Owner rule 3, called by the inbound handler AFTER it un-archived the
     * conversation. Idempotent per inbound event (deterministic action id).
     */
    async recordInboundReply({ threadKey, inboundEventId = null }) {
      const key = clean(threadKey)
      if (!CANONICAL_E164.test(key)) return { ok: false, reason: 'invalid_thread_key' }
      const archivedLinked = (await ports.listLinkedOpportunities(key)).filter(isArchivedOpp)
      if (!archivedLinked.length) return { ok: true, restored: [], pending: null }
      const replyPropertyId = archivedLinked.length > 1 ? await ports.resolveReplyProperty(key) : null
      const plan = planInboundReply({ archivedLinked, replyPropertyId })
      const actionId = deterministicActionId(`inbound:${key}:${clean(inboundEventId) || now()}`)
      const existing = await ports.readAction(actionId)
      if (existing && existing.status !== 'pending') return { ok: true, replayed: true, action_id: actionId, status: existing.status }
      if (!existing) {
        await ports.insertAction({
          action_id: actionId, operator_id: 'seller_inbound', action: 'unarchive', source: 'inbound_auto',
          thread_key: key, request: { inbound_event_id: clean(inboundEventId) || null, reply_property_id: replyPropertyId || null },
          resolved: plan.pending || [], status: 'pending',
        })
      }
      const ctx = { operatorId: 'seller_inbound', reason: 'inbound_reply', actionId, source: 'inbound_auto', system: true }
      const results = []
      for (const id of plan.restore) {
        try { results.push(await writeOpportunity(id, 'unarchive', ctx, key)) } catch (error) {
          results.push({ kind: 'opportunity', id, ok: false, outcome: 'failed', reason: 'item_failed', message: clean(error?.message) })
        }
      }
      if (plan.pending) {
        await ports.updateAction(actionId, { status: 'pending_resolution', results, updated_at: now() })
        return { ok: true, action_id: actionId, restored: [], pending: plan.pending }
      }
      await finalize(actionId, results)
      return { ok: true, action_id: actionId, restored: plan.restore, pending: null }
    },

    /** Open "reply on archived deals, property unclear" markers for these threads. */
    async listPending(threadKeys) {
      const keys = [...new Set((threadKeys || []).map(clean).filter((k) => CANONICAL_E164.test(k)))].slice(0, 200)
      if (!keys.length) return []
      const rows = await ports.listPendingResolutions(keys)
      return (rows || []).map((r) => ({ thread_key: r.thread_key, action_id: r.action_id, candidates: Array.isArray(r.resolved) ? r.resolved : [], since: r.created_at || null }))
    },
  }
}

/* ── production ports ────────────────────────────────────────────────── */

const ACTIVE_SEND_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']

/**
 * Only called after the gate (lead-visibility-gate.js) confirmed the schema —
 * these ports are the ONLY code that names the overlay columns.
 */
export async function createDefaultLeadVisibilityPorts() {
  const [{ supabase }, { patchUniversalLeadState }] = await Promise.all([
    import('@/lib/supabase/client.js'),
    import('@/lib/domain/lead-state/patch-universal-lead-state.js'),
  ])
  const OPP_COLUMNS = 'id,primary_thread_key,primary_property_id,opportunity_status,acquisition_stage,property_address_full,archived_at'
  const countRows = async (build) => {
    const { count, error } = await build(supabase.from('send_queue').select('id', { count: 'exact', head: true }).in('queue_status', ACTIVE_SEND_STATUSES))
    if (error) throw error
    return count ?? 0
  }
  return {
    async readThreadState(threadKey) {
      const { data, error } = await supabase.from('inbox_thread_state').select('thread_key,is_archived,archive_scope,property_id').eq('thread_key', threadKey).maybeSingle()
      if (error) throw error
      return data
    },
    async listLinkedOpportunities(threadKey) {
      const variants = threadKeyVariants(threadKey)
      if (!variants.length) return []
      const { data, error } = await supabase.from('acquisition_opportunities').select(OPP_COLUMNS).in('primary_thread_key', variants).limit(50)
      if (error) throw error
      const rows = [...(data || [])]
      try {
        const related = await supabase.from('acquisition_opportunities').select(OPP_COLUMNS).contains('related_thread_keys', [threadKey]).limit(50)
        for (const r of related.data || []) if (!rows.some((x) => x.id === r.id)) rows.push(r)
      } catch { /* related_thread_keys is a secondary link; the primary link already answered */ }
      return rows
    },
    async readOpportunity(id) {
      const { data, error } = await supabase.from('acquisition_opportunities').select(OPP_COLUMNS).eq('id', id).maybeSingle()
      if (error) throw error
      return data
    },
    // what is still going to go out — reported beside the archive, never cancelled by it
    async describeScheduledSends(threadKey) {
      const variants = threadKeyVariants(threadKey)
      if (!variants.length) return { count: 0, nextAt: null }
      const [byThread, byPhone, next] = await Promise.all([
        countRows((q) => q.in('thread_key', variants)),
        countRows((q) => q.in('to_phone_number', variants)),
        supabase.from('send_queue').select('scheduled_for_utc,scheduled_for')
          .in('to_phone_number', variants).in('queue_status', ACTIVE_SEND_STATUSES)
          .order('scheduled_for', { ascending: true, nullsFirst: false }).limit(1),
      ])
      const row = next?.data?.[0] || null
      return { count: Math.max(byThread, byPhone), nextAt: row ? (row.scheduled_for_utc || row.scheduled_for || null) : null }
    },
    patchLeadState: (args) => patchUniversalLeadState({ ...args, supabase }),
    async setOpportunityVisibility(id, { archived, actor, reason, actionId, source }) {
      const at = new Date().toISOString()
      let q = supabase.from('acquisition_opportunities').update(archived
        ? { archived_at: at, archived_by: actor || null, archive_reason: reason || null, archive_action_id: actionId }
        : { archived_at: null, archived_by: null, archive_reason: null, archive_action_id: null }).eq('id', id)
      q = archived ? q.is('archived_at', null) : q.not('archived_at', 'is', null)
      const { data, error } = await q.select('id')
      if (error) return { ok: false, error: error.message }
      if (!data?.length) return { ok: true, changed: false }
      const ins = await supabase.from('acquisition_opportunity_history').insert({
        opportunity_id: id,
        event_type: 'visibility_changed',
        field_name: 'archived_at',
        previous_value: archived ? null : 'archived',
        new_value: archived ? 'archived' : null,
        reason: reason || null,
        actor: actor || null,
        source: `lead_visibility:${source || 'inbox'}`,
        idempotency_key: `vis:${actionId}:${id}:${archived ? 'archive' : 'unarchive'}`,
        metadata: { visibility_action_id: actionId },
      })
      if (ins.error && ins.error.code !== '23505') console.warn('lead_visibility.history_failed', ins.error.message)
      return { ok: true, changed: true }
    },
    async resolveReplyProperty(threadKey) {
      // The property the seller is answering = the property of the last message we sent them.
      const variants = threadKeyVariants(threadKey)
      const { data, error } = await supabase.from('send_queue')
        .select('property_id,sent_at')
        .in('to_phone_number', variants)
        .in('queue_status', ['sent', 'delivered'])
        .not('property_id', 'is', null)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(1)
      if (error) return null
      return clean(data?.[0]?.property_id) || null
    },
    async readAction(actionId) {
      const { data, error } = await supabase.from('lead_visibility_actions').select('*').eq('action_id', actionId).maybeSingle()
      if (error) throw error
      return data
    },
    async insertAction(row) {
      const { error } = await supabase.from('lead_visibility_actions').insert(row)
      if (error && error.code !== '23505') throw error
    },
    async updateAction(actionId, patch) {
      const { error } = await supabase.from('lead_visibility_actions').update(patch).eq('action_id', actionId)
      if (error) throw error
    },
    async listPendingResolutions(threadKeys) {
      const { data, error } = await supabase.from('lead_visibility_actions')
        .select('action_id,thread_key,resolved,created_at')
        .in('thread_key', threadKeys).eq('status', 'pending_resolution')
        .order('created_at', { ascending: false }).limit(200)
      if (error) throw error
      return data || []
    },
    async resolvePending(threadKey, byActionId) {
      const { error } = await supabase.from('lead_visibility_actions')
        .update({ status: 'resolved', results: [{ resolved_by: byActionId }], updated_at: new Date().toISOString() })
        .eq('thread_key', threadKey).eq('status', 'pending_resolution')
      if (error) throw error
    },
  }
}
