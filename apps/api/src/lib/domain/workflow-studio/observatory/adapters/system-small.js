/**
 * Adapters for the smaller system runtimes. Each run is ONE row of the
 * runtime's own ledger — one repair, one notification, one bridged event, one
 * decision snapshot, one buyer-match run — never a merge of unrelated actions.
 */
import { BUYER_MATCHING, DECISION_ENGINE, DELIVERY_RECONCILE, EVENT_BRIDGE, LEAD_STATE_RECONCILE, OPERATOR_NOTIFICATIONS } from '../topologies/system-small.js'
import { human } from '../core.js'
import { clean, lower, nodeEvents, runRow, safe, sellerNames, subject, timestampSummary } from './shared.js'
import { DAY, iso } from '../core.js'

export { dncAdapter, negotiationAdapter } from './seller-subworkflows.js'

const inbox = (tk) => (tk ? `/inbox?thread=${encodeURIComponent(tk)}` : null)

/* ── lead-state reconciliation ───────────────────────────────────────────── */

function repairRun(r, nm) {
  const KEY = 'lead_state_reconcile'
  const { push, events } = nodeEvents(KEY, r.id, 'seller-flow/reconcile-state')
  const surfaced = lower(r.new_value) === 'human_review'
  push('reconcile_tick', 'succeeded', r.created_at)
  push('find_stale', 'succeeded', r.created_at, { label: r.previous_value ? `was “${human(r.previous_value)}”` : 'next action missing' })
  push('canonical_next_action', 'succeeded', r.created_at, { label: surfaced ? 'no canonical evidence' : 'found on the opportunity' })
  if (surfaced) push('surface_to_human', 'human', r.created_at, { reason: 'no canonical next action' })
  else push('restore_next_action', 'succeeded', r.created_at, { label: human(r.new_value) })
  push('lead_state_written', 'succeeded', r.created_at)
  return {
    run: runRow({ run_id: r.id, workflow_key: KEY, version: 'seller-state-reconcile-v1', started_at: r.created_at, finished_at: r.created_at, subject: subject('seller', r.thread_key, nm?.name(r.thread_key), nm?.address(r.thread_key, r.property_id), inbox(r.thread_key)), trigger: 'Reconcile tick', status: 'completed', final_node: 'lead_state_written', human: surfaced, result: surfaced ? 'Surfaced to a person (human_review)' : `Next action restored · ${human(r.new_value)}`, reason: r.reason || null }),
    events,
  }
}

export const leadStateAdapter = {
  key: 'lead_state_reconcile',
  topology: LEAD_STATE_RECONCILE,
  source_runtime: 'seller-flow/reconcile-state',
  async load(db, { since, limit = 500, degraded = [] }) {
    const rows = await safe(db.from('universal_lead_state_events').select('id, thread_key, property_id, field_name, previous_value, new_value, reason, change_source, source_view, created_at').eq('source_view', 'seller_execution_gap_recovery').gte('created_at', since).order('created_at', { ascending: false }).limit(limit), degraded, 'universal_lead_state_events')
    const nm = rows.length ? await sellerNames(db, rows.map((r) => r.thread_key), rows.map((r) => r.property_id), degraded) : null
    return rows.map((r) => repairRun(r, nm))
  },
  async detail(db, id, { degraded = [] } = {}) {
    const { data: r } = await db.from('universal_lead_state_events').select('*').eq('id', clean(id)).maybeSingle()
    if (!r) return null
    const nm = await sellerNames(db, [r.thread_key], [r.property_id], degraded)
    return { ...repairRun(r, nm), facts: [{ k: 'Field', v: human(r.field_name), source: 'universal_lead_state_events' }, { k: 'Before', v: r.previous_value ? human(r.previous_value) : '— (missing)', source: 'inbox_thread_state' }, { k: 'After', v: human(r.new_value), source: 'patchUniversalLeadState' }], decisions: [{ k: 'Canonical evidence', v: lower(r.new_value) === 'human_review' ? 'none — surfaced to a person' : 'acquisition_opportunities.next_action', source: 'reconcile-state sweep' }], ai: [], inputs: [], outputs: [], links: r.thread_key ? [{ label: 'Open conversation', href: inbox(r.thread_key), app: 'Inbox' }] : [], technical: { event_id: r.id, change_source: r.change_source, source_view: r.source_view } }
  },
  summary: (db, o) => timestampSummary(() => db.from('universal_lead_state_events').select('created_at').eq('source_view', 'seller_execution_gap_recovery').gte('created_at', iso(o.now - 7 * DAY)).order('created_at', { ascending: false }), { ...o, source: 'universal_lead_state_events' }),
  async current() { return { in_flight: 0, needs_you: [], live: [] } },
}

/* ── operator notifications ──────────────────────────────────────────────── */

function notificationRun(r) {
  const KEY = 'operator_notifications'
  const { push, events } = nodeEvents(KEY, r.id, 'notification-emitter.js')
  push('business_event', 'succeeded', r.created_at, { label: human(r.event_type) })
  push('known_type', 'succeeded', r.created_at)
  push('dedupe', 'succeeded', r.created_at, { label: Number(r.group_count) > 1 ? `grouped ×${r.group_count}` : 'new' })
  push('persist', 'succeeded', r.created_at)
  push('deliver_by_severity', 'succeeded', r.created_at, { label: `${r.severity}${r.sound_category ? ` · ${human(r.sound_category)}` : ''}` })
  const acted = r.read_at || r.dismissed_at || r.resolved_at
  if (acted) push('operator_acts', 'succeeded', acted, { label: r.resolved_at ? 'resolved' : r.dismissed_at ? 'dismissed' : 'read' })
  push('notification_closed', 'succeeded', acted || r.created_at)
  return {
    run: runRow({ run_id: r.id, workflow_key: KEY, version: 'notifications-v1', started_at: r.created_at, finished_at: acted || null, subject: subject('notification', r.source_entity_id, r.title, r.description, r.source_entity_type === 'seller_thread' ? inbox(r.source_entity_id) : null), trigger: human(r.event_type), status: 'completed', final_node: 'notification_closed', result: `${human(r.severity)} · ${human(r.status)}`, reason: null }),
    events,
  }
}

export const notificationsAdapter = {
  key: 'operator_notifications',
  activity: false, // a notification restates its source event — the source run is the activity
  topology: OPERATOR_NOTIFICATIONS,
  source_runtime: 'notification-emitter.js',
  live: false,
  async load(db, { since, limit = 400, degraded = [] }) {
    const rows = await safe(db.from('notification_events').select('id, event_type, domain, severity, title, description, source_entity_type, source_entity_id, sound_category, group_count, status, read_at, dismissed_at, resolved_at, created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(limit), degraded, 'notification_events')
    return rows.map(notificationRun)
  },
  async detail(db, id) {
    const { data: r } = await db.from('notification_events').select('*').eq('id', clean(id)).maybeSingle()
    if (!r) return null
    return { ...notificationRun(r), facts: [{ k: 'Type', v: human(r.event_type), source: 'notification_events.event_type' }, { k: 'Severity', v: human(r.severity), source: 'catalog' }, { k: 'Domain', v: human(r.domain), source: 'catalog' }], decisions: [{ k: 'Deduplication key', v: r.deduplication_key || '—', source: 'emitter' }], ai: [], inputs: [{ k: 'Title', v: r.title || '—' }], outputs: [{ k: 'Status', v: human(r.status) }], links: [], technical: { id: r.id, grouping_key: r.grouping_key, group_count: r.group_count } }
  },
  summary: (db, o) => timestampSummary(() => db.from('notification_events').select('created_at').gte('created_at', iso(o.now - 7 * DAY)).order('created_at', { ascending: false }), { ...o, source: 'notification_events' }),
  async current() { return { in_flight: 0, needs_you: [], live: [] } },
}

/* ── canonical event bridge ──────────────────────────────────────────────── */

function bridgedRun(r, cursorAt) {
  const KEY = 'event_bridge'
  const { push, events } = nodeEvents(KEY, r.id, 'workflows/runtime-tick')
  push('bridge_tick', 'succeeded', r.created_at)
  push('read_window', 'succeeded', r.created_at)
  push('map_event', 'succeeded', r.created_at, { label: human(r.event_type) })
  push('write_inbox', 'succeeded', r.created_at)
  if (cursorAt && r.created_at <= cursorAt) push('orchestrator_consumes', 'succeeded', r.created_at, { label: 'past the orchestrator cursor' })
  push('v2_matcher', 'succeeded', r.created_at, { label: 'no active definition' })
  push('nothing_enrolled', 'succeeded', r.created_at)
  return {
    run: runRow({ run_id: r.id, workflow_key: KEY, version: 'event-bridge-v1', started_at: r.created_at, finished_at: r.created_at, subject: subject(r.subject_type || 'event', r.subject_id, human(r.event_type), null, null), trigger: human(r.event_type), status: 'completed', final_node: 'nothing_enrolled', result: `${human(r.event_type)} bridged`, reason: null }),
    events,
  }
}

export const bridgeAdapter = {
  key: 'event_bridge',
  activity: false, // a bridged event duplicates the run that emitted it
  topology: EVENT_BRIDGE,
  source_runtime: 'workflows/runtime-tick',
  async load(db, { since, limit = 500, degraded = [] }) {
    const [rows, ctl] = await Promise.all([
      safe(db.from('workflow_events').select('id, event_type, subject_type, subject_id, created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(limit), degraded, 'workflow_events'),
      safe(db.from('system_control').select('key, value').eq('key', 'workflow_orchestrator_cursor'), degraded, 'system_control'),
    ])
    let cursorAt = null
    try { cursorAt = JSON.parse(ctl[0]?.value || 'null')?.at || null } catch { cursorAt = null }
    return rows.map((r) => bridgedRun(r, cursorAt))
  },
  async detail(db, id) {
    const { data: r } = await db.from('workflow_events').select('*').eq('id', clean(id)).maybeSingle()
    if (!r) return null
    return { ...bridgedRun(r, null), facts: [{ k: 'Event', v: human(r.event_type), source: 'workflow_events.event_type' }, { k: 'Dedupe key', v: r.dedupe_key || '—', source: 'canonical-event-bridge' }], decisions: [], ai: [], inputs: [], outputs: [], links: [], technical: { id: r.id, subject_type: r.subject_type, subject_id: r.subject_id } }
  },
  summary: (db, o) => timestampSummary(() => db.from('workflow_events').select('created_at').gte('created_at', iso(o.now - 7 * DAY)).order('created_at', { ascending: false }), { ...o, source: 'workflow_events' }),
  async current() { return { in_flight: 0, needs_you: [], live: [] } },
}

/* ── delivery reconciliation (no per-run ledger: heartbeat + last-tick counters only) ── */

export const deliveryReconcileAdapter = {
  key: 'delivery_reconcile',
  topology: DELIVERY_RECONCILE,
  source_runtime: 'webhooks/recover-delivery + queue/reconcile',
  activity: false,
  live: false,
  notes: ['This runtime keeps no per-run ledger. Its heartbeat and last-tick counters (webhook_delivery_recovery_last_*) are the only record, so node volumes are not observable.'],
  async load() { return [] },
  async detail() { return null },
  async summary(db, { degraded = [] } = {}) {
    const rows = await safe(db.from('system_control').select('key, value').in('key', ['webhook_delivery_recovery_last_at', 'webhook_delivery_recovery_last_groups', 'webhook_delivery_recovery_last_webhooks', 'queue_reconcile_heartbeat_at']), degraded, 'system_control')
    const v = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return { runs_today: null, runs_24h: null, runs_7d: null, failed_24h: null, last_run_at: v.webhook_delivery_recovery_last_at || null, last_tick: { groups: Number(v.webhook_delivery_recovery_last_groups || 0), webhooks: Number(v.webhook_delivery_recovery_last_webhooks || 0), queue_reconcile_at: v.queue_reconcile_heartbeat_at || null } }
  },
  async current() { return { in_flight: 0, needs_you: [], live: [] } },
}

/* ── decision engine ─────────────────────────────────────────────────────── */

function snapshotRun(s, addr) {
  const KEY = 'decision_engine'
  const { push, events } = nodeEvents(KEY, s.snapshot_id, 'decisionAuthority')
  const at = s.computed_at || s.created_at
  push('decision_requested', 'succeeded', at)
  push('subject_inputs', 'succeeded', at)
  push('select_comps', Number(s.selected_comp_count) ? 'succeeded' : 'held', at, { label: `${s.selected_comp_count ?? 0} of ${s.raw_candidate_count ?? 0} comps`, reason: Number(s.selected_comp_count) ? null : 'no usable comps' })
  push('valuation', s.valuation_mid ? 'succeeded' : 'held', at, { label: s.valuation_mid ? `$${Math.round(Number(s.valuation_mid)).toLocaleString('en-US')}` : 'no valuation' })
  push('buyer_ceiling', 'succeeded', at, { label: s.effective_authorized_ceiling ? `ceiling $${Math.round(Number(s.effective_authorized_ceiling)).toLocaleString('en-US')}` : null })
  push('decision_tier', 'succeeded', at, { label: human(s.decision_tier) })
  push('snapshot', 'succeeded', at)
  return {
    run: runRow({ run_id: s.snapshot_id, workflow_key: KEY, version: s.engine_version ? `v${s.engine_version}` : null, started_at: at, finished_at: at, subject: subject('property', s.property_id, addr || null, null, s.property_id ? `/deal-intelligence?property=${encodeURIComponent(s.property_id)}` : null), trigger: 'Decision requested', status: 'completed', final_node: 'snapshot', result: `${human(s.decision_tier || 'decided')}${s.recommended_cash_offer ? ` · offer $${Math.round(Number(s.recommended_cash_offer)).toLocaleString('en-US')}` : ''}`, reason: null }),
    events,
  }
}

export const decisionAdapter = {
  key: 'decision_engine',
  topology: DECISION_ENGINE,
  source_runtime: 'decisionAuthority',
  live: false,
  async load(db, { since, limit = 300, degraded = [] }) {
    const rows = await safe(db.from('acquisition_score_snapshots').select('snapshot_id, property_id, computed_at, engine_version, raw_candidate_count, eligible_comp_count, selected_comp_count, valuation_mid, valuation_confidence, decision_tier, effective_authorized_ceiling, recommended_cash_offer, created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(limit), degraded, 'acquisition_score_snapshots')
    const nm = rows.length ? await sellerNames(db, [], rows.map((r) => r.property_id), degraded) : null
    return rows.map((s) => snapshotRun(s, nm?.address(null, s.property_id)))
  },
  async detail(db, id, { degraded = [] } = {}) {
    const { data: s } = await db.from('acquisition_score_snapshots').select('snapshot_id, property_id, computed_at, engine_name, engine_version, policy_version, raw_candidate_count, eligible_comp_count, selected_comp_count, rejected_comp_count, outlier_method, valuation_low, valuation_mid, valuation_high, valuation_confidence, decision_tier, confidence, buyer_ceiling_authoritative, effective_authorized_ceiling, recommended_cash_offer, minimum_acceptable_offer, created_at').eq('snapshot_id', clean(id)).maybeSingle()
    if (!s) return null
    const nm = await sellerNames(db, [], [s.property_id], degraded)
    const $ = (v) => (v ? `$${Math.round(Number(v)).toLocaleString('en-US')}` : '—')
    return { ...snapshotRun(s, nm.address(null, s.property_id)), facts: [{ k: 'Comps', v: `${s.selected_comp_count ?? 0} selected · ${s.eligible_comp_count ?? 0} eligible · ${s.raw_candidate_count ?? 0} raw`, source: 'acquisition_score_snapshots' }, { k: 'Valuation', v: `${$(s.valuation_low)} – ${$(s.valuation_high)} (mid ${$(s.valuation_mid)})`, source: 'valuation' }], decisions: [{ k: 'Decision tier', v: human(s.decision_tier), source: `policy ${s.policy_version || '—'}` }, { k: 'Authorized ceiling', v: $(s.effective_authorized_ceiling), source: s.buyer_ceiling_authoritative ? 'buyer-behaviour authoritative' : 'valuation based' }, { k: 'Recommended offer', v: $(s.recommended_cash_offer), source: 'decision engine' }], ai: [], inputs: [{ k: 'Engine', v: `${s.engine_name || '—'} ${s.engine_version || ''}` }], outputs: [{ k: 'Minimum acceptable', v: $(s.minimum_acceptable_offer) }], links: s.property_id ? [{ label: 'Open Deal Intelligence', href: `/deal-intelligence?property=${encodeURIComponent(s.property_id)}`, app: 'Deal Intelligence' }] : [], technical: { snapshot_id: s.snapshot_id, outlier_method: s.outlier_method, confidence: s.confidence } }
  },
  summary: (db, o) => timestampSummary(() => db.from('acquisition_score_snapshots').select('created_at').gte('created_at', iso(o.now - 7 * DAY)).order('created_at', { ascending: false }), { ...o, source: 'acquisition_score_snapshots' }),
  async current() { return { in_flight: 0, needs_you: [], live: [] } },
}

/* ── buyer matching ──────────────────────────────────────────────────────── */

function matchRun(r, addr) {
  const KEY = 'buyer_matching'
  const { push, events } = nodeEvents(KEY, r.buyer_match_run_id, 'buyer-match workspace')
  push('match_requested', 'succeeded', r.created_at)
  push('candidate_buyers', Number(r.buyer_count) ? 'succeeded' : 'held', r.created_at, { label: `${r.buyer_count ?? 0} buyers`, reason: Number(r.buyer_count) ? null : 'no candidate buyers' })
  push('grade_buyers', 'succeeded', r.updated_at || r.created_at, { label: r.best_buyer_grade ? `best ${r.best_buyer_grade}` : null })
  push('match_recorded', lower(r.run_status) === 'complete' ? 'succeeded' : 'waiting', r.updated_at || r.created_at)
  return {
    run: runRow({ run_id: r.buyer_match_run_id, workflow_key: KEY, version: 'buyer-match-v1', started_at: r.created_at, finished_at: r.updated_at || r.created_at, subject: subject('property', r.property_id, addr || null, null, r.property_id ? `/buyer-match?property=${encodeURIComponent(r.property_id)}` : null), trigger: 'Operator opened Buyer Match', status: lower(r.run_status) === 'complete' ? 'completed' : 'running', final_node: 'match_recorded', result: `${r.buyer_count ?? 0} buyers · ${r.high_fit_count ?? 0} high fit${r.best_buyer_grade ? ` · best ${r.best_buyer_grade}` : ''}`, reason: null }),
    events,
  }
}

export const buyerAdapter = {
  key: 'buyer_matching',
  topology: BUYER_MATCHING,
  source_runtime: 'buyer-match workspace',
  live: false,
  async load(db, { since, limit = 200, degraded = [] }) {
    const rows = await safe(db.from('buyer_match_runs').select('buyer_match_run_id, property_id, run_status, buyer_count, high_fit_count, demand_score, best_buyer_grade, created_at, updated_at').gte('created_at', since).order('created_at', { ascending: false }).limit(limit), degraded, 'buyer_match_runs')
    const nm = rows.length ? await sellerNames(db, [], rows.map((r) => r.property_id), degraded) : null
    return rows.map((r) => matchRun(r, nm?.address(null, r.property_id)))
  },
  async detail(db, id, { degraded = [] } = {}) {
    const { data: r } = await db.from('buyer_match_runs').select('buyer_match_run_id, property_id, run_status, buyer_count, high_fit_count, demand_score, best_buyer_grade, created_at, updated_at').eq('buyer_match_run_id', clean(id)).maybeSingle()
    if (!r) return null
    const nm = await sellerNames(db, [], [r.property_id], degraded)
    return { ...matchRun(r, nm.address(null, r.property_id)), facts: [{ k: 'Buyers', v: String(r.buyer_count ?? 0), source: 'buyer_match_runs' }, { k: 'High fit', v: String(r.high_fit_count ?? 0), source: 'buyer_match_runs' }], decisions: [{ k: 'Demand score', v: String(r.demand_score ?? '—'), source: 'buyer match engine' }], ai: [], inputs: [], outputs: [], links: r.property_id ? [{ label: 'Open Buyer Match', href: `/buyer-match?property=${encodeURIComponent(r.property_id)}`, app: 'Buyer Match' }] : [], technical: { id: r.buyer_match_run_id } }
  },
  summary: (db, o) => timestampSummary(() => db.from('buyer_match_runs').select('created_at').gte('created_at', iso(o.now - 30 * DAY)).order('created_at', { ascending: false }), { ...o, source: 'buyer_match_runs' }),
  async current() { return { in_flight: 0, needs_you: [], live: [] } },
}
