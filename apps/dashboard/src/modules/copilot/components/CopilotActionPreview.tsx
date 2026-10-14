import { Icon } from '../../../shared/icons';
import type { CopilotActionPreviewData } from '../copilot.types';

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ');

interface CopilotActionPreviewProps {
  action: CopilotActionPreviewData;
  onExecute: (id: string) => void;
  onCancel: (id: string) => void;
}

export const CopilotActionPreview = ({ action, onExecute: _onExecute, onCancel }: CopilotActionPreviewProps) => {
  void _onExecute // kept for the prop contract: no execute affordance exists (no server action)
  const isPending = action.status === 'pending' || !action.status;
  const isSuccess = action.status === 'success';
  const isError = action.status === 'error';

  return (
    <div className={cls('nx-copilot-action-preview nx-liquid-panel', `is-${action.severity}`, action.status && `is-${action.status}`)}>
      <div className="nx-action-preview-header">
        <div className="nx-action-preview-title">
          <Icon name={action.severity === 'dangerous' ? 'alert' : 'zap'} />
          <span>PREVIEW: {action.title}</span>
        </div>
        {action.severity === 'dangerous' && <span className="nx-action-badge is-danger">DANGEROUS</span>}
      </div>

      <p className="nx-action-preview-desc">{action.description}</p>
      
      <p className="nx-action-preview-desc">Preview only — this assistant has no server action for it. Nothing changes until you use the thread's own control.</p>

      <div className="nx-action-preview-controls">
        {isPending && (
          <>
            <button type="button" className="nx-action-btn is-cancel" onClick={() => onCancel(action.id)}>
              Dismiss
            </button>
          </>
        )}
        {isSuccess && (
          <span className="nx-action-result is-success"><Icon name="check" /> Done</span>
        )}
        {isError && (
          <span className="nx-action-result is-error"><Icon name="close" /> Not executed</span>
        )}
      </div>
    </div>
  );
};
