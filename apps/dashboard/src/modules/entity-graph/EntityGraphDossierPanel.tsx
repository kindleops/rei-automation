import type { ContactLadderEntry, EntityGraphAction, EntityGraphDossier, UniversalEntityContext } from '../../domain/entity-graph/entity-graph.types'
import type { EntityGraphActionItem } from '../../domain/entity-graph/entity-graph-actions'
import type { SelectedEntity } from '../../domain/entity-graph/selected-entity'
import { dossierApiType } from '../../domain/entity-graph/selected-entity'
import {
  formatCurrency,
  formatMetricLabel,
  formatMetricValue,
  pluralCount,
} from './entity-graph-ui-helpers'

function propertyInspectorFields(row: Record<string, unknown>) {
  const city = String(row.property_address_city || '').trim()
  const state = String(row.property_address_state || '').trim()
  const zip = String(row.property_address_zip || row.property_zip || '').trim()
  const street = String(row.property_address_street || row.property_address_full || '').split(',')[0]?.trim()
  const market = String(row.marketLabel || row.market_region || row.market || '—')
  return {
    title: street && street.length >= 3 && !street.startsWith(',') ? street : 'Address incomplete',
    location: [city, state, zip].filter(Boolean).join(', ') || '—',
    market,
    assetType: row.normalized_asset_class || row.property_type || '—',
    units: row.units_count,
    value: row.estimated_value,
    equity: row.equity_percent ?? row.equity_amount,
  }
}

type Props = {
  selectedEntity: SelectedEntity
  dossier: EntityGraphDossier | null
  loading: boolean
  actionContext: UniversalEntityContext
  actions: Array<{ key: EntityGraphAction; label: string; disabled?: boolean; hint?: string }>
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
  onContactSelect: (entry: ContactLadderEntry) => void
  onSelectThreadKey?: (threadKey: string) => void
  compact?: boolean
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="eg-inspector-metric">
      <span className="eg-inspector-metric__label">{label}</span>
      <strong className="eg-inspector-metric__value">{value}</strong>
    </div>
  )
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
      <h4 className="eg-inspector-section__title">Contact ladder</h4>
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

function PropertyInspector({ dossier, compact }: { dossier: EntityGraphDossier; compact?: boolean }) {
  const row = dossier.summary as Record<string, unknown>
  const summary = propertyInspectorFields(row)
  const scores = dossier.scores as Record<string, unknown> | undefined
  return (
    <div className="eg-inspector-section">
      <MetricRow label="Address" value={summary.title} />
      <MetricRow label="City / State / ZIP" value={summary.location} />
      <MetricRow label="Canonical Market" value={String(summary.market)} />
      <MetricRow label="Property Type" value={String(summary.assetType)} />
      {summary.units !== undefined && <MetricRow label="Units" value={String(summary.units)} />}
      <MetricRow label="Value" value={formatCurrency(summary.value as number | undefined)} />
      <MetricRow label="Equity" value={summary.equity !== undefined ? formatMetricValue('equity', summary.equity) : '—'} />
      {!compact && scores && (
        <>
          {scores.acquisition !== undefined && <MetricRow label="Acquisition Score" value={formatMetricValue('acquisition', scores.acquisition)} />}
          {scores.motivation !== undefined && <MetricRow label="Motivation" value={formatMetricValue('motivation', scores.motivation)} />}
        </>
      )}
      {dossier.identity?.masterOwner && <MetricRow label="Master Owner" value={String(dossier.identity.masterOwner)} />}
      {dossier.identity?.talkingTo && <MetricRow label="Active Person" value={String(dossier.identity.talkingTo)} />}
    </div>
  )
}

function OwnerInspector({ dossier }: { dossier: EntityGraphDossier }) {
  const owner = dossier.summary as Record<string, unknown>
  const portfolio = dossier.portfolio as Record<string, unknown> | undefined
  const coverage = owner.contactability_score ?? ownerContactCoverageFromDossier(dossier)
  return (
    <div className="eg-inspector-section">
      <MetricRow label="Owner Name" value={String(owner.display_name || dossier.entityId)} />
      <MetricRow label="Owner Type" value={String(owner.owner_type_guess || '—')} />
      <MetricRow label="Priority Tier" value={String(owner.priority_tier || '—')} />
      <MetricRow label="Portfolio" value={formatMetricValue('propertyCount', portfolio?.propertyCount ?? owner.property_count)} />
      <MetricRow label="Portfolio Value" value={formatCurrency(portfolio?.totalValue as number | undefined)} />
      <MetricRow label="Linked People" value={pluralCount(dossier.prospects?.length, 'person', 'people')} />
      <MetricRow label="Contact Coverage" value={coverage !== null && coverage !== undefined ? `${Math.min(100, Math.round(Number(coverage)))}%` : '—'} />
    </div>
  )
}

function ownerContactCoverageFromDossier(dossier: EntityGraphDossier): number | null {
  const people = dossier.prospects?.length ?? 0
  if (people <= 0) return null
  const score = (dossier.summary as Record<string, unknown>)?.contactability_score
  if (score !== undefined && score !== null) return Math.min(100, Number(score))
  return null
}

function PersonInspector({ dossier }: { dossier: EntityGraphDossier }) {
  const person = dossier.summary as Record<string, unknown>
  const shortId = String(person.prospect_id || dossier.entityId).slice(-6)
  return (
    <div className="eg-inspector-section">
      <MetricRow label="Full Name" value={String(person.full_name || person.first_name || dossier.entityId)} />
      <MetricRow label="Canonical ID" value={shortId ? `…${shortId}` : '—'} />
      <MetricRow label="Linked Master Owner" value={String(dossier.identity?.masterOwner || '—')} />
      <MetricRow label="Linked Properties" value={pluralCount(dossier.properties?.length, 'property')} />
      <MetricRow label="Language" value={String(person.language_preference || '—')} />
      <MetricRow label="Occupation" value={String(person.occupation_group || '—')} />
    </div>
  )
}

function OrganizationInspector({ dossier }: { dossier: EntityGraphDossier }) {
  const org = dossier.summary as Record<string, unknown>
  const mailing = org.owner_address_full
    || [org.owner_address_city, org.owner_address_state, org.owner_address_zip].filter(Boolean).join(', ')
  return (
    <div className="eg-inspector-section">
      <MetricRow label="Entity Name" value={String(org.owner_name || dossier.entityId)} />
      <MetricRow label="Entity Type" value={String(org.owner_entity_id || 'Ownership Entity')} />
      <MetricRow label="Mailing Address" value={String(mailing || '—')} />
      <MetricRow label="Linked Properties" value={pluralCount(dossier.properties?.length, 'property')} />
      <MetricRow label="Linked People" value={pluralCount(dossier.prospects?.length, 'person', 'people')} />
      <MetricRow label="Related Master Owner" value={String(dossier.identity?.masterOwner || dossier.owner?.display_name || '—')} />
    </div>
  )
}

function ContactInspector({ dossier }: { dossier: EntityGraphDossier }) {
  const contact = dossier.summary as Record<string, unknown>
  const isPhone = dossier.entityType === 'phone'
  const eligibility = dossier.eligibility as Record<string, unknown> | undefined
  return (
    <div className="eg-inspector-section">
      <MetricRow label="Contact" value={String(isPhone ? contact.canonical_e164 || contact.phone : contact.email_normalized || contact.email || dossier.entityId)} />
      <MetricRow label="Type" value={isPhone ? String(contact.phone_type || 'Phone') : 'Email'} />
      <MetricRow label="Linked Person" value={String(dossier.identity?.talkingTo || '—')} />
      <MetricRow label="Linked Owner" value={String(dossier.identity?.masterOwner || '—')} />
      <MetricRow label="Eligibility" value={eligibility?.wrongNumber ? 'Wrong Number' : eligibility?.eligible === false ? 'Not Eligible' : 'Eligible'} />
      <MetricRow label="Reachability" value={eligibility?.wrongNumber ? 'Unreachable' : 'Reachable'} />
    </div>
  )
}

function AggregateInspector({ dossier, entityType }: { dossier: EntityGraphDossier; entityType: 'market' | 'zip' }) {
  const summary = dossier.summary as Record<string, unknown>
  const metrics = dossier.graph?.nodes?.[0]?.meta as Record<string, unknown> | undefined
  return (
    <div className="eg-inspector-section">
      <MetricRow label={entityType === 'zip' ? 'ZIP' : 'Market'} value={String(summary.zip || summary.market || dossier.entityId)} />
      <MetricRow label="Properties" value={pluralCount(Number(summary.propertyCount || metrics?.properties), 'property')} />
      <MetricRow label="Master Owners" value={pluralCount(Number(metrics?.masterOwners), 'owner')} />
      <MetricRow label="People" value={pluralCount(Number(metrics?.people), 'person', 'people')} />
      <MetricRow label="Reachable Contacts" value={pluralCount(Number(metrics?.reachableContacts), 'contact')} />
      {metrics?.avgAcquisitionScore !== undefined && (
        <MetricRow label="Avg Acquisition Score" value={formatMetricValue('acquisition', metrics.avgAcquisitionScore)} />
      )}
    </div>
  )
}

export function EntityGraphDossierPanel({
  selectedEntity,
  dossier,
  loading,
  actionContext,
  actions,
  onAction,
  onContactSelect,
  onSelectThreadKey,
  compact = false,
}: Props) {
  if (loading) return <div className="nx-entity-graph__loading">Loading dossier…</div>
  if (!dossier || dossierApiType(selectedEntity) !== dossier.entityType || dossier.entityId !== selectedEntity.id) {
    return (
      <div className="nx-entity-graph__empty">
        Select a record to inspect identity, relationships, contact ladder, and cross-view actions.
      </div>
    )
  }

  const entityType = selectedEntity.type
  const summary = dossier.summary as Record<string, unknown> | undefined
  const title = entityType === 'property'
    ? propertyInspectorFields(summary || {}).title
    : entityType === 'market'
      ? String(summary?.market || dossier.entityId)
      : entityType === 'zip'
        ? String(summary?.zip || dossier.entityId)
        : entityType === 'phone' || entityType === 'email'
          ? String(dossier.identity?.contactMethod || dossier.entityId)
          : entityType === 'person'
            ? String(summary?.full_name || dossier.entityId)
            : entityType === 'ownership_entity'
              ? String(summary?.owner_name || dossier.entityId)
              : String(summary?.display_name || summary?.full_name || dossier.entityId)

  const showMessagingActions = entityType !== 'market' && entityType !== 'zip'
  const filteredActions = showMessagingActions ? actions : actions.filter((a) =>
    !['create_manual_draft', 'open_thread', 'contact_owner', 'view_threads'].includes(a.key),
  )

  return (
    <div className={`nx-entity-graph__dossier${compact ? ' is-compact' : ''}`}>
      <div className={`nx-entity-graph__identity is-type-${entityType}`}>
        <h3>{title}</h3>
      </div>

      {entityType === 'property' && <PropertyInspector dossier={dossier} compact={compact} />}
      {entityType === 'master_owner' && <OwnerInspector dossier={dossier} />}
      {entityType === 'person' && <PersonInspector dossier={dossier} />}
      {entityType === 'ownership_entity' && <OrganizationInspector dossier={dossier} />}
      {(entityType === 'phone' || entityType === 'email') && <ContactInspector dossier={dossier} />}
      {(entityType === 'market' || entityType === 'zip') && (
        <AggregateInspector dossier={dossier} entityType={entityType} />
      )}

      {!compact && dossier.scores && entityType === 'property' && (
        <div className="nx-entity-graph__metrics">
          {Object.entries(dossier.scores).map(([key, value]) => (
            <div key={key} className="nx-entity-graph__metric">
              <span>{formatMetricLabel(key)}</span>
              <strong>{formatMetricValue(key, value)}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="nx-entity-graph__actions">
        {filteredActions.map((action, index) => (
          <button
            key={action.key}
            type="button"
            className={`nx-entity-graph__action${index === 0 && !action.disabled ? ' is-primary' : ''}`}
            disabled={action.disabled}
            title={action.disabled ? action.hint : undefined}
            onClick={() => onAction?.(action.key, actionContext)}
          >
            {action.label}
            {action.disabled && action.hint ? <span className="nx-entity-graph__action-hint">{action.hint}</span> : null}
          </button>
        ))}
      </div>

      {entityType !== 'market' && entityType !== 'zip' && (
        <ContactLadder ladder={dossier.contactLadder} onSelect={onContactSelect} />
      )}

      {showMessagingActions && dossier.threads && dossier.threads.length > 0 && (
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