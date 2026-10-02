import { describe, expect, it } from 'vitest'
import { evaluatorState, evidenceFacts, ledgerEmpty, ruleSource, SEVERITY_TONE, type SignalCenterModel, type SignalRow, type SignalRule } from './signals-model'
import { watchTargetOf } from './watch-target'
import { canonicalWatchKey } from '../../../lib/data/watchStore'

const base = (over: Partial<SignalCenterModel> = {}): SignalCenterModel => ({
  ok: true,
  generated_at: '2026-10-02T15:00:00.000Z',
  gate: { env_enabled: false, control_enabled: false, live: false },
  tables_ready: true,
  missing_tables: [],
  rules: [],
  signals: [],
  counts: { open: 0, new: 0, acknowledged: 0, fired_24h: 0, armed_rules: 0 },
  checkpoints: {},
  watches: { items: [], count: 0, supported_types: ['seller', 'property'], error: null },
  legacy: [],
  ...over,
})

describe('evaluator state never claims to be live when it is not', () => {
  it('setup required before the migration', () => {
    expect(evaluatorState(base({ tables_ready: false })).label).toBe('Setup required')
  })
  it('off at the ceiling, then at the control plane', () => {
    expect(evaluatorState(base()).detail).toMatch(/SIGNAL_CENTER_ENABLED/)
    expect(evaluatorState(base({ gate: { env_enabled: true, control_enabled: false, live: false } })).detail).toMatch(/signal_center_enabled/)
  })
  it('on with nothing armed, then evaluating', () => {
    const live = { env_enabled: true, control_enabled: true, live: true }
    expect(evaluatorState(base({ gate: live })).label).toBe('No rule armed')
    const s = evaluatorState(base({ gate: live, counts: { open: 0, new: 0, acknowledged: 0, fired_24h: 0, armed_rules: 2 }, checkpoints: { state: { evaluated_through: null, last_run_at: '2026-10-02T14:55:00.000Z', partial: false } } }))
    expect(s.label).toBe('Evaluating')
    expect(s.tone).toBe('exec')
  })
})

describe('honest empty ledger', () => {
  it('names why there are no signals', () => {
    expect(ledgerEmpty(base({ tables_ready: false })).title).toMatch(/not set up/)
    expect(ledgerEmpty(base()).body).toMatch(/evaluator is off/)
    const live = { env_enabled: true, control_enabled: true, live: true }
    expect(ledgerEmpty(base({ gate: live })).body).toMatch(/No rule is armed/)
    expect(ledgerEmpty(base({ gate: live, counts: { open: 0, new: 0, acknowledged: 0, fired_24h: 0, armed_rules: 1 } })).title).toBe('No signals yet')
  })
})

describe('rules and evidence render only what the server sent', () => {
  const rule = (over: Partial<SignalRule>): SignalRule => ({
    rule_key: 'r', label: 'R', description: '', source_kind: 'metric', event_source: null, event_types: [], metric_id: 'delivery_rate', dimension: 'campaign', state_id: null,
    scope: 'dimension', severity: 'warning', cooldown_seconds: 0, condition: { window_hours: 24, baseline_days: 7, min_n: 30, direction: 'down', floor: 0.7 }, replaces_legacy: [], seeded: true, is_enabled: false, firing: [], last_evaluated_at: null, ...over,
  })
  it('describes a metric rule with its window, bound and sample gate', () => {
    expect(ruleSource(rule({}))).toBe('Delivery rate per campaign · 1d vs 7d baseline · below 70% · n ≥ 30')
    expect(ruleSource(rule({ source_kind: 'event', event_source: 'inbox', scope: 'watched' }))).toBe('Inbox events · watched subjects')
  })
  it('evidence facts skip what is absent', () => {
    const s = { id: '1', rule_key: 'r', severity: 'warning', subject_type: 'campaign', subject_id: 'C1', title: 't', body: null, evidence: { value_pct: 61.5, n: 120, baseline_pct: null }, source_event_id: null, deep_link: null, status: 'new', fired_at: '', acknowledged_at: null, resolved_at: null, resolve_reason: null, notification_event_id: null } as SignalRow
    expect(evidenceFacts(s)).toEqual([{ label: 'Value', value: '61.5%' }, { label: 'Sample', value: '120' }])
  })
  it('red is for critical only', () => {
    expect(SEVERITY_TONE.critical).toBe('crit')
    expect(Object.entries(SEVERITY_TONE).filter(([, t]) => t === 'crit').map(([k]) => k)).toEqual(['critical'])
  })
})

describe('watch targets', () => {
  it('a seller is watched by thread key; buyers are not watchable', () => {
    expect(watchTargetOf({ type: 'seller', id: 'x', hint: { thread_key: 'phone:+15550001111' } })).toEqual({ type: 'seller', id: '+15550001111' })
    expect(watchTargetOf({ type: 'seller', id: '+1555' }, null)).toEqual({ type: 'seller', id: '+1555' })
    expect(watchTargetOf({ type: 'property', id: 'p', hint: { property_id: 'P9' } })).toEqual({ type: 'property', id: 'P9' })
    expect(watchTargetOf({ type: 'campaign', id: 'C1' })).toEqual({ type: 'campaign', id: 'C1' })
    expect(watchTargetOf({ type: 'buyer', id: 'B1' })).toBeNull()
  })
  it('canonical keys unify legacy thread/phone: rows with seller watches', () => {
    expect(canonicalWatchKey('thread', 'phone:+15550001111')).toBe('seller:+15550001111')
    expect(canonicalWatchKey('seller', '+15550001111')).toBe('seller:+15550001111')
    expect(canonicalWatchKey('property', 'P9')).toBe('property:P9')
  })
})
