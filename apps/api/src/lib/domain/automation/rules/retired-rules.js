// RETIRED automation rules (refused by the matcher AND the action executor, whatever a stored
// automation_rules row says).
//
// suppression.not_owner_bad_contact — OWNER RULE 2026-10-17 (locked): a property denial is NEVER
// global. It marked the whole PHONE bad_contact, cancelled every pending touch and set the thread
// stage wrong_number for a property-specific "not the owner" / tenant reply. The canonical inbound
// path records that denial per contact × property (contact resolution + the send-time recontact
// guard); phone-wide bad_contact stays only for wrong number / not this person / explicit stop.
export const RETIRED_RULE_KEYS = Object.freeze(new Set(['suppression.not_owner_bad_contact']))
export const isRetiredRule = (rule = {}) => RETIRED_RULE_KEYS.has(String(rule?.rule_key ?? '').trim())
