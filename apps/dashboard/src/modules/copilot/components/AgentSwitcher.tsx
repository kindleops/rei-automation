import { Icon } from '../../../shared/icons';
import type { CopilotAgent } from '../copilot.types';

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ');

interface AgentSwitcherProps {
  agents: CopilotAgent[];
  activeId: string;
  onSelect: (id: string) => void;
  open: boolean;
  onToggle: () => void;
}

export const AgentSwitcher = ({ agents, activeId, onSelect, open, onToggle }: AgentSwitcherProps) => {
  const activeAgent = agents.find(a => a.id === activeId) || agents[0];

  return (
    <div className="nx-copilot-switcher">
      <button type="button" className="nx-copilot-switcher__trigger" onClick={onToggle}>
        <span className="nx-copilot-switcher__emoji">{activeAgent.avatarEmoji}</span>
        <span>{activeAgent.name}</span>
        <Icon name="chevron-down" />
      </button>
      
      {open && (
        <div className="nx-copilot-switcher__menu nx-liquid-panel">
          {agents.map(a => (
            <button 
              key={a.id} 
              type="button"
              className={cls('nx-copilot-switcher__item', a.id === activeId && 'is-active')}
              onClick={() => { onSelect(a.id); onToggle(); }}
            >
              <span className="nx-copilot-switcher__item-emoji">{a.avatarEmoji}</span>
              <div className="nx-copilot-switcher__item-info">
                <strong>{a.name}</strong>
                <small>{a.role}</small>
              </div>
              {a.id === activeId && <Icon name="check" className="nx-switcher-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
