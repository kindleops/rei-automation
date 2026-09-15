import { describe, expect, it } from 'vitest'
import { TONE_LABEL, rollupCampaigns, targetModePhrase, targetingPhrase, toneOf } from './CampaignCommandMobile'
import type { CampaignSummary } from '../campaigns.types'

/**
 * CAMPAIGN-COMMAND-MOBILE-LOCK-1 §21/§31 — what the mobile card claims.
 *
 * Every fixture below is a shape measured on production on 2026-09-15, because
 * all three defects these tests pin were invisible against invented data:
 *
 *   - the KPI strip read "READY·ACTIVE 0" while 476 targets were ready
 *   - `built`, `previewed` and `failed` all rendered as DRAFT
 *   - 23 campaigns were labelled "no targeting"; 20 of them had targeting
 *
 * The real status mix was: active 2 (both test_mode), paused 2, built 2,
 * draft 11, archived 23 — and ready targets active 453 / paused 20 / draft 3,
 * plus 64 sitting inside archived campaigns.
 */

const campaign = (over: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: 'c1',
  campaign_name: 'Test',
  status: 'draft',
  total_targets: 0,
  ready_targets: 0,
  reply_count: 0,
  ...over,
} as CampaignSummary)

describe('the state badge names the canonical lifecycle state', () => {
  /**
   * These three fell through the bottom of toneOf() and rendered as DRAFT.
   * "Entity Graph · 5 properties" is status `built` with its targets resolved,
   * and it announced itself as though no work had happened.
   */
  it('does not call a built, previewed or failed campaign a draft', () => {
    expect(toneOf(campaign({ status: 'built' as never }))).toBe('built')
    expect(toneOf(campaign({ status: 'previewed' as never }))).toBe('previewed')
    expect(toneOf(campaign({ status: 'failed' as never }))).toBe('failed')
    for (const tone of ['built', 'previewed', 'failed'] as const) {
      expect(TONE_LABEL[tone]).not.toBe('DRAFT')
    }
  })

  /** A failure must never be quieter than a draft. */
  it('gives failure its own label', () => {
    expect(TONE_LABEL[toneOf(campaign({ status: 'failed' as never }))]).toBe('FAILED')
  })

  it('still reads the real lifecycle states', () => {
    expect(toneOf(campaign({ status: 'active' }))).toBe('running')
    expect(toneOf(campaign({ status: 'scheduled' }))).toBe('scheduled')
    expect(toneOf(campaign({ status: 'paused' }))).toBe('paused')
    expect(toneOf(campaign({ status: 'archived' }))).toBe('done')
    expect(toneOf(campaign({ status: 'draft' }))).toBe('draft')
  })

  /**
   * Test mode outranks everything: "no SMS will transmit" is the most
   * important thing about a campaign that has it, even an active one.
   */
  it('lets test mode outrank an active status', () => {
    expect(toneOf(campaign({ status: 'active', operator_state: 'test_mode' } as never))).toBe('test')
  })

  it('falls back to draft for a status it does not know', () => {
    expect(toneOf(campaign({ status: 'some_future_state' as never }))).toBe('draft')
  })
})

describe('targeting state is three different instructions, not one', () => {
  it('names a built target count', () => {
    expect(targetingPhrase(campaign({ total_targets: 311 }))).toBe('311 targets')
  })

  /**
   * The regression: inferred from `total_targets === 0`, which the list could
   * not distinguish from "not built yet" because the projection carried no
   * targeting signal at all. 20 of 23 zero-target campaigns had a definition.
   */
  it('does not claim "no targeting" for a campaign that has targeting', () => {
    const phrase = targetingPhrase(campaign({ total_targets: 0, has_target_definition: true }))
    expect(phrase).toBe('targeting set · not built')
    expect(phrase).not.toContain('no targeting')
  })

  it('says so plainly when there really is no targeting', () => {
    expect(targetingPhrase(campaign({ total_targets: 0, has_target_definition: false })))
      .toBe('no targeting configured')
  })

  it('reads as English for a single target', () => {
    expect(targetingPhrase(campaign({ total_targets: 1 }))).toBe('1 target')
  })
})

describe('the KPI strip counts what it says it counts', () => {
  /** The production mix, reproduced. */
  const book = [
    campaign({ id: 'a1', status: 'active', operator_state: 'test_mode', ready_targets: 303 } as never),
    campaign({ id: 'a2', status: 'active', operator_state: 'test_mode', ready_targets: 150 } as never),
    campaign({ id: 'p1', status: 'paused', ready_targets: 20 }),
    campaign({ id: 'd1', status: 'draft', ready_targets: 3 }),
    campaign({ id: 'z1', status: 'archived', ready_targets: 64 }),
  ]

  /**
   * The defect: ready was summed only for campaigns whose TONE was 'running',
   * and toneOf() returns 'test' before it checks 'active'. Under the
   * canary-only posture nothing qualified, so the strip read 0 above a first
   * row showing "303 ready".
   */
  it('counts ready targets even when every active campaign is in test mode', () => {
    const roll = rollupCampaigns(book)
    expect(roll.readyLive).toBe(476)
    expect(roll.readyLive).toBeGreaterThan(0)
  })

  /** 64 ready targets sat inside archived campaigns. That is not work. */
  it('excludes terminal campaigns from what is actionable', () => {
    const roll = rollupCampaigns(book)
    expect(roll.readyTerminal).toBe(64)
    expect(roll.readyLive + roll.readyTerminal).toBe(540) // the book-wide canonical figure
  })

  /**
   * The posture line said "0 RUNNING" for the same tone-vs-status confusion,
   * while /campaigns reported three operationally engaged campaigns.
   */
  it('counts running by canonical status and reports the test split', () => {
    const roll = rollupCampaigns(book)
    expect(roll.running).toBe(2)
    expect(roll.runningTest).toBe(2)
  })

  it('says zero honestly for an empty book', () => {
    const roll = rollupCampaigns([])
    expect(roll).toMatchObject({ running: 0, runningTest: 0, readyLive: 0, readyTerminal: 0 })
  })
})

describe('explicit and dynamic targeting are never confused', () => {
  /**
   * The two real handoffs on 2026-09-15: "Entity Graph · 5 properties" pinned
   * five ids, and "Tax Delinquent - Poor and Unsound" saved three dimension
   * filters. They promise different things and must read differently.
   */
  it('names a pinned selection and how many were pinned', () => {
    expect(targetModePhrase(campaign({ target_mode: 'explicit', explicit_target_count: 5 })))
      .toBe('Explicit · 5 selected')
  })

  it('names a dynamic cohort without implying a fixed size', () => {
    const phrase = targetModePhrase(campaign({ target_mode: 'dynamic', explicit_target_count: null }))
    expect(phrase).toBe('Dynamic cohort')
    expect(phrase).not.toMatch(/\d/)
  })

  it('does not pass a mixed definition off as purely explicit', () => {
    expect(targetModePhrase(campaign({ target_mode: 'explicit_filtered', explicit_target_count: 3 })))
      .toBe('Explicit 3 + filters')
  })

  it('says nothing when there is no targeting to describe', () => {
    expect(targetModePhrase(campaign({ target_mode: 'none' }))).toBeNull()
    expect(targetModePhrase(campaign())).toBeNull()
  })

  /**
   * The selected count is NOT the built count. campaign_targets is
   * contact-grained: 5 selected resolved to 2 rows, 186 selected to 984. A row
   * that showed only the built number is how a widened cohort hid.
   */
  it('keeps the selected count distinct from the built target count', () => {
    const c = campaign({ target_mode: 'explicit', explicit_target_count: 186, total_targets: 984 })
    expect(targetModePhrase(c)).toBe('Explicit · 186 selected')
    expect(targetingPhrase(c)).toBe('984 targets')
  })
})
