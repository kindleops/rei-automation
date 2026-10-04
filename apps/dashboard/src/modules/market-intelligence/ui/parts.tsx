import { useState, type ReactNode } from 'react'
import { LCButton, LCCombobox, LCIconButton, LCMenu, LCMetric, LCPopover, LCProgress, LCError, type LCComboOption } from '../../../shared/lc'
import { miFetch, type MiQueryState } from '../mi-api'
import { useMi } from '../mi-context'
import { fmtCount, fmtDate, fmtSample, fmtValue } from '../mi-format'
import { openComposerFor, showGeoOnMap } from '../mi-handoffs'
import type { MiGeoSummary, MiValue, MiWarming } from '../mi-types'
import { toggleWatch, useWatchlist } from '../mi-watchlist'
import { LEVEL_SUB, geoMenu, optionOf } from './ui-model'

// ── Explore bar (brief §6) ─────────────────────────────────────────────────
export function ExploreBar({ onPick, autoFocus }: { onPick: (id: string) => void; autoFocus?: boolean }) {
  const watch = useWatchlist()
  const recent: LCComboOption[] = watch.slice(0, 8).map((w) => ({ value: w.id, label: w.label, sub: `Watchlist · ${LEVEL_SUB[w.level] ?? w.level}`, group: 'Watchlist', icon: 'star' }))
  return (
    <LCCombobox
      className="mi-explore"
      label="Explore a market"
      placeholder="Explore a market: 55411, Dallas, Harris County, Texas…"
      icon="search"
      minQuery={2}
      recent={recent}
      autoFocus={autoFocus}
      emptyText="No geography by that name in LeadCommand's sales or property universe"
      load={async (q, signal) => {
        const r = await miFetch<{ results: MiGeoSummary[]; ambiguous: boolean }>('search', { q, limit: 16 }, signal)
        if (!r.ok) throw new Error(r.message)
        return r.data.results.map(optionOf)
      }}
      onChange={(v) => onPick(v)}
    />
  )
}

// ── Metric tile (brief §7, §8) ─────────────────────────────────────────────
export function MetricTile({ id, value, spark, rank, size = 'md', onClick, selected }: {
  id: string; value: MiValue | undefined; spark?: Array<number | null>; rank?: string | null; size?: 'lg' | 'md' | 'sm'; onClick?: () => void; selected?: boolean
}) {
  const { metric } = useMi()
  const m = metric(id)
  const [def, setDef] = useState(false)
  const ok = value?.status === 'ok'
  return (
    <LCPopover
      open={def}
      onOpenChange={setDef}
      side="bottom"
      align="start"
      trigger={
        <span className="mi-tile-anchor">
          <LCMetric
            className={`mi-tile${ok ? '' : ' is-withheld'}`}
            label={m?.label ?? id}
            value={fmtValue(m, value)}
            basis={fmtSample(m, value) || undefined}
            spark={ok && spark && spark.filter((v) => v !== null).length > 2 ? spark : undefined}
            size={size}
            status={rank ? <span className="mi-rank">{rank}</span> : undefined}
            onDefine={() => setDef(true)}
            onClick={onClick}
            selected={selected}
          />
        </span>
      }
    >
      <div className="mi-def">
        <strong>{m?.label ?? id}</strong>
        <p>{m?.description}</p>
        <dl>
          <dt>Formula</dt><dd>{m?.formula}</dd>
          <dt>Source</dt><dd>{m?.source}</dd>
          <dt>Minimum sample</dt><dd>{m?.min_sample ?? 1}</dd>
          {value ? <><dt>This value</dt><dd>{value.status === 'ok' ? `n ${fmtCount(value.n)}${value.basis ? ` · ${value.basis}` : ''}` : value.reason}</dd></> : null}
        </dl>
      </div>
    </LCPopover>
  )
}

// ── Provenance (brief §8) ──────────────────────────────────────────────────
export function Provenance({ extra }: { extra?: ReactNode }) {
  const { status } = useMi()
  if (!status) return null
  return (
    <p className="mi-prov">
      <span>Sales through <b>{fmtDate(status.as_of)}</b></span>
      <span>{fmtCount(status.rows)} canonical market sales (mv_map_market_sales, refreshed daily)</span>
      <span>Coverage {status.coverage.coverage_start ?? '—'} → complete through {status.coverage.complete_through ?? '—'}</span>
      {extra}
    </p>
  )
}

// ── Honest warming / error states ──────────────────────────────────────────
export function Warming({ w }: { w: MiWarming }) {
  const p = w.progress
  const pct = p?.est ? Math.min(1, p.rows / p.est) : null
  return (
    <div className="mi-warming" role="status">
      <strong>{w.status === 'deferred' ? 'Waiting for a quiet database' : w.status === 'error' ? 'The market index could not be built' : 'Building the market index'}</strong>
      <span>
        {w.status === 'deferred' ? `${w.error ?? 'Production is busy'}. The read is retried automatically; nothing is sampled meanwhile.`
          : w.status === 'error' ? (w.error ?? 'Read failed')
            : p ? `${p.phase === 'sales' ? 'Reading canonical sales' : 'Reading geography and census references'} · ${fmtCount(p.rows)}${p.est ? ` of ~${fmtCount(p.est)}` : ''} rows` : 'Starting the read'}
      </span>
      {w.status === 'loading' ? <LCProgress value={pct === null ? undefined : pct * 100} label="Market index" /> : null}
    </div>
  )
}

export function QueryState<T>({ q, children, skeleton }: { q: MiQueryState<T>; children: (data: T) => ReactNode; skeleton?: ReactNode }) {
  if (q.kind === 'ready') return <>{children(q.data)}</>
  if (q.kind === 'warming') return <Warming w={q.warming} />
  if (q.kind === 'error') return q.previous ? <>{children(q.previous)}</> : <LCError what={q.message} compact />
  if (q.kind === 'loading' && q.previous) return <div className="mi-stale">{children(q.previous)}</div>
  return <>{skeleton ?? <div className="mi-skel" aria-busy="true" />}</>
}

// ── Geography actions (brief §25) ──────────────────────────────────────────
export function GeoActions({ g, heatMetric }: { g: MiGeoSummary; heatMetric?: string }) {
  const { openGeo, addToCompare, setInspect, set } = useMi()
  const watch = useWatchlist()
  const watched = watch.some((w) => w.id === g.id)
  return (
    <div className="mi-actions">
      <LCIconButton icon="star" label={watched ? 'Remove from watchlist' : 'Add to watchlist (this device)'} size="sm" selected={watched} onClick={() => toggleWatch({ id: g.id, label: g.label, level: g.level })} />
      <LCButton size="sm" variant="secondary" icon="map" onClick={() => { showGeoOnMap(g, { lensMetric: heatMetric }) }} title="Opens the Map beside, framed on this area">Show on Map</LCButton>
      <LCButton size="sm" variant="primary" icon="send" disabled={g.level === 'nation'} title={g.level === 'nation' ? 'Pick a state or smaller area' : 'Opens Campaign Composer with this geography as its filter. Composer computes the audience; nothing launches.'} onClick={() => { openComposerFor(g) }}>Create campaign audience</LCButton>
      <LCMenu label={`${g.label} actions`} items={geoMenu(g, { openGeo, addToCompare, setInspect, setTab: (t) => set({ tab: t as never }), heatMetric })} trigger={<LCIconButton icon="more" label="More actions" size="sm" />} />
    </div>
  )
}
