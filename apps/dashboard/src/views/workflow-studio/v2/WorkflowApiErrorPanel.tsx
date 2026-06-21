import { useState } from 'react'
import { Icon } from '../../../shared/icons'

interface WorkflowApiErrorPanelProps {
  message: string
  traceId?: string | null
  affected?: string
  onRetry: () => void
  onOfflineDemo?: () => void
}

export const WorkflowApiErrorPanel = ({
  message,
  traceId,
  affected = 'Workflow catalog, graph, registry, console, and live overlay',
  onRetry,
  onOfflineDemo,
}: WorkflowApiErrorPanelProps) => {
  const [showDetails, setShowDetails] = useState(false)

  return (
    <section className="wfs2-api-error">
      <div className="wfs2-api-error__icon">
        <Icon name="alert" />
      </div>
      <div className="wfs2-api-error__copy">
        <strong>Workflow service unavailable</strong>
        <p>{affected}</p>
        {traceId ? <small>Trace ID: {traceId}</small> : null}
        {showDetails ? <pre className="wfs2-api-error__details">{message}</pre> : null}
      </div>
      <div className="wfs2-api-error__actions">
        <button type="button" className="wfs2__btn is-primary" onClick={onRetry}>
          Retry
        </button>
        <button type="button" className="wfs2__btn is-ghost" onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide details' : 'Details'}
        </button>
        {onOfflineDemo ? (
          <button type="button" className="wfs2__btn is-ghost" onClick={onOfflineDemo}>
            Offline Demo
          </button>
        ) : null}
      </div>
    </section>
  )
}