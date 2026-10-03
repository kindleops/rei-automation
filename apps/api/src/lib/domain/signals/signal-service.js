/**
 * SIGNAL CENTER — service.
 *
 *   runSignalEvaluation   the cron tick (POST /api/internal/signals/evaluate)
 *   getSignalCenter       the operator read model (GET /api/cockpit/signals)
 *   listWatches / addWatch / removeWatch / toggleWatch   the watchlist API
 *   acknowledgeSignal / resolveSignal / setRuleArmed      operator writes
 *   legacyScanSuppression the legacy notification-scanner types a live rule replaces
 *
 * GATES (all must hold, else the tick does nothing):
 *   env SIGNAL_CENTER_ENABLED = 'true'   (Worker ceiling, passed into the container)
 *   system_control.signal_center_enabled = 'true'
 *   the schema exists (fail closed: tables_ready:false → nothing evaluates)
 * and then only ARMED rules (signal_rules.is_enabled) are evaluated.
 *
 * The one operator-facing awareness path is upsertNotificationEvent (domain
 * 'signals'); a signal row records the trigger + evidence and links the
 * notification it raised. Nothing here sends, queues or mutates seller state.
 */
import { listPlatformEvents } from '@/lib/domain/platform/events/platform-events-service.js'
import { upsertNotificationEvent, resolveNotificationByDeduplicationKey } from '@/lib/domain/notifications/notification-intelligence-service.js'
import { threadMatchesBucketFilter } from '@/lib/domain/inbox/inbox-bucket-predicates.js'
import { BUILT_IN_RULES, LEGACY_SCAN_RETIREMENT, RULES_BY_KEY, effectiveRule, legacyRetiredWhileLive } from './signal-rules.js'
import { toNotificationSeverity } from './signal-vocabulary.js'
import {
  conditionCandidate, decideTransition, eventAllowed, eventCandidate, evaluateQueueStall, evaluateRate, evaluateRepliesBacklog,
  evidenceHash, matchEvent, notificationKey, subjectKey, watchIndex,
} from './signal-evaluator.js'
import { CONTROL_KEY, ENV_CEILING, SignalSchemaMissing, createSignalStore, isMissingSchema } from './signal-store.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** envelope events younger than this are left for the next tick (ingest settles) */
export const SETTLE_MS = 60_000
/** re-read this much before the checkpoint (dedupe makes overlap idempotent) */
export const OVERLAP_MS = 2 * MIN
/** first run / a checkpoint older than MAX_GAP: start here, never replay history */
export const FIRST_RUN_LOOKBACK_MS = 15 * MIN
export const MAX_GAP_MS = 6 * HOUR
export const MAX_PAGES = 10
export const PAGE_LIMIT = 200
/** metric rules are heavier (Lab fact load) — at most this often */
export const METRIC_INTERVAL_MS = 15 * MIN

const clean = (v) => String(v ?? '').trim()
const stripPhone = (v) => clean(v).replace(/^phone:/i, '')
const iso = (ms) => new Date(ms).toISOString()

export class SignalError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}

/* ── gate ─────────────────────────────────────────────────────────────── */

export async function readGate(store, env = process.env, { readControlWhenCeilingOff = false } = {}) {
  const envEnabled = clean(env[ENV_CEILING]).toLowerCase() === 'true'
  let controlEnabled = false
  let controlError = null
  // ceiling off: nothing can run, so the evaluator/scanners never touch the DB for it
  if (!envEnabled && !readControlWhenCeilingOff) return { env_enabled: false, control_enabled: null, live: false, control_error: null, env_key: ENV_CEILING, control_key: CONTROL_KEY }
  try {
    const ctl = await store.readControl([CONTROL_KEY])
    controlEnabled = clean(ctl[CONTROL_KEY]).toLowerCase() === 'true'
  } catch (e) { controlError = e.message }
  return { env_enabled: envEnabled, control_enabled: controlEnabled, live: envEnabled && controlEnabled, control_error: controlError, env_key: ENV_CEILING, control_key: CONTROL_KEY }
}

/* ── evaluation ───────────────────────────────────────────────────────── */

async function defaultMetricReader({ now, specs }) {
  const { sharedFactLoader } = await import('@/lib/domain/analytics/lab/fact-loader.js')
  const { buildModel, breakdown, periodFacts } = await import('@/lib/domain/analytics/lab/metric-engine.js')
  const back = Math.max(...specs.map((s) => s.window_hours * HOUR + s.baseline_days * DAY + (s.settle_minutes || 0) * MIN))
  const facts = await sharedFactLoader().load({ start: now - back, end: now, lookbackMs: 30 * DAY })
  const model = buildModel(facts)
  return (spec) => {
    const end = now - (spec.settle_minutes || 0) * MIN
    const cur = { start: end - spec.window_hours * HOUR, end }
    const base = { start: cur.start - spec.baseline_days * DAY, end: cur.start }
    const c = breakdown(spec.metric_id, periodFacts(model, cur), spec.dimension, { limit: 1000 })
    const b = breakdown(spec.metric_id, periodFacts(model, base), spec.dimension, { limit: 1000 })
    return { cur: c.rows, base: new Map(b.rows.map((r) => [r.key, r])), windows: { current: { start: iso(cur.start), end: iso(cur.end) }, baseline: { start: iso(base.start), end: iso(base.end) } } }
  }
}

async function defaultQueueHealth() {
  const { fetchQueueProcessorHealth } = await import('@/lib/cockpit/queue-processor-health-service.js')
  return fetchQueueProcessorHealth()
}

async function defaultWithLock(fn) {
  const { withRunLock } = await import('@/lib/domain/runs/run-locks.js')
  return withRunLock({ scope: 'signals:evaluate', lease_ms: 4 * MIN, owner: 'signal-evaluator', fn: () => fn() })
}

function depsOf(deps = {}) {
  return {
    store: deps.store || createSignalStore(deps.supabase),
    env: deps.env || process.env,
    now: deps.now || (() => Date.now()),
    listEvents: deps.listEvents || ((q) => listPlatformEvents(q, { quiet: true })),
    metricReader: deps.metricReader || defaultMetricReader,
    queueHealth: deps.queueHealth || defaultQueueHealth,
    notify: deps.notify || upsertNotificationEvent,
    resolveNotification: deps.resolveNotification || resolveNotificationByDeduplicationKey,
    withLock: deps.withLock || defaultWithLock,
  }
}

/**
 * Fire one candidate: ledger row first (dedupe), then the notification, then link.
 *
 * ONE firing = ONE notification row. The notification's deduplication_key is
 * per rule × subject (`signal:<rule_key>:<subject_type>:<subject_id>`), so a
 * re-fire on the same subject evolves that row (group_count) instead of adding
 * one, and a cleared condition resolves it. The platform event envelope already
 * projects it as `alert.triggered` (event_id `ne:<notification id>`,
 * details.domain 'signals', details.kind = the signal_* type); the signal id,
 * rule and envelope severity ride in metrics_snapshot. Rules never read the
 * 'notification' source, so a signal can never trigger another signal.
 */
async function fire(d, rule, c, summary) {
  const { id, inserted } = await d.store.insertSignal({
    rule_id: rule.id, rule_key: c.rule_key, severity: c.severity, subject_type: c.subject_type, subject_id: c.subject_id,
    title: c.title, body: c.body, evidence: c.evidence, evidence_hash: c.evidence_hash, source_event_id: c.source_event_id,
    deep_link: c.deep_link, dedupe_key: c.dedupe_key, status: 'new', fired_at: c.occurred_at || iso(d.now()),
  })
  if (!inserted) { summary.duplicates += 1; return false }
  summary.fired += 1
  const n = await d.notify({
    event_type: rule.notification_type,
    domain: 'signals',
    severity: toNotificationSeverity(c.severity),
    title: c.title,
    description: c.body,
    // the envelope's notifications adapter reads a seller subject as 'seller_thread'
    source_entity_type: c.subject_type === 'seller' ? 'seller_thread' : c.subject_type,
    source_entity_id: c.subject_id,
    campaign_id: c.subject_type === 'campaign' ? c.subject_id : null,
    property_id: c.subject_type === 'property' ? c.subject_id : null,
    sender_number_id: c.subject_type === 'sender' ? c.subject_id : null,
    metrics_snapshot: { signal_id: id, rule_key: c.rule_key, signal_severity: c.severity, ...c.evidence },
    deduplication_key: c.notification_key,
  })
  if (n?.ok && n.id) await d.store.linkNotification(id, n.id)
  else summary.notify_failed += 1
  return true
}

async function resolveCondition(d, rule, subject, at, summary) {
  await d.store.resolveOpen(rule.rule_key, subject.type === 'platform' ? null : subject.type, subject.id === '*' ? null : subject.id, { reason: 'condition_cleared', at })
  await d.resolveNotification(notificationKey(rule.rule_key, subject), { reason: 'signal_condition_cleared' })
  summary.resolved += 1
}

/** Event rules over the envelope since the checkpoint. */
export async function evaluateEvents(d, rules, states, checkpoint, watch, nowMs) {
  const summary = { rules: rules.length, fired: 0, duplicates: 0, suppressed: 0, resolved: 0, notify_failed: 0, events_read: 0, pages: 0, matched: 0 }
  const until = nowMs - SETTLE_MS
  let since
  let cursor = null
  let windowUntil = until
  if (checkpoint?.cursor && checkpoint.window_since && checkpoint.window_until) {
    since = Date.parse(checkpoint.window_since); windowUntil = Date.parse(checkpoint.window_until); cursor = checkpoint.cursor
    summary.resumed = true
  } else if (checkpoint?.evaluated_through) {
    const through = Date.parse(checkpoint.evaluated_through)
    if (nowMs - through > MAX_GAP_MS) { since = until - FIRST_RUN_LOOKBACK_MS; summary.gap_skipped_from = checkpoint.evaluated_through }
    else since = through - OVERLAP_MS
  } else {
    since = until - FIRST_RUN_LOOKBACK_MS
    summary.first_run = true
  }
  const sources = [...new Set(rules.map((r) => r.event_source))]
  const types = [...new Set(rules.flatMap((r) => r.event_types))]
  const events = []
  const degraded = new Set()
  for (; summary.pages < MAX_PAGES;) {
    const res = await d.listEvents({ since: iso(since), ...(cursor ? { cursor } : { until: iso(windowUntil) }), sources: sources.join(','), types: types.join(','), limit: String(PAGE_LIMIT) })
    summary.pages += 1
    for (const x of res.degraded || []) degraded.add(x)
    events.push(...(res.events || []))
    cursor = res.next_cursor || null
    if (!cursor) break
  }
  summary.events_read = events.length
  // oldest first, so a cooldown collapses a burst onto its first event
  events.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0))
  const stateRows = new Map()
  for (const e of events) {
    for (const rule of rules) {
      const subject = matchEvent(rule, e, watch)
      if (!subject) continue
      summary.matched += 1
      const key = `${rule.id}|${subjectKey(subject)}`
      const prev = stateRows.get(key) || states.get(key) || null
      const at = Date.parse(e.occurred_at)
      if (!eventAllowed(rule, prev, at)) { summary.suppressed += 1; continue }
      const c = eventCandidate(rule, e, subject)
      if (await fire(d, rule, c, summary)) {
        stateRows.set(key, { rule_id: rule.id, subject_key: subjectKey(subject), state: 'ok', last_evidence_hash: c.evidence_hash, last_reason: e.event_type, last_evaluated_at: iso(nowMs), last_fired_at: e.occurred_at, fire_count: Number(prev?.fire_count || 0) + 1 })
      }
    }
  }
  await d.store.upsertRuleState([...stateRows.values()])
  // A failed adapter's events in this window would be lost forever if we moved on:
  // keep the checkpoint where it is (the overlap + dedupe make the retry safe).
  const partial = Boolean(cursor)
  const hold = degraded.size > 0
  const next = partial
    ? { source: 'envelope', evaluated_through: checkpoint?.evaluated_through || null, cursor, window_since: iso(since), window_until: iso(windowUntil) }
    : { source: 'envelope', evaluated_through: hold ? (checkpoint?.evaluated_through || null) : iso(windowUntil), cursor: null, window_since: null, window_until: null }
  summary.degraded = [...degraded]
  summary.checkpoint_held = hold && !partial
  summary.partial = partial
  await d.store.saveCheckpoint({ ...next, last_run_at: iso(nowMs), last_summary: summary })
  return summary
}

/** Shared edge-trigger handling for metric + state results. */
async function applyCondition(d, rule, subject, result, states, nowMs, summary, writes) {
  const sk = subjectKey(subject)
  const key = `${rule.id}|${sk}`
  const prev = states.get(key) || null
  const hash = evidenceHash(result.hashFacts || { condition: result.condition, severity: result.severity || rule.severity, ...result.facts })
  const t = decideTransition(prev, result, { hash, cooldownSeconds: rule.cooldown_seconds, nowMs })
  summary.evaluated += 1
  if (result.condition === 'unknown') summary.unknown += 1
  if (t.fire) await fire(d, rule, conditionCandidate(rule, subject, result, { nowMs, hash }), summary)
  if (t.resolve) await resolveCondition(d, rule, subject, iso(nowMs), summary)
  writes.push({
    rule_id: rule.id, subject_key: sk, state: t.state,
    last_value: Number.isFinite(result.value) ? result.value : null,
    last_evidence_hash: t.fire ? hash : (prev?.last_evidence_hash ?? null),
    last_reason: clean(result.reason).slice(0, 300) || null,
    last_evaluated_at: iso(nowMs),
    last_fired_at: t.fire ? iso(nowMs) : (prev?.last_fired_at ?? null),
    last_resolved_at: t.resolve ? iso(nowMs) : (prev?.last_resolved_at ?? null),
    fire_count: Number(prev?.fire_count || 0) + (t.fire ? 1 : 0),
  })
}

export async function evaluateMetrics(d, rules, states, nowMs) {
  const summary = { rules: rules.length, evaluated: 0, unknown: 0, fired: 0, duplicates: 0, resolved: 0, notify_failed: 0, skipped_subjects: 0 }
  const specs = rules.map((r) => ({ metric_id: r.metric_id, dimension: r.dimension, window_hours: r.condition.window_hours, baseline_days: r.condition.baseline_days, settle_minutes: r.condition.settle_minutes || 0 }))
  const read = await d.metricReader({ now: nowMs, specs })
  const writes = []
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    const snap = read(specs[i])
    for (const row of snap.cur) {
      // test/proof campaigns never alert; unattributed rows are not a subject
      if (row.test || !row.key || row.key.startsWith('__')) { summary.skipped_subjects += 1; continue }
      const subject = { type: rule.dimension, id: String(row.key), label: row.label || null }
      const result = evaluateRate(rule, row, snap.base.get(row.key) || null)
      result.facts = { ...result.facts, windows: snap.windows, metric_id: rule.metric_id }
      result.hashFacts = { condition: result.condition, severity: result.severity || rule.severity, band: result.facts.value_pct == null ? null : Math.round(result.facts.value_pct / 5) }
      await applyCondition(d, rule, subject, result, states, nowMs, summary, writes)
    }
  }
  await d.store.upsertRuleState(writes)
  return summary
}

export async function evaluateStates(d, rules, states, nowMs) {
  const summary = { rules: rules.length, evaluated: 0, unknown: 0, fired: 0, duplicates: 0, resolved: 0, notify_failed: 0 }
  const writes = []
  for (const rule of rules) {
    let result
    let subject
    try {
      if (rule.state_id === 'queue_processor') {
        const [health, control] = await Promise.all([d.queueHealth(), d.store.readControl(['queue_processor_mode', 'queue_emergency_stop_at'])])
        result = evaluateQueueStall(health, control)
        subject = { type: 'queue', id: 'send_queue', label: null }
      } else if (rule.state_id === 'new_replies_backlog') {
        const rows = (await d.store.newRepliesRows(500)).filter((r) => threadMatchesBucketFilter(r, 'new_replies', nowMs))
        result = evaluateRepliesBacklog(rule, rows, nowMs)
        subject = { type: 'inbox', id: 'new_replies', label: null }
      } else continue
    } catch (e) {
      result = { condition: 'unknown', reason: `read_failed: ${e.message}`, facts: {} }
      subject = { type: rule.state_id === 'queue_processor' ? 'queue' : 'inbox', id: rule.state_id === 'queue_processor' ? 'send_queue' : 'new_replies', label: null }
    }
    await applyCondition(d, rule, subject, result, states, nowMs, summary, writes)
  }
  await d.store.upsertRuleState(writes)
  return summary
}

export async function runSignalEvaluation(deps = {}) {
  const d = depsOf(deps)
  const nowMs = d.now()
  const base = { ok: true, generated_at: iso(nowMs) }
  const gate = await readGate(d.store, d.env)
  if (!gate.live) return { ...base, skipped: 'disabled', gate }
  const schema = await d.store.schema()
  if (!schema.tables_ready) return { ...base, skipped: 'schema_missing', tables_ready: false, missing: schema.missing, gate }

  return d.withLock(async () => {
    try {
      const rows = await d.store.listRules()
      const rules = rows.filter((r) => r.is_enabled && RULES_BY_KEY[r.rule_key]).map((r) => effectiveRule(RULES_BY_KEY[r.rule_key], r))
      if (!rules.length) return { ...base, gate, tables_ready: true, armed: 0, note: 'no rule is armed' }
      const stateRows = await d.store.listRuleState(rules.map((r) => r.id))
      const states = new Map(stateRows.map((s) => [`${s.rule_id}|${s.subject_key}`, s]))
      const checkpoints = new Map((await d.store.getCheckpoints()).map((c) => [c.source, c]))
      const out = { ...base, gate, tables_ready: true, armed: rules.length }

      const eventRules = rules.filter((r) => r.source_kind === 'event')
      if (eventRules.length) {
        const watch = eventRules.some((r) => r.scope === 'watched') ? watchIndex(await d.store.listWatches()) : null
        out.events = await evaluateEvents(d, eventRules, states, checkpoints.get('envelope'), watch, nowMs)
      }
      const metricRules = rules.filter((r) => r.source_kind === 'metric')
      if (metricRules.length) {
        const last = checkpoints.get('metrics')?.last_run_at
        if (last && nowMs - Date.parse(last) < METRIC_INTERVAL_MS && !deps.forceMetrics) out.metrics = { skipped: 'interval', next_at: iso(Date.parse(last) + METRIC_INTERVAL_MS) }
        else {
          out.metrics = await evaluateMetrics(d, metricRules, states, nowMs)
          await d.store.saveCheckpoint({ source: 'metrics', evaluated_through: iso(nowMs), last_run_at: iso(nowMs), last_summary: out.metrics })
        }
      }
      const stateRules = rules.filter((r) => r.source_kind === 'state')
      if (stateRules.length) {
        out.states = await evaluateStates(d, stateRules, states, nowMs)
        await d.store.saveCheckpoint({ source: 'state', evaluated_through: iso(nowMs), last_run_at: iso(nowMs), last_summary: out.states })
      }
      return out
    } catch (e) {
      if (e instanceof SignalSchemaMissing) return { ...base, skipped: 'schema_missing', tables_ready: false, missing: [e.table], gate }
      throw e
    }
  })
}

/* ── legacy scanner hand-off ──────────────────────────────────────────── */

/**
 * The legacy notification-scanner event types to SKIP right now: those whose
 * replacing rule is armed while the gate is live and the schema exists, plus the
 * owner-retired null-replacement checks (retire_when_live) while live. Any
 * failure returns an empty set — the legacy scan keeps running (never a gap).
 */
export async function legacyScanSuppression(deps = {}) {
  try {
    const d = depsOf(deps)
    const gate = await readGate(d.store, d.env)
    if (!gate.live) return new Set()
    const rows = await d.store.listRules()
    const armed = new Set(rows.filter((r) => r.is_enabled).map((r) => r.rule_key))
    return new Set(LEGACY_SCAN_RETIREMENT.filter((x) => legacyRetiredWhileLive(x, armed)).map((x) => x.legacy))
  } catch {
    return new Set()
  }
}

/* ── read model ───────────────────────────────────────────────────────── */

function shapeWatch(r) {
  const type = clean(r.entity_type) || (r.watch_type === 'thread' ? 'seller' : clean(r.watch_type))
  return {
    id: r.id, entity_type: type, entity_id: stripPhone(r.entity_id || r.watch_key),
    watch_type: r.watch_type, watch_key: r.watch_key,
    label: r.label || null, address: r.address || null, market: r.market || null,
    thread_key: r.thread_key || null, property_id: r.property_id || null,
    created_at: r.created_at, updated_at: r.updated_at,
  }
}

export async function getSignalCenter(deps = {}) {
  const d = depsOf(deps)
  const nowMs = d.now()
  const [gate, schema] = await Promise.all([readGate(d.store, d.env, { readControlWhenCeilingOff: true }), d.store.schema()])
  let watches = []
  let watchError = null
  try { watches = (await d.store.listWatches()).map(shapeWatch) } catch (e) { watchError = e.message }

  let ruleRows = []
  let stateRows = []
  let signals = []
  let checkpoints = []
  if (schema.tables_ready) {
    try {
      ruleRows = await d.store.listRules()
      ;[stateRows, signals, checkpoints] = await Promise.all([
        d.store.listRuleState(ruleRows.map((r) => r.id)),
        d.store.listSignals({ limit: deps.limit || 100 }),
        d.store.getCheckpoints(),
      ])
    } catch (e) {
      if (!(e instanceof SignalSchemaMissing) && !isMissingSchema(e)) throw e
      schema.tables_ready = false
    }
  }
  const rowByKey = new Map(ruleRows.map((r) => [r.rule_key, r]))
  const rules = BUILT_IN_RULES.map((def) => {
    const row = rowByKey.get(def.rule_key) || null
    const eff = effectiveRule(def, row)
    const st = row ? stateRows.filter((s) => s.rule_id === row.id) : []
    const firing = st.filter((s) => s.state === 'firing')
    return {
      rule_key: def.rule_key, label: def.label, description: def.description, source_kind: def.source_kind,
      event_source: def.event_source || null, event_types: def.event_types || [], metric_id: def.metric_id || null, dimension: def.dimension || null, state_id: def.state_id || null,
      scope: def.scope, severity: eff.severity, cooldown_seconds: eff.cooldown_seconds, condition: eff.condition, replaces_legacy: def.replaces_legacy,
      seeded: Boolean(row), is_enabled: eff.is_enabled,
      firing: firing.map((s) => ({ subject_key: s.subject_key, since: s.last_fired_at, reason: s.last_reason })),
      last_evaluated_at: st.reduce((m, s) => (!m || (s.last_evaluated_at && s.last_evaluated_at > m) ? s.last_evaluated_at : m), null),
    }
  })
  const day = iso(nowMs - DAY)
  const armed = new Set(rules.filter((r) => r.is_enabled).map((r) => r.rule_key))
  return {
    ok: true,
    generated_at: iso(nowMs),
    gate,
    tables_ready: schema.tables_ready,
    missing_tables: schema.missing,
    rules,
    signals,
    counts: {
      open: signals.filter((s) => s.status !== 'resolved').length,
      new: signals.filter((s) => s.status === 'new').length,
      acknowledged: signals.filter((s) => s.status === 'acknowledged').length,
      fired_24h: signals.filter((s) => s.fired_at >= day).length,
      armed_rules: armed.size,
    },
    checkpoints: Object.fromEntries(checkpoints.map((c) => [c.source, { evaluated_through: c.evaluated_through, last_run_at: c.last_run_at, partial: Boolean(c.cursor), summary: c.last_summary || {} }])),
    watches: { items: watches, count: watches.length, supported_types: supportedWatchTypes(schema), error: watchError },
    legacy: LEGACY_SCAN_RETIREMENT.map((x) => ({ ...x, suppressed_now: Boolean(gate.live && schema.tables_ready && legacyRetiredWhileLive(x, armed)) })),
  }
}

/* ── watches ──────────────────────────────────────────────────────────── */

const ENTITY_TO_WATCH_TYPE = { seller: 'thread', property: 'property', campaign: 'campaign', prospect: 'prospect', owner: 'owner' }
const LEGACY_WATCH_TYPES = new Set(['seller', 'property', 'thread', 'prospect', 'owner', 'campaign'])

export const supportedWatchTypes = (schema) => (schema?.watchlist_formal ? ['seller', 'property', 'campaign'] : ['seller', 'property'])

/** Request body → { watch_type, keys[], entity_type, entity_id } (legacy WatchBell payload accepted). */
export function parseWatchTarget(body = {}) {
  let entityType = clean(body.entity_type).toLowerCase()
  let entityId = clean(body.entity_id)
  if (!entityType && body.watch_type) {
    const wt = clean(body.watch_type).toLowerCase()
    if (!LEGACY_WATCH_TYPES.has(wt)) throw new SignalError('unsupported_watch_type', `Unknown watch type "${wt}".`)
    entityType = wt === 'thread' ? 'seller' : wt
    entityId = clean(body.watch_key)
  }
  if (!ENTITY_TO_WATCH_TYPE[entityType]) throw new SignalError('unsupported_watch_type', `Watching a ${entityType || 'blank'} is not supported.`)
  if (!entityId || entityId.length > 200) throw new SignalError('entity_id_required', 'entity_id is required.')
  const id = entityType === 'seller' ? stripPhone(entityId) : entityId
  const keys = entityType === 'seller' ? [id, `phone:${id}`] : [id]
  const types = entityType === 'seller' ? ['thread', 'seller'] : [ENTITY_TO_WATCH_TYPE[entityType]]
  return { entity_type: entityType, entity_id: id, watch_type: ENTITY_TO_WATCH_TYPE[entityType], keys, types }
}

const OPTIONAL = ['label', 'address', 'market', 'thread_key', 'property_id', 'prospect_id', 'owner_id', 'master_owner_id', 'phone']
const optional = (body) => Object.fromEntries(OPTIONAL.filter((k) => clean(body[k])).map((k) => [k, clean(body[k]).slice(0, 300)]))

export async function listWatches(deps = {}) {
  const d = depsOf(deps)
  const schema = await d.store.schema()
  const items = (await d.store.listWatches()).map(shapeWatch)
  return { ok: true, items, count: items.length, supported_types: supportedWatchTypes(schema) }
}

export async function addWatch(body = {}, { operatorId = null, ...deps } = {}) {
  const d = depsOf(deps)
  const t = parseWatchTarget(body)
  const schema = await d.store.schema()
  if (!supportedWatchTypes(schema).includes(t.entity_type)) {
    throw new SignalError('watch_type_requires_migration', `Watching a ${t.entity_type} needs the Signal Center migration.`, 409)
  }
  const existing = await d.store.findWatch(t.types, t.keys)
  if (existing.length) {
    const rows = await d.store.updateWatches(existing.map((r) => r.id), { is_active: true, ...optional(body) })
    return { ok: true, result: 'added', watch: shapeWatch(rows[0] || existing[0]) }
  }
  const row = { watch_type: t.watch_type, watch_key: t.entity_id, is_active: true, ...optional(body) }
  if (t.entity_type === 'seller' && !row.thread_key) row.thread_key = t.entity_id
  if (t.entity_type === 'property' && !row.property_id) row.property_id = t.entity_id
  // entity columns exist only after the migration (a phantom column fails the whole insert)
  if (schema.watchlist_formal) Object.assign(row, { entity_type: t.entity_type, entity_id: t.entity_id, ...(operatorId ? { created_by: operatorId } : {}) })
  const watch = await d.store.insertWatch(row)
  return { ok: true, result: 'added', watch: shapeWatch(watch) }
}

export async function removeWatch(body = {}, deps = {}) {
  const d = depsOf(deps)
  const t = parseWatchTarget(body)
  const existing = (await d.store.findWatch(t.types, t.keys)).filter((r) => r.is_active)
  if (existing.length) await d.store.updateWatches(existing.map((r) => r.id), { is_active: false })
  return { ok: true, result: 'removed', removed: existing.length }
}

export async function toggleWatch(body = {}, deps = {}) {
  const d = depsOf(deps)
  const t = parseWatchTarget(body)
  const active = (await d.store.findWatch(t.types, t.keys)).some((r) => r.is_active)
  return active ? removeWatch(body, deps) : addWatch(body, deps)
}

/* ── operator writes on signals and rules ─────────────────────────────── */

async function requireTables(d) {
  const schema = await d.store.schema()
  if (!schema.tables_ready) throw new SignalError('setup_required', 'Signal Center is not set up yet (migration pending).', 409)
}

export async function acknowledgeSignal(id, { operatorId = null, ...deps } = {}) {
  const d = depsOf(deps)
  await requireTables(d)
  const s = await d.store.getSignal(id)
  if (!s) throw new SignalError('signal_not_found', 'No signal with that id.', 404)
  if (s.status !== 'new') return { ok: true, signal: s, unchanged: true }
  return { ok: true, signal: await d.store.patchSignal(id, { status: 'acknowledged', acknowledged_at: iso(d.now()), acknowledged_by: operatorId }) }
}

export async function resolveSignal(id, { operatorId = null, ...deps } = {}) {
  const d = depsOf(deps)
  await requireTables(d)
  const s = await d.store.getSignal(id)
  if (!s) throw new SignalError('signal_not_found', 'No signal with that id.', 404)
  if (s.status === 'resolved') return { ok: true, signal: s, unchanged: true }
  return { ok: true, signal: await d.store.patchSignal(id, { status: 'resolved', resolved_at: iso(d.now()), resolved_by: operatorId, resolve_reason: 'operator' }) }
}

export async function setRuleArmed(ruleKey, enabled, { operatorId = null, ...deps } = {}) {
  const d = depsOf(deps)
  if (!RULES_BY_KEY[ruleKey]) throw new SignalError('unknown_rule', `Unknown rule "${ruleKey}".`, 404)
  if (typeof enabled !== 'boolean') throw new SignalError('enabled_required', 'enabled must be true or false.')
  await requireTables(d)
  const row = await d.store.setRuleEnabled(ruleKey, enabled, operatorId)
  if (!row) throw new SignalError('rule_not_seeded', 'This rule is not seeded in signal_rules.', 409)
  return { ok: true, rule_key: ruleKey, is_enabled: row.is_enabled }
}
