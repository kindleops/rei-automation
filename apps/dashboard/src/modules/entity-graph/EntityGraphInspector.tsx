import type { ContactLadderEntry, EntityGraphAction, EntityGraphDossier, UniversalEntityContext } from '../../domain/entity-graph/entity-graph.types'
import type { EntityGraphActionItem } from '../../domain/entity-graph/entity-graph-actions'
import type { SelectedEntity } from '../../domain/entity-graph/selected-entity'
import { inspectorEntityLabel } from '../../domain/entity-graph/selected-entity'
import { EntityGraphDossierPanel } from './EntityGraphDossierPanel'

type Props = {
  open: boolean
  selectedEntity: SelectedEntity
  dossier: EntityGraphDossier | null
  loading: boolean
  actionContext: UniversalEntityContext
  actions: EntityGraphActionItem[]
  onClose: () => void
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
  onContactSelect: (entry: ContactLadderEntry) => void
  onSelectThreadKey?: (threadKey: string) => void
}

export function EntityGraphInspector({
  open,
  selectedEntity,
  dossier,
  loading,
  actionContext,
  actions,
  onClose,
  onAction,
  onContactSelect,
  onSelectThreadKey,
}: Props) {
  if (!open) return null

  return (
    <aside className="eg-inspector nx-liquid-surface" role="dialog" aria-label="Entity inspector">
      <header className="eg-inspector__header">
        <div>
          <span className="eg-inspector__eyebrow">Inspector</span>
          <strong>{inspectorEntityLabel(selectedEntity)}</strong>
        </div>
        <button type="button" className="eg-glass-btn" onClick={onClose} aria-label="Close inspector">Close</button>
      </header>
      <div className="eg-inspector__body">
        <EntityGraphDossierPanel
          selectedEntity={selectedEntity}
          dossier={dossier}
          loading={loading}
          actionContext={actionContext}
          actions={actions}
          onAction={onAction}
          onContactSelect={onContactSelect}
          onSelectThreadKey={onSelectThreadKey}
        />
      </div>
    </aside>
  )
}