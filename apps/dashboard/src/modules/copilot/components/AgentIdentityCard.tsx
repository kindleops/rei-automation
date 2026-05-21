import type { CopilotAgent } from '../copilot.types';
import { ThinkingOrb } from './ThinkingOrb';

interface AgentIdentityCardProps {
  agent: CopilotAgent;
  isThinking: boolean;
  currentPhrase?: string;
  onOrbClick?: () => void;
}

export const AgentIdentityCard = ({ agent, isThinking, currentPhrase, onOrbClick }: AgentIdentityCardProps) => {
  return (
    <div className="nx-copilot-identity-header">
      <ThinkingOrb 
        state={isThinking ? 'analyzing' : 'idle'} 
        amplitude={isThinking ? 0.2 : 0} 
        color={agent.accentColor} 
        size="md"
        onClick={onOrbClick}
      />
      <div className="nx-copilot-identity-info">
        <div className="nx-identity-title-row">
          <strong>{agent.name}</strong>
          <span className="nx-identity-badge">v2.1-ELITE</span>
        </div>
        {isThinking ? (
          <span className="nx-identity-thinking-text">{currentPhrase || agent.thinkingPhrases[0]}</span>
        ) : (
          <span className="nx-identity-role">{agent.role}</span>
        )}
      </div>
    </div>
  );
};
