import { useCallback, useRef } from 'react'
import { Icon } from '../../../shared/icons'
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import {
  compactCount,
  compactCurrency,
  humanizeEnum,
  resolveContactability,
  resolveIdentity,
  resolveMarket,
  resolveTags,
  type EntityScope,
} from './entity-graph-mobile-format'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s && s !== 'null' ? s : null
}

/** Score tier drives the rail colour so the number can leave the row. */
function scoreTier(score?: number | null): 'hot' | 'warm' | 'cool' | 'none' {
  if (score === null || score === undefined) return 'none'
  const n = Number(score)
  if (!Number.isFinite(n)) return 'none'
  if (n >= 80) return 'hot'
  if (n >= 65) return 'warm'
  if (n > 0) return 'cool'
  return 'none'
}

const SIGNAL_TAGS = /tax delinquent|foreclos|vacant|tired landlord|lien|divorce|probate/i

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
  scope,
  result,
  selectionMode,
  selected,
  active,
  onOpen,
  onToggleSelect,
  onEnterSelection,
}: Props) {
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
    ? scoreTier(d.acquisitionScore ?? result.score)
    : scope === 'master_owners'
      ? scoreTier(result.score)
      : contactability.reachable === true ? 'cool' : 'none'

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
          <RowValue scope={scope} result={result} />
        </span>

        <span className="egm-row__meta">
          {scope === 'properties' && market.label ? (
            <span className={market.isSendingZone ? undefined : 'egm-offzone'}>{market.label}</span>
          ) : null}
          {scope === 'properties' && d.assetType ? <span>{d.assetType}</span> : null}
          {scope === 'properties' && typeof d.equity === 'number' ? <span>{Math.round(d.equity)}% eq</span> : null}
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

        {tags.length > 0 ? (
          <span className="egm-tags">
            {tags.map((tag) => (
              <span key={tag} className={cls('egm-tag', SIGNAL_TAGS.test(tag) && 'is-signal')}>{tag}</span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  )
}

function RowValue({ scope, result }: { scope: EntityScope; result: EntitySearchResult }) {
  const d = result.details ?? {}
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
    if (!owner) return <span className="egm-row__owner"><em>Owner unresolved</em></span>
    return (
      <span className="egm-row__owner">
        <Icon name={/ llc|inc| lp|trust|corp/i.test(owner) ? 'briefcase' : 'user'} />
        {owner}
        {d.ownerVia === 'linked_person' ? <em>· via person</em> : null}
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
