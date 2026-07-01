/**
 * Canonical language normalization for campaign targets and template matching.
 */

import {
  normalizeLanguage,
  resolveLanguage,
  isUnsupportedTemplateLanguage,
  CANONICAL_LANGUAGE_SET,
} from '@/lib/sms/language_aliases.js'

export {
  normalizeLanguage,
  resolveLanguage,
  isUnsupportedTemplateLanguage,
  CANONICAL_LANGUAGE_SET,
}

export function templateCatalogLanguage(value) {
  const resolved = resolveLanguage(value)
  if (resolved.unsupported) return { language: String(value ?? '').trim(), unsupported: true }
  const canonical = resolved.canonical || String(value ?? '').trim()
  if (canonical === 'Asian Indian (Hindi or Other)') {
    return { language: 'Indian (Hindi or Other)', unsupported: false }
  }
  return { language: canonical, unsupported: false }
}

export function canonicalLanguageLabel(value) {
  const resolved = resolveLanguage(value)
  if (resolved.canonical) return resolved.canonical
  if (resolved.unsupported) return String(value ?? '').trim()
  return String(value ?? '').trim() || 'Unknown'
}