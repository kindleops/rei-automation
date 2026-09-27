/**
 * ALL — the interconnected universe, before you pick a lens.
 *
 * One glass tile per entity family with its live count, then the CROSSOVER
 * facts that only exist because seller and buyer intelligence share one
 * identity graph. Every number is a live exact count; every tile opens the
 * cohort it describes, pre-filtered.
 */
import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { CountUp } from '../../../shared/motion/CountUp'
import type { EntityGraphTabCounts } from '../../../domain/entity-graph/entity-graph.types'
import type { EntityGraphFieldFilter } from '../../../domain/entity-graph/entity-graph-field-filters'
import { fetchComposition, type Composition } from '../../../domain/entity-graph/entity-graph-intel-api'
import type { EntityScope } from './entity-graph-mobile-format'

type Target = { scope: EntityScope; fieldFilters?: EntityGraphFieldFilter[]; sortKey?: string }

type Props = {
  counts: EntityGraphTabCounts | null
  onOpen: (target: Target) => void
}

const FAMILIES: Array<{ scope: EntityScope; label: string; countKey: keyof EntityGraphTabCounts; icon: IconName; hue: string; line: string }> = [
  { scope: 'properties', label: 'Properties', countKey: 'properties', icon: 'home', hue: '#5ee7ff', line: 'Parcels, debt, liens, sale history' },
  { scope: 'master_owners', label: 'Owners', countKey: 'master_owners', icon: 'briefcase', hue: '#f7c75b', line: 'Who controls the portfolio' },
  { scope: 'buyers', label: 'Buyers', countKey: 'buyers', icon: 'target', hue: '#34e8c4', line: 'Resolved buyer entities + behaviour' },
  { scope: 'organizations', label: 'Companies', countKey: 'organizations', icon: 'layers', hue: '#a98bff', line: 'LLCs, trusts, estates on title' },
  { scope: 'people', label: 'People', countKey: 'people', icon: 'users', hue: '#3ee6a4', line: 'Decision makers and relatives' },
  { scope: 'contact_methods', label: 'Contacts', countKey: 'contact_methods', icon: 'phone', hue: '#7cc4ff', line: 'Phones and emails that reach them' },
]

function bucket(c: Composition | null, key: string): { value: number | null; filter: EntityGraphFieldFilter | null } {
  const b = c?.buckets.find((x) => x.key === key)
  return { value: b?.value ?? null, filter: b?.filter ?? null }
}

export function EntityGraphUniverseOverview({ counts, onOpen }: Props) {
  const [owner, setOwner] = useState<Composition | null>(null)
  const [distress, setDistress] = useState<Composition | null>(null)
  const [roles, setRoles] = useState<Composition | null>(null)
  const [activity, setActivity] = useState<Composition | null>(null)

  useEffect(() => {
    const c = new AbortController()
    void fetchComposition({ tab: 'properties', dimension: 'owner' }, c.signal).then(setOwner).catch(() => {})
    void fetchComposition({ tab: 'properties', dimension: 'distress' }, c.signal).then(setDistress).catch(() => {})
    void fetchComposition({ tab: 'buyers', dimension: 'roles' }, c.signal).then(setRoles).catch(() => {})
    void fetchComposition({ tab: 'buyers', dimension: 'activity' }, c.signal).then(setActivity).catch(() => {})
    return () => c.abort()
  }, [])

  const ownerBuyer = bucket(owner, 'owner_buyer')
  const ownerActive = bucket(owner, 'owner_buyer_active')
  const crossover = bucket(roles, 'crossover')
  const activeBuyers = bucket(activity, 'active')
  const probate = bucket(distress, 'probate')
  const foreclosure = bucket(distress, 'foreclosure')
  const lisPendens = bucket(distress, 'lis_pendens')

  const insights: Array<{ key: string; value: number | null; label: string; sub: string; hue: string; icon: IconName; target: Target | null }> = [
    { key: 'owner_buyer', value: ownerBuyer.value, label: 'Owned by a repeat buyer', sub: 'Seller here, buyer elsewhere', hue: '#34e8c4', icon: 'refresh-cw', target: ownerBuyer.filter ? { scope: 'properties', fieldFilters: [ownerBuyer.filter] } : null },
    { key: 'owner_active', value: ownerActive.value, label: 'Owned by an ACTIVE buyer', sub: 'Still acquiring right now', hue: '#3ee6a4', icon: 'zap', target: ownerActive.filter ? { scope: 'properties', fieldFilters: [ownerActive.filter] } : null },
    { key: 'crossover', value: crossover.value, label: 'Buyers that also sell', sub: 'Own here and have sold', hue: '#a98bff', icon: 'layers', target: crossover.filter ? { scope: 'buyers', fieldFilters: [crossover.filter] } : null },
    { key: 'active', value: activeBuyers.value, label: 'Active buyers', sub: 'Bought recently and consistently', hue: '#34e8c4', icon: 'target', target: activeBuyers.filter ? { scope: 'buyers', fieldFilters: [activeBuyers.filter], sortKey: 'recent' } : null },
    { key: 'probate', value: probate.value, label: 'Probate filings', sub: 'Recorded against the property', hue: '#ff9f6b', icon: 'file-text', target: probate.filter ? { scope: 'properties', fieldFilters: [probate.filter] } : null },
    { key: 'lis', value: lisPendens.value, label: 'Lis pendens', sub: 'Litigation recorded on title', hue: '#ff7a9c', icon: 'alert', target: lisPendens.filter ? { scope: 'properties', fieldFilters: [lisPendens.filter] } : null },
    { key: 'fc', value: foreclosure.value, label: 'Foreclosure filings', sub: 'Default, judgment or auction', hue: '#ff5a64', icon: 'alert-circle', target: foreclosure.filter ? { scope: 'properties', fieldFilters: [foreclosure.filter] } : null },
  ]

  return (
    <section className="egu">
      <div className="egu__families">
        {FAMILIES.map((f, i) => {
          const n = counts?.[f.countKey]
          return (
            <button key={f.scope} type="button" className="egu__family" style={{ ['--hue' as string]: f.hue, ['--i' as string]: i }} onClick={() => onOpen({ scope: f.scope })}>
              <span className="egu__glow" aria-hidden="true" />
              <span className="egu__icon"><Icon name={f.icon} /></span>
              <span className="egu__count">{typeof n === 'number' ? <CountUp value={n} format={(v) => Math.round(v).toLocaleString()} /> : '—'}</span>
              <span className="egu__label">{f.label}</span>
              <span className="egu__line">{f.line}</span>
            </button>
          )
        })}
      </div>

      <h2 className="egu__eyebrow">Where the universe connects</h2>
      <div className="egu__insights">
        {insights.map((row, i) => (
          <button
            key={row.key}
            type="button"
            className="egu__insight"
            style={{ ['--hue' as string]: row.hue, ['--i' as string]: i }}
            disabled={!row.target}
            onClick={() => row.target && onOpen(row.target)}
          >
            <span className="egu__insight-icon"><Icon name={row.icon} /></span>
            <span className="egu__insight-text">
              <b>{row.label}</b>
              <small>{row.sub}</small>
            </span>
            <span className="egu__insight-num">{row.value === null ? <i className="egu__dots" /> : <CountUp value={row.value} format={(v) => Math.round(v).toLocaleString()} />}</span>
            <Icon name="chevron-right" />
          </button>
        ))}
      </div>
    </section>
  )
}
