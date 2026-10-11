import { describe, expect, it } from 'vitest'
import { CONTACT_SCORE_VENDOR_MAX, contactScore100, contactScoreHint, contactScoreText } from './contact-score'

describe('contact score is shown on a labelled 0–100 scale', () => {
  it('the vendor 0–120 scale maps into 0–100: "105" was never a broken percentage', () => {
    expect(CONTACT_SCORE_VENDOR_MAX).toBe(120)
    expect(contactScore100(105)).toBe(88)
    expect(contactScore100(120)).toBe(100)
    expect(contactScore100(0)).toBe(0)
    expect(contactScore100('60')).toBe(50)
  })
  it('never leaves 0–100, whatever the vendor sends', () => {
    for (const raw of [-5, -1, 0, 1, 59.4, 100, 101, 111, 120, 121, 500]) {
      const s = contactScore100(raw)
      if (s !== null) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(100) }
    }
    expect(contactScore100(500)).toBe(100)
  })
  it('the −1 sentinel and absent values are "not scored", not 0', () => {
    expect(contactScore100(-1)).toBeNull()
    expect(contactScore100(null)).toBeNull()
    expect(contactScore100(undefined)).toBeNull()
    expect(contactScore100('')).toBeNull()
    expect(contactScore100('n/a')).toBeNull()
  })
  it('the display and hint name the scale', () => {
    expect(contactScoreText(105)).toBe('88/100')
    expect(contactScoreText(-1)).toBeNull()
    expect(contactScoreHint(105)).toContain('Vendor value 105 of 120')
    expect(contactScoreHint(null)).toContain('Not scored')
  })
})
