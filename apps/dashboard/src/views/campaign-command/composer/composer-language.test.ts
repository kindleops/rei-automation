import { describe, expect, it } from 'vitest'
import { templateLanguageKey } from './composer-language'

describe('templateLanguageKey', () => {
  it('maps the seller-data Hindi label to the template catalog label', () => {
    expect(templateLanguageKey('Asian Indian (Hindi or Other)')).toBe('Indian (Hindi or Other)')
    expect(templateLanguageKey('Indian (Hindi or Other)')).toBe('Indian (Hindi or Other)')
  })
  it('treats no stated language as English', () => {
    expect(templateLanguageKey('unknown')).toBe('English')
    expect(templateLanguageKey('')).toBe('English')
    expect(templateLanguageKey(null)).toBe('English')
  })
  it('passes other languages through unchanged', () => {
    expect(templateLanguageKey('Spanish')).toBe('Spanish')
    expect(templateLanguageKey('Farsi')).toBe('Farsi')
  })
})
