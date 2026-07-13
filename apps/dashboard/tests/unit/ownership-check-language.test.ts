import { describe, expect, it } from 'vitest'
import {
  canonicalizeOwnershipCheckLanguage,
  languagesMatchForOwnershipCheck,
  resolveOwnershipCheckSellerLanguage,
} from '../../src/domain/map/ownership-check-language'

describe('ownership check language matching', () => {
  it('canonicalizes Asian Indian seller language to the Supabase template language', () => {
    expect(canonicalizeOwnershipCheckLanguage('Asian Indian (Hindi or Other)')).toBe('Indian (Hindi or Other)')
  })

  it('matches Asian Indian sellers to Indian (Hindi or Other) templates', () => {
    expect(
      languagesMatchForOwnershipCheck(
        'Asian Indian (Hindi or Other)',
        'Indian (Hindi or Other)',
      ),
    ).toBe(true)
  })

  it('matches Mandarin, Chinese, and zh seller aliases', () => {
    expect(languagesMatchForOwnershipCheck('Chinese', 'Mandarin')).toBe(true)
    expect(languagesMatchForOwnershipCheck('zh-CN', 'Mandarin')).toBe(true)
  })

  it('prefers prospect language preference over master owner best_language', () => {
    expect(resolveOwnershipCheckSellerLanguage({
      prospectLanguagePreference: 'Spanish',
      languagePreference: 'English',
      bestLanguage: 'English',
      ownerBestLanguage: 'English',
    })).toBe('Spanish')
  })

  it('never downgrades a non-English seller to English when prospect language is present', () => {
    expect(resolveOwnershipCheckSellerLanguage({
      prospectLanguagePreference: 'Arabic',
      ownerBestLanguage: 'English',
    })).toBe('Arabic')
  })
})