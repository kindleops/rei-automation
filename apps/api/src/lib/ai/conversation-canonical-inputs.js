// The ONE production input loader for the canonical conversation runtime (rc-8.5.21, Phase 2).
// Every production caller of decideAndCompose (live shadow, conversation.turn, the review-API
// draft, the inbox.draft_ai_reply capability, R3's fresh-state re-validation) builds its context
// here, so they all see the same thread, ledger inputs, persona / sender continuity, configured
// company identity, recipient zone evidence and eligibility. Read-only: bounded, indexed selects.
import { getSystemValueFresh } from '@/lib/system-control.js'
import { loadShadowContext } from '@/lib/domain/conversation-ai/context-loader.js'
import { resolveThreadContinuity } from '@/lib/domain/conversation-ai/persona-continuity.js'
import { loadCompanyIdentity } from '@/lib/domain/conversation-ai/company-identity.js'
import { dryRunEligibility, hypotheticalReplyRow } from '@/lib/domain/conversation-ai/eligibility-bridge.js'
import { resolveRecipientZones } from '@/lib/domain/queue/reply-timing.js'

export const CANONICAL_INPUTS_VERSION = 'conv-ai.canonical-inputs.v1'
const QUEUE_COLS = 'id,queue_status,use_case_template,created_at,source,inbound_message_id,agent_name,metadata,message_body,from_phone_number'

async function rowsOrThrow(q, code = 'CANONICAL_INPUTS_READ_FAILED') {
  const r = await q
  if (r?.error) throw Object.assign(new Error(code), { code })
  return Array.isArray(r?.data) ? r.data : []
}

/** Composition spend pre-check over the job tracker (the tracker + the DB spend ledger are the hard caps). */
export function composeSpendFor(tracker, { perMessageMaxUsd = 0.02 } = {}) {
  if (!tracker) return null
  return {
    perMessageMaxUsd,
    // the day / month caps live in agent.spend_ledger (runtime reserve); this pre-check bounds one message
    dailyMaxUsd: perMessageMaxUsd * 1000,
    spentTodayUsd: () => Number(tracker.snapshot?.().committed ?? 0) || 0,
    estimateUsd: (route) => (route === 'escalation' ? 0.015 : 0.002),
  }
}

/**
 * @param {{ supabase: object, providerMessageSid: string, inbound?: object|null, now?: string, readSwitch?: Function|null }} a
 * @returns {Promise<null|{ loaded: object, input: object, queueRows: object[], threadState: object|null, continuity: object, companyIdentity: object, recipientZones: object, property_address: string|null, eligibilityFor: Function, version: string }>}
 */
export async function loadCanonicalInputs({ supabase, providerMessageSid, inbound = null, now = new Date().toISOString(), readSwitch = null }) {
  const loaded = await loadShadowContext({ supabase, providerMessageSid, inbound, now })
  if (!loaded) return null
  const tk = loaded.input.inbound.thread_key
  const since = new Date(Date.parse(now) - 75 * 864e5).toISOString()
  const [queueRows, threadState, propRows] = await Promise.all([
    rowsOrThrow(supabase.from('send_queue').select(QUEUE_COLS).eq('thread_key', tk).gte('created_at', since).order('created_at', { ascending: false }).limit(60)),
    rowsOrThrow(supabase.from('inbox_thread_state').select('our_number').eq('thread_key', tk).limit(1)),
    loaded.row.property_id ? rowsOrThrow(supabase.from('properties').select('property_address,property_address_full,owner_address_state').eq('property_id', loaded.row.property_id).limit(1)) : Promise.resolve([]),
  ])
  const continuity = resolveThreadContinuity({ sentRows: queueRows, threadState: threadState[0] || null, inboundTo: loaded.row.to_phone_number })
  const read = readSwitch || ((key) => getSystemValueFresh(key, { supabase }))
  const companyIdentity = await loadCompanyIdentity({ readSwitch: read })
  const mailing = propRows[0]?.owner_address_state ? { state: propRows[0].owner_address_state, zip: null } : null
  const recipientZones = resolveRecipientZones({ recipientPhone: loaded.row.from_phone_number, propertyGeography: loaded.geography, mailingGeography: mailing, storedTimezone: loaded.timezone })
  const row = hypotheticalReplyRow({ sellerPhone: loaded.row.from_phone_number, ourPhone: loaded.row.to_phone_number, threadKey: tk, propertyId: loaded.row.property_id, prospectId: loaded.row.prospect_id, inboundId: loaded.row.id, inboundAt: loaded.input.inbound.at, now })
  const eligibilityFor = ({ now: at = now } = {}) => dryRunEligibility({ row: { ...row, created_at: at }, supabase, timezone: loaded.timezone, geography: loaded.geography, recipientZones, now: at })
  return {
    loaded, input: loaded.input, queueRows, threadState: threadState[0] || null, continuity, companyIdentity, recipientZones,
    property_address: propRows[0]?.property_address || propRows[0]?.property_address_full || null, eligibilityFor, version: CANONICAL_INPUTS_VERSION,
  }
}
