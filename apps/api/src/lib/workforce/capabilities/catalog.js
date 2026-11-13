// The CLOSED Workforce capability catalog, Phase A (docs/WORKFORCE.md §4.1). Every capability is
// either READ (inline, no side effect) or INTERNAL (writes only Workforce rows, or enqueues an
// existing internal runtime kind). There is no send, offer, stage_write, campaign_launch or contact
// capability; a key outside this catalog is denied by the authority engine.
import { capability as activeOpportunities } from './active-opportunities.js'
import { capability as conversationState } from './conversation-state.js'
import { capability as acquisitionDecision } from './acquisition-decision.js'
import { capability as financeReview } from './finance-review.js'
import { capability as researchProperty } from './research-property.js'
import { capability as rankOpportunities } from './rank-opportunities.js'
import { capability as nextAction } from './next-action.js'
import { capability as workAssign } from './work-assign.js'
import { capability as raiseWorkItem } from './raise-work-item.js'
import { capability as memoryAssert } from './memory-assert.js'

export const CAPABILITY_CLASSES = Object.freeze(['read', 'internal'])
/** read = T0, internal = T1 (Phase A); T2+ would be an Action Gateway mutation — none exists here. */
export const CLASS_TIER = Object.freeze({ read: 'T0', internal: 'T1' })

const ALL = [activeOpportunities, conversationState, acquisitionDecision, financeReview, researchProperty, rankOpportunities, nextAction, workAssign, raiseWorkItem, memoryAssert]
export const CAPABILITIES = Object.freeze(Object.fromEntries(ALL.map((c) => [c.key, c])))
export const CAPABILITY_KEYS = Object.freeze(ALL.map((c) => c.key))

/** Action shapes that are NOT Workforce capabilities in Phase A (named so a refusal can say why). */
export const FORBIDDEN_ACTION_PATTERNS = Object.freeze([
  /(^|[._])(send|sms|text|message|dispatch|contact|call|email|outreach)([._]|$)/,
  /(^|[._])(offer|offers)[._](send|write|create|accept|persist|authorize)/,
  /(^|[._])stage[._]?(write|advance|transition|set)/,
  /(^|[._])campaign[._]?(launch|transition|start|activate|resume)/,
  /(^|[._])(suppression|opt_?out|hold)[._](release|override|clear|ignore)/,
])

export function getCapability(key) {
  return CAPABILITIES[String(key || '')] || null
}
export function isForbiddenAction(key) {
  const k = String(key || '').toLowerCase()
  return FORBIDDEN_ACTION_PATTERNS.some((re) => re.test(k))
}
export const capabilityTier = (cap) => (cap ? CLASS_TIER[cap.class] || null : null)
