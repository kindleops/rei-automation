import { asString } from '../../lib/data/shared'

const LANGUAGE_ALIASES: Record<string, string> = {
  english: 'English',
  en: 'English',
  spanish: 'Spanish',
  es: 'Spanish',
  espanol: 'Spanish',
  español: 'Spanish',
  portuguese: 'Portuguese',
  pt: 'Portuguese',
  italian: 'Italian',
  it: 'Italian',
  vietnamese: 'Vietnamese',
  vi: 'Vietnamese',
  french: 'French',
  fr: 'French',
  german: 'German',
  de: 'German',
  greek: 'Greek',
  russian: 'Russian',
  ru: 'Russian',
  polish: 'Polish',
  pl: 'Polish',
  arabic: 'Arabic',
  ar: 'Arabic',
  hebrew: 'Hebrew',
  he: 'Hebrew',
  japanese: 'Japanese',
  ja: 'Japanese',
  korean: 'Korean',
  ko: 'Korean',
  mandarin: 'Mandarin',
  'mandarin chinese': 'Mandarin',
  chinese: 'Mandarin',
  zh: 'Mandarin',
  'zh-cn': 'Mandarin',
  cn: 'Mandarin',
  hindi: 'Indian (Hindi or Other)',
  'indian (hindi or other)': 'Indian (Hindi or Other)',
  'asian indian (hindi or other)': 'Indian (Hindi or Other)',
  'asian indian': 'Indian (Hindi or Other)',
}

export const canonicalizeOwnershipCheckLanguage = (value: unknown): string => {
  const raw = asString(value, '').trim()
  if (!raw) return 'English'
  const lowered = raw.toLowerCase()
  if (LANGUAGE_ALIASES[lowered]) return LANGUAGE_ALIASES[lowered]
  return raw
}

export const languagesMatchForOwnershipCheck = (
  sellerLanguage: string,
  templateLanguage: string,
): boolean => {
  const seller = canonicalizeOwnershipCheckLanguage(sellerLanguage)
  const template = canonicalizeOwnershipCheckLanguage(templateLanguage)
  if (seller.toLowerCase() === template.toLowerCase()) return true

  const sellerToken = seller.toLowerCase()
  const templateToken = template.toLowerCase()
  if (sellerToken.includes('hindi') && templateToken.includes('hindi')) return true
  if (sellerToken.includes('indian') && templateToken.includes('indian')) return true
  const mandarinFamily = new Set(['mandarin', 'chinese', 'zh', 'zh-cn', 'cn'])
  if (mandarinFamily.has(sellerToken) && mandarinFamily.has(templateToken)) return true
  return false
}

export type OwnershipCheckLanguageHints = {
  prospectLanguagePreference?: string | null
  languagePreference?: string | null
  bestLanguage?: string | null
  ownerBestLanguage?: string | null
}

/** Prospect/seller language wins over master-owner default for template selection. */
export const resolveOwnershipCheckSellerLanguage = (
  hints: OwnershipCheckLanguageHints = {},
): string => {
  const candidates = [
    hints.prospectLanguagePreference,
    hints.languagePreference,
    hints.bestLanguage,
    hints.ownerBestLanguage,
  ]
  for (const value of candidates) {
    const raw = asString(value, '').trim()
    if (!raw) continue
    return canonicalizeOwnershipCheckLanguage(raw)
  }
  return 'English'
}