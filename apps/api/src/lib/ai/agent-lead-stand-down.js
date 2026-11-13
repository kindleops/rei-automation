// NO SECOND AI ENGINE ON AN AGENT-HELD LEAD (link #32, owner architecture correction 2026-10-29: "Agntei owns the
// intelligence and conversation"). When an Agntei AI employee holds a lead (action_gateway.lead_assignments, read through
// public.lc_agent_lead_holder), the conversation is THAT agent's: LeadCommand's own conversation engine stands down there
// — no model decision (the conversation.decide shadow, the conversation.turn decision, review drafts) and no AI reply (R3
// auto-reply; the AI reply row gate cancels any LeadCommand AI row queued for the thread). The inbound reaches the agent
// on its event feed (inbound_message / opt_out, written by the inbound webhook). DETERMINISTIC compliance handling
// stays: the inbound webhook's STOP recognition and suppression (and its confirmation template, when one is configured)
// run unchanged, and a routed stop still cancels the thread's open turn (no model). Explicit template campaign workflows
// are not touched.
//
// Read failures STAND DOWN (fail closed: no model decision, no AI reply); without link #32 (the read function does not
// exist) nobody holds a lead and nothing changes.
import { readLeadHolder } from '@/lib/domain/queue/agent-text-row-gate.js'
import { isStopRequest } from '@/lib/domain/conversation-ai/stop-request.js'

export const AGENT_HELD_STAND_DOWN = 'AGENT_HELD_STAND_DOWN'
const clean = (v) => String(v ?? '').trim()
const STOP_INTENTS = new Set(['opt_out', 'stop_texting'])

/** Does an agent hold the lead of this thread key? { stand_down, agent_id, unreadable } */
export async function agentStandDownForThread(supabase, threadKey) {
  if (!clean(threadKey)) return { stand_down: false, agent_id: null }
  const h = await readLeadHolder(supabase, clean(threadKey), { strict: false }).catch(() => ({ read_failed: true }))
  if (!h || h.read_failed) return { stand_down: true, agent_id: null, unreadable: true }
  return { stand_down: Boolean(h.agent_id), agent_id: h.agent_id || null }
}

/** The same, for an inbound (by provider message id): + whether it is a stop (the deterministic path still runs). */
export async function agentStandDownForInbound(supabase, providerMessageSid) {
  const sid = clean(providerMessageSid)
  if (!sid || !supabase?.from) return { stand_down: false, agent_id: null, stop: false }
  let row = null
  try {
    const r = await supabase.from('message_events').select('thread_key,message_body,detected_intent,direction').eq('provider_message_sid', sid).limit(1)
    if (r?.error) return { stand_down: true, agent_id: null, stop: false, unreadable: true }
    row = r?.data?.[0] || null
  } catch { return { stand_down: true, agent_id: null, stop: false, unreadable: true } }
  if (!row?.thread_key) return { stand_down: false, agent_id: null, stop: false }
  const v = await agentStandDownForThread(supabase, row.thread_key)
  return { ...v, stop: isStopRequest(row.message_body || '') || STOP_INTENTS.has(clean(row.detected_intent)), thread_key: row.thread_key }
}

/** A turn decider that makes NO model decision on an agent-held thread (the turn closes as a shadow, nothing queued). */
export function standDownDecider(innerDecide, { supabase }) {
  return async (claim) => {
    const v = await agentStandDownForThread(supabase, claim?.thread_key)
    if (v.stand_down) return { code: AGENT_HELD_STAND_DOWN, outcome: 'agent_held', reply: null, agent_id: v.agent_id || null, unreadable: Boolean(v.unreadable) }
    return innerDecide(claim)
  }
}
