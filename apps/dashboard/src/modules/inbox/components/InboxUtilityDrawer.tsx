import { Icon } from '../../../shared/icons'
import { IntelligencePanel } from './IntelligencePanel'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import { getStatusVisual, statusStyleVars } from '../status-visuals'
import { InboxCommandMap } from '../InboxCommandMap'

const fallback = (value: unknown, placeholder = 'Unknown') => {
  const text = String(value ?? '').trim()
  return text || placeholder
}

export const MapDossierDrawer = ({
  mode,
  thread,
  context: _context,
  onClose,
  full: _full,
  onToggleFull: _onToggleFull,
}: {
  mode: 'map' | 'dossier'
  thread: InboxWorkflowThread | null
  context: any
  onClose: () => void
  full: boolean
  onToggleFull: () => void
}) => {
  const address = thread?.propertyAddress || 'Property Unknown'
  const hasCoordinates = Boolean(thread?.lat && thread?.lng)
  // Use a proper status visual fallback to avoid type errors
  const statusVisual = thread ? getStatusVisual(thread.inboxStatus) : { label: 'Unknown', color: '#ccc', bg: '#ccc', border: '#ccc', dot: '#ccc', pulse: 'none', description: 'Unknown' }
  
  return (
    <section className="nx-utility-drawer">
      <header>
        <span>
          <Icon name={mode === 'map' ? 'map' : 'briefing'} />
          {mode === 'map' ? 'Map View' : 'Deal Dossier'}
        </span>
        <button 
          type="button" 
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }} 
          title="Close"
        >
          <Icon name="close" />
        </button>
      </header>

      {mode === 'map' ? (
        <div className="nx-map-placeholder nx-map-placeholder--command">
          <div className="nx-map-placeholder__map">
            {thread ? (
              <InboxCommandMap
                threads={[thread]}
                visibleThreads={[thread]}
                selectedThread={thread}
                zoomedIn
                sourceMode="visible_threads"
                onSelectThreadId={() => {}}
              />
            ) : (
              <div className="nx-map-grid">
                {hasCoordinates ? (
                  <span className="nx-map-pin nx-status-dot" style={statusStyleVars(statusVisual)}>
                    <Icon name="pin" />
                  </span>
                ) : (
                  <span className="nx-map-pin nx-map-pin--empty"><Icon name="pin" /></span>
                )}
              </div>
            )}
          </div>
          <aside>
            <strong>{address}</strong>
            <span>{fallback(thread?.market || thread?.marketId, 'Market Unknown')}</span>
            <p>{hasCoordinates ? 'Mini command map is synchronized with deterministic inbox state.' : 'No coordinates linked for this lead yet.'}</p>
          </aside>
        </div>
      ) : thread ? (
        <IntelligencePanel
          thread={thread}
          onStatusChange={() => {}}
          onStageChange={() => {}}
          onOpenMap={() => {}}
          onOpenDossier={() => {}}
          onOpenAi={() => {}}
          messages={[]}
        />
      ) : (
        <div className="nx-dossier-empty">Select a thread to view dossier</div>
      )}
    </section>
  )
}

export const InboxUtilityDrawer = ({
  type,
  thread,
  onClose,
}: {
  type: 'ai' | 'keys'
  thread: InboxWorkflowThread | null
  onClose: () => void
}) => {
  const title = type === 'ai' ? 'AI Assistant' : 'Keyboard Shortcuts'
  const shortcuts = [
    ['[', 'Toggle left panel'],
    [']', 'Toggle right panel'],
    ['\\', 'Toggle dossier'],
    ['⌘M', 'Toggle map view'],
    ['⌘K', 'Global search'],
    ['⌘Enter', 'Send message'],
  ]

  return (
    <aside className="nx-utility-drawer">
      <header>
        <span>
          <Icon name={type === 'ai' ? 'spark' : 'key'} />
          {title}
        </span>
        <button 
          type="button" 
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }} 
          title="Close"
        >
          <Icon name="close" />
        </button>
      </header>

      {type === 'ai' ? (
        <div className="nx-ai-drawer-body">
          <p>{thread ? `Draft workspace for ${fallback(thread.ownerName, 'this seller')}.` : 'Select a thread to open AI drafting.'}</p>
          <button type="button" className="nx-primary-action" disabled={!thread}>
            <Icon name="spark" />
            Generate Draft
          </button>
        </div>
      ) : (
        <div className="nx-shortcut-list">
          {shortcuts.map(([key, label]) => (
            <div key={key}>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
