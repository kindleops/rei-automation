import { getSupabaseClient } from '../supabaseClient'
import { safeArray, type AnyRecord } from './shared'

export interface ConversationThread {
  id: string
  seller_id: string
  property_id: string | null
  status: string
  priority: number
  created_at: string
  updated_at: string
  last_message_at: string | null
  metadata: AnyRecord
}

export interface ConversationTurn {
  id: string
  thread_id: string
  direction: 'inbound' | 'outbound'
  channel: string
  content: string
  intent_detected: string | null
  confidence_score: number | null
  handled_by: 'ai' | 'human' | 'system'
  created_at: string
  metadata: AnyRecord
}

export interface SellerStateSnapshot {
  id: string
  seller_id: string
  thread_id: string
  state_data: {
    timeline: string | null
    confidence: number
    emotional_state: string | null
    price_mentioned: number | null
    seller_interest: 'low' | 'medium' | 'high' | 'none'
    tenant_occupied: boolean
    motivation_level: 'low' | 'medium' | 'high'
    next_best_action: string
    ownership_confirmed: boolean
    creative_finance_open: boolean
    [key: string]: any
  }
  capture_reason: string
  created_at: string
}

export interface RoutingDecision {
  id: string
  turn_id: string | null
  thread_id: string
  decision_type: string
  routed_to: string
  confidence: number
  rules_triggered: string[]
  created_at: string
}

export interface AIDecision {
  id: string
  thread_id: string
  decision_category: string
  decision_value: string
  confidence: number
  alternatives: AnyRecord
  created_at: string
}

export interface NegotiationEvent {
  id: string
  thread_id: string
  event_type: string
  event_payload: AnyRecord
  created_at: string
}

export interface Phase3Intelligence {
  thread: ConversationThread | null
  latestSnapshot: SellerStateSnapshot | null
  recentTurns: ConversationTurn[]
  routingDecisions: RoutingDecision[]
  aiDecisions: AIDecision[]
  negotiationEvents: NegotiationEvent[]
}

export const fetchThreadPhase3Intelligence = async (threadKey: string): Promise<Phase3Intelligence> => {
  const supabase = getSupabaseClient()
  
  // 1. Find the conversation thread
  const { data: threadData, error: threadError } = await supabase
    .from('conversation_threads')
    .select('*')
    // We use the JSONB operator to find the thread_key in metadata
    .contains('metadata', { thread_key: threadKey })
    .limit(1)
    .maybeSingle()

  if (threadError || !threadData) {
    return {
      thread: null,
      latestSnapshot: null,
      recentTurns: [],
      routingDecisions: [],
      aiDecisions: [],
      negotiationEvents: []
    }
  }

  const thread = threadData as ConversationThread
  const threadId = thread.id

  // 2. Fetch related telemetry in parallel
  const [
    snapshotRes,
    turnsRes,
    routingRes,
    aiDecRes,
    negRes
  ] = await Promise.all([
    supabase.from('seller_state_snapshots').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('conversation_turns').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(20),
    supabase.from('routing_decisions').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(5),
    supabase.from('ai_decisions').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(5),
    supabase.from('negotiation_events').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(10)
  ])

  return {
    thread,
    latestSnapshot: snapshotRes.data as SellerStateSnapshot | null,
    recentTurns: safeArray(turnsRes.data as ConversationTurn[]),
    routingDecisions: safeArray(routingRes.data as RoutingDecision[]),
    aiDecisions: safeArray(aiDecRes.data as AIDecision[]),
    negotiationEvents: safeArray(negRes.data as NegotiationEvent[])
  }
}
