import { useState, useCallback, useEffect } from 'react';
import type { ChatMessage, CopilotActionPreviewData, ReasoningContext } from './copilot.types';
import { routeQueryToAgent } from './copilot.router';
import { detectPropertyCategory } from '../inbox/helpers/propertyHelpers';

// Session-only, in-memory: lost on reload. This is NOT agent memory; nothing is sent to a server.
const messageCache = new Map<string, ChatMessage[]>();

/*
 * INTELLIGENCE 2.0 AUDIT (10-13): this Inbox assistant is NOT a model. Its only real
 * server call is underwriting (POST /api/internal/offers/underwrite). Removed here:
 * a canned "I've reviewed this thread" reply typed out character by character with
 * random jitter, hard-coded reasoning lines ("Gemini Underwriter API", "Verified
 * deterministic MAO calculator is active.", "Analyzed recent message history."),
 * a fake "Agent Handoff … delegated to …" event, and an "Execute Action" that marked
 * a suppression "executed successfully" WITHOUT any server call.
 */

export const useCopilotChat = (thread: any, initialAgentId: string = 'ceo') => {
  const threadId = thread?.id || 'global';
  const [messages, setMessages] = useState<ChatMessage[]>(messageCache.get(threadId) || []);
  const [activeAgentId, setActiveAgentId] = useState(initialAgentId);
  const [isThinking, setIsThinking] = useState(false);

  useEffect(() => {
    // Restore or reset messages when thread changes
    setMessages(messageCache.get(threadId) || []);
  }, [threadId]);

  // Persist to cache whenever messages change
  useEffect(() => {
    messageCache.set(threadId, messages);
  }, [messages, threadId]);

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    const id = `${msg.role}-${Date.now()}`;
    const timestamp = new Date().toISOString();
    setMessages(prev => [...prev, { ...msg, id, timestamp }]);
    return id;
  }, []);

  const updateMessage = useCallback((id: string, updates: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m));
  }, []);

  // There is no server action behind this preview: it is never reported as executed.
  const executeAction = useCallback(async (actionId: string, actionData: CopilotActionPreviewData) => {
    const msgToUpdate = messages.find(m => m.actionPreview?.id === actionId);
    if (msgToUpdate) {
      updateMessage(msgToUpdate.id, {
        actionPreview: { ...actionData, status: 'error' }
      });
      addMessage({
        role: 'agent',
        agentId: msgToUpdate.agentId,
        body: `Not executed: "${actionData.title}" is a preview only. Use the thread's own suppression control, which records the change on the server.`,
      });
    }
  }, [messages, updateMessage, addMessage]);

  const cancelAction = useCallback((actionId: string) => {
    const msgToUpdate = messages.find(m => m.actionPreview?.id === actionId);
    if (msgToUpdate) {
      updateMessage(msgToUpdate.id, {
        actionPreview: { ...msgToUpdate.actionPreview!, status: 'error' }
      });
      addMessage({
        role: 'agent',
        agentId: msgToUpdate.agentId,
        body: 'Action cancelled by operator.',
      });
    }
  }, [messages, updateMessage, addMessage]);

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim()) return;

    addMessage({
      role: 'operator',
      agentId: activeAgentId,
      body: text,
    });

    let targetAgentId = routeQueryToAgent(text, activeAgentId);

    // persona label only (keyword routing); there are no separate agents to hand off to
    if (targetAgentId !== activeAgentId) setActiveAgentId(targetAgentId);

    setIsThinking(true);
    const agentMsgId = addMessage({
      role: 'agent',
      agentId: targetAgentId,
      body: '',
      status: 'thinking',
    });

    const lowerText = text.toLowerCase();
    
    const reasoning: ReasoningContext = {
      contextLoaded: thread ? [`Thread: ${thread.subject || thread.id}`, `Stage: ${thread.conversationStage || 'unknown'}`] : [],
      toolsConsidered: [],
      safetyChecks: [],
      dataReads: [],
      proposedMutations: [],
      finalPlan: 'Drafting conversational response.'
    };

    try {
      if (lowerText.includes('underwrite') || lowerText.includes('comps')) {
        reasoning.toolsConsidered.push('POST /api/internal/offers/underwrite');
        if (!thread) throw new Error("Thread context missing. Select a deal first.");
        
        reasoning.dataReads.push(`Property: ${thread.propertyAddress}`);
        reasoning.finalPlan = 'Running API and displaying results.';

        updateMessage(agentMsgId, { reasoning });

        const res = await fetch('/api/internal/offers/underwrite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            address: thread.propertyAddress || thread.subject, 
            propertyType: detectPropertyCategory(thread)
          })
        });
        
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        updateMessage(agentMsgId, {
          status: 'complete',
          body: `I've completed the underwriting for ${thread.propertyAddress}. The MAO is $${data.valuation.mao.toLocaleString()} based on our deterministic rules. Verdict: **${data.valuation.verdict.toUpperCase()}**.`,
          underwritingData: data,
          sentiment: data.valuation.score >= 80 ? 'hot' : data.valuation.score >= 60 ? 'warm' : 'cold',
          confidenceScore: data.valuation.score,
        });

      } else if (lowerText.includes('suppress') || lowerText.includes('dnc')) {
        reasoning.proposedMutations.push(`Suppress thread ${thread?.id} (not executed here)`);
        reasoning.finalPlan = 'Preview only: no server action is wired to this assistant.';
        
        updateMessage(agentMsgId, {
          status: 'complete',
          body: `This is a preview only — this assistant cannot suppress a lead. Use the thread's suppression control to make the change.`,
          reasoning,
          actionPreview: {
            id: `act-${Date.now()}`,
            title: 'Suppress Lead',
            description: 'This will mark the lead as DNC, pause all automation, and move them to the suppressed state.',
            severity: 'dangerous',
            payload: { action: 'suppressThread', threadId: thread?.id, reason: 'operator requested' }
          }
        });
      } else {
        // no model behind this assistant: say what it can do instead of a canned "I've reviewed this thread"
        updateMessage(agentMsgId, {
          status: 'complete',
          reasoning: { ...reasoning, finalPlan: 'No model call: this assistant only runs underwriting.' },
          body: `I can run underwriting for this thread ("underwrite" or "comps"). For questions about this lead, open LeadCommand Intelligence (⌘L), which reads the records and cites them.`,
        });
      }
    } catch (err) {
      updateMessage(agentMsgId, {
        status: 'error',
        body: `❌ **Operation Failed:** ${err instanceof Error ? err.message : String(err)}`,
        reasoning,
      });
    } finally {
      setIsThinking(false);
    }

  }, [activeAgentId, thread, addMessage, updateMessage]);

  return {
    messages,
    activeAgentId,
    setActiveAgentId,
    isThinking,
    handleSend,
    executeAction,
    cancelAction
  };
};
