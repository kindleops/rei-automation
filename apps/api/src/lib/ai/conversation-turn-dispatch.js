// The R3 DISPATCHER for a finalized conversation turn (rc-8.5.21, Phase 6). The ONLY module that
// hands a canonical decision to the R3 executor, and the only importer of it (static test). Loaded
// lazily by the conversation.turn handler. The turn's finalize already holds the inbound_reply
// reservation for every member under the turn's token; R3 verifies that token, re-reads every OFF
// switch (emergency stop, kill switch, policy, scope) and re-validates on fresh state before any
// enqueue. With the switches absent (production) nothing ever reaches this module: the decider
// hands a reply to the dispatcher only when an AI send is authorised (aiSendAuthorizedFor).
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'

export const TURN_DISPATCH_VERSION = 'conv-ai.turn-dispatch.v1'

export function createR3TurnDispatcher({ supabase = getDefaultSupabaseClient(), jobId = null, execute = null, deps = {} } = {}) {
  // decisionId: a caller that is not a turn (the Action Gateway's action_gateway.execute job for queue_authorized_reply) names its own decision;
  // without a claim token R3 takes the per-inbound reservation itself (exactly one reply per inbound, shared scope)
  return async ({ turn_id, version, claim, decision, decisionId = null }) => {
    const run = execute || (await import('./conversation-ai-r3-executor.js')).executeAiConversationReply
    return run({ record: decision.canonical, inbound: decision.inbound, turn: { turn_id, version, token: claim.token, inbound_ids: claim.inbound_ids || [] }, job_id: jobId, decision_id: decisionId || `turn:${turn_id}#v${version}` }, { supabase, ...deps })
  }
}
