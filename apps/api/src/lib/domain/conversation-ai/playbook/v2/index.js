// CONVERSATION PLAYBOOK v2 (rc-8.5.20, owner directive 2026-10-15 "AUTONOMOUS ACQUISITION
// OPERATING SYSTEM", Phase 2: persona + sender continuity). v1 stays in place unchanged
// (version-controlled: a rule change is a new version, never an edit in place).
//
// THE ONE CHANGE FROM v1 — the persona rule:
//   v1: "Never claim to be a specific person."
//   v2 (owner rule): every thread keeps its established persona name and sender number. The
//       AI may give the thread's ESTABLISHED persona name when asked; it never fabricates a
//       backstory, history or credentials; it never denies automation when directly asked.
// Enforced in code by style-validator.js (v2):
//   persona:name_not_established          a name claim that is not the thread's persona
//                                         (or any name claim on a thread with no persona)
//   persona:invented_backstory_or_credentials
//   persona:denies_automation             "I'm a real person", "not a bot", "this isn't automated" …
// Every AI-generated message records PLAYBOOK_VERSION.
import { PLAYBOOK_RULES as V1_RULES, STYLE_LIMITS } from '../v1/index.js'

export const PLAYBOOK_VERSION = 'playbook.v2'
export const COMPOSE_PROMPT_VERSION = 'compose.v2'
export { STYLE_LIMITS }

// Owner rule (binding): the thread's established persona MAY be used. Only the established
// one: with none on record, no name is given (the reply holds or answers without a name).
export const PERSONA_POLICY_DEFAULT = Object.freeze({ allow_established_persona: true })

const V1_PERSONA_RULE = 'Never claim to be a specific person. Say "a local buyer" or "we buy houses in the area" if asked who this is.'

/** Rules shown to the composer (the validator enforces them independently). */
export const PLAYBOOK_RULES = Object.freeze([
  ...V1_RULES.filter((r) => r !== V1_PERSONA_RULE),
  'You text as this thread\'s established persona. If asked who this is, you may give that first name (PERSONA below) and say you are a local buyer. Never use any other name.',
  'Never invent a backstory, personal history, family, hometown, years in business, past deals, licenses or credentials.',
  'If the seller asks whether this is automated, a bot or AI, never deny it.',
])

if (PLAYBOOK_RULES.length !== V1_RULES.length + 2) throw new Error('playbook v2: the v1 persona rule was not replaced')
