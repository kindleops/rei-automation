import { useMemo, useState } from 'react'
import { LCContextMenu, LCSegmented, LCStatus, cx, lcMenu } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { Globe } from './Globe'
import { LIVE_SURFACE_LABEL, LIVE_SURFACE_PROVIDER, surfaceAwake, type LiveSurface } from '../domain/lifecycle'
import { postLaunchState, preLaunchBrief, waveReadiness } from '../domain/brief'
import { geoCoverage } from '../domain/geography'
import { searchMeasureGate, analyticsMeasureGate, type UnavailableReason } from '../domain/metrics'
import { wavesIn } from '../domain/model'
import type { Opportunity, SearchProperty } from '../domain/types'
import { PROVIDER_DESCRIPTORS } from '../providers/registry'
import { BrandMark, ConnectionPill, LifecyclePill, Meter, ObjLink, StatusBar, Stat, Unavailable } from './parts'
import { ACCENT_VAR, SEVERITY_LABEL, SEVERITY_TONE, fmt, pct, useSi } from './si-context'

/* ── globe panel: PLANNING + honest live modes ──────────────────────────── */

type GlobeMode = 'planning' | LiveSurface
const LIVE: LiveSurface[] = ['impressions', 'clicks', 'sessions', 'conversions', 'leads', 'outcomes']

export function GlobePanel({ hero }: { hero?: boolean }) {
  const { data, state, actions } = useSi()
  const m = data.model
  const [mode, setMode] = useState<GlobeMode>('planning')
  const props = state.property ? [m.property.get(state.property)!] : m.dataset.properties
  const cov = useMemo(() => geoCoverage(m, state.property), [m, state.property])
  const placed = [...cov.values()].filter((c) => c.geo.kind !== 'COUNTRY' && c.geo.lat != null).length
  const unplaced = [...cov.values()].filter((c) => c.geo.kind !== 'COUNTRY' && c.geo.lat == null).length
  const states = [...cov.values()].filter((c) => c.geo.kind === 'STATE').length
  const awake = mode !== 'planning' && props.some((p) => surfaceAwake(p, mode, m.dataset.connections))
  const reason: UnavailableReason | null = mode === 'planning' || awake ? null
    : props.every((p) => (mode === 'impressions' || mode === 'clicks' ? searchMeasureGate(p, m.dataset.connections) : analyticsMeasureGate(p, m.dataset.connections)) === 'AWAITING_LAUNCH') ? 'AWAITING_LAUNCH'
      : mode === 'impressions' || mode === 'clicks' ? 'SEARCH_CONSOLE_NOT_CONNECTED' : mode === 'leads' || mode === 'outcomes' ? 'BRIDGE_NOT_CONNECTED' : 'ANALYTICS_NOT_CONNECTED'
  const selGeo = state.object?.kind === 'geography' ? state.object.id : null
  return (
    <section className={cx('si-globe-panel', hero && 'is-hero')} aria-label="Search footprint globe">
      <Globe model={m} scope={state.property} selectedGeo={selGeo} onSelectGeo={(id) => actions.inspect({ kind: 'geography', id })} dimmed={mode !== 'planning'} label="Planned search territory on a globe" />
      <div className="si-globe-panel__mode">
        <span className="si-modebadge" data-mode={mode === 'planning' ? 'planning' : 'live'}>
          {mode === 'planning' ? 'PLANNING · SEARCH FOOTPRINT' : `LIVE · ${LIVE_SURFACE_LABEL[mode].toUpperCase()}`}
        </span>
        <LCSegmented
          size="sm" label="Globe mode" value={mode} onChange={(v) => setMode(v as GlobeMode)}
          options={[{ value: 'planning', label: 'Footprint' }, ...LIVE.map((l) => ({ value: l, label: LIVE_SURFACE_LABEL[l] }))]}
        />
      </div>
      <div className="si-globe-panel__legend">
        <span><i className="si-dot is-hollow" />Planned</span>
        <span><i className="si-dot is-exec" />Pages building</span>
        <span><i className="si-dot is-ok" />Pages ready</span>
        <span><i className="si-dash" />Declared place, no page</span>
        <em>{fmt(states)} states · {fmt(placed)} places lit{unplaced ? ` · ${unplaced} not placed (no reference coordinate)` : ''}</em>
      </div>
      {reason ? (
        <div className="si-globe-panel__overlay">
          <Unavailable reason={reason} detail={`${LIVE_SURFACE_LABEL[mode as LiveSurface]} come from ${LIVE_SURFACE_PROVIDER[mode as LiveSurface].map((p) => PROVIDER_DESCRIPTORS[p].label).join(' or ')}. ${reason === 'AWAITING_LAUNCH' ? 'No property in scope has launched, so the globe draws no activity. What it shows is the plan.' : 'Nothing is drawn until that source reports.'}`} />
        </div>
      ) : null}
    </section>
  )
}

/* ── intelligence brief ─────────────────────────────────────────────────── */

export function BriefPanel({ dense }: { dense?: boolean }) {
  const { data, state } = useSi()
  const m = data.model
  const scoped = data.opportunities.filter((o) => !state.property || o.propertyId === state.property)
  const b = preLaunchBrief(m, state.property, scoped)
  const post = postLaunchState(m, state.property)
  return (
    <section className={cx('si-card si-brief', dense && 'is-dense')} aria-label="Intelligence brief">
      <header className="si-card__h"><h3>Intelligence brief</h3><span className="si-card__m">pre-launch · computed from the plan</span></header>
      <div className="si-brief__stats">
        <Stat label="Pages completed" value={fmt(b.pagesCompleted)} sub={`of ${fmt(b.pagesTotal)} planned`} tone="ok" />
        <Stat label="Pages blocked" value={fmt(b.pagesBlocked)} sub="needs work" tone={b.pagesBlocked ? 'attn' : undefined} />
        <Stat label="Clusters without pages" value={fmt(b.clustersWithoutPages)} sub={`of ${fmt(b.clustersTotal)}`} tone={b.clustersWithoutPages ? 'attn' : undefined} />
        <Stat label="Coverage gaps" value={fmt(b.coverageGaps)} sub="declared, unbuilt" />
      </div>
      <StatusBar counts={b.byStatus} total={b.pagesTotal} />
      {b.nextWave ? (
        <div className="si-brief__wave">
          <span className="si-eyebrow">Next launch wave</span>
          <ObjLink to={{ kind: 'wave', id: b.nextWave.wave.id }}><b>{b.nextWave.wave.label}</b></ObjLink>
          <div className="si-brief__wavebar">
            <Meter value={b.nextWave.pages ? b.nextWave.ready / b.nextWave.pages : 0} label="Next wave readiness" />
            <span>{b.nextWave.pages ? `${fmt(b.nextWave.ready)} of ${fmt(b.nextWave.pages)} ready` : 'No registered pages yet'} · {fmt(b.nextWave.blockers.length)} blockers</span>
          </div>
        </div>
      ) : null}
      {b.largestGaps.length ? (
        <div className="si-brief__gaps">
          <span className="si-eyebrow">Largest architecture gaps</span>
          {b.largestGaps.slice(0, dense ? 3 : 5).map((o) => <OpportunityRow key={o.id} o={o} compact />)}
        </div>
      ) : null}
      {!dense ? (
        <div className="si-brief__post">
          <span className="si-eyebrow">After launch</span>
          <div className="si-brief__postgrid">
            {post.map((p) => <div key={p.section}><b>{p.section}</b><span>{p.reason === 'AWAITING_LAUNCH' ? 'Awaiting site launch' : p.reason === 'SEARCH_CONSOLE_NOT_CONNECTED' ? 'Search Console not connected' : p.reason === 'ANALYTICS_NOT_CONNECTED' ? 'Analytics not connected' : p.reason ? 'Baseline collection begins after launch' : 'Live'}</span></div>)}
          </div>
        </div>
      ) : null}
    </section>
  )
}

/* ── opportunities ──────────────────────────────────────────────────────── */

export function OpportunityRow({ o, compact }: { o: Opportunity; compact?: boolean }) {
  const { data, actions, state } = useSi()
  const prop = data.model.property.get(o.propertyId)
  const active = state.object?.kind === 'opportunity' && state.object.id === o.id
  return (
    <LCContextMenu items={lcMenu([
      { label: 'Inspect', icon: 'eye', onSelect: () => actions.inspect({ kind: 'opportunity', id: o.id }) },
      { label: 'Inspect subject', icon: 'target', onSelect: () => actions.inspect(o.subject) },
      { label: `Focus ${prop?.brand ?? 'property'}`, icon: 'layers', onSelect: () => actions.setProperty(o.propertyId) },
    ])}>
      <button type="button" className={cx('si-opp', compact && 'is-compact', active && 'is-active')} onClick={() => actions.inspect({ kind: 'opportunity', id: o.id })}>
        <LCStatus label={SEVERITY_LABEL[o.severity]} tone={SEVERITY_TONE[o.severity]} quiet={o.severity === 'LOW'} />
        <span className="si-opp__t">{o.title}</span>
        {!compact ? <span className="si-opp__w">{o.why}</span> : null}
        {prop && !state.property ? <span className="si-opp__p"><BrandMark property={prop} size={6} />{prop.brand}</span> : null}
      </button>
    </LCContextMenu>
  )
}

export function OpportunityList({ limit, title = 'Opportunities' }: { limit?: number; title?: string }) {
  const { data, state, actions } = useSi()
  const ops = data.opportunities.filter((o) => !state.property || o.propertyId === state.property)
  const shown = limit ? ops.slice(0, limit) : ops
  return (
    <section className="si-card si-opps" aria-label={title}>
      <header className="si-card__h"><h3>{title}</h3><span className="si-card__m">{fmt(ops.length)} · deterministic rules</span></header>
      <div className="si-opps__list">{shown.map((o) => <OpportunityRow key={o.id} o={o} compact />)}</div>
      {limit && ops.length > limit ? <button type="button" className="si-more" onClick={() => actions.setView('opportunities')}>All {fmt(ops.length)} opportunities <Icon name="chevron-right" size={12} /></button> : null}
    </section>
  )
}

/* ── launch feed ────────────────────────────────────────────────────────── */

export function LaunchFeed() {
  const { data, state } = useSi()
  const m = data.model
  const waves = [...wavesIn(m, state.property)].sort((a, b) => a.order - b.order || a.propertyId.localeCompare(b.propertyId))
  return (
    <section className="si-card si-feed" aria-label="Launch status">
      <header className="si-card__h"><h3>Launch status</h3><span className="si-card__m">{fmt(waves.length)} waves in plan</span></header>
      <ol className="si-feed__list">
        {waves.map((w) => {
          const r = waveReadiness(m, w)
          const prop = m.property.get(w.propertyId)!
          return (
            <li key={w.id}>
              <ObjLink to={{ kind: 'wave', id: w.id }}>
                <span className="si-feed__row"><BrandMark property={prop} size={6} /><b>{w.label}</b></span>
                <span className="si-feed__meta">{r.pages ? `${fmt(r.ready)}/${fmt(r.pages)} ready` : 'No registered pages yet'} · {fmt(r.blockers.length)} blockers</span>
                {r.pages ? <Meter value={r.ready / r.pages} label={`${w.label} readiness`} /> : null}
              </ObjLink>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/* ── portfolio cards (property switcher detail) ─────────────────────────── */

export function PortfolioGrid() {
  const { data, actions, state } = useSi()
  return (
    <section className="si-portfolio" aria-label="Portfolio">
      {data.summaries.map((s) => <PropertyCard key={s.property.id} p={s.property} active={state.property === s.property.id} onOpen={() => actions.setProperty(s.property.id)} />)}
    </section>
  )
}

function PropertyCard({ p, active, onOpen }: { p: SearchProperty; active: boolean; onOpen: () => void }) {
  const { data, actions } = useSi()
  const s = data.summaries.find((x) => x.property.id === p.id)!
  return (
    <LCContextMenu items={lcMenu([
      { label: `Focus ${p.brand}`, icon: 'target', onSelect: onOpen },
      { label: 'Inspect property', icon: 'eye', onSelect: () => actions.inspect({ kind: 'property', id: p.id }) },
      { label: 'Architecture', icon: 'layers', onSelect: () => { onOpen(); actions.setView('architecture') } },
      { label: 'Connections', icon: 'link', onSelect: () => { onOpen(); actions.setView('connections') } },
    ])}>
      <article className={cx('si-prop', active && 'is-active')} style={{ ['--si-accent' as string]: ACCENT_VAR[p.accent] }}>
        <button type="button" className="si-prop__hit" onClick={onOpen} aria-label={`Focus ${p.brand}`} />
        <header>
          <BrandMark property={p} size={9} />
          <div className="si-prop__id"><b>{p.brand}</b><span>{p.domain}</span></div>
          <LifecyclePill property={p} />
        </header>
        <p className="si-prop__thesis">{p.thesis}</p>
        <div className="si-prop__stats">
          <Stat label="Planned" value={fmt(s.pagesPlanned)} />
          <Stat label="Built" value={fmt(s.pagesBuilt)} />
          <Stat label="Ready" value={fmt(s.pagesReady)} tone={s.pagesReady ? 'ok' : undefined} />
          <Stat label="Live" value={fmt(s.pagesPublished)} />
          <Stat label="Clusters" value={`${fmt(s.clustersOwned)}/${fmt(s.clusters)}`} />
          <Stat label="Places" value={fmt(s.geographies)} />
        </div>
        <div className="si-prop__ready">
          <span>Launch readiness</span>
          {s.launchReadiness == null ? <em>No launch wave registered</em> : <><Meter value={s.launchReadiness} label="Launch readiness" /><b>{pct(s.launchReadiness)}</b></>}
        </div>
        <dl className="si-prop__conn">
          <div><dt>Search Console</dt><dd><ConnectionPill state={s.connections.SEARCH_CONSOLE} /></dd></div>
          <div><dt>Analytics</dt><dd><ConnectionPill state={s.connections.GA4} /></dd></div>
          <div><dt>First-party</dt><dd><ConnectionPill state={s.connections.FIRST_PARTY} /></dd></div>
          <div><dt>Cloudflare</dt><dd><ConnectionPill state={s.connections.CLOUDFLARE} /></dd></div>
          <div><dt>Indexing health</dt><dd>{s.pagesIndexed == null ? <span className="si-na">Not connected</span> : fmt(s.pagesIndexed)}</dd></div>
          <div><dt>Data freshness</dt><dd>{s.dataFreshness ?? <span className="si-na">No provider data</span>}</dd></div>
        </dl>
        <footer>
          <span>Plan captured {s.planCapturedAt ?? '—'}</span>
          {s.opportunities.blocker ? <LCStatus label={`${s.opportunities.blocker} blocker${s.opportunities.blocker === 1 ? '' : 's'}`} tone="crit" quiet /> : null}
          {s.opportunities.high ? <LCStatus label={`${s.opportunities.high} high`} tone="attn" quiet /> : null}
        </footer>
      </article>
    </LCContextMenu>
  )
}
