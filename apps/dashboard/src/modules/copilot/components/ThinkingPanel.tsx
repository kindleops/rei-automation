import { useState } from 'react';
import { Icon } from '../../../shared/icons';
import type { ReasoningContext } from '../copilot.types';

interface ThinkingPanelProps {
  reasoning: ReasoningContext;
}

export const ThinkingPanel = ({ reasoning }: ThinkingPanelProps) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="nx-copilot-reasoning-panel">
      <button 
        type="button" 
        className="nx-reasoning-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
        <span>{expanded ? 'Hide' : 'Show'} reasoning & actions</span>
      </button>
      
      {expanded && (
        <div className="nx-reasoning-content nx-liquid-panel">
          {reasoning.contextLoaded.length > 0 && (
            <div className="nx-reasoning-section">
              <strong>Context Loaded</strong>
              <ul>{reasoning.contextLoaded.map((item, i) => <li key={i}>{item}</li>)}</ul>
            </div>
          )}
          {reasoning.safetyChecks.length > 0 && (
            <div className="nx-reasoning-section">
              <strong>Safety Checks</strong>
              <ul>{reasoning.safetyChecks.map((item, i) => <li key={i} className="is-safe"><Icon name="check" /> {item}</li>)}</ul>
            </div>
          )}
          {reasoning.dataReads.length > 0 && (
            <div className="nx-reasoning-section">
              <strong>Data Read</strong>
              <ul>{reasoning.dataReads.map((item, i) => <li key={i}>{item}</li>)}</ul>
            </div>
          )}
          {reasoning.proposedMutations.length > 0 && (
            <div className="nx-reasoning-section">
              <strong>Proposed Mutations</strong>
              <ul>{reasoning.proposedMutations.map((item, i) => <li key={i} className="is-mutation"><Icon name="file-text" /> {item}</li>)}</ul>
            </div>
          )}
          <div className="nx-reasoning-section nx-reasoning-plan">
            <strong>Final Action Plan</strong>
            <p>{reasoning.finalPlan}</p>
          </div>
        </div>
      )}
    </div>
  );
};
