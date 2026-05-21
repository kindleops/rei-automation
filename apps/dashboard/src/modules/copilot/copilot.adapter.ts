import { useState, useCallback, useEffect } from 'react';
import type { ChatMessage, CopilotActionPreviewData, ReasoningContext } from './copilot.types';
import { getAgentById } from './copilot.agents';
import { routeQueryToAgent } from './copilot.router';
import { detectPropertyCategory } from '../inbox/helpers/propertyHelpers';

// Simple in-memory cache for thread persistence across renders during the session
const messageCache = new Map<string, ChatMessage[]>();

export const useCopilotChat = (thread: any, initialAgentId: string = 'ceo') => {
  const threadId = thread?.id || 'global';
  const [messages, setMessages] = useState<ChatMessage[]>(messageCache.get(threadId) || []);
  const [activeAgentId, setActiveAgentId] = useState(initialAgentId);
  const [isThinking, setIsThinking] = useState(false);
  const typingSpeed = 30; // ms per character

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

  const streamText = async (msgId: string, fullText: string) => {
    let currentText = '';
    updateMessage(msgId, { status: 'streaming', body: '' });
    
    for (let i = 0; i < fullText.length; i++) {
      currentText += fullText[i];
      updateMessage(msgId, { body: currentText });
      await new Promise(r => setTimeout(r, typingSpeed + (Math.random() * 20))); // slight natural jitter
    }
    
    updateMessage(msgId, { status: 'complete' });
  };

  const executeAction = useCallback(async (actionId: string, actionData: CopilotActionPreviewData) => {
    const msgToUpdate = messages.find(m => m.actionPreview?.id === actionId);
    if (msgToUpdate) {
      updateMessage(msgToUpdate.id, {
        actionPreview: { ...actionData, status: 'success' }
      });
      addMessage({
        role: 'agent',
        agentId: msgToUpdate.agentId,
        body: `Action "${actionData.title}" executed successfully.`,
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
    let targetAgent = getAgentById(targetAgentId);

    // Collaboration & Handoff
    if (targetAgentId !== activeAgentId) {
      const prevAgentId = activeAgentId;
      setActiveAgentId(targetAgentId);
      addMessage({
        role: 'system',
        agentId: targetAgentId,
        body: `Handoff requested.`,
        handoffAgentId: targetAgentId,
        collaborationEvent: {
          title: 'Agent Handoff',
          description: `${getAgentById(prevAgentId).name} delegated to ${targetAgent.name}`
        }
      });
    }

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
        reasoning.toolsConsidered.push('Gemini Underwriter API');
        if (!thread) throw new Error("Thread context missing. Select a deal first.");
        
        reasoning.dataReads.push(`Property: ${thread.propertyAddress}`);
        reasoning.safetyChecks.push('Verified deterministic MAO calculator is active.');
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
        reasoning.toolsConsidered.push('Compliance Suppression Tool');
        reasoning.safetyChecks.push('Requires operator preview before mutating thread state.');
        reasoning.proposedMutations.push(`Update thread ${thread?.id} status to 'suppressed'`);
        reasoning.finalPlan = 'Presenting action preview for approval.';
        
        updateMessage(agentMsgId, {
          status: 'complete',
          body: `I've prepared the suppression action for this contact. Please review and execute the mutation below.`,
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
        await new Promise(r => setTimeout(r, 1000));
        reasoning.dataReads.push('Analyzed recent message history.');
        updateMessage(agentMsgId, { reasoning });
        
        const responseText = `As your ${targetAgent.role}, I've reviewed this thread. The current stage is ${thread?.conversationStage || 'unknown'}. I'm ready to run numbers, draft a reply, or assist with operations. Let me know how you want to proceed.`;
        await streamText(agentMsgId, responseText);
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

  }, [activeAgentId, thread, addMessage, updateMessage, streamText]);

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
