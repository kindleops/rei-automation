/**
 * SIGNAL CENTER — pure evaluation (no I/O; every input is passed in).
 *
 *   event rules   envelope event × rule (source_system + event_type + scope) → candidate
 *   metric rules  per-subject rate (trailing window) vs the subject's own baseline
 *   state rules   queue processor health · New Replies backlog
 *   transitions   edge trigger: fire on ok→firing; re-fire while firing only after
 *                 the cooldown AND with new evidence; resolve on firing→ok;
 *                 "unknown" (insufficient sample, queue paused) never fires or resolves.
 */
import { createHash } from 'node:crypto'
import { compareProportions } from '@/lib/domain/analytics/lab/stats.js'

const clean = (v) => String(v ?? '').trim()
const stripPhone = (v) => clean(v).replace(/^phone:/i, '')

/* ── evidence ─────────────────────────────────────────────────────────── */

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
}

/** Short, stable digest of the facts that make a firing "the same" or "new". */
export const evidenceHash = (facts) => createHash('sha256').update(stableStringify(facts)).digest('hex').slice(0, 24)

/* ── watchlist ────────────────────────────────────────────────────────── */

/**
 * Active notification_watchlist rows → subject sets. Works before AND after the
 * Signal Center migration: pre-migration rows have only watch_type/watch_key
 * ('thread' = a seller, key may carry a legacy 'phone:' prefix).
 */
export function watchIndex(rows = []) {
  const idx = { seller: new Set(), property: new Set(), campaign: new Set(), labels: new Map(), size: 0 }
  for (const r of rows) {
    if (!r || r.is_active === false) continue
    const type = clean(r.entity_type) || (r.watch_type === 'thread' ? 'seller' : clean(r.watch_type))
    const id = stripPhone(r.entity_id || r.watch_key)
    if (!id || !idx[type]) continue
    idx[type].add(id)
    idx.labels.set(`${type}:${id}`, r.label || r.address || null)
    idx.size += 1
    if (type === 'seller' && r.property_id) idx.labels.set(`property:${r.property_id}`, r.address || r.label || null)
    if (r.thread_key && type !== 'seller') idx.seller.add(stripPhone(r.thread_key))
  }
  return idx
}

/** The subjects an envelope event names (entity_refs + its id columns). */
export function subjectsOfEvent(e) {
  const out = []
  const push = (type, id, label) => { const v = type === 'seller' ? stripPhone(id) : clean(id); if (v && !out.some((s) => s.type === type && s.id === v)) out.push({ type, id: v, label: label || null }) }
  for (const r of e.entity_refs || []) push(r.type, r.id, r.label)
  if (e.thread_key) push('seller', e.thread_key)
  if (e.property_id) push('property', e.property_id)
  if (e.campaign_id) push('campaign', e.campaign_id)
  return out
}

/* ── event rules ──────────────────────────────────────────────────────── */

/** The subject this event fires for under this rule, or null. */
export function matchEvent(rule, e, watch) {
  if (!e || e.source_system !== rule.event_source || !rule.event_types.includes(e.event_type)) return null
  const subjects = subjectsOfEvent(e)
  if (rule.scope === 'watched') {
    if (!watch?.size) return null
    // seller first (the most specific), then property, then campaign
    for (const type of ['seller', 'property', 'campaign']) {
      const hit = subjects.find((s) => s.type === type && watch[type].has(s.id))
      if (hit) return { ...hit, label: hit.label || watch.labels.get(`${type}:${hit.id}`) || null }
    }
    return null
  }
  if (rule.scope === 'campaign') return subjects.find((s) => s.type === 'campaign') || null
  return { type: 'platform', id: '*', label: null }
}

export const subjectKey = (s) => (s?.type && s.id && s.id !== '*' ? `${s.type}:${s.id}` : '*')
export const notificationKey = (ruleKey, subject) => `signal:${ruleKey}:${subjectKey(subject)}`

export function eventCandidate(rule, e, subject) {
  const evidence = { event_id: e.event_id, event_type: e.event_type, source_system: e.source_system, occurred_at: e.occurred_at, summary: e.summary, provenance: e.provenance || null }
  const who = subject.label ? ` · ${subject.label}` : ''
  return {
    rule_key: rule.rule_key,
    severity: rule.severity,
    subject_type: subject.type,
    subject_id: subject.id === '*' ? null : subject.id,
    title: `${rule.label}${who}`.slice(0, 200),
    body: clean(e.summary).slice(0, 400) || null,
    evidence,
    evidence_hash: evidenceHash({ event_id: e.event_id }),
    source_event_id: e.event_id,
    deep_link: e.deep_link || null,
    dedupe_key: `${rule.rule_key}:${e.event_id}`,
    notification_key: notificationKey(rule.rule_key, subject),
    occurred_at: e.occurred_at,
  }
}

/** Cooldown gate for event rules: a burst on one subject collapses into one signal. */
export function eventAllowed(rule, state, nowMs) {
  if (!(rule.cooldown_seconds > 0) || !state?.last_fired_at) return true
  return nowMs - Date.parse(state.last_fired_at) >= rule.cooldown_seconds * 1000
}

/* ── metric rules ─────────────────────────────────────────────────────── */

const pct = (v) => (v == null ? null : Math.round(v * 1000) / 10)

/**
 * One subject's trailing-window rate vs its own baseline.
 *   cur / base: { num, den, value } (base may be null)
 * → { condition: 'firing'|'ok'|'unknown', severity, value, reason, facts }
 */
export function evaluateRate(rule, cur, base) {
  const c = rule.condition
  const n = Number(cur?.den || 0)
  if (n < c.min_n) return { condition: 'unknown', value: cur?.value ?? null, reason: `insufficient_sample: ${n} of ${c.min_n}`, facts: { n } }
  const value = cur.num / n
  const down = c.direction === 'down'
  const absolute = down ? value < c.floor : value > c.ceiling
  let relative = false
  let shift = null
  let p = null
  const baseN = Number(base?.den || 0)
  if (baseN >= c.min_n) {
    const baseValue = base.num / baseN
    shift = (value - baseValue) * 100
    const t = compareProportions(cur.num, n, base.num, baseN)
    p = t ? t.p : 1
    relative = (down ? -shift : shift) >= c.min_shift_pts && p < c.alpha
  }
  const facts = {
    value_pct: pct(value), num: cur.num, n,
    baseline_pct: baseN ? pct(base.num / baseN) : null, baseline_num: base?.num ?? null, baseline_n: baseN || null,
    shift_pts: shift == null ? null : Math.round(shift * 10) / 10, p: p == null ? null : Math.round(p * 10000) / 10000,
    threshold_pct: pct(down ? c.floor : c.ceiling),
  }
  if (!absolute && !relative) return { condition: 'ok', value, reason: 'within_threshold', facts }
  const escalate = down ? (c.escalate_below != null && value < c.escalate_below) : (c.escalate_above != null && value > c.escalate_above)
  const why = absolute
    ? `${facts.value_pct}% is ${down ? 'below the' : 'above the'} ${facts.threshold_pct}% ${down ? 'floor' : 'ceiling'}`
    : `${facts.value_pct}% vs ${facts.baseline_pct}% baseline (${facts.shift_pts > 0 ? '+' : ''}${facts.shift_pts} pts, p=${facts.p})`
  return { condition: 'firing', value, severity: escalate ? 'critical' : rule.severity, reason: why, facts }
}

/* ── state rules ──────────────────────────────────────────────────────── */

export function evaluateQueueStall(health, control = {}) {
  const mode = clean(control.queue_processor_mode).toLowerCase()
  if (clean(control.queue_emergency_stop_at)) return { condition: 'unknown', reason: 'queue_emergency_stop_set', facts: {} }
  if (mode && mode !== 'live') return { condition: 'unknown', reason: `queue_processor_mode=${mode}`, facts: {} }
  if (!health || !health.status) return { condition: 'unknown', reason: 'queue_health_unavailable', facts: {} }
  const counts = health.counts || {}
  const facts = { status: health.status, lag_active: counts.lagActive ?? 0, stale_active: counts.staleActive ?? 0, oldest_queued_at: health.oldestQueuedAt || null, latest_sent_at: health.latestSentAt || null }
  if (health.status !== 'degraded') return { condition: 'ok', value: 0, reason: `queue ${health.status}`, facts }
  return {
    condition: 'firing', value: facts.lag_active + facts.stale_active,
    reason: `${facts.lag_active} lagging and ${facts.stale_active} stale due sends while the processor is live`,
    facts, hashFacts: { oldest_queued_at: facts.oldest_queued_at, lagging: facts.lag_active > 0, stale: facts.stale_active > 0 },
  }
}

/** rows = New Replies threads that pass the canonical bucket predicate. */
export function evaluateRepliesBacklog(rule, rows = [], nowMs) {
  const maxMs = rule.condition.max_wait_minutes * 60_000
  const waiting = rows
    .map((r) => ({ thread_key: r.thread_key, name: r.seller_display_name || null, at: Date.parse(r.last_inbound_at || r.latest_message_at || '') }))
    .filter((r) => Number.isFinite(r.at) && nowMs - r.at > maxMs)
    .sort((a, b) => a.at - b.at)
  const facts = { waiting: waiting.length, in_bucket: rows.length, max_wait_minutes: rule.condition.max_wait_minutes, oldest_wait_minutes: waiting.length ? Math.round((nowMs - waiting[0].at) / 60_000) : null, sample: waiting.slice(0, 5).map((w) => ({ thread_key: w.thread_key, name: w.name })) }
  if (waiting.length < rule.condition.min_threads) return { condition: 'ok', value: waiting.length, reason: 'no reply waiting past the limit', facts }
  return {
    condition: 'firing', value: waiting.length,
    reason: `${waiting.length} repl${waiting.length === 1 ? 'y' : 'ies'} waiting over ${rule.condition.max_wait_minutes} min (oldest ${facts.oldest_wait_minutes} min)`,
    facts, hashFacts: { threads: waiting.map((w) => w.thread_key).sort() },
  }
}

/* ── transitions ──────────────────────────────────────────────────────── */

/**
 * Edge trigger + cooldown + new evidence.
 *   prev: signal_rule_state row (or null) · result: evaluate* output
 * → { fire, resolve, state }
 */
export function decideTransition(prev, result, { hash, cooldownSeconds = 0, nowMs }) {
  const was = prev?.state || 'ok'
  if (result.condition === 'unknown') return { fire: false, resolve: false, state: prev?.state || 'unknown' }
  if (result.condition === 'ok') return { fire: false, resolve: was === 'firing', state: 'ok' }
  if (was !== 'firing') return { fire: true, resolve: false, state: 'firing' }
  const cooled = !prev?.last_fired_at || nowMs - Date.parse(prev.last_fired_at) >= cooldownSeconds * 1000
  return { fire: cooled && hash !== prev?.last_evidence_hash, resolve: false, state: 'firing' }
}

/** A fired metric/state condition → signal candidate. */
export function conditionCandidate(rule, subject, result, { nowMs, hash }) {
  const who = subject.label ? ` · ${subject.label}` : ''
  return {
    rule_key: rule.rule_key,
    severity: result.severity || rule.severity,
    subject_type: subject.type,
    subject_id: subject.id === '*' ? null : subject.id,
    title: `${rule.label}${who}`.slice(0, 200),
    body: result.reason,
    evidence: { ...result.facts, rule_condition: rule.condition, evaluated_at: new Date(nowMs).toISOString() },
    evidence_hash: hash,
    source_event_id: null,
    deep_link: subject.type === 'campaign' ? `/campaign-command?campaign=${encodeURIComponent(subject.id)}` : subject.type === 'queue' ? '/queue' : subject.type === 'inbox' ? '/inbox' : null,
    // one firing per subject per evaluation instant (a re-fire after resolve is a new row)
    dedupe_key: `${rule.rule_key}:${subjectKey(subject)}:${new Date(nowMs).toISOString().slice(0, 16)}`,
    notification_key: notificationKey(rule.rule_key, subject),
    occurred_at: new Date(nowMs).toISOString(),
  }
}
