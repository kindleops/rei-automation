// JURISDICTIONAL / CONSENT MESSAGING RESTRICTIONS (owner ruling 2026-10-18). Pure, static, CONFIGURABLE.
//
// ONE explicit table of extra sending restrictions per jurisdiction × messaging category, read by
// recipient-window-policy.js#evaluateMessagingWindow (the one verdict the delay planner, R3, the AI row
// gate, the follow-up lifecycle and the queue dispatcher all use). It ships EMPTY: no legal rule is
// invented here. Every entry must come from counsel; the open questions are listed in
// docs/messaging-jurisdiction-questions-for-counsel.md.
//
// Category 1 (active seller-initiated conversation) has NO universal after-hours block; it is neutral
// unless an entry here names it. Categories 2 (campaign outreach) and 3 (scheduled follow-ups) always keep
// the 08:00–21:00 recipient-local base window; an entry can only NARROW a category's hours, never widen.
//
// ENTRY SHAPE (all fields required; an entry failing validateMessagingRestrictions() is rejected):
//   {
//     id:            'fl-quiet-hours-example',              stable id (audit)
//     jurisdiction:  'FL',                                   US state / territory code (upper case)
//     categories:    ['active_seller_conversation', ...],    messaging categories it binds
//     hours:         { start_hour: 8, end_hour: 20 },        permitted recipient-local hours, or
//     blocked:       true,                                   (instead of hours) never permitted
//     citation:      'Fla. Stat. § ... (counsel memo …)',     the legal source, from counsel
//     approved_by:   'counsel name / date',                  who approved the entry
//   }
//
// HOOKS: which jurisdictions a message "is in" (recipient mailing state, property state; area-code
// states are not mapped yet) comes from resolveRecipientWindowZones().jurisdictions. The hours of a
// matched entry are evaluated in every plausible recipient zone (the same intersection rule).
export const MESSAGING_RESTRICTIONS_VERSION = 'messaging-restrictions.v1'

/** THE table. Empty by design (counsel review pending). */
export const MESSAGING_RESTRICTIONS = Object.freeze([])

const clean = (v) => String(v ?? '').trim()

/** Validate a restriction table; returns { ok, errors }. The shipped table must validate. */
export function validateMessagingRestrictions(table = MESSAGING_RESTRICTIONS, categories = null) {
  const errors = []
  if (!Array.isArray(table)) return { ok: false, errors: ['table_not_array'] }
  table.forEach((e, i) => {
    const at = `entry[${i}]`
    if (!e || typeof e !== 'object') { errors.push(`${at}:not_object`); return }
    if (!clean(e.id)) errors.push(`${at}:id_missing`)
    if (!/^[A-Z]{2}$/.test(clean(e.jurisdiction))) errors.push(`${at}:jurisdiction_invalid`)
    if (!Array.isArray(e.categories) || !e.categories.length) errors.push(`${at}:categories_missing`)
    else if (categories && e.categories.some((c) => !categories.includes(c))) errors.push(`${at}:category_unknown`)
    const h = e.hours
    const hoursOk = h && Number.isInteger(h.start_hour) && Number.isInteger(h.end_hour) && h.start_hour >= 0 && h.end_hour <= 24 && h.start_hour < h.end_hour
    if (e.blocked !== true && !hoursOk) errors.push(`${at}:hours_invalid`)
    if (!clean(e.citation)) errors.push(`${at}:citation_missing`)
    if (!clean(e.approved_by)) errors.push(`${at}:approval_missing`)
  })
  return { ok: errors.length === 0, errors }
}
