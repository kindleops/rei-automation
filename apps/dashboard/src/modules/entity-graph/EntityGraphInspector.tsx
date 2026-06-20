import type { ContactLadderEntry, EntityGraphAction, EntityGraphDossier, UniversalEntityContext } from '../../domain/entity-graph/entity-graph.types'
import type { EntityGraphActionItem } from '../../domain/entity-graph/entity-graph-actions'
import { EntityGraphDossierPanel } from './EntityGraphDossierPanel'

type Props = {
  open: boolean
  dossier: EntityGraphDossier | null
  loading: boolean
  universalContext: UniversalEntityContext
  actions: EntityGraphActionItem[]
  onClose: () => void
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
  onContactSelect: (entry: ContactLadderEntry) => void
  onSelectThreadKey?: (threadKey: string) => void
}

export function EntityGraphInspector({
  open,
  dossier,
  loading,
  universalContext,
  actions,
  onClose,
  onAction,
  onContactSelect,
  onSelectThreadKey,
}: Props) {
  if (!open) return null

  const type = dossier?.entityType ?? universalContext.entityType ?? 'record'

  return (
    <aside className="eg-inspector nx-liquid-surface" role="dialog" aria-label="Entity inspector">
      <header className="eg-inspector__header">
        <div>
          <span className="eg-inspector__eyebrow">Inspector</span>
          <strong>{type.replace(/_/g, ' ')}</strong>
        </div>
        <button type="button" className="eg-glass-btn" onClick={onClose} aria-label="Close inspector">Close</button>
      </header>
      <div className="eg-inspector__body">
        <EntityGraphDossierPanel
          dossier={dossier}
          loading={loading}
          universalContext={universalContext}
          actions={actions}
          onAction={onAction}
          onContactSelect={onContactSelect}
          onSelectThreadKey={onSelectThreadKey}
        />
      </div>
    </aside>
  )
}