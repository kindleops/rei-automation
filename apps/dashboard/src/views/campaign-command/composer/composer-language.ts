/**
 * Audience language → the label sms_templates uses for it.
 *
 * Seller data writes the Hindi family as "Asian Indian (Hindi or Other)"; the
 * template catalog labels it "Indian (Hindi or Other)". The coverage table
 * compared the two strings exactly, so a Hindi-speaking cohort showed as
 * uncovered next to 306 sendable Hindi templates. Mirrors the API's
 * TEMPLATE_CATALOG_LANGUAGE_ALIASES (apps/api/src/lib/sms/language_aliases.js);
 * the API remains the authority for what is sendable — this only lines labels up.
 * No stated language ('unknown') is English, the documented default.
 */
const CATALOG_ALIASES: Record<string, string> = {
  'asian indian (hindi or other)': 'Indian (Hindi or Other)',
  'unknown': 'English',
}

export function templateLanguageKey(value: string | null | undefined): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return 'English'
  return CATALOG_ALIASES[trimmed.toLowerCase()] ?? trimmed
}
