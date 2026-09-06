import { describe, expect, it } from 'vitest'
import {
  classifyFailureReason,
  describeFailureReason,
  CONTAINMENT_REASONS,
  VALIDATION_REASONS,
} from './followup-failure-reasons'

describe('N: containment vs validation failure semantics', () => {
  it('does NOT present a missing sending number as containment', () => {
    // The exact bug: a plumbing failure was reported as a safety brake.
    expect(classifyFailureReason('invalid_from_phone_number')).toBe('validation')
    expect(describeFailureReason('invalid_from_phone_number'))
      .toBe('No valid sending number could be resolved. Nothing was queued.')
    expect(describeFailureReason('invalid_from_phone_number')).not.toMatch(/containment/i)
  })

  it('does NOT present an unresolvable sender as containment', () => {
    expect(classifyFailureReason('no_eligible_sender_number')).toBe('validation')
    expect(describeFailureReason('no_eligible_sender_number')).not.toMatch(/containment/i)
  })

  it('DOES present a real safety control as containment', () => {
    expect(classifyFailureReason('followup_disabled')).toBe('containment')
    expect(describeFailureReason('followup_disabled')).toMatch(/Blocked by containment/)
    for (const reason of Object.keys(CONTAINMENT_REASONS)) {
      expect(classifyFailureReason(reason)).toBe('containment')
    }
  })

  it('renders an unknown reason neutrally and preserves the raw code', () => {
    expect(classifyFailureReason('some_new_defect')).toBe('unknown')
    const text = describeFailureReason('some_new_defect')
    expect(text).toMatch(/Scheduling failed/)
    expect(text).toContain('some_new_defect')
    // The critical property: an unidentified defect is never called a brake.
    expect(text).not.toMatch(/containment/i)
  })

  it('no validation reason is ever phrased as containment', () => {
    for (const [reason, text] of Object.entries(VALIDATION_REASONS)) {
      expect(text).not.toMatch(/containment/i)
      expect(classifyFailureReason(reason)).toBe('validation')
    }
  })

  it('every reason states that nothing was queued', () => {
    // An operator must never be left wondering whether a partial send happened.
    for (const text of [...Object.values(CONTAINMENT_REASONS), ...Object.values(VALIDATION_REASONS)]) {
      expect(text).toMatch(/Nothing was queued/)
    }
    expect(describeFailureReason('anything_unknown')).toMatch(/Nothing was queued/)
  })

  it('the two maps never overlap', () => {
    const overlap = Object.keys(CONTAINMENT_REASONS).filter((k) => k in VALIDATION_REASONS)
    expect(overlap).toEqual([])
  })

  it('returns null when there is no reason at all', () => {
    expect(describeFailureReason(null)).toBeNull()
    expect(describeFailureReason(undefined)).toBeNull()
    expect(describeFailureReason('')).toBeNull()
  })
})
