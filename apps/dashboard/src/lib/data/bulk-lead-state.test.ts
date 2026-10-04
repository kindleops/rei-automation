import { describe, expect, it } from 'vitest'
import { runPerItem } from './bulkArchiveData'
import { leadOutcomeLine } from './bulkLeadStateData'
import { choiceOptions } from '../../modules/inbox/desk/bulk-choice-options'

describe('bulk lead-state (stage / status / follow-up / snooze / read)', () => {
  it('runs through the same per-item engine: ✓ per row, refusals listed, unconfirmed rechecked', async () => {
    const seen: string[] = []
    let firstPass = true
    const report = await runPerItem({
      ids: ['a', 'b', 'c'],
      confirmedOutcome: 'changed',
      post: async (id) => {
        seen.push(id)
        if (id === 'b') return { ok: true, results: [{ id, ok: false, outcome: 'blocked', reason: 'canonical_stage_transition_refused', message: 'refused' }] }
        if (id === 'c' && firstPass) { firstPass = false; return { ok: false, status: 504, message: 'no answer', timedOut: true } }
        return { ok: true, results: [{ id, ok: true, outcome: id === 'c' ? 'unchanged' : 'changed' }] }
      },
    })
    expect(report.results.map((r) => r.outcome)).toEqual(['changed', 'blocked', 'changed'])
    expect(report.results[2].reason).toBe('confirmed_on_recheck')
    expect(report.changedIds).toEqual(['a', 'c'])
    expect(leadOutcomeLine('stage', report.summary, { one: 'conversation', many: 'conversations' })).toBe('2 conversations stage moved · 1 refused')
  })

  it('stage choices stop at S6; status never offers suppression; follow-up presets are dates', () => {
    const stages = choiceOptions('stage').map((o) => o.value)
    expect(stages).toEqual(['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract'])
    expect(choiceOptions('status').map((o) => o.value)).not.toContain('suppressed')
    const now = Date.parse('2026-10-04T12:00:00Z')
    expect(choiceOptions('follow_up', now).map((o) => o.value)).toEqual(['2026-10-05', '2026-10-07', '2026-10-11', '2026-11-03'])
    expect(choiceOptions('snooze', now)[1].value).toBe('2026-10-05T12:00:00.000Z')
  })
})
