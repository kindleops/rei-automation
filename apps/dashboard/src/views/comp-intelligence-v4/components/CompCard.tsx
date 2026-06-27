/**
 * Comp Intelligence V4 — premium comp card.
 * Property-dossier preview: media, qualification badge, transaction intelligence,
 * subject-comparison chips, buyer line, and a precise classification reason.
 * One canonical state drives the badge, border, and reason (Phase 5). Memoized.
 */

import { memo, useMemo } from 'react'
import type { V4Evidence, V4Subject } from '../state/types'
import { evidenceStateLabel, matchTierLabel } from '../adapters/labels'
import { fmtDate, fmtMiles, fmtMoneyShort, fmtNumber, fmtPpsf, fmtSqft, daysAgo } from '../adapters/format'
import { PropertyMedia } from './PropertyMedia'

interface CompCardProps {
  evidence: V4Evidence
  subject: V4Subject
  selected: boolean
  hovered: boolean
  onHover: (id: string | null) => void
  onSelect: (id: string) => void
  onOpenDossier: (id: string) => void
}

type ChipTone = 'exact' | 'close' | 'review' | 'bad' | 'unknown'
interface Chip {
  label: string
  value: string
  tone: ChipTone
}

function CompCardBase(props: CompCardProps) {
  const { evidence: e, subject, selected, hovered } = props
  const chips = useMemo(() => buildChips(subject, e), [subject, e])

  return (
    <article
      className={[
        'civ4-card',
        `civ4-card--${e.state}`,
        selected ? 'is-selected' : '',
        hovered ? 'is-hovered' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseEnter={() => props.onHover(e.id)}
      onMouseLeave={() => props.onHover(null)}
      onClick={() => props.onSelect(e.id)}
    >
      <PropertyMedia url={e.imageUrl} alt={e.address ?? 'Comparable property'} className="civ4-card__media" />
      <div className="civ4-card__main">
        <div className="civ4-card__header">
          <span className="civ4-card__price">{fmtMoneyShort(e.salePrice)}</span>
          <span className={`civ4-statebadge civ4-statebadge--${e.state}`}>{evidenceStateLabel(e.state)}</span>
        </div>
        <div className="civ4-card__address" title={e.address ?? undefined}>
          {e.address ?? 'Address unavailable'}
        </div>
        <div className="civ4-card__subline">
          <span>{fmtDate(e.saleDate)}</span>
          <span className="civ4-dotsep">·</span>
          <span>{fmtMiles(e.distanceMiles)}</span>
          <span className="civ4-dotsep">·</span>
          <span>{matchTierLabel(e.matchTier)}</span>
        </div>

        <div className="civ4-card__facts">
          <Fact label="Beds" value={e.beds != null ? fmtNumber(e.beds) : '—'} />
          <Fact label="Baths" value={e.baths != null ? fmtNumber(e.baths) : '—'} />
          <Fact label="Sq Ft" value={e.buildingSqft != null ? fmtSqft(e.buildingSqft) : '—'} />
          <Fact label="Year" value={e.yearBuilt != null ? String(e.yearBuilt) : '—'} />
          <Fact label="$/sf" value={fmtPpsf(e.ppsf)} />
          {e.units != null && e.units > 1 && <Fact label="Units" value={fmtNumber(e.units)} />}
        </div>

        <div className="civ4-card__chips">
          {chips.map((c) => (
            <span key={c.label} className={`civ4-chip2 civ4-chip2--${c.tone}`}>
              <span className="civ4-chip2__k">{c.label}</span>
              <span className="civ4-chip2__v">{c.value}</span>
            </span>
          ))}
        </div>

        <div className="civ4-card__tags">
          {e.transactionBadges.map((b) => (
            <span key={b.label} className={`civ4-tag civ4-tag--${b.tone}`}>
              {b.label}
            </span>
          ))}
          {e.buyerName ? (
            <span className="civ4-tag civ4-tag--buyer">{e.buyerName}</span>
          ) : null}
        </div>

        {e.basis.reason && (
          <div className={`civ4-card__reason civ4-card__reason--${e.state}`}>{e.basis.reason}</div>
        )}
      </div>
      <div className="civ4-card__actions">
        <button
          type="button"
          className="civ4-btn civ4-btn--mini"
          onClick={(evt) => {
            evt.stopPropagation()
            props.onOpenDossier(e.id)
          }}
        >
          Open Dossier
        </button>
      </div>
    </article>
  )
}

function Fact(props: { label: string; value: string }) {
  return (
    <span className="civ4-cardfact">
      <span className="civ4-cardfact__label">{props.label}</span>
      <span className="civ4-cardfact__value">{props.value}</span>
    </span>
  )
}

function buildChips(s: V4Subject, c: V4Evidence): Chip[] {
  const chips: Chip[] = []
  chips.push(pctChip('Sq Ft', s.buildingSqft, c.buildingSqft))
  chips.push(pctChip('Lot', s.lotSqft, c.lotSqft))
  chips.push(yearChip('Year', s.yearBuilt, c.yearBuilt))
  chips.push(exactChip('Beds', s.beds, c.beds))
  chips.push(exactChip('Baths', s.baths, c.baths))
  if ((s.units ?? 1) > 1 || (c.units ?? 1) > 1) chips.push(exactChip('Units', s.units, c.units))
  if (c.distanceMiles != null) {
    chips.push({
      label: 'Distance',
      value: fmtMiles(c.distanceMiles),
      tone: c.distanceMiles <= 1 ? 'exact' : c.distanceMiles <= 3 ? 'close' : 'review',
    })
  }
  const d = daysAgo(c.saleDate)
  if (d != null) {
    chips.push({ label: 'Recency', value: `${d}d`, tone: d <= 365 ? 'exact' : d <= 730 ? 'close' : 'review' })
  }
  return chips.filter(Boolean)
}

function pctChip(label: string, s: number | null, c: number | null): Chip {
  if (s == null || c == null || s === 0) return { label, value: '—', tone: 'unknown' }
  const pct = ((c - s) / s) * 100
  const tone: ChipTone = Math.abs(pct) <= 5 ? 'exact' : Math.abs(pct) <= 15 ? 'close' : 'review'
  return { label, value: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, tone }
}

function yearChip(label: string, s: number | null, c: number | null): Chip {
  if (s == null || c == null) return { label, value: '—', tone: 'unknown' }
  const d = c - s
  const tone: ChipTone = d === 0 ? 'exact' : Math.abs(d) <= 10 ? 'close' : 'review'
  return { label, value: `${d >= 0 ? '+' : ''}${d}`, tone }
}

function exactChip(label: string, s: number | null, c: number | null): Chip {
  if (s == null || c == null) return { label, value: '—', tone: 'unknown' }
  const d = c - s
  if (d === 0) return { label, value: 'Exact', tone: 'exact' }
  const tone: ChipTone = Math.abs(d) <= 1 ? 'close' : 'review'
  return { label, value: `${d >= 0 ? '+' : ''}${d}`, tone }
}

export const CompCard = memo(CompCardBase)
