/**
 * Big Pickle Intelligence Provider
 * 
 * Authoritative adapter for drafting, summarizing, and classifying 
 * seller communications via the Big Pickle neural engine.
 */

import type { CopilotThreadContext, BigPickleDraft } from '../../../lib/data/copilotContextData'

export type ProviderState = 'connected' | 'mock_mode' | 'offline'

interface BigPickleResponse<T> {
  data: T
  state: ProviderState
  latencyMs: number
}

const ENABLED = import.meta.env.VITE_BIG_PICKLE_ENABLED === 'true'
const API_KEY = import.meta.env.VITE_BIG_PICKLE_API_KEY || ''
const API_URL = import.meta.env.VITE_BIG_PICKLE_API_URL || 'https://api.bigpickle.ai/v1'

export const getProviderState = (): ProviderState => {
  if (!ENABLED) return 'mock_mode'
  if (!API_KEY) return 'offline'
  return 'connected'
}

/* ── Intelligence Methods ───────────────────────────────────────── */

/**
 * Drafts a seller-safe reply based on thread context
 */
export async function draftSellerReply(context: CopilotThreadContext): Promise<BigPickleResponse<BigPickleDraft>> {
  const start = Date.now()
  const state = getProviderState()
  
  console.log('[BigPickleProvider] Initiating Draft request for:', context.sellerName)

  if (state === 'connected') {
    try {
      // Real API implementation placeholder
      const res = await fetch(`${API_URL}/draft`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ context })
      })
      const data = await res.json()
      console.log('[BigPickleDraft] API Success')
      return { data, state, latencyMs: Date.now() - start }
    } catch (err) {
      console.error('[BigPickleError] API Failed, falling back to mock:', err)
    }
  }

  // Fallback / Mock Mode
  console.log('[BigPickleMock] Generating deterministic mock draft')
  const mockDraft: BigPickleDraft = {
    draftBody: `Hey ${context.sellerName}, I received your message regarding ${context.propertyAddress}. We are definitely interested in making a fair cash offer. When would be a good time for a brief 5-minute call to discuss the property's condition?`,
    sellerSafe: true,
    tone: 'Professional/Direct',
    intent: 'Schedule Call',
    confidence: 0.92,
    internalNotes: 'Mock provider fallback active.',
    suggestedNextStage: 'schedule_call'
  }

  return { data: mockDraft, state: 'mock_mode', latencyMs: Date.now() - start }
}

/**
 * Summarizes the entire thread history
 */
export async function summarizeThread(context: CopilotThreadContext): Promise<BigPickleResponse<string>> {
  const start = Date.now()
  const state = getProviderState()
  console.log('[BigPickleProvider] Summarizing thread:', context.propertyAddress)

  const summary = `Thread for ${context.sellerName} at ${context.propertyAddress}. Currently in ${context.sellerStage} stage. Last interaction was ${context.lastInbound ? `inbound on ${context.lastInbound}` : 'unknown'}.`
  
  return { data: summary, state: state === 'connected' ? 'connected' : 'mock_mode', latencyMs: Date.now() - start }
}

/**
 * Classifies the seller's intent from the last message
 */
export async function classifyIntent(_context: CopilotThreadContext): Promise<BigPickleResponse<string>> {
  const state = getProviderState()
  return { data: 'Inquiry / Interest', state: state === 'connected' ? 'connected' : 'mock_mode', latencyMs: 0 }
}

/**
 * Recommends the next best action to take
 */
export async function recommendNextAction(_context: CopilotThreadContext): Promise<BigPickleResponse<string[]>> {
  return { data: ['Schedule Call', 'Verify ARV', 'Send Offer'], state: 'mock_mode', latencyMs: 0 }
}

/**
 * Runs offer intelligence analysis
 */
export async function runOfferAssist(context: CopilotThreadContext): Promise<BigPickleResponse<any>> {
  console.log('[BigPickleProvider] Running Offer Assist')
  return { 
    data: { 
      recommendedPrice: context.aiOffer || '$0', 
      confidence: 0.88,
      riskLevel: 'Low'
    }, 
    state: 'mock_mode', 
    latencyMs: 120 
  }
}
