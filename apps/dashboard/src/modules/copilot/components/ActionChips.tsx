import { Icon } from '../../../shared/icons';

interface ActionChipsProps {
  prompts: string[];
  onSelect: (prompt: string) => void;
}

export const ActionChips = ({ prompts, onSelect }: ActionChipsProps) => {
  if (!prompts || prompts.length === 0) return null;

  return (
    <div className="nx-copilot-action-chips">
      <span className="nx-chips-label">Suggested:</span>
      <div className="nx-chips-scroll">
        {prompts.map((prompt, i) => (
          <button 
            key={i} 
            type="button" 
            className="nx-copilot-chip"
            onClick={() => onSelect(prompt)}
          >
            <Icon name="spark" />
            <span>{prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
