// LeadCommand Global AI Agent — human approval contracts (S1).
//
// Pure ESM, no imports. Source of truth: global-ai-agent-architecture.md §3.6
// (approval tokens), §3.7 (roles), §13 O5 (named-user identity first).
//
// What the UI may rely on:
//  * An approval covers EXACTLY one payload (payload_hash). A batch card is N
//    approvals with per-item toggles; one click grants only the checked items.
//  * Approvals are scoped (one tool, one resolved target set), expiring and
//    single-use. The model never sees or handles approval tokens.
//  * Granting requires a VERIFIED, NAMED user identity. Until real identity
//    exists (S7), every grant is refused with IDENTITY_REQUIRED and the card
//    must say so ("Approval unavailable: named-user sign-in required").
//  * The approval endpoint is not a tool; content (SMS, web pages, notes,
//    research documents) can never create, grant or consume an approval.

/** @typedef {'requested'|'granted'|'denied'|'expired'|'invalidated'|'consumed'} ApprovalState */
export const APPROVAL_STATES = Object.freeze(['requested', 'granted', 'denied', 'expired', 'invalidated', 'consumed'])
export const APPROVAL_TERMINAL_STATES = Object.freeze(['denied', 'expired', 'invalidated', 'consumed'])

/** @typedef {'operator'|'lead'|'owner'} Role */
export const ROLES = Object.freeze(['operator', 'lead', 'owner'])
export const ROLE_RANK = Object.freeze({ operator: 1, lead: 2, owner: 3 })

/** Default TTLs (ms) by approval class (§3.6). */
export const APPROVAL_TTL_MS = Object.freeze({
  default: 10 * 60 * 1000,
  sms: 5 * 60 * 1000,
  campaign_launch: 30 * 60 * 1000,
})

/** Fresh-auth window for high-impact approvals (O5): re-auth ≤ 5 min. */
export const FRESH_AUTH_MAX_AGE_MS = 5 * 60 * 1000

/** Refusal codes the approval service returns (UI shows the matching copy). */
export const APPROVAL_REFUSAL_CODES = Object.freeze({
  IDENTITY_REQUIRED: 'Approval unavailable: named-user sign-in is required before any consequential action.',
  FRESH_AUTH_REQUIRED: 'Re-authenticate to approve this high-impact action.',
  ROLE_NOT_ALLOWED: 'Your role cannot approve this action.',
  HASH_MISMATCH: 'This approval no longer matches what was shown. Review the updated request.',
  APPROVAL_EXPIRED: 'This approval expired. Ask the agent to prepare it again.',
  APPROVAL_NOT_PENDING: 'This approval was already decided.',
  APPROVAL_ALREADY_CONSUMED: 'This approval was already used.',
  PRECONDITION_DRIFT: 'The underlying records changed since this was prepared.',
  IDENTICAL_PROPOSAL_DENIED: 'An identical request was already declined in this run.',
  UNTRUSTED_ORIGIN: 'Requests originating from message or document content cannot be approved from content.',
})

/**
 * A single effect line on an approval card, in LCConfirm language:
 * "Sends 1 SMS to ••4471 (Houston) from ••1600 · English · template-free reply".
 * @typedef {Object} ApprovalEffect
 * @property {string} summary             user-facing, sanitized (masked phones only)
 * @property {'contact'|'money_stage'|'materialize'|'schedule'|'protective'|'budget'|'other'} kind
 * @property {boolean} reversible
 * @property {string|null} undo_note      what undo cannot reverse
 */

/**
 * Approval request as rendered on the card (payload of `approval.requested`).
 * @typedef {Object} ApprovalRequest
 * @property {string} approval_id
 * @property {string} run_id
 * @property {string} tool_call_id
 * @property {string} tool
 * @property {number} tool_version
 * @property {'T3'} tier
 * @property {string} payload_hash_prefix   first 12 hex chars (full hash never needs display)
 * @property {string} payload_hash          full sha256 hex; echoed back by the grant call
 * @property {ApprovalEffect[]} effects
 * @property {string[]} precondition_summary  e.g. ['Campaign is still a draft', 'Outbound paused: send will be held']
 * @property {string} target_scope_summary  e.g. '1 thread · Houston'
 * @property {Role} required_role
 * @property {boolean} fresh_auth_required
 * @property {boolean} owner_only
 * @property {string} requested_at
 * @property {string} expires_at
 * @property {ApprovalState} state
 * @property {{ basis: 'turn'|'plan'|'untrusted_content', label: string }} provenance
 *           e.g. { basis: 'untrusted_content', label: 'Proposed from: inbound SMS 10-08 14:02' }
 * @property {string|null} batch_id         set when shown inside a batch card
 * @property {boolean} identity_available   false until named-user identity exists (S7)
 */

/** Hash prefix length shown in events/cards. */
export const PAYLOAD_HASH_PREFIX_LEN = 12
