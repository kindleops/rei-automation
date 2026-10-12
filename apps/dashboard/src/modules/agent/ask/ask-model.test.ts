import { describe, expect, it } from 'vitest'
import {
  budgetMeter, buildTimeline, citationsOf, classifyFailure, composeAsk, composerKeyAction, escalationOf, followUpsOf, globalKeyAction, isBlockingFailure,
  mentionAt, modelIndicator, parseSlash, removeMentionText, shortModelName, slashMatches, summarizeTimeline, SLASH_COMMANDS,
  type AskRun, type AskStatus, type MentionChip,
} from './ask-model'
import { normalizeRun, normalizeStatus } from './ask-transport'

const STATUS: AskStatus = normalizeStatus({
  ok: true, enabled: true, mode_ok: true,
  models: { ok: true, default: { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }, escalation: { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' } },
  caps: { day_usd: 10, user_day_usd: 10, cycle_usd: 150, run_usd: 2.5 },
  spend: { day_usd: 0.42, cycle_usd: 3.1, day_remaining_usd: 9.58, cycle_remaining_usd: 146.9 },
  runs_today: 3, daily_run_cap: 40, limits: { question_max_chars: 2000 },
  tools: [{ name: 'eg.distress_signals', label: 'Reading distress signals' }, { name: 'campaign.overview', label: 'Reading campaign overview' }],
})

const RUN: AskRun = normalizeRun({
  run_id: 'ask_abcdefgh1234', state: 'completed', outcome: 'completed', latency_ms: 14200, cost_usd: 0.0312,
  models: { default: 'claude-haiku-5-5', escalation: 'claude-sonnet-5-5' },
  counters: { model_calls: 3, escalated_calls: 1, escalated_usd: 0.02, tool_calls: 2 },
  answer: { answer_md: 'Summary. Property 1000001 shows a tax lien.\n\n- **Evidence**: eg.distress_signals', property_ids: ['1000001', '1000002'] },
  calls: [{ model: 'claude-haiku-5-5', route: 'default', input_tokens: 1200, output_tokens: 90 }, { model: 'claude-sonnet-5-5', route: 'escalation', input_tokens: 4000, output_tokens: 600 }],
  audit: [
    { kind: 'run_start', name: 'research.ask' },
    { kind: 'model_call', name: 'claude-haiku-5-5', latency_ms: 900, cost_usd: 0.002, outcome: 'tool_use' },
    { kind: 'tool_call', name: 'eg.distress_signals', rows_returned: 4, latency_ms: 210, outcome: 'ok' },
    { kind: 'tool_call', name: 'campaign.overview', rows_returned: 0, latency_ms: 30000, outcome: 'TOOL_TIMEOUT' },
    { kind: 'escalation', name: 'claude-sonnet-5-5', outcome: 'multi_property_synthesis' },
    { kind: 'model_call', name: 'claude-sonnet-5-5', latency_ms: 6000, cost_usd: 0.02, outcome: 'end_turn' },
    { kind: 'run_end', outcome: 'completed' },
  ],
})!

const prop = (id: string, label = `Addr ${id}`): MentionChip => ({ key: `property:${id}`, kind: 'property', id, label, detail: null, property_ids: [id] })

describe('slash commands map to the read-only research modes', () => {
  it('parses a complete command and its text', () => {
    const p = parseSlash('/compare which is strongest?')
    expect(p.command?.id).toBe('compare')
    expect(p.command?.mode).toBe('multi_property_synthesis')
    expect(p.rest).toBe('which is strongest?')
  })
  it('a partial command opens the popover, plain text is not a command', () => {
    expect(parseSlash('/inc').partial).toBe('inc')
    expect(slashMatches('inc', { quickScan: true }).map((c) => c.id)).toEqual(['inconsistencies'])
    expect(parseSlash('what is /this').command).toBeNull()
    expect(SLASH_COMMANDS.map((c) => c.id)).toEqual(['research', 'compare', 'inconsistencies', 'explain', 'quick-scan'])
    expect(SLASH_COMMANDS.find((c) => c.id === 'inconsistencies')?.mode).toBe('contradiction_analysis')
  })
})

describe('@-mentions', () => {
  it('detects a bare term, a kind token and HOT LEADS at the caret', () => {
    expect(mentionAt('look at @dal', 12)).toMatchObject({ kind: null, term: 'dal', start: 8 })
    expect(mentionAt('@campaign spring ', 17)).toMatchObject({ kind: 'campaign', term: 'spring' })
    expect(mentionAt('@hot', 4)).toMatchObject({ kind: 'hot_leads' })
    expect(mentionAt('email me@x', 10)).toBeNull()
    expect(mentionAt('@dal then more', 14)).toBeNull()
  })
  it('removes the query text when a chip is attached', () => {
    const q = mentionAt('compare @dal now', 12)!
    expect(removeMentionText('compare @dal now', q).text).toBe('compare now')
  })
})

describe('the request sent to POST /ask', () => {
  it('property chips → property_ids, campaign → campaign_id, command framing first', () => {
    const r = composeAsk({ text: 'which is strongest?', command: SLASH_COMMANDS[1], chips: [prop('1000001'), prop('1000002'), { key: 'campaign:x', kind: 'campaign', id: '11111111-2222-3333-4444-555555555555', label: 'Spring', detail: null, property_ids: [] }] })
    expect(r.context).toEqual({ campaign_id: '11111111-2222-3333-4444-555555555555', property_ids: ['1000001', '1000002'] })
    expect(r.question.startsWith('Compare the properties in context')).toBe(true)
    expect(r.question.endsWith('which is strongest?')).toBe(true)
  })
  it('caps context at 10 properties and says so; owner names never leave (id only)', () => {
    const many = Array.from({ length: 14 }, (_, i) => prop(String(2000000 + i)))
    const owner: MentionChip = { key: 'owner:mo_9', kind: 'owner', id: 'mo_9', label: 'Jane Q Owner', detail: null, property_ids: ['3000001'] }
    const r = composeAsk({ text: 'x', command: null, chips: [...many, owner] })
    expect(r.context.property_ids).toHaveLength(10)
    expect(r.notes.join(' ')).toMatch(/5 were left out/)
    expect(r.question).toContain('master owner record mo_9')
    expect(r.question).not.toContain('Jane')
  })
  it('warns when /compare has fewer than 2 properties', () => {
    expect(composeAsk({ text: '', command: SLASH_COMMANDS[1], chips: [prop('1')] }).notes.join(' ')).toMatch(/2\+ properties/)
  })
})

describe('the run timeline', () => {
  const steps = buildTimeline(RUN, STATUS.tools)
  it('turns audit rows into tool / model / escalation steps with rows and timing', () => {
    expect(steps.map((s) => s.kind)).toEqual(['model', 'tool', 'tool', 'escalation', 'model'])
    expect(steps[1]).toMatchObject({ title: 'Reading distress signals', name: 'eg.distress_signals', rows: 4, latency_ms: 210, ok: true })
    expect(steps[2]).toMatchObject({ ok: false, outcome: 'TOOL_TIMEOUT' })
    expect(steps[4]).toMatchObject({ title: 'Deeper analysis', name: 'Sonnet 5.5' })
    expect(summarizeTimeline(steps)).toEqual({ tools: 2, rows: 4, models: 2, failed: 1 })
  })
  it('names the escalation and its reason', () => {
    expect(escalationOf(RUN)).toMatchObject({ model: 'Sonnet 5.5', reason: 'multi-property synthesis', calls: 1 })
  })
})

describe('model indicator + budget meter (from the status endpoint)', () => {
  it('shows Haiku 5.5 → Sonnet 5.5', () => {
    expect(modelIndicator(STATUS)).toMatchObject({ primary: 'Haiku 5.5', escalation: 'Sonnet 5.5', ok: true })
    expect(shortModelName('claude-sonnet-5-5-20261001')).toBe('Sonnet 5.5')
  })
  it('meters today against the $10 cap with tones', () => {
    expect(budgetMeter(STATUS)).toMatchObject({ label: '$0.42 / $10', tone: 'calm' })
    expect(budgetMeter({ ...STATUS, spend: { ...STATUS.spend, day_usd: 9.5 } })?.tone).toBe('crit')
    expect(budgetMeter({ ...STATUS, caps: { ...STATUS.caps, day_usd: 0 } })?.tone).toBe('off')
  })
})

describe('citations + follow-ups', () => {
  it('evidence cards deep-link to the property, the EG filter and the campaign', () => {
    const c = citationsOf(RUN, [prop('1000001', '12 Synthetic Ln')])
    expect(c[0]).toMatchObject({ title: '12 Synthetic Ln', href: '/entity-graph/property/1000001', cited: true })
    expect(c[1]).toMatchObject({ title: 'Property ••0002', cited: false })
    expect(c.find((x) => x.kind === 'eg_filter')?.href).toMatch(/^\/entity-graph\?eg_tab=properties&eg_ff=/)
  })
  it('suggests compare / inconsistencies, never a send or offer', () => {
    const f = followUpsOf(RUN, [], 'research')
    expect(f.map((x) => x.id)).toEqual(['compare', 'inconsistencies', 'explain'])
    expect(JSON.stringify(f)).not.toMatch(/send|offer|text the seller/i)
  })
})

describe('failures', () => {
  it('a 403 is the clean "not enabled for your account" state', () => {
    const f = classifyFailure(403, 'NOT_ALLOWLISTED')
    expect(f.kind).toBe('not_allowlisted')
    expect(f.message).toMatch(/not enabled for your account/)
    expect(isBlockingFailure(f)).toBe(true)
    expect(classifyFailure(404, null).kind).toBe('disabled')
    expect(classifyFailure(429, 'DAILY_RUN_CAP', 'cap').kind).toBe('rate_limited')
    expect(isBlockingFailure(classifyFailure(500, null))).toBe(false)
  })
  it('refuses a fixture on the live channel', () => {
    expect(normalizeRun({ run_id: 'ask_x', state: 'weird' })?.state).toBe('running')
  })
})

describe('shortcuts', () => {
  const base = { popoverOpen: false, empty: false, running: false, chips: 0 }
  it('⌘↩ and ↩ send, ⇧↩ breaks a line, Esc closes, ⌘⌫ stops a running turn', () => {
    expect(composerKeyAction({ key: 'Enter', metaKey: true }, base)).toBe('send')
    expect(composerKeyAction({ key: 'Enter' }, base)).toBe('send')
    expect(composerKeyAction({ key: 'Enter', shiftKey: true }, base)).toBe('newline')
    expect(composerKeyAction({ key: 'Escape' }, base)).toBe('close')
    expect(composerKeyAction({ key: 'Backspace', metaKey: true }, { ...base, running: true })).toBe('stop')
    expect(composerKeyAction({ key: 'Enter', isComposing: true }, base)).toBeNull()
  })
  it('with the popover open, arrows navigate, ↩/Tab pick and Esc only dismisses it', () => {
    const p = { ...base, popoverOpen: true }
    expect(composerKeyAction({ key: 'ArrowDown' }, p)).toBe('popover-next')
    expect(composerKeyAction({ key: 'ArrowUp' }, p)).toBe('popover-prev')
    expect(composerKeyAction({ key: 'Enter' }, p)).toBe('popover-pick')
    expect(composerKeyAction({ key: 'Tab' }, p)).toBe('popover-pick')
    expect(composerKeyAction({ key: 'Escape' }, p)).toBe('popover-close')
  })
  it('Backspace on an empty field removes the last chip', () => {
    expect(composerKeyAction({ key: 'Backspace' }, { ...base, empty: true, chips: 2 })).toBe('remove-last-chip')
  })
  it('⌘L focuses the dock, ⌘⇧L toggles the palette, ⌘K is claimed only inside the agent', () => {
    expect(globalKeyAction({ key: 'l', metaKey: true }, { insideAgent: false })).toBe('focus-dock')
    expect(globalKeyAction({ key: 'L', metaKey: true, shiftKey: true }, { insideAgent: false })).toBe('toggle-palette')
    expect(globalKeyAction({ key: 'k', metaKey: true }, { insideAgent: false })).toBeNull()
    expect(globalKeyAction({ key: 'k', ctrlKey: true }, { insideAgent: true })).toBe('focus-composer')
    expect(globalKeyAction({ key: 'l' }, { insideAgent: false })).toBeNull()
  })
})
