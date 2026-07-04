/**
 * Entity/corporate name detection for the dashboard's send-time personalization guards.
 *
 * Mirrors ENTITY_TOKENS in apps/api/src/lib/identity/ownerProspectAlignment.js — keep the
 * two lists in sync. A Master Owner display name (LLC, trust, estate, church, ...) must
 * never populate a `first_name`/`seller_first_name`/greeting-name variable; this is the
 * shared check used to block that regardless of which field the string arrived through.
 */

const ENTITY_TOKENS = new Set([
  'llc', 'l.l.c', 'l.l.c.', 'inc', 'incorporated', 'corp', 'corporation',
  'co.', 'company', 'holdings', 'properties', 'property', 'assets',
  'apartments', 'church', 'ministries', 'ministry', 'trust', 'estate',
  'lp', 'llp', 'partners', 'partnership', 'ventures', 'capital',
  'investments', 'investment', 'group', 'fund', 'bank', 'lender',
  'realty', 'management', 'enterprises', 'international', 'associates',
  'assoc', 'ltd', 'limited', 'services', 'systems', 'foundation',
  'university', 'college', 'school', 'board', 'authority', 'department',
  'agency', 'network', 'solutions', 'development', 'resources',
])

/** Returns true if the name contains entity/corporate/trust indicator tokens. */
export const isEntityName = (name: string | null | undefined): boolean => {
  if (!name) return false
  const words = String(name)
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=`~()]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
  return words.some((word) => ENTITY_TOKENS.has(word))
}

/**
 * Returns the given human-name candidate, or '' if it is blank or entity-shaped.
 * Use this to gate any value before it is allowed to populate a first_name/seller_name
 * personalization variable.
 */
export const safeHumanName = (name: string | null | undefined): string => {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return ''
  if (isEntityName(trimmed)) return ''
  return trimmed
}
