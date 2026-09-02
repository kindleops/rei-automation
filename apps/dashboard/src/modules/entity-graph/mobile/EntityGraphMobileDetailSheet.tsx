import { useMemo, useState } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { MobileSheet } from '../../mobile/MobileSheet'
import type {
  ContactLadderEntry,
  EntityGraphAction,
  EntityGraphDossier,
  EntitySearchResult,
} from '../../../domain/entity-graph/entity-graph.types'
import type { EntityGraphActionItem } from '../../../domain/entity-graph/entity-graph-actions'
import {
  compactCurrency,
  humanizeEnum,
  resolveIdentity,
  resolveMarket,
  type EntityScope,
} from './entity-graph-mobile-format'
import {
  buildRecordSections,
  countPopulated,
  type FieldSectionKey,
  type RecordSection,
} from './entity-graph-record-schema'
import { EntityGraphPropertyVisual } from './EntityGraphPropertyVisual'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s && s !== 'null' ? s : null
}

const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

type Row = Record<string, unknown>

const SCOPE_LABEL: Record<EntityScope, string> = {
  properties: 'Property',
  master_owners: 'Master owner',
  people: 'Person',
  organizations: 'Ownership entity',
  contact_methods: 'Contact method',
}

/** Actions that only make sense at a desk; the sheet keeps the phone-usable set. */
const DESKTOP_ONLY_ACTIONS = new Set<EntityGraphAction>(['open_workflow_studio'])

const ACTION_ICONS: Partial<Record<EntityGraphAction, IconName>> = {
  open_thread: 'message',
  open_conversation: 'message',
  create_manual_draft: 'send',
  contact_owner: 'phone',
  contact_person: 'phone',
  open_deal_intelligence: 'brain',
  open_comp_intelligence: 'stats',
  open_buyer_match: 'users',
  open_in_map: 'map',
  show_on_map: 'map',
  view_properties: 'home',
  view_linked_properties: 'home',
  open_portfolio: 'briefcase',
  view_portfolio: 'briefcase',
  view_owner: 'briefcase',
  view_master_owner: 'briefcase',
  view_prospect: 'user',
  view_linked_person: 'user',
  create_opportunity: 'target',
  open_opportunity: 'target',
  view_threads: 'inbox',
}

const SECTION_ICONS: Record<FieldSectionKey, IconName> = {
  overview: 'grid',
  ownership: 'briefcase',
  people: 'users',
  contact: 'phone',
  intelligence: 'home',
  distress: 'alert',
  outreach: 'send',
  related: 'link',
  provenance: 'database',
  other: 'file-text',
}

/** Sections open by default — the operator's first questions. */
const DEFAULT_OPEN: FieldSectionKey[] = ['overview', 'distress']

function ChainNode({
  icon,
  tone,
  title,
  meta,
  onOpen,
}: {
  icon: IconName
  tone?: 'person' | 'contact'
  title: string
  meta?: string | null
  onOpen?: () => void
}) {
  const Tag = onOpen ? 'button' : 'div'
  return (
    <Tag type={onOpen ? 'button' : undefined} className="egm-node" onClick={onOpen}>
      <span className={cls('egm-node__icon', tone && `is-${tone}`)}><Icon name={icon} /></span>
      <span className="egm-node__body">
        <span className="egm-node__title">{title}</span>
        {meta ? <span className="egm-node__meta">{meta}</span> : null}
      </span>
      {onOpen ? <span className="egm-node__go"><Icon name="chevron-right" /></span> : null}
    </Tag>
  )
}

function CollapsibleSection({
  icon,
  label,
  count,
  open,
  onToggle,
  children,
}: {
  icon: IconName
  label: string
  count?: number | null
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className={cls('egi-section', open && 'is-open')}>
      <button type="button" className="egi-section__head" onClick={onToggle} aria-expanded={open}>
        <span className="egi-section__icon"><Icon name={icon} /></span>
        <span className="egi-section__label">{label}</span>
        {count !== null && count !== undefined ? <span className="egi-section__count">{count}</span> : null}
        <span className="egi-section__chevron"><Icon name={open ? 'chevron-up' : 'chevron-down'} /></span>
      </button>
      {open ? <div className="egi-section__body">{children}</div> : null}
    </section>
  )
}

function FieldGrid({ section }: { section: RecordSection }) {
  return (
    <dl className="egi-fields">
      {section.fields.map((field) => (
        <div key={field.key} className="egi-field">
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  )
}

type Props = {
  open: boolean
  scope: EntityScope
  result: EntitySearchResult | null
  dossier: EntityGraphDossier | null
  loading: boolean
  actions: EntityGraphActionItem[]
  onClose: () => void
  onAction: (action: EntityGraphAction) => void
  onOpenEntity: (entityType: string, entityId: string) => void
}

/**
 * Record inspector.
 *
 * Two layers: the relationship chain (property → owner/entity → people →
 * phones/emails → related properties) which is what a list row cannot show, and
 * a schema-grouped field inspector that surfaces every populated column on the
 * record instead of a curated dozen. Handoffs jump into Map / Seller Detail /
 * Deal Intelligence rather than rebuilding them here.
 */
export function EntityGraphMobileDetailSheet({
  open,
  scope,
  result,
  dossier,
  loading,
  actions,
  onClose,
  onAction,
  onOpenEntity,
}: Props) {
  const [openSections, setOpenSections] = useState<Set<FieldSectionKey>>(new Set(DEFAULT_OPEN))
  const [chainOpen, setChainOpen] = useState(true)
  const [fieldQuery, setFieldQuery] = useState('')

  const summary = (dossier?.summary ?? null) as Row | null
  const allSections = useMemo(() => buildRecordSections(summary), [summary])
  const populated = useMemo(() => countPopulated(summary), [summary])

  /**
   * Field search. With 115 populated fields on a property and 75 on an owner,
   * "collapse everything and scroll" stops being navigation. Matching on label
   * and raw column name both, because an operator who knows the schema will
   * type `apn` or `tax_delinquent`, not "APN / parcel".
   */
  const fieldSearch = fieldQuery.trim().toLowerCase()
  const sections = useMemo(() => {
    if (!fieldSearch) return allSections
    return allSections
      .map((section) => ({
        ...section,
        fields: section.fields.filter((field) =>
          field.label.toLowerCase().includes(fieldSearch)
          || field.key.toLowerCase().includes(fieldSearch)
          || field.value.toLowerCase().includes(fieldSearch)),
      }))
      .filter((section) => section.fields.length > 0)
  }, [allSections, fieldSearch])

  const matchCount = sections.reduce((acc, section) => acc + section.fields.length, 0)

  if (!result) return null

  const identity = resolveIdentity(scope, result)
  const market = resolveMarket(result)
  const owner = (dossier?.owner ?? null) as Row | null
  const people = (dossier?.prospects ?? []) as Row[]
  // Dossier shape differs by entity type: `portfolio` is an array of property
  // rows on the property dossier, but a `{propertyCount, totalValue}` summary
  // object on the owner/organization dossiers, where the rows live under
  // `properties`. Treating it as an array unconditionally crashed the owner
  // inspector with `portfolio.filter is not a function`.
  const portfolio: Row[] = Array.isArray(dossier?.portfolio)
    ? (dossier.portfolio as Row[])
    : ((dossier?.properties ?? []) as Row[])
  const ladder = dossier?.contactLadder
  const threads = dossier?.threads ?? []
  const identityMeta = dossier?.identity as (Record<string, unknown> | undefined)
  const ownerVia = text(identityMeta?.masterOwnerVia)

  const phones = ladder?.phones ?? []
  const emails = ladder?.emails ?? []
  const related = portfolio.filter((p) => text(p.property_id) !== result.entityId)
  const visibleActions = actions.filter((a) => !DESKTOP_ONLY_ACTIONS.has(a.key))

  const toggle = (key: FieldSectionKey) => {
    setOpenSections((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const showVisual = scope === 'properties'
  const address = text(summary?.property_address_full) ?? identity.primary
  const lat = num(summary?.latitude)
  const lng = num(summary?.longitude)

  return (
    <MobileSheet
      open={open}
      title={SCOPE_LABEL[scope]}
      subtitle={identity.primary}
      height="full"
      className="egm-sheet"
      onClose={onClose}
    >
      <div className="egm-detail">
        <header className="egm-detail__hero">
          <div className="egm-detail__title">{identity.primary}</div>
          <div className="egm-detail__sub">
            {identity.secondary ? <span>{identity.secondary}</span> : null}
            {market.label && !identity.secondary?.toLowerCase().includes(market.label.toLowerCase()) ? (
              <span className={market.isSendingZone ? undefined : 'egm-offzone'}>{market.label}</span>
            ) : null}
            {market.label && !market.isSendingZone ? (
              <span className="egm-offzone">Off sending zone</span>
            ) : null}
            {identity.gap ? <span className="egm-row__gap">{identity.gap}</span> : null}
          </div>
        </header>

        {showVisual ? (
          <EntityGraphPropertyVisual
            address={address}
            lat={lat}
            lng={lng}
            onOpenMap={() => onAction('open_in_map')}
          />
        ) : null}

        <DetailStats scope={scope} result={result} dossier={dossier} summary={summary ?? {}} />

        <div className="egm-detail__actions">
          {visibleActions.slice(0, 4).map((action, index) => (
            <button
              key={action.key}
              type="button"
              className={cls('egm-act', index === 0 && 'is-primary')}
              disabled={action.disabled}
              onClick={() => onAction(action.key)}
            >
              <Icon name={ACTION_ICONS[action.key] ?? 'chevron-right'} />
              <span>{action.label}</span>
            </button>
          ))}
        </div>

        {/* ── Relationship chain ── */}
        <CollapsibleSection
          icon="link"
          label="Relationships"
          open={chainOpen}
          onToggle={() => setChainOpen((c) => !c)}
        >
          {loading ? (
            <div className="egm-chain__empty">Loading relationships…</div>
          ) : (
            <>
              {scope !== 'master_owners' && scope !== 'organizations' ? (
                <div className="egi-chainblock">
                  <h5>Owner{ownerVia === 'linked_person' ? ' · via linked person' : ''}</h5>
                  {owner ? (
                    <ChainNode
                      icon="briefcase"
                      title={text(owner.display_name) ?? text(owner.master_owner_id) ?? 'Owner'}
                      meta={[
                        humanizeEnum(text(owner.owner_type_guess)),
                        num(owner.property_count)
                          ? `${num(owner.property_count)} ${num(owner.property_count) === 1 ? 'property' : 'properties'}`
                          : null,
                        compactCurrency(num(owner.portfolio_total_value)),
                      ].filter(Boolean).join(' · ') || null}
                      onOpen={() => onOpenEntity('master_owner', String(owner.master_owner_id))}
                    />
                  ) : (
                    <div className="egm-chain__empty">No master owner record links to this property.</div>
                  )}
                </div>
              ) : null}

              <div className="egi-chainblock">
                <h5>People{people.length ? ` · ${people.length}` : ''}</h5>
                {people.length > 0 ? people.slice(0, 6).map((person) => (
                  <ChainNode
                    key={String(person.prospect_id)}
                    icon="user"
                    tone="person"
                    title={text(person.full_name) ?? String(person.prospect_id)}
                    meta={[
                      person.likely_owner ? 'Likely owner' : null,
                      text(person.language_preference),
                      text(person.occupation_group),
                    ].filter(Boolean).join(' · ') || null}
                    onOpen={() => onOpenEntity('prospect', String(person.prospect_id))}
                  />
                )) : <div className="egm-chain__empty">No linked people on this record.</div>}
              </div>

              <div className="egi-chainblock">
                <h5>Contact ladder{phones.length + emails.length ? ` · ${phones.length + emails.length}` : ''}</h5>
                {phones.length + emails.length > 0 ? (
                  <>
                    {phones.slice(0, 5).map((entry) => (
                      <ContactNode key={entry.id} entry={entry} icon="phone" onOpenEntity={onOpenEntity} />
                    ))}
                    {emails.slice(0, 4).map((entry) => (
                      <ContactNode key={entry.id} entry={entry} icon="mail" onOpenEntity={onOpenEntity} />
                    ))}
                  </>
                ) : <div className="egm-chain__empty">No phones or emails on the ladder.</div>}
              </div>

              <div className="egi-chainblock">
                <h5>Related properties{related.length ? ` · ${related.length}` : ''}</h5>
                {related.length > 0 ? related.slice(0, 6).map((property) => (
                  <ChainNode
                    key={String(property.property_id)}
                    icon="home"
                    title={text(property.property_address_full) ?? String(property.property_id)}
                    meta={[
                      text(property.property_address_city),
                      compactCurrency(num(property.estimated_value)),
                    ].filter(Boolean).join(' · ') || null}
                    onOpen={() => onOpenEntity('property', String(property.property_id))}
                  />
                )) : (
                  <div className="egm-chain__empty">
                    {scope === 'properties' ? 'Single-property owner — no portfolio siblings.' : 'None.'}
                  </div>
                )}
              </div>

              {threads.length > 0 ? (
                <div className="egi-chainblock">
                  <h5>Conversations · {threads.length}</h5>
                  {threads.slice(0, 4).map((thread, index) => {
                    const row = thread as Row
                    return (
                      <ChainNode
                        key={text(row.thread_key) ?? index}
                        icon="message"
                        tone="contact"
                        title={text(row.thread_key) ?? 'Thread'}
                        meta={text(row.conversation_state) ?? text(row.status)}
                        onOpen={() => onAction('open_thread')}
                      />
                    )
                  })}
                </div>
              ) : null}
            </>
          )}
        </CollapsibleSection>

        {/* ── Schema-grouped field inspector ── */}
        {allSections.length > 0 ? (
          <>
            <div className="egi-fieldhead">
              <span>Record fields</span>
              <small>
                {fieldSearch
                  ? `${matchCount} matching`
                  : `${populated.populated} populated of ${populated.total}`}
              </small>
            </div>

            <div className="egm-search egi-search">
              <span className="egm-search__icon"><Icon name="search" /></span>
              <input
                value={fieldQuery}
                onChange={(e) => setFieldQuery(e.target.value)}
                placeholder="Search fields, values, column names…"
                aria-label="Search record fields"
                type="search"
              />
              {fieldQuery ? (
                <button
                  type="button"
                  className="egm-search__clear"
                  onClick={() => setFieldQuery('')}
                  aria-label="Clear field search"
                >
                  ×
                </button>
              ) : null}
            </div>

            {sections.length === 0 ? (
              <div className="egm-chain__empty">No fields match “{fieldQuery}”.</div>
            ) : sections.map((section) => (
              <CollapsibleSection
                key={section.key}
                icon={SECTION_ICONS[section.key]}
                label={section.label}
                count={section.fields.length}
                // A search result is useless collapsed, so matches open themselves.
                open={Boolean(fieldSearch) || openSections.has(section.key)}
                onToggle={() => toggle(section.key)}
              >
                <FieldGrid section={section} />
              </CollapsibleSection>
            ))}
          </>
        ) : loading ? null : (
          <div className="egm-chain__empty">No record fields returned for this entity.</div>
        )}

        {visibleActions.length > 4 ? (
          <div className="egm-detail__actions">
            {visibleActions.slice(4).map((action) => (
              <button
                key={action.key}
                type="button"
                className="egm-act"
                disabled={action.disabled}
                onClick={() => onAction(action.key)}
              >
                <Icon name={ACTION_ICONS[action.key] ?? 'chevron-right'} />
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </MobileSheet>
  )
}

function ContactNode({
  entry,
  icon,
  onOpenEntity,
}: {
  entry: ContactLadderEntry
  icon: IconName
  onOpenEntity: (entityType: string, entityId: string) => void
}) {
  const state = entry.wrongNumber
    ? 'Wrong number'
    : entry.optedOut ? 'Opted out'
    : entry.suppressed ? 'Suppressed'
    : entry.eligible ? 'Eligible' : 'Not eligible'

  return (
    <ChainNode
      icon={icon}
      tone="contact"
      title={entry.value}
      meta={[
        state,
        entry.phoneType,
        entry.rank ? `rank ${entry.rank}` : null,
        entry.lastContacted ? `last ${new Date(entry.lastContacted).toLocaleDateString()}` : null,
      ].filter(Boolean).join(' · ')}
      onOpen={() => onOpenEntity(entry.type, entry.id)}
    />
  )
}

function DetailStats({
  scope,
  result,
  dossier,
  summary,
}: {
  scope: EntityScope
  result: EntitySearchResult
  dossier: EntityGraphDossier | null
  summary: Row
}) {
  const d = result.details ?? {}
  const scores = (dossier?.scores ?? {}) as Row

  const stats: Array<{ label: string; value: string | null }> = scope === 'properties'
    ? [
        { label: 'Value', value: compactCurrency(num(summary.estimated_value) ?? d.value) },
        {
          label: 'Equity',
          value: num(scores.equityPercent) !== null
            ? `${Math.round(num(scores.equityPercent) as number)}%`
            : (typeof d.equity === 'number' ? `${Math.round(d.equity)}%` : null),
        },
        {
          label: 'Score',
          value: num(scores.acquisition) !== null
            ? String(Math.round(num(scores.acquisition) as number))
            : (typeof d.acquisitionScore === 'number' ? String(Math.round(d.acquisitionScore)) : null),
        },
      ]
    : scope === 'master_owners'
      ? [
          { label: 'Portfolio', value: compactCurrency(num(summary.portfolio_total_value) ?? d.portfolioValue) },
          { label: 'Properties', value: num(summary.property_count) !== null ? String(num(summary.property_count)) : (result.linkedCounts.properties?.toString() ?? null) },
          { label: 'Tier', value: humanizeEnum(text(summary.priority_tier) ?? text(d.priorityTier)) },
        ]
      : scope === 'people'
        ? [
            { label: 'Properties', value: result.linkedCounts.properties?.toString() ?? null },
            { label: 'Contacts', value: result.linkedCounts.contacts?.toString() ?? null },
            { label: 'Language', value: text(d.language) },
          ]
        : scope === 'contact_methods'
          ? [
              { label: 'Type', value: text(d.phoneType) ?? text(d.contactType) },
              { label: 'Status', value: text(d.eligibility) },
              { label: 'Reachability', value: text(d.reachability) },
            ]
          : [
              { label: 'Entity type', value: text(d.entityType) ?? text(result.subtitle) },
              { label: 'Properties', value: result.linkedCounts.properties?.toString() ?? null },
              { label: 'People', value: result.linkedCounts.prospects?.toString() ?? null },
            ]

  return (
    <div className="egm-detail__stats">
      {stats.map((stat) => (
        <div key={stat.label} className="egm-stat">
          <em>{stat.label}</em>
          <strong className={stat.value ? undefined : 'is-empty'}>{stat.value ?? '—'}</strong>
        </div>
      ))}
    </div>
  )
}
