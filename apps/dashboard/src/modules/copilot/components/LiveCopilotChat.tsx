import { useState, useRef, useEffect } from 'react';
import { Icon } from '../../../shared/icons';
import { getAgentById, COPILOT_AGENTS } from '../copilot.agents';
import { useCopilotChat } from '../copilot.adapter';
import { useThinkingRotation } from '../copilot.thinking';
import { AgentIdentityCard } from './AgentIdentityCard';
import { AgentSwitcher } from './AgentSwitcher';
import { ThinkingPanel } from './ThinkingPanel';
import { CopilotActionPreview } from './CopilotActionPreview';
import { ActionChips } from './ActionChips';
import { SentimentTracker, ConfidenceVisualizer } from './Visualizers';
import { AgentHandoffEvent } from './AgentHandoff';
import '../copilot-v2.css';

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ');

// Dummy component to replace UnderwritingResultCard from before
const UnderwritingResultCard = ({ data }: { data: any }) => (
  <div className="nx-copilot-underwrite-card nx-liquid-panel">
    <div className="nx-underwrite-header">
      <div className="nx-underwrite-title">
        <Icon name="spark" />
        <span>OFFER INTELLIGENCE</span>
      </div>
      <div className={cls('nx-underwrite-badge', `is-${data.valuation?.verdict}`)}>
        {data.valuation?.verdict?.toUpperCase()} ({data.valuation?.score}/100)
      </div>
    </div>
    
    <div className="nx-underwrite-stats">
      <div className="nx-underwrite-stat">
        <label>ARV</label>
        <strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.valuation?.arv_estimate || 0)}</strong>
      </div>
      <div className="nx-underwrite-stat">
        <label>MAO</label>
        <strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.valuation?.mao || 0)}</strong>
      </div>
      <div className="nx-underwrite-stat">
        <label>PROFIT</label>
        <strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(data.valuation?.assignmentFee || 0)}</strong>
      </div>
    </div>

    <div className="nx-underwrite-comps">
      <div className="nx-comps-label">Verified Sold Comps:</div>
      {data.comps?.slice(0, 3).map((comp: any, i: number) => (
        <a key={i} href={comp.source_url} target="_blank" rel="noreferrer" className="nx-comp-row">
          <span>{comp.address}</span>
          <strong>${comp.price?.toLocaleString()}</strong>
        </a>
      ))}
    </div>
  </div>
);

export const LiveCopilotChat = ({ thread, onClose }: { thread: any, onClose: () => void }) => {
  const { 
    messages, 
    activeAgentId, 
    setActiveAgentId, 
    isThinking, 
    handleSend,
    executeAction,
    cancelAction
  } = useCopilotChat(thread);
  
  const [inputText, setInputText] = useState('');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  
  const activeAgent = getAgentById(activeAgentId);
  const currentThinkingPhrase = useThinkingRotation(activeAgent, isThinking);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  return (
    <aside className="nx-copilot-v2-panel">
      <AgentIdentityCard 
        agent={activeAgent} 
        isThinking={isThinking} 
        currentPhrase={currentThinkingPhrase} 
        onOrbClick={() => setSwitcherOpen(!switcherOpen)}
      />

      <div className="nx-copilot-header-actions">
        <AgentSwitcher 
          agents={COPILOT_AGENTS} 
          activeId={activeAgentId} 
          onSelect={setActiveAgentId} 
          open={switcherOpen} 
          onToggle={() => setSwitcherOpen(!switcherOpen)} 
        />
        <button type="button" onClick={onClose} className="nx-copilot-close-btn">
          <Icon name="close" />
        </button>
      </div>

      <div className="nx-copilot-v2-chat">
        {messages.length === 0 && (
          <div className="nx-copilot-welcome">
            <div className="nx-copilot-welcome-icon">{activeAgent.avatarEmoji}</div>
            <p>I'm your {activeAgent.name}. {activeAgent.personality}</p>
            <ActionChips prompts={activeAgent.suggestedPrompts} onSelect={handleSend} />
          </div>
        )}

        {messages.map((msg, index) => {
          const msgAgent = getAgentById(msg.agentId);
          const isOperator = msg.role === 'operator';
          const isSystem = msg.role === 'system';

          if (isSystem) {
            if (msg.handoffAgentId && msg.collaborationEvent) {
              const prevAgentId = messages[index - 1]?.agentId || 'ceo';
              return (
                <AgentHandoffEvent 
                  key={msg.id} 
                  fromAgentId={prevAgentId} 
                  toAgentId={msg.handoffAgentId} 
                  reason={msg.collaborationEvent.description} 
                />
              );
            }
            return <div key={msg.id} className="nx-copilot-msg is-system">{msg.body}</div>;
          }

          return (
            <div key={msg.id} className={cls('nx-copilot-msg', isOperator ? 'is-operator' : 'is-agent', msg.status === 'thinking' && 'is-thinking')}>
              {!isOperator && <span className="nx-copilot-msg__avatar">{msgAgent.avatarEmoji}</span>}
              <div className="nx-copilot-msg__content">
                {!isOperator && (
                  <div className="nx-copilot-msg__header-row">
                    <span className="nx-copilot-msg__name">{msgAgent.name}</span>
                    {msg.sentiment && <SentimentTracker sentiment={msg.sentiment} />}
                    {msg.confidenceScore !== undefined && <ConfidenceVisualizer score={msg.confidenceScore} />}
                  </div>
                )}
                
                {msg.body && (
                  <div className={cls('nx-copilot-msg__body', msg.status === 'streaming' && 'is-streaming')}>
                    {msg.body}
                  </div>
                )}
                
                {msg.reasoning && <ThinkingPanel reasoning={msg.reasoning} />}
                
                {msg.actionPreview && (
                  <CopilotActionPreview 
                    action={msg.actionPreview} 
                    onExecute={(id) => executeAction(id, msg.actionPreview!)} 
                    onCancel={cancelAction} 
                  />
                )}

                {msg.underwritingData && <UnderwritingResultCard data={msg.underwritingData} />}

                <time className="nx-copilot-msg__time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              </div>
            </div>
          );
        })}
        {isThinking && (
          <div className="nx-copilot-typing nx-liquid-panel">
            <span className="nx-typing-icon">✨</span>
            <span className="nx-typing-text">{currentThinkingPhrase}</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="nx-copilot-v2-input-area">
        <div className="nx-copilot-v2-input-row">
          <textarea
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { 
                e.preventDefault(); 
                handleSend(inputText); 
                setInputText(''); 
              }
            }}
            placeholder={`Ask ${activeAgent.name}...`}
            rows={1}
          />
          <button type="button" className="nx-copilot-send-btn" onClick={() => { handleSend(inputText); setInputText(''); }}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </aside>
  );
};
