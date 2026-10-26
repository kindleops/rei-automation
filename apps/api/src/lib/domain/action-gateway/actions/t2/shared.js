// Action Gateway Tier-2: shared rules, constants and helpers (pure unless a client is passed in).
//
// Every T2 tool reuses an EXISTING domain service (docs/ACTION-MCP-AUDIT.md §11). The rules here are the
// owner's, restated once for the T2 policies, the T2 database writers (PROPOSED_20261020100000_action_gateway_t2
// mirrors the hard refusals) and the human-path capabilities that execute the request actions.
import crypto from 'node:crypto'
import { maskString } from '../../../../agent/research/pii.js'
import { staticExclusionFor } from '../../../holds/automation-hold-core.js'
import { gwErr } from '../../errors.js'

export const T2_VERSION = 'action-gateway.t2.v1'
export const T2_LINK = 'PROPOSED_20261020100000_action_gateway_t2'

/** The server-derived source of every T2 change: the authenticated agent, never a tool argument (R1). */
export const agentSource = (agentId) => `action_gateway:${String(agentId)}`
export const AGENT_SOURCE_RE = /^action_gateway:agt_[a-z0-9][a-z0-9_]{2,40}$/

/**
 * NEVER REVIVE (owner decisions). Hartford is CLOSED LOST (owner 2026-10-19: never revive); Maxwell is a
 * permanent exclusion (owner handles it, 2026-10-14). Mirrored by action_gateway.t2_never_revive (SQL).
 */
export const NEVER_REVIVE = Object.freeze([
  Object.freeze({ code: 'CLOSED_LOST_NEVER_REVIVE', hold_key: 'owner_hold_20261016:hartford', thread_id: '596a9368-6ef8-40f8-97cb-fcc46e6672d3', property_id: '225438557', opportunity_id: '9b690ce3-ff88-400b-b56e-69e9bd0055b0' }),
  Object.freeze({ code: 'PERMANENT_EXCLUSION', hold_key: 'owner_handled_20261014:maxwell', thread_id: '58d05df2-561d-4c9e-9226-ab3de105d773', property_id: '251027062', opportunity_id: '47da7121-c39d-425a-b608-046750e35027' }),
])
const low = (v) => String(v ?? '').trim().toLowerCase()

/** The never-revive code for any of these identities (or the static exclusion of a thread key / address), else null. */
export function neverReviveCode({ thread_id = null, thread_key = null, property_id = null, opportunity_id = null, hold_key = null, property_address = null } = {}) {
  for (const x of NEVER_REVIVE) {
    if ((hold_key && hold_key === x.hold_key) || (thread_id && low(thread_id) === x.thread_id) || (property_id && String(property_id) === x.property_id)
      || (opportunity_id && low(opportunity_id) === x.opportunity_id)) return x.code
  }
  if (staticExclusionFor({ thread_key, property_id, property_address })) return 'PERMANENT_EXCLUSION'
  return null
}

/** Stages an agent may never request (contract / closing: S6+ and S10 belong to the Closing Desk and finalize_closing_case). */
export const CONTRACT_OR_CLOSING_STAGES = Object.freeze(new Set(['formal_contract', 'contract_to_close', 'disposition', 'under_contract', 'prepared_to_close', 'closed', 'closed_won', 'closed_lost']))
/** The stages an agent may PROPOSE (S1–S5 + needs_review). Mirrored by the T2 database writer. */
export const AGENT_PROPOSABLE_STAGES = Object.freeze(['needs_review', 'ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer'])

/**
 * Dispositions an agent may PROPOSE (universal-lead-state-registry DISPOSITION_CODES minus every
 * contactability / identity code): wrong_number and wrong_person are contact-quality / identity facts that
 * belong to the ownership pipeline, suppression is a compliance path, and none is an agent action.
 */
export const AGENT_DISPOSITIONS = Object.freeze(['interested', 'not_interested', 'referred', 'no_response', 'unqualified', 'duplicate', 'sold', 'declined_unverified'])

/** Temperatures an agent may PROPOSE (universal-lead-state-registry LEAD_TEMPERATURE_CODES minus `unscored`, which is the scoring model's reset, never a proposal). */
export const AGENT_TEMPERATURES = Object.freeze(['cold', 'warm', 'hot'])
/** The evidence class a temperature request rests on (recorded with the request; the human reads it beside the reason). */
export const TEMPERATURE_BASES = Object.freeze(['seller_words', 'seller_price', 'seller_timeline', 'no_response', 'decision_engine', 'property_evidence'])

export const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex')

// the DB's phone-run rule (agent.payload_string_violation): such runs never reach a stored row
const PHONE_RUN = /[0-9](?:[\s().,:/_+·–—-]{0,4}[0-9]){9,14}/g
/** Free text an agent supplies → masked (phones / emails) and digit-run-neutralized, bounded. */
export function cleanText(v, max) {
  const [masked] = maskString(String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max * 2), {})
  return masked.replace(PHONE_RUN, '[number withheld]').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** THE hold authority through the gateway's port; any failure is a hold (fail closed). */
export async function holdVerdict(services, args, capability) {
  let h
  try { h = await services.holdCheck({ ...args, capability }) } catch { h = { held: true, fail_closed: true } }
  if (h?.held !== false) return { decision: 'deny', code: h?.fail_closed ? 'AUTOMATION_HOLD_LOOKUP_FAILED' : 'AUTOMATION_HOLD', evidence: { hold: h?.fail_closed ? 'lookup_failed' : 'held', hold_type: h?.hold_type || null, capability } }
  return null
}

export const deny = (code, evidence = {}) => ({ decision: 'deny', code, evidence })
export const allow = (evidence = {}) => ({ decision: 'allow', evidence })

export async function mustThread(reads, id) {
  const t = await reads.thread(id)
  if (!t?.thread_key) throw gwErr('not_found', 'THREAD_NOT_FOUND', 'no inbox thread with this id')
  return t
}
export const threadResource = (t) => ({ type: 'thread', id: t.id, refs: { thread_key: t.thread_key, thread_id: t.id, property_id: t.property_id || null, market: t.market || null } })

/** STOP / suppression / opt-out of a thread (the gateway's permission read); unreadable = blocked. */
export async function permissionOf(reads, resource) {
  try {
    return await reads.permission({ id: resource.id, thread_key: resource.refs.thread_key })
  } catch {
    return { blocked: true, reasons: ['permission_state_unreadable'] }
  }
}

/** The approval row id an intent's human request is filed under (the database derives the same one). */
export function requestApprovalId(intentId) {
  const h = crypto.createHash('md5').update(`action_gateway_request:${intentId}`, 'utf8').digest('hex')
  return `apr_${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
