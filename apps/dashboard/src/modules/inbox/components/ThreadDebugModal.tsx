import { Icon } from '../../../shared/icons'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { ThreadMessage, ThreadIntelligenceRecord } from '../../../lib/data/inboxData'

interface ThreadDebugModalProps {
  isOpen: boolean
  onClose: () => void
  thread: InboxWorkflowThread | null
  messages: ThreadMessage[]
  intelligence: ThreadIntelligenceRecord | null
}

export function ThreadDebugModal({ isOpen, onClose, thread, messages, intelligence }: ThreadDebugModalProps) {
  if (!isOpen || !thread) return null

  const jsonStyle = {
    background: '#0d1117',
    color: '#c9d1d9',
    padding: '12px',
    borderRadius: '8px',
    fontSize: '11px',
    fontFamily: 'monospace',
    overflow: 'auto',
    maxHeight: '300px',
    border: '1px solid #30363d',
    marginTop: '8px'
  }

  return (
    <div className="nx-modal-overlay debug-modal" onClick={onClose}>
      <div className="nx-modal-content debug-modal__content" onClick={e => e.stopPropagation()}>
        <header className="nx-modal-header">
          <div className="nx-modal-title">
            <Icon name="cpu" />
            <span>Thread Debugger</span>
          </div>
          <button className="nx-modal-close" onClick={onClose}>
            <Icon name="x" />
          </button>

        </header>

        <div className="nx-modal-body">
          <div className="debug-grid">
            <section>
              <h4>Thread Metadata</h4>
              <ul className="debug-stats">
                <li>Key: <code>{thread.threadKey || thread.id}</code></li>
                <li>Messages: <code>{messages.length}</code></li>
                <li>Status: <code>{thread.status}</code></li>
                <li>Category: <code>{thread.inboxCategory}</code></li>
                <li>Intent: <code>{thread.uiIntent}</code></li>
                <li>Stage: <code>{thread.workflowStage}</code></li>
              </ul>
            </section>

            <section>
              <h4>Raw Thread State</h4>
              <pre style={jsonStyle}>{JSON.stringify(thread, null, 2)}</pre>
            </section>

            <section>
              <h4>Intelligence Record</h4>
              <pre style={jsonStyle}>{JSON.stringify(intelligence, null, 2)}</pre>
            </section>

            <section>
              <h4>Latest Messages (First 5)</h4>
              <pre style={jsonStyle}>{JSON.stringify(messages.slice(0, 5), null, 2)}</pre>
            </section>
          </div>
        </div>

        <footer className="nx-modal-footer">
          <button className="nx-btn nx-btn--secondary" onClick={onClose}>Close</button>
        </footer>
      </div>

      <style>{`
        .debug-modal .nx-modal-content {
          max-width: 900px;
          width: 90%;
          max-height: 85vh;
        }
        .debug-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 20px;
        }
        .debug-stats {
          list-style: none;
          padding: 0;
          margin: 10px 0;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 10px;
        }
        .debug-stats li {
          font-size: 12px;
          color: #8b949e;
        }
        .debug-stats code {
          background: #161b22;
          color: #58a6ff;
          padding: 2px 4px;
          border-radius: 4px;
        }
        h4 {
          margin: 0 0 8px;
          font-size: 12px;
          text-transform: uppercase;
          color: #58a6ff;
        }
      `}</style>
    </div>
  )
}
