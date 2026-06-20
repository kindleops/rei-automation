import type { ContactLadderEntry, EntityGraphAction, EntityGraphDossier, UniversalEntityContext } from '../../domain/entity-graph/entity-graph.types'

type Props = {
  dossier: EntityGraphDossier | null
  loading: boolean
  universalContext: UniversalEntityContext
  actions: Array<{ key: EntityGraphAction; label: string; disabled?: boolean; hint?: string }>
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
  onContactSelect: (entry: ContactLadderEntry) => void
  onSelectThreadKey?: (threadKey: string) => void
  compact?: boolean
}

function ContactLadder({
  ladder,
  onSelect,
}: {
  ladder?: { phones: ContactLadderEntry[]; emails: ContactLadderEntry[] }
  onSelect: (entry: ContactLadderEntry) => void
}) {
  if (!ladder) return null
  const items = [...ladder.phones, ...ladder.emails]
  if (items.length === 0) return null
  return (
    <div className="nx-entity-graph__ladder">
      {items.map((entry) => (
        <button
          key={`${entry.type}:${entry.id}`}
          type="button"
          className={`nx-entity-graph__ladder-item${entry.eligible ? '' : ' is-ineligible'}`}
          onClick={() => onSelect(entry)}
          disabled={!entry.eligible}
        >
          <div>{entry.value}</div>
          <div>{entry.type === 'phone' ? 'Phone' : 'Email'} · Rank {entry.rank ?? '—'}</div>
          <div>{entry.wrongNumber ? 'Wrong Number' : entry.eligible ? 'Eligible' : 'Ineligible'}</div>
        </button>
      ))}
    </div>
  )
}

export function EntityGraphDossierPanel({
  dossier,
  loading,
  universalContext,
  actions,
  onAction,
  onContactSelect,
  onSelectThreadKey,
  compact = false,
}: Props) {
  if (loading) return <div className="nx-entity-graph__loading">Loading dossier…</div>
  if (!dossier) {
    return (
      <div className="nx-entity-graph__empty">
        Select a record to inspect identity, relationships, contact ladder, and cross-view actions.
      </div>
    )
  }

  const identity = dossier.identity
  const summary = dossier.summary as Record<string, unknown> | undefined
  const title = dossier.entityType === 'property'
    ? String(summary?.property_address_full || identity?.propertyContext || dossier.entityId)
    : dossier.entityType === 'market'
      ? String(summary?.market || dossier.entityId)
      : dossier.entityType === 'zip'
        ? String(summary?.zip || dossier.entityId)
        : dossier.entityType === 'phone' || dossier.entityType === 'email'
          ? String(identity?.contactMethod || dossier.entityId)
          : identity?.masterOwner
            || String(summary?.display_name || summary?.full_name || dossier.entityId)

  return (
    <div className={`nx-entity-graph__dossier${compact ? ' is-compact' : ''}`}>
      <div className={`nx-entity-graph__identity is-type-${dossier.entityType}`}>
        <h3>{title}</h3>
        {identity && (
          <div className="nx-entity-graph__identity-grid">
            {identity.talkingTo && (
              <div><span>Talking to:</span> {identity.talkingTo}{identity.talkingToRelationship ? ` · ${identity.talkingToRelationship}` : ''}</div>
            )}
            {identity.propertyContext && <div><span>Property:</span> {identity.propertyContext}</div>}
            {identity.contactMethod && <div><span>Channel:</span> {identity.contactMethod}</div>}
          </div>
        )}
      </div>

      {!compact && (
        <div className="nx-entity-graph__metrics">
          {dossier.scores && Object.entries(dossier.scores).map(([key, value]) => (
            <div key={key} className="nx-entity-graph__metric">
              <span>{key}</span>
              <strong>{String(value ?? '—')}</strong>
            </div>
          ))}
          {dossier.portfolio && (
            <div className="nx-entity-graph__metric">
              <span>Portfolio</span>
              <strong>{String((dossier.portfolio as Record<string, unknown>).propertyCount ?? '—')} properties</strong>
            </div>
          )}
        </div>
      )}

      <div className="nx-entity-graph__actions">
        {actions.map((action, index) => (
          <button
            key={action.key}
            type="button"
            className={`nx-entity-graph__action${index === 0 && !action.disabled ? ' is-primary' : ''}`}
            disabled={action.disabled}
            title={action.disabled ? action.hint : undefined}
            onClick={() => onAction?.(action.key, universalContext)}
          >
            {action.label}
            {action.disabled && action.hint ? <span className="nx-entity-graph__action-hint">{action.hint}</span> : null}
          </button>
        ))}
      </div>

      <ContactLadder ladder={dossier.contactLadder} onSelect={onContactSelect} />

      {dossier.threads && dossier.threads.length > 0 && (
        <div className="nx-entity-graph__ladder" style={{ marginTop: 12 }}>
          {dossier.threads.slice(0, compact ? 2 : 6).map((thread) => (
            <button
              key={String(thread.thread_key)}
              type="button"
              className="nx-entity-graph__ladder-item"
              onClick={() => onSelectThreadKey?.(String(thread.thread_key))}
            >
              <div>Thread {String(thread.thread_key).slice(-8)}</div>
              <div>{String(thread.last_message_body || '').slice(0, compact ? 40 : 80)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}