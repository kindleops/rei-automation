import { useMemo } from 'react'
import { Icon } from '../../../shared/icons'
import type { EntityGraphDossier, EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'

/**
 * RELATIONSHIP SCOPE, stated before anything is scrolled.
 *
 * §9's complaint is that the mobile Entity Graph "fails the premise of the
 * application because the actual relationship graph is missing or de-emphasised".
 * Two things were true: the graph was the third of three view tabs, and nothing on
 * the landing state said what the subject was CONNECTED to — the operator had to
 * open a record and then switch views to learn there were seven properties behind
 * one owner.
 *
 * This is the missing sentence — "1 owner · 7 properties · 4 phones · 2 emails" —
 * and it is also the entry to the graph, so the relationship structure is one tap
 * from the landing state rather than two.
 *
 * Every count is real. The dossier's own arrays are counted where it has loaded;
 * otherwise the search result's `linkedCounts`, which the graph service computes.
 * A count that neither source has is ABSENT rather than rendered as zero — "0
 * phones" and "phones not loaded yet" are different claims about a seller.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/**
 * `EntityGraphDossier.portfolio` is declared `Record<string, unknown>` while the
 * service returns an array of properties. Rather than trust either, count what is
 * actually there — a wrong type must not become a wrong number on screen.
 */
const lengthOf = (value: unknown): number | null =>
  Array.isArray(value) ? value.length : null

interface ScopeCount {
  key: string
  label: string
  plural: string
  value: number
}

export interface EntityGraphScopeStripProps {
  anchor: EntitySearchResult | null
  dossier: EntityGraphDossier | null
  loading: boolean
  active: boolean
  onOpenGraph: () => void
}

export const EntityGraphScopeStrip = ({
  anchor,
  dossier,
  loading,
  active,
  onOpenGraph,
}: EntityGraphScopeStripProps) => {
  const counts = useMemo<ScopeCount[]>(() => {
    if (!anchor) return []
    const linked = anchor.linkedCounts ?? {}
    const rows: ScopeCount[] = []

    const push = (key: string, label: string, plural: string, value: number | undefined | null) => {
      if (value == null || !Number.isFinite(value)) return
      rows.push({ key, label, plural, value })
    }

    // The dossier is the richer source when it has arrived: it carries the actual
    // arrays rather than a precomputed rollup.
    if (dossier) {
      push('owners', 'owner', 'owners', dossier.owner ? 1 : 0)
      push(
        'properties',
        'property',
        'properties',
        lengthOf(dossier.portfolio) ?? lengthOf(dossier.properties) ?? linked.properties,
      )
      push('people', 'person', 'people', lengthOf(dossier.prospects) ?? linked.prospects)
      push('phones', 'phone', 'phones', dossier.contactLadder?.phones?.length)
      push('emails', 'email', 'emails', dossier.contactLadder?.emails?.length)
      push('threads', 'thread', 'threads', lengthOf(dossier.threads) ?? linked.threads)
    } else {
      push('properties', 'property', 'properties', linked.properties)
      push('people', 'person', 'people', linked.prospects)
      push('contacts', 'contact', 'contacts', linked.contacts)
      push('threads', 'thread', 'threads', linked.threads)
    }

    return rows.filter((row) => row.value > 0)
  }, [anchor, dossier])

  if (!anchor) return null

  return (
    <button
      type="button"
      className={cls('egm-relscope', active && 'is-active')}
      onClick={onOpenGraph}
      aria-label={`Open the relationship graph for ${anchor.title}`}
    >
      <span className="egm-relscope__icon" aria-hidden><Icon name="link" size={14} strokeWidth={1.7} /></span>
      <span className="egm-relscope__copy">
        <strong>{anchor.title}</strong>
        <small>
          {loading && counts.length === 0
            ? 'Resolving relationships…'
            : counts.length === 0
              ? 'No linked records resolved for this entity'
              : counts
                .map((row) => `${row.value.toLocaleString()} ${row.value === 1 ? row.label : row.plural}`)
                .join(' · ')}
        </small>
      </span>
      <span className="egm-relscope__cta">{active ? 'Graph' : 'View graph'}</span>
    </button>
  )
}
