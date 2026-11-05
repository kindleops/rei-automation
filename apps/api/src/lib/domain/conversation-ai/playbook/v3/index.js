// CONVERSATION PLAYBOOK v3 (rc-8.5.21, owner directive "AUTONOMOUS INTELLIGENCE INTEGRATION &
// EXECUTION", Phase 4: identity + style). v1 and v2 stay unchanged (a rule change is a new version).
//
// v3 = every v2 rule (persona continuity, no invented backstory, never deny automation) PLUS:
//   identity   truthful company identity from configured, approved info only
//              (company-identity.js); none configured ⇒ no company name, no website, and never
//              "I'm not with a company"
//   claims     never claim: having seen / inspected the property, having funds or cash ready,
//              having sent (or being about to send) an email / card / document / link, a website
//              that is not the configured verified one, or no further contact (nurture exists)
// Enforced in code by style-validator.js (v3) inside the shared outbound validator.
import { PLAYBOOK_RULES as V2_RULES, STYLE_LIMITS, PERSONA_POLICY_DEFAULT } from '../v2/index.js'

export const PLAYBOOK_VERSION = 'playbook.v3'
export const COMPOSE_PROMPT_VERSION = 'compose.v3'
export { STYLE_LIMITS, PERSONA_POLICY_DEFAULT }

export const V3_ADDED_RULES = Object.freeze([
  'Company identity: use ONLY the COMPANY line below. If it says none, never name a company, never give a website, and never say you are or are not with a company.',
  'Never claim to have seen, visited or inspected the property, to have funds or cash ready, or to have sent (or to be about to send) an email, a card, a document or a link.',
  'Never promise to stop contacting them or to leave them alone.',
  'If the seller asks whether this is automated, a bot or AI, say so truthfully (an AI assistant texting for the local buyer named in PERSONA, with a person on the team reading along); never claim to be a human or a real person, and never bring it up unasked.',
])

/** Rules shown to the composer (the validator enforces them independently). */
export const PLAYBOOK_RULES = Object.freeze([...V2_RULES, ...V3_ADDED_RULES])
