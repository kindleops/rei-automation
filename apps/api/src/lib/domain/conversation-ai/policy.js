// Conversation Engine 2.0 — AI REPLY POLICY (R1/R2: SHADOW ONLY).
//
// This policy is SEPARATE from template auto-reply approval (auto_reply_mode /
// followup_automation_mode / sms_templates approval). Turning template
// auto-reply on never turns AI replies on, and vice versa.
//
// Two different questions, two different answers:
//   shadowAllowed(policy, env)  may R1/R2 run (model calls, shadow records)?
//                               Needs AI_CONVERSATION_SHADOW_ENABLED=true AND
//                               policy.shadow_enabled AND the kill switch released.
//   assertSendAllowed(policy)   may an AI draft be SENT? In R1/R2 the answer is
//                               ALWAYS no: there is no send path in this release.
//                               Even a policy with enabled=true and the kill switch
//                               released is refused with NO_SEND_PATH_IN_RELEASE.
//
// The PROPOSED table conversation_ai_reply_policy mirrors DEFAULT_AI_REPLY_POLICY.

export const AI_REPLY_POLICY_VERSION = 'conv-ai.policy.v1'
export const CONVERSATION_AI_RELEASE = 'R1+R2-shadow'
export const SHADOW_ENV_FLAG = 'AI_CONVERSATION_SHADOW_ENABLED'

export const DEFAULT_AI_REPLY_POLICY = Object.freeze({
  policy_version: AI_REPLY_POLICY_VERSION,
  enabled: false, // AI replies may be sent (R3+ only; refused in R1/R2 regardless)
  shadow_enabled: false, // R1/R2 may run in shadow on live inbound (owner approval required)
  kill_switch_engaged: true, // engaged = everything (shadow model calls included) stops
  scopes: Object.freeze({ market_ids: Object.freeze([]), campaign_ids: Object.freeze([]), asset_classes: Object.freeze(['sfr']) }),
  allowed_categories: Object.freeze(['ownership_confirmed', 'who_is_this', 'interested', 'conditional_interest', 'not_interested', 'asking_price_provided', 'asks_offer', 'condition_disclosed', 'price_and_condition', 'acknowledgement']),
  never_categories: Object.freeze(['opt_out', 'hostile_or_legal', 'wrong_number', 'ownership_denied', 'counter_or_negotiation', 'multi_property']),
  models: Object.freeze({ default: 'family:haiku@5.5', escalation: 'family:sonnet@5.5' }),
  frequency: Object.freeze({ max_ai_replies_per_thread_per_day: 1, max_ai_replies_per_thread_total: 4, min_minutes_between_ai_replies: 60, max_ai_replies_per_day_global: 0 }),
  stage_bounds: Object.freeze({ min: 'S1_ownership', max: 'S4_condition' }),
  hours: Object.freeze({ start_local_hour: 8, end_local_hour: 21, recipient_local: true }),
  budgets: Object.freeze({ daily_usd: 0, per_decision_max_usd: 0.02, monthly_usd: 0 }),
  min_confidence: 0.85,
  require_human_approval_for_money: true,
})

export const POLICY_KEYS = Object.freeze(Object.keys(DEFAULT_AI_REPLY_POLICY))

/** Normalise a policy row; anything missing or malformed falls back to the SAFE default. */
export function normalizePolicy(row = null) {
  const p = { ...DEFAULT_AI_REPLY_POLICY }
  if (!row || typeof row !== 'object') return Object.freeze(p)
  for (const k of POLICY_KEYS) if (k in row && row[k] !== undefined && row[k] !== null) p[k] = row[k]
  // booleans must be real booleans; a truthy string never enables anything
  p.enabled = row.enabled === true
  p.shadow_enabled = row.shadow_enabled === true
  p.kill_switch_engaged = row.kill_switch_engaged !== false
  return Object.freeze(p)
}

export function shadowAllowed(policy = DEFAULT_AI_REPLY_POLICY, env = process.env) {
  const p = normalizePolicy(policy)
  if (p.kill_switch_engaged) return { allowed: false, code: 'KILL_SWITCH_ENGAGED' }
  if (String(env?.[SHADOW_ENV_FLAG] ?? '').trim() !== 'true') return { allowed: false, code: 'SHADOW_ENV_OFF' }
  if (!p.shadow_enabled) return { allowed: false, code: 'SHADOW_POLICY_OFF' }
  return { allowed: true, code: 'SHADOW_ALLOWED' }
}

/**
 * The send gate. In R1/R2 there is no send path, so this NEVER returns allowed.
 * Order: kill switch → enabled → release.
 */
export function assertSendAllowed(policy = DEFAULT_AI_REPLY_POLICY) {
  const p = normalizePolicy(policy)
  if (p.kill_switch_engaged) return { allowed: false, code: 'KILL_SWITCH_ENGAGED' }
  if (!p.enabled) return { allowed: false, code: 'AI_REPLY_POLICY_DISABLED' }
  return { allowed: false, code: 'NO_SEND_PATH_IN_RELEASE', release: CONVERSATION_AI_RELEASE }
}

/** Every shadow record carries this. */
export const SHADOW_SEND_STATUS = 'not_sent_shadow'
