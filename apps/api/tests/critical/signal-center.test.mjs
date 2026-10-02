/**
 * SIGNAL CENTER v1 — critical tests (no network; every dependency injected).
 *   vocabulary · event matching · rate conditions · edge trigger / cooldown / new
 *   evidence · gate + fail-closed schema · checkpoint restart (first run, overlap,
 *   resume cursor, degraded hold, gap clamp) · dedupe · metric resolve · legacy
 *   scan hand-off · watches before/after the migration.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { toNotificationSeverity, severityOfNotification, SIGNAL_SEVERITIES } from '../../src/lib/domain/signals/signal-vocabulary.js'
import { BUILT_IN_RULES, LEGACY_SCAN_RETIREMENT, RULES_BY_KEY, effectiveRule } from '../../src/lib/domain/signals/signal-rules.js'
import { decideTransition, evaluateQueueStall, evaluateRate, evaluateRepliesBacklog, matchEvent, watchIndex } from '../../src/lib/domain/signals/signal-evaluator.js'
import { isMissingSchema } from '../../src/lib/domain/signals/signal-store.js'
import {
  FIRST_RUN_LOOKBACK_MS, MAX_PAGES, OVERLAP_MS, SETTLE_MS,
  addWatch, getSignalCenter, legacyScanSuppression, parseWatchTarget, runSignalEvaluation, setRuleArmed,
} from '../../src/lib/domain/signals/signal-service.js'
import { EVENT_TYPES, SOURCE_SYSTEMS } from '../../src/lib/domain/platform/events/envelope.js'
import { EVENT_CATALOG } from '../../src/lib/domain/notifications/notification-event-catalog.js'
import { __setProactiveNotificationsDeps, __resetProactiveNotificationsDeps } from '../../src/lib/domain/ops/proactive-notifications.js'
import { scanCampaignNotifications, __setDeps as setScannerDeps, __resetDeps as resetScannerDeps, __setRetiredBySignals } from '../../src/lib/domain/notifications/notification-scanners.js'

const NOW = Date.parse('2026-10-02T15:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const LIVE_ENV = { SIGNAL_CENTER_ENABLED: 'true' }

/* ── in-memory store (the signal-store.js surface) ───────────────────── */

function memoryStore({ control = { signal_center_enabled: 'true' }, rules = [], tablesReady = true, watchlistFormal = true, watches = [], checkpoints = [], replies = [] } = {}) {
  const s = {
    control, rules, watches, replies,
    states: new Map(), signals: [], checkpoints: new Map(checkpoints.map((c) => [c.source, c])), calls: [],
    async schema() { return { tables_ready: tablesReady && watchlistFormal, missing: tablesReady ? [] : ['signal_rules'], watchlist_formal: watchlistFormal } },
    async readControl(keys) { s.calls.push('readControl'); return Object.fromEntries(keys.filter((k) => k in s.control).map((k) => [k, s.control[k]])) },
    async listRules() { return s.rules },
    async setRuleEnabled(key, enabled) { const r = s.rules.find((x) => x.rule_key === key); if (r) r.is_enabled = enabled; return r || null },
    async listRuleState() { return [...s.states.values()] },
    async upsertRuleState(rows) { for (const r of rows) s.states.set(`${r.rule_id}|${r.subject_key}`, { ...s.states.get(`${r.rule_id}|${r.subject_key}`), ...r }) },
    async insertSignal(row) {
      if (s.signals.some((x) => x.dedupe_key === row.dedupe_key)) return { id: null, inserted: false }
      const id = `00000000-0000-4000-8000-${String(s.signals.length + 1).padStart(12, '0')}`
      s.signals.push({ ...row, id })
      return { id, inserted: true }
    },
    async linkNotification(id, nid) { const x = s.signals.find((r) => r.id === id); if (x) x.notification_event_id = nid },
    async resolveOpen(ruleKey, type, id, { reason, at }) { for (const x of s.signals) if (x.rule_key === ruleKey && x.subject_type === type && x.subject_id === id && x.status !== 'resolved') Object.assign(x, { status: 'resolved', resolve_reason: reason, resolved_at: at }) },
    async listSignals() { return [...s.signals].reverse() },
    async patchSignal(id, patch) { const x = s.signals.find((r) => r.id === id); Object.assign(x, patch); return x },
    async getSignal(id) { return s.signals.find((r) => r.id === id) || null },
    async getCheckpoints() { return [...s.checkpoints.values()] },
    async saveCheckpoint(row) { s.checkpoints.set(row.source, { ...row }) },
    async listWatches() { return s.watches.filter((w) => w.is_active !== false) },
    async findWatch(types, keys) { return s.watches.filter((w) => types.includes(w.watch_type) && keys.includes(w.watch_key)) },
    async updateWatches(ids, patch) { const out = []; for (const w of s.watches) if (ids.includes(w.id)) { Object.assign(w, patch); out.push(w) } return out },
    async insertWatch(row) { const w = { id: `w${s.watches.length + 1}`, ...row }; s.watches.push(w); return w },
    async newRepliesRows() { return s.replies },
  }
  return s
}

const ruleRow = (key, extra = {}) => ({ id: `rule-${key}`, rule_key: key, is_enabled: true, condition: {}, ...extra })

function harness(opts = {}) {
  const store = memoryStore(opts)
  const notes = []
  const resolved = []
  const reads = []
  const deps = {
    store,
    env: opts.env || LIVE_ENV,
    now: () => opts.now ?? NOW,
    withLock: (fn) => fn(),
    listEvents: async (q) => { reads.push(q); return opts.listEvents ? opts.listEvents(q, reads.length) : { events: [], next_cursor: null, degraded: [] } },
    metricReader: opts.metricReader || (async () => () => ({ cur: [], base: new Map(), windows: {} })),
    queueHealth: async () => opts.health || { status: 'healthy', counts: {} },
    notify: async (n) => { notes.push(n); return { ok: true, id: `n${notes.length}` } },
    resolveNotification: async (key) => { resolved.push(key); return { ok: true } },
  }
  return { store, notes, resolved, reads, deps }
}

const replyEvent = (id, at, thread = '+15550001111', extra = {}) => ({
  event_id: `me:${id}`, occurred_at: iso(at), source_system: 'inbox', event_type: 'seller.replied', severity: 'info',
  entity_refs: [{ type: 'seller', id: thread, label: 'Jane D.' }], thread_key: thread, summary: 'Jane D. replied', provenance: { table: 'message_events', row_id: id }, ...extra,
})

/* ── vocabulary + registry ───────────────────────────────────────────── */

test('one severity vocabulary: envelope severities, mapped to notification severities in one place', () => {
  assert.deepEqual([...SIGNAL_SEVERITIES], ['info', 'attention', 'warning', 'critical'])
  assert.equal(toNotificationSeverity('critical'), 'critical')
  assert.equal(toNotificationSeverity('warning'), 'warning')
  assert.equal(toNotificationSeverity('attention'), 'warning')
  assert.equal(toNotificationSeverity('info'), 'neutral')
  assert.equal(severityOfNotification('warning'), 'warning')
  for (const r of BUILT_IN_RULES) assert.ok(SIGNAL_SEVERITIES.includes(r.severity), r.rule_key)
})

test('every event rule names a real envelope source + event types; every rule has a catalogued notification type', () => {
  for (const r of BUILT_IN_RULES) {
    assert.ok(EVENT_CATALOG[r.notification_type], `${r.rule_key} → ${r.notification_type}`)
    assert.equal(EVENT_CATALOG[r.notification_type].domain, 'signals')
    if (r.source_kind !== 'event') continue
    assert.ok(SOURCE_SYSTEMS.includes(r.event_source), r.rule_key)
    for (const t of r.event_types) assert.ok(EVENT_TYPES[t], `${r.rule_key}: ${t}`)
  }
  assert.ok(!BUILT_IN_RULES.some((r) => r.source_kind === 'monitor'), 'no IC monitor rule until the intelligence schema exists')
  assert.ok(!BUILT_IN_RULES.some((r) => r.event_source === 'notification'), 'signals never read their own notifications (no feedback loop)')
  for (const x of LEGACY_SCAN_RETIREMENT) if (x.replacement) assert.ok(RULES_BY_KEY[x.replacement], x.legacy)
})

test('the migration seeds exactly the code registry, all disarmed, in the envelope vocabulary', async () => {
  const { readFile } = await import('node:fs/promises')
  const sql = await readFile(new URL('../../supabase/migrations/PROPOSED_20261001131000_signal_center.sql', import.meta.url), 'utf8')
  for (const r of BUILT_IN_RULES) assert.ok(sql.includes(`('${r.rule_key}',`), `seed for ${r.rule_key}`)
  assert.ok(!/to authenticated\s+using\s*\(true\)/i.test(sql), 'no authenticated using(true)')
  assert.ok(!/'high'|'medium'|'low'/.test(sql), 'no second severity vocabulary')
  assert.match(sql, /is_enabled\s+boolean not null default false/)
  assert.match(sql, /notification_event_id\s+uuid/)
  assert.match(sql, /signal_evaluator_checkpoints/)
  const lock = await readFile(new URL('../../supabase/migrations/PROPOSED_20261002100000_notification_watchlist_lockdown.sql', import.meta.url), 'utf8')
  assert.match(lock, /revoke all on public\.notification_watchlist from anon, authenticated/)
  const lockSql = lock.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  assert.ok(!/create policy[^;]*to (anon|authenticated)/i.test(lockSql))
  const sqlBody = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  assert.ok(!/to (anon|authenticated)/i.test(sqlBody.replace(/from (public, )?anon, authenticated/gi, '')), 'no anon/authenticated grant or policy')
})

/* ── matching + conditions ───────────────────────────────────────────── */

test('event matching: watched subjects only (legacy phone: keys normalised), campaign scope needs a campaign ref, source must match', () => {
  const watch = watchIndex([{ watch_type: 'thread', watch_key: 'phone:+15550001111', label: 'Jane D.', is_active: true }, { watch_type: 'property', watch_key: 'P9', is_active: false }])
  const rule = RULES_BY_KEY['watch.seller_replied']
  assert.equal(matchEvent(rule, replyEvent('1', NOW), watch)?.id, '+15550001111')
  assert.equal(matchEvent(rule, replyEvent('2', NOW, '+15559999999'), watch), null)
  assert.equal(matchEvent(rule, { ...replyEvent('3', NOW), source_system: 'queue' }, watch), null, 'source_system must match')
  assert.equal(matchEvent(rule, { ...replyEvent('4', NOW), property_id: 'P9', thread_key: null, entity_refs: [{ type: 'property', id: 'P9' }] }, watch), null, 'inactive watch never matches')
  const ex = RULES_BY_KEY['campaign.execution_exception']
  const held = { event_id: 'wf:1', occurred_at: iso(NOW), source_system: 'workflow', event_type: 'workflow.held', entity_refs: [{ type: 'campaign', id: 'C1', label: 'Dallas' }] }
  assert.deepEqual(matchEvent(ex, held, null), { type: 'campaign', id: 'C1', label: 'Dallas' })
  assert.equal(matchEvent(ex, { ...held, entity_refs: [{ type: 'seller', id: '+1' }] }, null), null)
})

test('rate condition: insufficient sample never fires; floor, significant relative drop and escalation fire', () => {
  const rule = effectiveRule(RULES_BY_KEY['campaign.delivery_rate_drop'])
  assert.equal(evaluateRate(rule, { num: 5, den: 20 }, null).condition, 'unknown')
  const floor = evaluateRate(rule, { num: 60, den: 100 }, null)
  assert.equal(floor.condition, 'firing')
  assert.equal(floor.severity, 'warning')
  assert.equal(evaluateRate(rule, { num: 40, den: 100 }, null).severity, 'critical')
  const rel = evaluateRate(rule, { num: 75, den: 100 }, { num: 190, den: 200 })
  assert.equal(rel.condition, 'firing', 'a 20-pt significant drop fires above the floor')
  assert.equal(evaluateRate(rule, { num: 75, den: 100 }, { num: 15, den: 20 }).condition, 'ok', 'baseline below min_n is not comparable')
  assert.equal(evaluateRate(rule, { num: 95, den: 100 }, { num: 190, den: 200 }).condition, 'ok')
  const up = evaluateRate(effectiveRule(RULES_BY_KEY['campaign.content_filter_spike']), { num: 30, den: 100 }, null)
  assert.equal(up.condition, 'firing')
  assert.equal(up.severity, 'critical')
})

test('state conditions: a paused queue is unknown (never fires); backlog counts only waits past the limit', () => {
  assert.equal(evaluateQueueStall({ status: 'degraded', counts: { lagActive: 3 } }, { queue_processor_mode: 'paused' }).condition, 'unknown')
  assert.equal(evaluateQueueStall({ status: 'degraded', counts: { lagActive: 3 } }, { queue_processor_mode: 'live', queue_emergency_stop_at: '2026-10-02' }).condition, 'unknown')
  assert.equal(evaluateQueueStall({ status: 'degraded', counts: { lagActive: 3 } }, { queue_processor_mode: 'live' }).condition, 'firing')
  assert.equal(evaluateQueueStall({ status: 'idle', counts: {} }, { queue_processor_mode: 'live' }).condition, 'ok')
  const rule = effectiveRule(RULES_BY_KEY['inbox.new_replies_backlog'])
  const rows = [{ thread_key: 'a', last_inbound_at: iso(NOW - 30 * 60e3) }, { thread_key: 'b', last_inbound_at: iso(NOW - 5 * 3600e3) }]
  const r = evaluateRepliesBacklog(rule, rows, NOW)
  assert.equal(r.condition, 'firing')
  assert.equal(r.facts.waiting, 1)
  assert.equal(evaluateRepliesBacklog(rule, rows.slice(0, 1), NOW).condition, 'ok')
})

test('transitions: edge fire, cooldown, new evidence, resolve, unknown holds', () => {
  const firing = { condition: 'firing' }
  assert.deepEqual(decideTransition(null, firing, { hash: 'h1', cooldownSeconds: 3600, nowMs: NOW }), { fire: true, resolve: false, state: 'firing' })
  const prev = { state: 'firing', last_fired_at: iso(NOW - 10 * 60e3), last_evidence_hash: 'h1' }
  assert.equal(decideTransition(prev, firing, { hash: 'h2', cooldownSeconds: 3600, nowMs: NOW }).fire, false, 'inside cooldown')
  assert.equal(decideTransition({ ...prev, last_fired_at: iso(NOW - 2 * 3600e3) }, firing, { hash: 'h1', cooldownSeconds: 3600, nowMs: NOW }).fire, false, 'same evidence never re-fires')
  assert.equal(decideTransition({ ...prev, last_fired_at: iso(NOW - 2 * 3600e3) }, firing, { hash: 'h2', cooldownSeconds: 3600, nowMs: NOW }).fire, true, 'cooled + new evidence')
  assert.deepEqual(decideTransition(prev, { condition: 'ok' }, { hash: 'x', nowMs: NOW }), { fire: false, resolve: true, state: 'ok' })
  assert.deepEqual(decideTransition(prev, { condition: 'unknown' }, { hash: 'x', nowMs: NOW }), { fire: false, resolve: false, state: 'firing' })
})

/* ── gate + schema ───────────────────────────────────────────────────── */

test('gate: env ceiling off → nothing runs and the control plane is not even read; control off → disabled', async () => {
  const off = harness({ env: {}, rules: [ruleRow('watch.seller_replied')] })
  const r1 = await runSignalEvaluation(off.deps)
  assert.equal(r1.skipped, 'disabled')
  assert.equal(off.store.calls.length, 0)
  const ctlOff = harness({ control: { signal_center_enabled: 'false' }, rules: [ruleRow('watch.seller_replied')] })
  const r2 = await runSignalEvaluation(ctlOff.deps)
  assert.equal(r2.skipped, 'disabled')
  assert.equal(r2.gate.env_enabled, true)
  assert.equal(ctlOff.reads.length, 0)
})

test('fail closed: a missing schema evaluates nothing and writes nothing', async () => {
  const h = harness({ tablesReady: false, rules: [ruleRow('watch.seller_replied')] })
  const r = await runSignalEvaluation(h.deps)
  assert.equal(r.skipped, 'schema_missing')
  assert.equal(r.tables_ready, false)
  assert.equal(h.reads.length, 0)
  assert.equal(h.store.signals.length, 0)
  assert.equal(h.store.checkpoints.size, 0)
  assert.ok(isMissingSchema({ code: '42P01', message: 'relation "signals" does not exist' }))
  assert.ok(isMissingSchema({ code: 'PGRST205', message: "Could not find the table 'public.signals' in the schema cache" }))
  assert.ok(!isMissingSchema({ code: '23505', message: 'duplicate key' }))
})

test('disarmed rules never evaluate', async () => {
  const h = harness({ rules: [ruleRow('watch.seller_replied', { is_enabled: false })] })
  const r = await runSignalEvaluation(h.deps)
  assert.equal(r.armed, 0)
  assert.equal(h.reads.length, 0)
})

/* ── checkpoint restart ──────────────────────────────────────────────── */

const watched = [{ id: 'w1', watch_type: 'thread', watch_key: '+15550001111', label: 'Jane D.', is_active: true }]

test('first run starts FIRST_RUN_LOOKBACK before now (never replays history) and advances the checkpoint', async () => {
  const h = harness({ rules: [ruleRow('watch.seller_replied')], watches: watched, listEvents: () => ({ events: [replyEvent('1', NOW - 5 * 60e3)], next_cursor: null, degraded: [] }) })
  const r = await runSignalEvaluation(h.deps)
  assert.equal(h.reads[0].since, iso(NOW - SETTLE_MS - FIRST_RUN_LOOKBACK_MS))
  assert.equal(h.reads[0].until, iso(NOW - SETTLE_MS))
  assert.equal(r.events.fired, 1)
  assert.equal(h.notes[0].domain, 'signals')
  assert.equal(h.notes[0].severity, 'warning', 'attention → notification warning')
  assert.equal(h.notes[0].deduplication_key, 'signal:watch.seller_replied:seller:+15550001111')
  assert.equal(h.notes[0].source_entity_type, 'seller_thread', 'the envelope notifications adapter resolves it to the seller')
  assert.equal(h.notes[0].metrics_snapshot.signal_id, h.store.signals[0].id)
  assert.equal(h.notes[0].metrics_snapshot.signal_severity, 'attention')
  assert.equal(h.store.signals[0].notification_event_id, 'n1')
  assert.equal(h.store.checkpoints.get('envelope').evaluated_through, iso(NOW - SETTLE_MS))
})

test('restart: resumes from the checkpoint minus overlap; an event re-read in the overlap is deduped, not re-notified', async () => {
  const through = NOW - 6 * 60e3
  const ev = replyEvent('1', through - 30e3)
  const h = harness({ rules: [ruleRow('watch.seller_replied')], watches: watched, checkpoints: [{ source: 'envelope', evaluated_through: iso(through) }], listEvents: () => ({ events: [ev], next_cursor: null, degraded: [] }) })
  h.store.signals.push({ id: 'old', dedupe_key: `watch.seller_replied:${ev.event_id}`, rule_key: 'watch.seller_replied' })
  const r = await runSignalEvaluation(h.deps)
  assert.equal(h.reads[0].since, iso(through - OVERLAP_MS))
  assert.equal(r.events.fired, 0)
  assert.equal(r.events.duplicates, 1)
  assert.equal(h.notes.length, 0)
})

test('restart mid-window: a partly drained window saves its cursor and the next run resumes it before moving on', async () => {
  const h = harness({ rules: [ruleRow('watch.seller_replied')], watches: watched, listEvents: (q, n) => ({ events: [replyEvent(`p${n}`, NOW - 120e3 - n * 1000)], next_cursor: `c${n}`, degraded: [] }) })
  const r = await runSignalEvaluation(h.deps)
  assert.equal(h.reads.length, MAX_PAGES)
  assert.equal(r.events.partial, true)
  const cp = h.store.checkpoints.get('envelope')
  assert.equal(cp.cursor, `c${MAX_PAGES}`)
  assert.equal(cp.evaluated_through, null, 'not advanced past an undrained window')
  // the process restarts: the next run resumes the cursor inside the same window
  const h2 = harness({ rules: [ruleRow('watch.seller_replied')], watches: watched, checkpoints: [cp], listEvents: () => ({ events: [], next_cursor: null, degraded: [] }) })
  const r2 = await runSignalEvaluation(h2.deps)
  assert.equal(h2.reads[0].cursor, `c${MAX_PAGES}`)
  assert.equal(h2.reads[0].since, cp.window_since)
  assert.equal(r2.events.resumed, true)
  assert.equal(h2.store.checkpoints.get('envelope').evaluated_through, cp.window_until)
  assert.equal(h2.store.checkpoints.get('envelope').cursor, null)
})

test('a degraded source holds the checkpoint; a stale checkpoint (> 6h) is clamped, not replayed', async () => {
  const through = NOW - 10 * 60e3
  const h = harness({ rules: [ruleRow('watch.seller_replied')], watches: watched, checkpoints: [{ source: 'envelope', evaluated_through: iso(through) }], listEvents: () => ({ events: [], next_cursor: null, degraded: ['messages'] }) })
  const r = await runSignalEvaluation(h.deps)
  assert.equal(r.events.checkpoint_held, true)
  assert.equal(h.store.checkpoints.get('envelope').evaluated_through, iso(through))
  const old = harness({ rules: [ruleRow('watch.seller_replied')], watches: watched, checkpoints: [{ source: 'envelope', evaluated_through: iso(NOW - 3 * 864e5) }] })
  const r2 = await runSignalEvaluation(old.deps)
  assert.equal(old.reads[0].since, iso(NOW - SETTLE_MS - FIRST_RUN_LOOKBACK_MS))
  assert.ok(r2.events.gap_skipped_from)
})

test('event cooldown collapses a burst on one subject', async () => {
  const events = [replyEvent('1', NOW - 240e3), replyEvent('2', NOW - 200e3), replyEvent('3', NOW - 150e3)]
  const h = harness({ rules: [ruleRow('watch.seller_replied', { cooldown_seconds: 600 })], watches: watched, listEvents: () => ({ events, next_cursor: null, degraded: [] }) })
  const r = await runSignalEvaluation(h.deps)
  assert.equal(r.events.fired, 1)
  assert.equal(r.events.suppressed, 2)
  assert.equal(h.notes.length, 1, 'one firing → one notification upsert')
})

/* ── metric + state rules ───────────────────────────────────────────── */

test('metric rule: fires per campaign on the edge, skips test/unattributed rows, resolves when the rate recovers', async () => {
  let cur = [{ key: 'C1', label: 'Dallas', num: 50, den: 100 }, { key: 'T1', label: 'Proof', test: true, num: 0, den: 100 }, { key: '__none', num: 0, den: 100 }]
  const metricReader = async () => () => ({ cur, base: new Map(), windows: { current: {}, baseline: {} } })
  const h = harness({ rules: [ruleRow('campaign.delivery_rate_drop')], metricReader })
  const r = await runSignalEvaluation({ ...h.deps, forceMetrics: true })
  assert.equal(r.metrics.fired, 1)
  assert.equal(r.metrics.skipped_subjects, 2)
  assert.equal(h.notes[0].campaign_id, 'C1')
  assert.equal(h.notes[0].event_type, 'signal_campaign_health')
  // same condition next tick: no second signal (edge trigger)
  const again = await runSignalEvaluation({ ...h.deps, forceMetrics: true, now: () => NOW + 60e3 })
  assert.equal(again.metrics.fired, 0)
  cur = [{ key: 'C1', label: 'Dallas', num: 97, den: 100 }]
  const rec = await runSignalEvaluation({ ...h.deps, forceMetrics: true, now: () => NOW + 120e3 })
  assert.equal(rec.metrics.resolved, 1)
  assert.deepEqual(h.resolved, ['signal:campaign.delivery_rate_drop:campaign:C1'])
  assert.equal(h.store.signals[0].status, 'resolved')
})

test('metric rules are throttled to their interval; state rules run every tick', async () => {
  const h = harness({ rules: [ruleRow('campaign.delivery_rate_drop'), ruleRow('queue.stalled')], checkpoints: [{ source: 'metrics', last_run_at: iso(NOW - 5 * 60e3) }], control: { signal_center_enabled: 'true', queue_processor_mode: 'live' }, health: { status: 'degraded', counts: { lagActive: 4, staleActive: 0 }, oldestQueuedAt: iso(NOW - 3600e3) } })
  const r = await runSignalEvaluation(h.deps)
  assert.equal(r.metrics.skipped, 'interval')
  assert.equal(r.states.fired, 1)
  assert.equal(h.notes[0].severity, 'critical')
})

/* ── legacy hand-off ─────────────────────────────────────────────────── */

test('legacy scans are retired only while the gate is live AND the replacing rule is armed', async () => {
  const live = harness({ rules: [ruleRow('campaign.delivery_rate_drop'), ruleRow('queue.stalled', { is_enabled: false })] })
  assert.deepEqual([...await legacyScanSuppression(live.deps)], ['campaign_delivery_rate_falling'])
  const off = harness({ env: {}, rules: [ruleRow('campaign.delivery_rate_drop')] })
  assert.equal((await legacyScanSuppression(off.deps)).size, 0)
  const broken = harness({ rules: [] })
  broken.store.listRules = async () => { throw new Error('boom') }
  assert.equal((await legacyScanSuppression(broken.deps)).size, 0, 'any failure keeps the legacy scan running')
})

test('the campaign scanner skips a retired check and still runs the rest', async () => {
  const inserted = []
  const campaign = { id: '11111111-1111-4111-8111-111111111111', name: 'Dallas', status: 'active', sent_count: 200, delivered_count: 80, failed_count: 0, replied_count: 0, opt_out_count: 0, queued_count: 0, metadata: {} }
  const builder = (table) => {
    const q = {
      _table: table, _op: 'select',
      select() { return q }, in() { return q }, order() { return q }, limit() { return q }, eq() { return q }, gte() { return q },
      insert(row) { q._op = 'insert'; inserted.push(row); return q },
      update() { q._op = 'update'; return q },
      maybeSingle() { return Promise.resolve(q._op === 'insert' ? { data: { id: `n${inserted.length}` }, error: null } : { data: null, error: null }) },
      then(res, rej) { return Promise.resolve(table === 'campaigns' ? { data: [campaign], error: null } : { data: [], error: null }).then(res, rej) },
    }
    return q
  }
  setScannerDeps({ supabase_override: { from: builder } })
  __setProactiveNotificationsDeps({ supabase_override: { from: builder } })
  try {
    __setRetiredBySignals(new Set(['campaign_delivery_rate_falling']))
    await scanCampaignNotifications()
    assert.ok(!inserted.some((r) => r.event_type === 'campaign_delivery_rate_falling'), 'retired check is skipped')
    inserted.length = 0
    __setRetiredBySignals(new Set())
    await scanCampaignNotifications()
    assert.ok(inserted.some((r) => r.event_type === 'campaign_delivery_rate_falling'), 'without a live replacement the legacy check still runs')
  } finally {
    __setRetiredBySignals(new Set())
    resetScannerDeps()
    __resetProactiveNotificationsDeps()
  }
})

/* ── watches + operator writes ───────────────────────────────────────── */

test('watch targets: legacy WatchBell payloads map to sellers; unsupported types are refused', () => {
  assert.deepEqual(parseWatchTarget({ watch_type: 'thread', watch_key: 'phone:+15550001111' }).keys, ['+15550001111', 'phone:+15550001111'])
  assert.equal(parseWatchTarget({ entity_type: 'campaign', entity_id: 'C1' }).watch_type, 'campaign')
  assert.throws(() => parseWatchTarget({ entity_type: 'buyer', entity_id: 'B1' }), /not supported/)
  assert.throws(() => parseWatchTarget({ entity_type: 'seller' }), /entity_id/)
})

test('watching before the migration writes only existing columns; campaign watches wait for the migration', async () => {
  const h = harness({ watchlistFormal: false, tablesReady: false })
  const r = await addWatch({ entity_type: 'seller', entity_id: '+15550002222', label: 'Bob' }, { ...h.deps, operatorId: 'u1' })
  assert.equal(r.result, 'added')
  const row = h.store.watches[0]
  assert.equal(row.watch_type, 'thread')
  assert.equal(row.thread_key, '+15550002222')
  assert.ok(!('entity_type' in row) && !('created_by' in row), 'no phantom columns pre-migration')
  await assert.rejects(addWatch({ entity_type: 'campaign', entity_id: 'C1' }, h.deps), (e) => e.code === 'watch_type_requires_migration' && e.status === 409)
  // re-watching a legacy-keyed row reactivates it instead of duplicating
  h.store.watches.push({ id: 'legacy', watch_type: 'thread', watch_key: 'phone:+15550003333', is_active: false })
  await addWatch({ entity_type: 'seller', entity_id: '+15550003333' }, h.deps)
  assert.equal(h.store.watches.filter((w) => w.watch_key.endsWith('3333')).length, 1)
  assert.equal(h.store.watches.find((w) => w.id === 'legacy').is_active, true)
})

test('after the migration a watch records the canonical entity and the operator', async () => {
  const h = harness()
  await addWatch({ entity_type: 'campaign', entity_id: 'C1', label: 'Dallas' }, { ...h.deps, operatorId: 'u1' })
  assert.deepEqual({ t: h.store.watches[0].entity_type, id: h.store.watches[0].entity_id, by: h.store.watches[0].created_by }, { t: 'campaign', id: 'C1', by: 'u1' })
})

test('read model is honest before the migration: rules from code, disarmed, no signals; arming needs the schema', async () => {
  const h = harness({ tablesReady: false, watchlistFormal: false, env: {} })
  const m = await getSignalCenter(h.deps)
  assert.equal(m.tables_ready, false)
  assert.equal(m.rules.length, BUILT_IN_RULES.length)
  assert.ok(m.rules.every((r) => !r.is_enabled && !r.seeded))
  assert.deepEqual(m.signals, [])
  assert.deepEqual(m.watches.supported_types, ['seller', 'property'])
  assert.ok(m.legacy.every((x) => !x.suppressed_now))
  await assert.rejects(setRuleArmed('queue.stalled', true, h.deps), (e) => e.code === 'setup_required')
  await assert.rejects(setRuleArmed('nope', true, h.deps), (e) => e.code === 'unknown_rule')
})
