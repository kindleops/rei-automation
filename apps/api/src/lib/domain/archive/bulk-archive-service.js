/**
 * BULK ARCHIVE — one reversible "clear it out" across Inbox threads, Pipeline
 * opportunities and Campaigns, built on each object's EXISTING canonical
 * archive state. Nothing here invents state and nothing hard-deletes.
 *
 *   object          archive state (canonical)                       writer reused                     audit row
 *   inbox_thread    inbox_thread_state.is_archived / archived_at     patchUniversalLeadState            universal_lead_state_events (operator_id)
 *   opportunity     acquisition_opportunities.opportunity_status     updateOpportunity                  acquisition_opportunity_history (actor)
 *                   = 'archived' (closed-lost family)
 *   campaign        campaigns.status = 'archived' (state machine)    applyCampaignLifecycleAction       campaign_events (metadata.actor)
 *
 * Unarchive is the exact inverse:
 *   thread       → is_archived=false (archive_scope/reason cleared by the writer)
 *   opportunity  → the status it held before it was archived, read from its own
 *                  history row; when no history names it, the item is refused
 *                  (prior_status_unknown) rather than guessed
 *   campaign     → the lifecycle's own `restore` (archived → draft)
 *
 * SEND STATE. Archiving never touches send state. An item that still has a
 * send that can transmit (send_queue in an active status) is BLOCKED with the
 * count, never archived around it:
 *   thread       → queued sends to that phone
 *   opportunity  → queued sends to its primary thread
 *   campaign     → a live campaign (active/activating/live_limited) or any
 *                  pending queue row. The single-campaign Archive in Campaign
 *                  Command (which cancels pending rows through its own guard)
 *                  stays the path for those.
 * "Won" opportunities are refused: won is closing authority (finalize_closing_case).
 *
 * Idempotent per item (already archived → `unchanged`), batched with bounded
 * concurrency, one result per id. Every port is injected so the whole service
 * runs in tests without a network or a database.
 */

export const BULK_OBJECT_TYPES = Object.freeze(['inbox_thread', 'opportunity', 'campaign'])
export const BULK_ACTIONS = Object.freeze(['archive', 'unarchive'])
export const BULK_MAX_IDS = 100
const CONCURRENCY = 4

/** send_queue statuses that can still transmit (mirror of campaign-live-execution). */
export const ACTIVE_SEND_STATUSES = Object.freeze(['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending'])
const LIVE_CAMPAIGN_STATUSES = new Set(['active', 'activating', 'live_limited'])
const RESTORABLE_OPPORTUNITY_STATUSES = new Set(['active', 'waiting', 'paused', 'nurture', 'dead', 'suppressed', 'lost'])

const CANONICAL_E164 = /^\+1\d{10}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class BulkArchiveError extends Error {
  constructor(code, status, message) {
    super(message)
    this.code = code
    this.status = status
  }
}

const clean = (v) => String(v ?? '').trim()

/** Every spelling a thread's phone is stored under (E.164, 1-prefixed digits, 10 digits). */
export function threadKeyVariants(threadKey) {
  const key = clean(threadKey)
  const digits = key.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (ten.length !== 10) return key ? [key] : []
  return [...new Set([key, `+1${ten}`, `1${ten}`, ten])]
}

/** Validate the request body. Throws BulkArchiveError(400) with the reason. */
export function parseBulkRequest(body) {
  const bad = (msg) => new BulkArchiveError('invalid_request', 400, msg)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object')
  const objectType = clean(body.object_type)
  if (!BULK_OBJECT_TYPES.includes(objectType)) throw bad(`object_type must be one of ${BULK_OBJECT_TYPES.join(', ')}`)
  const action = clean(body.action)
  if (!BULK_ACTIONS.includes(action)) throw bad('action must be archive or unarchive')
  if (!Array.isArray(body.ids) || body.ids.length === 0) throw bad('ids must be a non-empty array')
  const ids = [...new Set(body.ids.map(clean).filter(Boolean))]
  if (!ids.length) throw bad('ids must be a non-empty array')
  if (ids.length > BULK_MAX_IDS) throw bad(`at most ${BULK_MAX_IDS} ids per request`)
  const reason = clean(body.reason).slice(0, 240) || null
  return { objectType, action, ids, reason }
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

const done = (id, outcome, extra = {}) => ({ id, ok: true, outcome, ...extra })
const blocked = (id, reason, message, extra = {}) => ({ id, ok: false, outcome: 'blocked', reason, message, ...extra })
const failed = (id, reason, message) => ({ id, ok: false, outcome: 'failed', reason, message })
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/* ── per-object handlers ─────────────────────────────────────────────── */

async function threadItem(ports, id, action, ctx) {
  if (!CANONICAL_E164.test(id)) return failed(id, 'invalid_thread_key', 'Not a canonical thread key (+1XXXXXXXXXX).')
  const state = await ports.readThreadState(id)
  const archived = state?.is_archived === true
  if (action === 'archive') {
    if (archived) return done(id, 'unchanged', { state: 'archived' })
    const queued = await ports.countActiveSendsForThread(id)
    if (queued > 0) {
      return blocked(id, 'queued_sends', `${plural(queued, 'send is', 'sends are')} still queued to this seller. Cancel them in Queue first.`, { queued_sends: queued })
    }
  } else if (!archived) {
    return done(id, 'unchanged', { state: 'active' })
  }
  const result = await ports.patchLeadState({
    threadKey: id,
    patch: action === 'archive'
      ? { is_archived: true, archive_reason: ctx.reason || 'bulk_archive' }
      : { is_archived: false },
    meta: {
      change_source: 'manual',
      source_view: 'bulk_archive',
      operator_id: ctx.operatorId,
      updated_by: ctx.operatorId,
      reason: ctx.reason || `bulk_${action}`,
    },
  })
  if (!result?.ok || result?.blocked) return failed(id, clean(result?.reason) || 'thread_state_write_failed', 'The thread state was not written.')
  return done(id, action === 'archive' ? 'archived' : 'unarchived', { state: action === 'archive' ? 'archived' : 'active' })
}

async function opportunityItem(ports, id, action, ctx) {
  if (!UUID.test(id)) return failed(id, 'invalid_opportunity_id', 'Not an opportunity id.')
  const row = await ports.readOpportunity(id)
  if (!row) return failed(id, 'not_found', 'Opportunity not found.')
  const status = clean(row.opportunity_status).toLowerCase()
  if (action === 'archive') {
    if (status === 'archived') return done(id, 'unchanged', { state: 'archived' })
    if (status === 'won') return blocked(id, 'won_is_closing_authority', 'A won deal is set by the closing; it is not archived from a list.')
    const threadKey = clean(row.primary_thread_key)
    const queued = threadKey ? await ports.countActiveSendsForThread(threadKey) : 0
    if (queued > 0) {
      return blocked(id, 'queued_sends', `${plural(queued, 'send is', 'sends are')} still queued to this seller. Cancel them in Queue first.`, { queued_sends: queued })
    }
    const result = await ports.updateOpportunity(id, {
      opportunity_status: 'archived',
      reason: ctx.reason || 'bulk_archive',
      actor: ctx.operatorId,
      source: 'operator_bulk_archive',
    })
    if (!result?.ok) return failed(id, clean(result?.error) || 'opportunity_write_failed', 'The opportunity was not archived.')
    return done(id, 'archived', { state: 'archived', previous_status: status || null })
  }
  if (status !== 'archived') return done(id, 'unchanged', { state: status || null })
  const prior = clean(await ports.findStatusBeforeArchive(id)).toLowerCase()
  if (!RESTORABLE_OPPORTUNITY_STATUSES.has(prior)) {
    return blocked(id, 'prior_status_unknown', 'No history records what this deal was before it was archived, so it is not guessed. Restore it from the deal.')
  }
  const result = await ports.updateOpportunity(id, {
    opportunity_status: prior,
    reason: ctx.reason || 'bulk_unarchive',
    actor: ctx.operatorId,
    source: 'operator_bulk_archive',
  })
  if (!result?.ok) return failed(id, clean(result?.error) || 'opportunity_write_failed', 'The opportunity was not restored.')
  return done(id, 'unarchived', { state: prior })
}

async function campaignItem(ports, id, action, ctx) {
  if (!UUID.test(id)) return failed(id, 'invalid_campaign_id', 'Not a campaign id.')
  const row = await ports.readCampaign(id)
  if (!row) return failed(id, 'not_found', 'Campaign not found.')
  const status = clean(row.status).toLowerCase()
  if (action === 'archive') {
    if (status === 'archived') return done(id, 'unchanged', { state: 'archived' })
    if (LIVE_CAMPAIGN_STATUSES.has(status)) {
      return blocked(id, 'campaign_live', 'This campaign is live. Pause it first, or archive it from Campaign Command.')
    }
    const queued = await ports.countActiveSendsForCampaign(id)
    if (queued > 0) {
      return blocked(id, 'queued_sends', `${plural(queued, 'send is', 'sends are')} still pending. Archive it from Campaign Command, which cancels them.`, { queued_sends: queued })
    }
  } else if (status !== 'archived') {
    return done(id, 'unchanged', { state: status || null })
  }
  const result = await ports.campaignLifecycle(id, {
    action: action === 'archive' ? 'archive' : 'restore',
    reason: `bulk_${action}:operator:${ctx.operatorId}${ctx.reason ? `:${ctx.reason}` : ''}`,
  })
  if (!result?.ok) {
    return failed(id, clean(result?.error) || 'campaign_transition_failed', clean(result?.message) || 'The campaign state machine refused the transition.')
  }
  // The lifecycle records no actor; the operator lands on the campaign's own event log.
  try {
    await ports.recordCampaignEvent({
      campaign_id: id,
      event_type: action === 'archive' ? 'campaign.archived' : 'campaign.unarchived',
      severity: 'info',
      title: action === 'archive' ? 'Campaign archived' : 'Campaign restored to draft',
      description: action === 'archive' ? 'Archived from a bulk selection.' : 'Restored from a bulk selection.',
      metadata: { actor: ctx.operatorId, source: 'bulk_archive', from: status, to: action === 'archive' ? 'archived' : 'draft', reason: ctx.reason },
    })
  } catch (error) {
    console.warn('bulk_archive.campaign_event_failed', error?.message || error)
  }
  return done(id, action === 'archive' ? 'archived' : 'unarchived', { state: action === 'archive' ? 'archived' : 'draft' })
}

const HANDLERS = { inbox_thread: threadItem, opportunity: opportunityItem, campaign: campaignItem }

export function summarize(results) {
  const s = { requested: results.length, changed: 0, unchanged: 0, blocked: 0, failed: 0 }
  for (const r of results) {
    if (r.outcome === 'archived' || r.outcome === 'unarchived') s.changed += 1
    else if (r.outcome === 'unchanged') s.unchanged += 1
    else if (r.outcome === 'blocked') s.blocked += 1
    else s.failed += 1
  }
  return s
}

export function createBulkArchiveService(ports) {
  return {
    async run({ objectType, action, ids, reason }, operatorId) {
      if (!operatorId) throw new BulkArchiveError('operator_unknown', 401, 'The signed-in operator could not be identified.')
      const handler = HANDLERS[objectType]
      const ctx = { operatorId, reason }
      const results = await mapBounded(ids, CONCURRENCY, async (id) => {
        try {
          return await handler(ports, id, action, ctx)
        } catch (error) {
          return failed(id, 'item_failed', clean(error?.message) || 'Unexpected error.')
        }
      })
      const summary = summarize(results)
      return { object_type: objectType, action, operator_id: operatorId, summary, partial: summary.blocked + summary.failed > 0, results }
    },
  }
}

/* ── production ports (supabase + the canonical writers) ─────────────── */

export async function createDefaultBulkArchivePorts() {
  const [{ supabase }, { patchUniversalLeadState }, { updateOpportunity }, campaigns] = await Promise.all([
    import('@/lib/supabase/client.js'),
    import('@/lib/domain/lead-state/patch-universal-lead-state.js'),
    import('@/lib/domain/opportunity/opportunity-service.js'),
    import('@/lib/domain/campaigns/campaign-automation-service.js'),
  ])
  const countRows = async (build) => {
    const { count, error } = await build(supabase.from('send_queue').select('id', { count: 'exact', head: true }).in('queue_status', ACTIVE_SEND_STATUSES))
    if (error) throw error
    return count ?? 0
  }
  return {
    async readThreadState(threadKey) {
      const { data, error } = await supabase.from('inbox_thread_state').select('thread_key,is_archived').eq('thread_key', threadKey).maybeSingle()
      if (error) throw error
      return data
    },
    async countActiveSendsForThread(threadKey) {
      const variants = threadKeyVariants(threadKey)
      if (!variants.length) return 0
      const [byThread, byPhone] = await Promise.all([
        countRows((q) => q.in('thread_key', variants)),
        countRows((q) => q.in('to_phone_number', variants)),
      ])
      return Math.max(byThread, byPhone)
    },
    patchLeadState: (args) => patchUniversalLeadState({ ...args, supabase }),
    async readOpportunity(id) {
      const { data, error } = await supabase.from('acquisition_opportunities').select('id,opportunity_status,primary_thread_key').eq('id', id).maybeSingle()
      if (error) throw error
      return data
    },
    async findStatusBeforeArchive(id) {
      const { data, error } = await supabase
        .from('acquisition_opportunity_history')
        .select('previous_value,created_at')
        .eq('opportunity_id', id)
        .eq('field_name', 'opportunity_status')
        .eq('new_value', 'archived')
        .order('created_at', { ascending: false })
        .limit(1)
      if (error) throw error
      return data?.[0]?.previous_value ?? null
    },
    // Archive is clearing, not a business transition: no seller-facing workflow fan-out.
    updateOpportunity: (id, patch) => updateOpportunity(id, patch, { supabase, emitWorkflowEvents: false }),
    async readCampaign(id) {
      const { data, error } = await supabase.from('campaigns').select('id,status').eq('id', id).maybeSingle()
      if (error) throw error
      return data
    },
    countActiveSendsForCampaign: (id) => countRows((q) => q.eq('campaign_id', id)),
    campaignLifecycle: (id, input) => campaigns.applyCampaignLifecycleAction(id, input),
    recordCampaignEvent: (fields) => campaigns.recordCampaignEvent(fields),
  }
}
