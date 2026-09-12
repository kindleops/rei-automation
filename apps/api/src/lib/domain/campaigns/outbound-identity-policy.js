/**
 * OPS-1 — OUTBOUND IDENTITY CONTINUITY.
 *
 * WHAT THE AUDIT FOUND. `{{agent_name}}` resolves per send from
 * `master_owners.agent_persona`, so the human a seller believes they are
 * talking to is a property of whichever OWNER ROW was joined on that turn —
 * not of the conversation. Twelve-plus personas exist (Helen Crawford 26,360
 * owners, Michael Hargrove 16,989, Carlos Mendez 7,213, ...) with nothing
 * tying a persona to a market, a sender number, or a thread.
 *
 * Nothing today prevents a seller hearing from "Helen" on the first touch and
 * "Carlos" on the follow-up, if a different join, template path or owner
 * record is involved. To the seller that is not a routing detail — it reads as
 * a different person, or as a bot.
 *
 * WHAT THIS MODULE DOES. Binds a thread to ONE persona per channel, and makes
 * every later message on that thread reuse the binding regardless of which
 * template, sender number or code path produced it. A persona may change only
 * through an explicit handoff event.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not choose the business identity
 * model. Whether the company should present one named operator, a small
 * approved pool, market-specific personas, or transparent company/AI identity
 * is a brand and legal decision, not an engineering one — and today's
 * behaviour (an arbitrary owner row decides) is an accident, not a policy. So
 * when no approved persona can be resolved this HOLDS rather than falling back
 * to the owner-level value, which would quietly re-enact the accident.
 *
 * CROSS-CHANNEL. The binding is keyed by (thread, channel) with a shared
 * persona, so email and voice can later reuse the same identity instead of
 * inventing their own. Those channels are not built here.
 */

const clean = (value) => String(value ?? '').trim()

export const IDENTITY_HOLD = Object.freeze({
  UNRESOLVED: 'identity_policy_unresolved',
  NOT_APPROVED: 'persona_not_in_approved_pool',
  CONFLICT: 'thread_identity_conflict',
})

export const IDENTITY_CHANNEL = Object.freeze({
  SMS: 'sms',
  EMAIL: 'email',
  VOICE: 'voice',
})

/**
 * The approved pool is EMPTY until a policy decision is made.
 *
 * Deliberate. An empty pool means every thread without an existing binding
 * holds for review, which is the correct behaviour while the identity question
 * is open: it is better to send nothing than to keep assigning whichever of
 * twelve names an owner row happens to carry. Populating this is a business
 * decision, and doing it silently here would BE the decision.
 */
export const APPROVED_PERSONA_POOL = Object.freeze([])

export function isPersonaApproved(persona) {
  const name = clean(persona)
  if (!name) return false
  if (!APPROVED_PERSONA_POOL.length) return false
  return APPROVED_PERSONA_POOL.includes(name)
}

/**
 * Resolve the identity for an outbound on a thread.
 *
 * An EXISTING binding always wins — including over an owner-level persona that
 * disagrees. That precedence is the whole point: continuity is a promise to
 * the seller, and the owner row is exactly the source that drifts.
 *
 * @param {object} input
 * @param {object} [input.existing_binding] row from thread_identity_binding
 * @param {string} [input.proposed_persona] e.g. master_owners.agent_persona
 */
export function resolveThreadIdentity({
  thread_key = null,
  channel = IDENTITY_CHANNEL.SMS,
  existing_binding = null,
  proposed_persona = null,
  sender_phone_e164 = null,
  market = null,
  allow_handoff = false,
  handoff_reason = null,
  now = null,
} = {}) {
  const thread = clean(thread_key)
  const ch = clean(channel) || IDENTITY_CHANNEL.SMS
  const at = now || new Date().toISOString()

  if (!thread) {
    return { ok: false, hold: true, reason: IDENTITY_HOLD.UNRESOLVED, detail: 'missing_thread_key' }
  }

  const bound = clean(existing_binding?.persona)
  if (bound) {
    const proposed = clean(proposed_persona)
    const drifting = Boolean(proposed) && proposed !== bound

    if (drifting && !allow_handoff) {
      // The defect, caught: a different source proposed a different human for
      // an established conversation. The binding wins and the drift is
      // REPORTED rather than silently discarded, so the source can be fixed.
      return {
        ok: true,
        hold: false,
        persona: bound,
        agent_name: bound.split(/\s+/)[0],
        channel: ch,
        source: 'existing_thread_binding',
        drift_detected: true,
        drift_proposed_persona: proposed,
        drift_suppressed: true,
      }
    }

    if (drifting && allow_handoff) {
      if (!isPersonaApproved(proposed)) {
        return { ok: false, hold: true, reason: IDENTITY_HOLD.NOT_APPROVED, detail: proposed }
      }
      return {
        ok: true, hold: false,
        persona: proposed,
        agent_name: proposed.split(/\s+/)[0],
        channel: ch,
        source: 'explicit_handoff',
        handoff: { from: bound, to: proposed, reason: clean(handoff_reason) || null, at },
      }
    }

    return {
      ok: true, hold: false,
      persona: bound,
      agent_name: bound.split(/\s+/)[0],
      channel: ch,
      source: 'existing_thread_binding',
      drift_detected: false,
    }
  }

  // No binding yet: this is the FIRST outbound, and the only point where an
  // identity may legitimately be chosen.
  const proposed = clean(proposed_persona)
  if (!proposed) {
    return { ok: false, hold: true, reason: IDENTITY_HOLD.UNRESOLVED, detail: 'no_persona_proposed' }
  }
  if (!isPersonaApproved(proposed)) {
    // Today this always holds, because the approved pool is intentionally
    // empty pending the policy decision.
    return {
      ok: false, hold: true,
      reason: IDENTITY_HOLD.NOT_APPROVED,
      detail: proposed,
      policy_decision_required: true,
    }
  }

  return {
    ok: true, hold: false,
    persona: proposed,
    agent_name: proposed.split(/\s+/)[0],
    channel: ch,
    source: 'new_thread_binding',
    binding_to_create: {
      thread_key: thread,
      channel: ch,
      persona: proposed,
      sender_phone_e164: clean(sender_phone_e164) || null,
      market: clean(market) || null,
      bound_at: at,
    },
  }
}

/**
 * Identity-model options for the pending business decision. Reported, never
 * chosen here.
 */
export const IDENTITY_POLICY_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'single_named_operator',
    summary: 'One named human identity across all markets and channels.',
    pros: ['simplest continuity', 'one voice to train and supervise'],
    cons: ['one person appears to cover every market', 'volume may strain plausibility'],
  }),
  Object.freeze({
    id: 'small_approved_pool',
    summary: 'A small vetted set of operator identities, bound per thread.',
    pros: ['scales with staffing', 'continuity preserved by binding'],
    cons: ['each identity needs a real accountable owner'],
  }),
  Object.freeze({
    id: 'market_specific_persona',
    summary: 'One identity per market, aligned to the local sender number.',
    pros: ['area code and identity agree', 'natural local framing'],
    cons: ['cross-market threads need an explicit handoff'],
  }),
  Object.freeze({
    id: 'transparent_company_identity',
    summary: 'Company/assistant identity with no personal human name.',
    pros: ['no representation question at all', 'simplest compliance posture'],
    cons: ['measurably different response behaviour', 'changes existing copy'],
  }),
])

export default resolveThreadIdentity
