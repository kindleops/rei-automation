import { describe, expect, it } from 'vitest'
import { AUTO_RUN_STALE_MS, decideAutoRun } from './auto-run-policy'

/**
 * A READ MUST NOT COMMISSION A WRITE.
 *
 * Both of these produced real production match runs on property 24613730
 * before being fixed, so both directions are pinned here.
 */
describe('opening a property does not order a match run by accident', () => {
  const base = { runsLoaded: true, candidateCount: 0, latestRunCreatedAt: null as string | null }

  /**
   * THE PRODUCTION DEFECT. `latestRun === null` also means "the runs query has
   * not returned yet", and the old condition read that as "no run exists".
   * Against production on 2026-09-16 the query lost a race with a 400ms timer
   * and merely opening the page created run 5833ab4a — 63 minutes after the
   * previous run, well inside the 6-hour window.
   */
  it('refuses to decide before the run history has been read', () => {
    const d = decideAutoRun({ ...base, runsLoaded: false })
    expect(d.run).toBe(false)
    expect(d.reason).toBe('runs_not_loaded')
  })

  it('does not confuse "not loaded" with "no run exists"', () => {
    const notLoaded = decideAutoRun({ ...base, runsLoaded: false, latestRunCreatedAt: null })
    const genuinelyNone = decideAutoRun({ ...base, runsLoaded: true, latestRunCreatedAt: null })
    expect(notLoaded.run).toBe(false)
    expect(genuinelyNone.run, 'a property that truly has no run may run one').toBe(true)
    expect(genuinelyNone.reason).toBe('no_run_exists')
  })

  it('leaves a fresh run alone', () => {
    const d = decideAutoRun({ ...base, latestRunCreatedAt: new Date(Date.now() - 63 * 60 * 1000).toISOString() })
    expect(d.run, '63 minutes is well inside the 6-hour window').toBe(false)
    expect(d.reason).toBe('run_is_fresh')
  })

  it('refreshes a genuinely stale run', () => {
    const d = decideAutoRun({ ...base, latestRunCreatedAt: new Date(Date.now() - AUTO_RUN_STALE_MS - 1000).toISOString() })
    expect(d.run).toBe(true)
    expect(d.reason).toBe('run_is_stale')
  })

  /**
   * The OTHER defect: the envelope bug kept candidateCount at 0 forever, so
   * this guard never engaged and every visit ordered a run.
   */
  it('does nothing when candidates are already loaded', () => {
    const d = decideAutoRun({ ...base, candidateCount: 25, latestRunCreatedAt: null })
    expect(d.run).toBe(false)
    expect(d.reason).toBe('has_candidates')
  })

  it('never runs while paused or already running', () => {
    expect(decideAutoRun({ ...base, paused: true }).run).toBe(false)
    expect(decideAutoRun({ ...base, running: true }).run).toBe(false)
  })

  it('decides once per property', () => {
    const d = decideAutoRun({ ...base, alreadyDecided: true })
    expect(d.run).toBe(false)
    expect(d.reason).toBe('already_decided')
  })

  /** A bad timestamp is not evidence of staleness. */
  it('does not order work off an unparseable run date', () => {
    const d = decideAutoRun({ ...base, latestRunCreatedAt: 'not-a-date' })
    expect(d.run).toBe(false)
    expect(d.reason).toBe('run_is_fresh')
  })

  it('exposes the staleness window as six hours', () => {
    expect(AUTO_RUN_STALE_MS).toBe(6 * 60 * 60 * 1000)
  })
})
