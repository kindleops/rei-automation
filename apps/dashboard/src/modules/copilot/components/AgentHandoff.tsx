import { Icon } from '../../../shared/icons';
import { getAgentById } from '../copilot.agents';

export const AgentHandoffEvent = ({ fromAgentId, toAgentId, reason }: { fromAgentId: string, toAgentId: string, reason?: string }) => {
  const fromAgent = getAgentById(fromAgentId);
  const toAgent = getAgentById(toAgentId);

  return (
    <div className="nx-copilot-handoff-event nx-liquid-panel">
      <div className="nx-handoff-agents">
        <span className="nx-handoff-avatar" style={{ border: `1px solid ${fromAgent.accentColor}` }}>
          {fromAgent.avatarEmoji}
        </span>
        <div className="nx-handoff-arrow">
          <Icon name="arrow-up-right" />
        </div>
        <span className="nx-handoff-avatar is-target" style={{ border: `1px solid ${toAgent.accentColor}` }}>
          {toAgent.avatarEmoji}
        </span>
      </div>
      <div className="nx-handoff-details">
        <strong>Handoff: {fromAgent.name} → {toAgent.name}</strong>
        {reason && <p>{reason}</p>}
      </div>
    </div>
  );
};
