import { Icon } from '../../../shared/icons';
import type { CopilotActionPreviewData } from '../copilot.types';

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ');

interface CopilotActionPreviewProps {
  action: CopilotActionPreviewData;
  onExecute: (id: string) => void;
  onCancel: (id: string) => void;
}

export const CopilotActionPreview = ({ action, onExecute, onCancel }: CopilotActionPreviewProps) => {
  const isPending = action.status === 'pending' || !action.status;
  const isSuccess = action.status === 'success';
  const isError = action.status === 'error';

  return (
    <div className={cls('nx-copilot-action-preview nx-liquid-panel', `is-${action.severity}`, action.status && `is-${action.status}`)}>
      <div className="nx-action-preview-header">
        <div className="nx-action-preview-title">
          <Icon name={action.severity === 'dangerous' ? 'alert' : 'zap'} />
          <span>ACTION REQUIRED: {action.title}</span>
        </div>
        {action.severity === 'dangerous' && <span className="nx-action-badge is-danger">DANGEROUS</span>}
      </div>

      <p className="nx-action-preview-desc">{action.description}</p>
      
      <div className="nx-action-preview-payload">
        <pre>{JSON.stringify(action.payload, null, 2)}</pre>
      </div>

      <div className="nx-action-preview-controls">
        {isPending && (
          <>
            <button type="button" className="nx-action-btn is-cancel" onClick={() => onCancel(action.id)}>
              Cancel
            </button>
            <button type="button" className="nx-action-btn is-execute" onClick={() => onExecute(action.id)}>
              Execute Action
            </button>
          </>
        )}
        {isSuccess && (
          <span className="nx-action-result is-success"><Icon name="check" /> Executed successfully</span>
        )}
        {isError && (
          <span className="nx-action-result is-error"><Icon name="close" /> Execution failed</span>
        )}
      </div>
    </div>
  );
};
