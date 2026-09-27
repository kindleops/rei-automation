import { useCallback, useRef } from 'react'
import { Icon } from '../../../shared/icons'
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import { ARCHETYPE_LABEL } from '../../../domain/entity-graph/entity-graph-intel-api'
import {
  compactCount,
  compactCurrency,
  humanizeEnum,
  resolveContactability,
  resolveIdentity,
  resolveMarket,
  resolveTags,
  scopeForResult,
  type EntityScope,
} from './entity-graph-mobile-format'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s && s !== 'null' ? s : null
}

/** The rail states the loudest RECORDED signal — never a legacy score. */
function recordTier(result: EntitySearchResult): 'hot' | 'warm' | 'cool' | 'none' {
  const d = result.details ?? {}
  const signals = d.records?.signals ?? []
  if (signals.some((s) => s.tone === 'alert')) return 'hot'
  if (signals.some((s) => s.tone === 'warn') || d.taxDelinquent) return 'warm'
  if (d.records && (d.records.mortgageCount > 0 || d.records.lienCount > 0 || d.records.saleCount > 0)) return 'cool'
  return 'none'
}

function relativeYears(date?: string | null): string | null {
  if (!date) return null
  const y = Number(String(date).slice(0, 4))
  return Number.isFinite(y) ? String(y) : null
}

const SIGNAL_TAGS = /tax delinquent|foreclos|vacant|tired landlord|lien|divorce|probate/i

/** Shown only on a cross-type search row, so a mixed list stays legible. */
const TYPE_LABEL: Record<EntityScope, string> = {
  properties: 'Property',
  master_owners: 'Owner',
  people: 'Person',
  organizations: 'Company',
  contact_methods: 'Contact',
  buyers: 'Buyer',
}

type Props = {
  scope: EntityScope
  result: EntitySearchResult
  selectionMode: boolean
  selected: boolean
  active: boolean
  onOpen: () => void
  onToggleSelect: () => void
  onEnterSelection: () => void
}

/**
 * One dense operator row. The desktop card was a 2-up grid of ~150px tiles that
 * fit three records per phone screen; this fits eight, and leads with what the
 * operator actually triages on — address, money, who owns it, can we reach them.
 */
export function EntityGraphMobileRow({
  scope: ambientScope,
  result,
  selectionMode,
  selected,
  active,
  onOpen,
  onToggleSelect,
  onEnterSelection,
}: Props) {
  /**
   * A row renders as WHAT IT IS, not as the tab it is sitting in.
   *
   * Global search returns a mixed set -- a property, the owner behind it, the
   * person on the ladder, the phone that reaches them. Rendering all of those
   * with the ambient scope put an owner's portfolio value in the property-value
   * slot and a phone in the address slot. The ambient scope stays as the
   * fallback for a browse list, where every row genuinely is that type.
   */
  const scope = scopeForResult(result, ambientScope)
  const isCrossType = scope !== ambientScope
  const d = result.details ?? {}
  const identity = resolveIdentity(scope, result)
  const market = resolveMarket(result)
  const contactability = resolveContactability(scope, result)
  const ownerTier = humanizeEnum(d.priorityTier)
  // Everything the row already prints, so tags don't repeat it.
  const tags = resolveTags(scope, result, [
    identity.secondary,
    ownerTier,
    d.occupation,
    d.language,
    d.phoneType,
    d.eligibility,
    d.contactType,
    result.subtitle,
  ])
  const longPressRef = useRef<number | null>(null)
  const longPressedRef = useRef(false)

  const cancelLongPress = useCallback(() => {
    if (longPressRef.current !== null) {
      window.clearTimeout(longPressRef.current)
      longPressRef.current = null
    }
  }, [])

  const handlePointerDown = useCallback(() => {
    if (selectionMode) return
    longPressedRef.current = false
    longPressRef.current = window.setTimeout(() => {
      longPressedRef.current = true
      // Haptic where the platform offers it; silent elsewhere.
      navigator.vibrate?.(12)
      onEnterSelection()
    }, 420)
  }, [onEnterSelection, selectionMode])

  const handleClick = useCallback(() => {
    cancelLongPress()
    if (longPressedRef.current) {
      longPressedRef.current = false
      return
    }
    if (selectionMode) onToggleSelect()
    else onOpen()
  }, [cancelLongPress, onOpen, onToggleSelect, selectionMode])

  const rail = scope === 'properties'
    ? recordTier(result)
    : scope === 'buyers'
      ? (d.activityStatus === 'active' ? 'buyer' : d.activityStatus === 'slowing' ? 'warm' : 'none')
      : contactability.reachable === true ? 'cool' : 'none'
  const recordSignals = scope === 'properties' ? (d.records?.signals ?? []) : []
  // Buyer badges already render as the activity pill + archetype meta.
  const shownTags = scope === 'buyers' ? [] : tags

  return (
    <div
      className={cls('egm-row', selected && 'is-selected', active && !selected && 'is-active')}
      role="button"
      tabIndex={0}
      aria-pressed={selectionMode ? selected : undefined}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      onPointerDown={handlePointerDown}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onContextMenu={(e) => e.preventDefault()}
    >
      {selectionMode ? (
        <span className="egm-row__check">
          <span className="egm-row__box"><Icon name="check" /></span>
        </span>
      ) : (
        <span className={cls('egm-row__rail', `is-${rail}`)} aria-hidden />
      )}

      <span className="egm-row__body">
        <span className="egm-row__l1">
          <span className="egm-row__title">{identity.primary}</span>
          {isCrossType ? <span className="egr-typepill">{TYPE_LABEL[scope]}</span> : null}
          <RowValue scope={scope} result={result} />
        </span>

        <span className="egm-row__meta">
          {scope === 'properties' && market.label ? (
            <span className={market.isSendingZone ? undefined : 'egm-offzone'}>{market.label}</span>
          ) : null}
          {scope === 'properties' && d.assetType ? <span>{d.assetType}</span> : null}
          {scope === 'properties' && typeof d.equity === 'number' ? <span>{Math.round(d.equity)}% eq</span> : null}
          {scope === 'buyers' && d.primaryMarket ? <span>{d.primaryMarket}</span> : null}
          {scope === 'buyers' && d.archetype && ARCHETYPE_LABEL[d.archetype] && d.archetype !== 'insufficient_evidence' ? <span>{ARCHETYPE_LABEL[d.archetype]}</span> : null}
          {scope === 'buyers' && d.lastAcquisition ? <span>Last buy {relativeYears(d.lastAcquisition)}</span> : null}
          {(scope === 'master_owners' || scope === 'people') && identity.secondary ? (
            <span>{identity.secondary}</span>
          ) : null}
          {scope === 'organizations' ? (() => {
            const type = text(d.entityType) ?? text(result.subtitle)
            const unknown = !type || /^other\/?unknown$/i.test(type)
            return unknown
              ? <span className="egm-row__gap">Entity type unclassified</span>
              : <span>{type}</span>
          })() : null}
          {(scope === 'master_owners' || scope === 'people') && result.linkedCounts.properties !== undefined ? (
            <span>
              {compactCount(result.linkedCounts.properties)}
              {result.linkedCounts.properties === 1 ? ' property' : ' properties'}
            </span>
          ) : null}
          {scope === 'contact_methods' ? (
            <span>{text(d.phoneType) ?? text(d.contactType) ?? 'Contact method'}</span>
          ) : null}
          {/* When the address is missing, the parcel id is the only handle the
              operator has — keep it on the row rather than only in the sheet. */}
          {scope === 'properties' && identity.gap && identity.secondary ? (
            <span>{identity.secondary}</span>
          ) : null}
          {identity.gap ? <span className="egm-row__gap">{identity.gap}</span> : null}
        </span>

        <span className="egm-row__l3">
          <RowOwner scope={scope} result={result} identitySecondary={identity.secondary} />
          <ContactPill scope={scope} result={result} />
        </span>

        {scope === 'properties' ? <RecordStrip result={result} /> : null}
        {scope === 'buyers' ? <BuyerStrip result={result} /> : null}

        {recordSignals.length > 0 || shownTags.length > 0 ? (
          <span className="egm-tags">
            {recordSignals.map((signal) => (
              <span key={signal.key} className={cls('egm-tag', 'is-record', `is-${signal.tone}`)}>{signal.label}</span>
            ))}
            {shownTags.filter((tag) => !recordSignals.some((s) => s.label.toLowerCase() === tag.toLowerCase())).map((tag) => (
              <span key={tag} className={cls('egm-tag', SIGNAL_TAGS.test(tag) && 'is-signal')}>{tag}</span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/** Debt · liens · last sale, in one quiet line — the recorded story of the parcel. */
function RecordStrip({ result }: { result: EntitySearchResult }) {
  const r = result.details?.records
  if (!r) return null
  const parts: Array<{ key: string; icon: 'dollar-sign' | 'alert' | 'refresh-cw'; text: string }> = []
  if (r.mortgageCount > 0) {
    const bal = compactCurrency(r.mortgageBalance)
    parts.push({ key: 'debt', icon: 'dollar-sign', text: [`${r.mortgageCount} loan${r.mortgageCount === 1 ? '' : 's'}`, bal, r.firstRate ? `${Number(r.firstRate).toFixed(2).replace(/\.?0+$/, '')}%` : null].filter(Boolean).join(' · ') })
  } else if (r.saleCount > 0) {
    parts.push({ key: 'debt', icon: 'dollar-sign', text: 'No open loans' })
  }
  if (r.lienCount > 0) parts.push({ key: 'liens', icon: 'alert', text: `${r.lienCount} lien${r.lienCount === 1 ? '' : 's'} & notices` })
  if (r.lastSaleDate) {
    parts.push({ key: 'sale', icon: 'refresh-cw', text: ['Sold', relativeYears(r.lastSaleDate), compactCurrency(r.lastSalePrice)].filter(Boolean).join(' ') })
  }
  if (!parts.length) return null
  return (
    <span className="egm-rec">
      {parts.map((p) => (
        <span key={p.key} className={cls('egm-rec__item', `is-${p.key}`)}><Icon name={p.icon} />{p.text}</span>
      ))}
    </span>
  )
}

function BuyerStrip({ result }: { result: EntitySearchResult }) {
  const d = result.details ?? {}
  const parts: string[] = []
  if (d.priceP50) parts.push(`Median ${compactCurrency(d.priceP50)}`)
  if (typeof d.trailing365 === 'number' && d.trailing365 > 0) parts.push(`${d.trailing365} in 12 mo`)
  if (typeof d.cashShare === 'number') parts.push(`${Math.round(d.cashShare * 100)}% cash`)
  return (
    <span className="egm-rec is-buyer">
      {parts.map((p) => <span key={p} className="egm-rec__item">{p}</span>)}
      {d.crossover ? <span className="egm-rec__item is-cross"><Icon name="refresh-cw" />Buys + sells</span> : null}
      {typeof d.ownedCount === 'number' && d.ownedCount > 0 ? <span className="egm-rec__item is-owns"><Icon name="home" />Owns {d.ownedCount} here</span> : null}
    </span>
  )
}

function RowValue({ scope, result }: { scope: EntityScope; result: EntitySearchResult }) {
  const d = result.details ?? {}
  if (scope === 'buyers') {
    return typeof d.acquisitions === 'number'
      ? <span className="egm-row__value is-buys">{d.acquisitions}<small> buys</small></span>
      : null
  }
  if (scope === 'properties') {
    const value = compactCurrency(d.value)
    return value
      ? <span className="egm-row__value">{value}</span>
      : <span className="egm-row__value is-muted">No value</span>
  }
  if (scope === 'master_owners') {
    const value = compactCurrency(d.portfolioValue)
    return value ? <span className="egm-row__value">{value}</span> : null
  }
  if (scope === 'contact_methods') {
    const rank = result.details?.eligibility
    return rank ? null : <span className="egm-row__value is-muted">Unranked</span>
  }
  return null
}

/**
 * Owner identity on a property row. `ownerVia === 'linked_person'` means the
 * owner was resolved through the prospect graph rather than
 * `properties.master_owner_id` (null on 75% of rows), so the row says so
 * instead of asserting a direct ownership record it does not have.
 */
function RowOwner({
  scope,
  result,
  identitySecondary,
}: {
  scope: EntityScope
  result: EntitySearchResult
  identitySecondary: string | null
}) {
  const d = result.details ?? {}

  if (scope === 'properties') {
    const owner = text(d.ownerName)
    // Every owner "bought" their own property once; the role only means
    // something for a REPEAT or still-active buyer.
    const rawBuyer = d.records?.ownerBuyer
    const buyer = rawBuyer && ((rawBuyer.acquisitions ?? 0) >= 2 || rawBuyer.status === 'active') ? rawBuyer : null
    if (!owner) return <span className="egm-row__owner"><em>No owner on title</em></span>
    return (
      <span className="egm-row__owner">
        <Icon name={/ llc|inc| lp|trust|corp/i.test(owner) || d.ownerCorporate ? 'briefcase' : 'user'} />
        <span className="egm-row__owner-name">{owner}</span>
        {d.ownerVia === 'linked_person' ? <em>· via person</em> : null}
        {buyer ? (
          <span className={cls('egm-buyerbadge', buyer.basis === 'name' && 'is-observed', buyer.status === 'active' && 'is-active')}>
            Buyer{typeof buyer.acquisitions === 'number' ? ` · ${buyer.acquisitions}` : ''}
          </span>
        ) : null}
      </span>
    )
  }

  if (scope === 'buyers') {
    const kind = d.entityKind === 'person' ? 'Individual' : 'Company'
    const status = text(d.activityStatus)
    return (
      <span className="egm-row__owner">
        <Icon name={d.entityKind === 'person' ? 'user' : 'briefcase'} />
        {kind}
        {status ? <span className={cls('egm-activity', `is-${status}`)}>{status === 'active' ? 'Active' : status === 'slowing' ? 'Slowing' : status === 'inactive' ? 'Inactive' : 'Unknown'}</span> : null}
      </span>
    )
  }

  if (scope === 'people') {
    const owner = text(d.ownerName)
    return owner ? (
      <span className="egm-row__owner"><Icon name="briefcase" />{owner}</span>
    ) : null
  }

  if (scope === 'contact_methods') {
    const linked = text(result.subtitle)
    return linked ? (
      <span className="egm-row__owner"><Icon name="user" />{linked}</span>
    ) : null
  }

  if (scope === 'organizations') {
    return identitySecondary ? (
      <span className="egm-row__owner"><Icon name="map" />{identitySecondary}</span>
    ) : <span className="egm-row__owner"><em>No mailing address on file</em></span>
  }

  if (scope === 'master_owners') {
    const tier = humanizeEnum(result.details?.priorityTier)
    return tier ? <span className="egm-row__owner"><Icon name="target" />{tier}</span> : null
  }

  return null
}

function ContactPill({ scope, result }: { scope: EntityScope; result: EntitySearchResult }) {
  const c = resolveContactability(scope, result)

  if (scope === 'contact_methods') {
    if (c.reachable === false) return <span className="egm-pill is-blocked">Wrong #</span>
    if (c.reachable === true) return <span className="egm-pill is-reachable">Eligible</span>
    return c.label ? <span className="egm-pill is-unreachable">{c.label}</span> : null
  }

  if (scope === 'master_owners') {
    const coverage = result.linkedCounts.contactCoverage
    if (coverage === null || coverage === undefined) return null
    const pct = Math.min(100, Math.round(Number(coverage)))
    if (!Number.isFinite(pct)) return null
    return (
      <span className={cls('egm-pill', pct > 0 ? 'is-reachable' : 'is-unreachable')}>
        {pct}% reach
      </span>
    )
  }

  // Null means "the adapter did not resolve links", which renders as nothing —
  // never as a zero and never as the old hardcoded "2 contacts".
  if (c.contacts === null) return null
  if (c.contacts === 0) return <span className="egm-pill is-unreachable">No contacts</span>
  return <span className="egm-pill is-reachable">{c.contacts} reachable</span>
}
