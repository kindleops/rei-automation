import { useMemo, useState } from 'react'
import { LCDataGrid, LCEmpty, LCFacts, LCStatus, LCTabs, cx, lcMenu, type LCColumn, type LCSort } from '../../../shared/lc'
import { SiteGraph } from './SiteGraph'
import { BriefPanel, GlobePanel, LaunchFeed, OpportunityList, OpportunityRow, PortfolioGrid } from './panels'
import { BrandMark, ConnectionPill, Meter, MetricCell, ObjLink, ProvenanceLine, Stat, StatusBar, StatusPill } from './parts'
import { fmt, pct, useSi } from './si-context'
import { useContainerWidth } from './useContainerWidth'
import { keywordsIn, pagesIn, wavesIn } from '../domain/model'
import { registryStage, STAGE_LABEL, validateRegistry, isOrphan } from '../domain/registry'
import { ownershipConflicts, ownershipTable, type OwnershipRow } from '../domain/ownership'
import { searchMeasureGate, analyticsMeasureGate, pageSearchMetric, unavailable } from '../domain/metrics'
import { LIFECYCLE_EXIT, LIFECYCLE_LABEL, lifecycleIndex } from '../domain/lifecycle'
import { waveReadiness } from '../domain/brief'
import { RULES } from '../domain/opportunities'
import { JOURNEY } from '../domain/bridge'
import { EVENT_SPEC, OFFERR_FUNNEL, TELEMETRY_EVENTS } from '../domain/telemetry'
import { LIFECYCLE, PROVIDERS, type SearchKeyword, type SearchPage } from '../domain/types'
import { PROVIDER_DESCRIPTORS } from '../providers/registry'

/* ── HOME — the command home / ultrawide command wall ───────────────────── */

export function HomeView() {
  const { data, state, actions } = useSi()
  const [ref, width] = useContainerWidth<HTMLDivElement>()
  const wall = width >= 2600
  const selectedPage = state.object?.kind === 'page' ? state.object.id : null
  const scope = state.property ? data.model.property.get(state.property)! : null
  return (
    <div ref={ref} className={cx('si-home', wall && 'is-wall')}>
      <div className="si-home__globe"><GlobePanel hero /></div>
      <div className="si-home__brief"><BriefPanel dense={!wall} /></div>
      {wall ? (
        <section className="si-card si-home__graph" aria-label="Site graph">
          <header className="si-card__h"><h3>Site architecture</h3><span className="si-card__m">{scope ? scope.domain : 'every property'}</span></header>
          <SiteGraph compact model={data.model} scope={state.property} selectedPageId={selectedPage} onSelectPage={(id) => actions.inspect({ kind: 'page', id })} label="Site architecture graph" />
        </section>
      ) : null}
      <div className="si-home__opps"><OpportunityList limit={wall ? 14 : 7} /></div>
      <div className="si-home__feed"><LaunchFeed /></div>
      {!state.property ? <div className="si-home__portfolio"><PortfolioGrid /></div> : null}
    </div>
  )
}

/* ── GLOBE ──────────────────────────────────────────────────────────────── */

export function GlobeView() {
  const { data, state } = useSi()
  const m = data.model
  const cov = useMemo(() => {
    const out: Array<{ id: string; name: string; kind: string; planned: number; ready: number; props: string[] }> = []
    const seen = new Map<string, number>()
    for (const p of pagesIn(m, state.property)) for (const g of p.geographyIds) {
      const geo = m.geo.get(g)
      if (!geo) continue
      let i = seen.get(g)
      if (i === undefined) { i = out.length; seen.set(g, i); out.push({ id: g, name: geo.kind !== 'STATE' && geo.stateCode ? `${geo.name}, ${geo.stateCode}` : geo.name, kind: geo.kind, planned: 0, ready: 0, props: [] }) }
      out[i].planned += 1
      if (['READY', 'PUBLISHED', 'INDEXED'].includes(p.status)) out[i].ready += 1
      if (!out[i].props.includes(p.propertyId)) out[i].props.push(p.propertyId)
    }
    return out.sort((a, b) => b.planned - a.planned)
  }, [m, state.property])
  return (
    <div className="si-split">
      <div className="si-split__main"><GlobePanel hero /></div>
      <aside className="si-split__side si-card" aria-label="Planned territory">
        <header className="si-card__h"><h3>Planned territory</h3><span className="si-card__m">{fmt(cov.length)} places · pages planned per place</span></header>
        <div className="si-terr">
          {cov.slice(0, 120).map((c) => (
            <ObjLink key={c.id} to={{ kind: 'geography', id: c.id }} className="si-terr__row">
              <span className="si-terr__n">{c.name}</span>
              <span className="si-terr__k">{c.kind.toLowerCase()}</span>
              <Meter value={c.planned ? c.ready / c.planned : 0} label={`${c.name} readiness`} />
              <span className="si-terr__c">{c.ready}/{c.planned}</span>
            </ObjLink>
          ))}
          {!cov.length ? <LCEmpty title="No geographic plan" body="No page in this property's architecture targets a place yet." icon="globe" compact /> : null}
        </div>
      </aside>
    </div>
  )
}

/* ── ARCHITECTURE ───────────────────────────────────────────────────────── */

export function ArchitectureView() {
  const { data, state, actions } = useSi()
  const m = data.model
  const [family, setFamily] = useState<string | null>(null)
  const pages = pagesIn(m, state.property)
  const families = useMemo(() => {
    const f = new Map<string, { n: number; ready: number; built: number }>()
    for (const p of pages) { const x = f.get(p.family) ?? { n: 0, ready: 0, built: 0 }; x.n += 1; if (['READY', 'PUBLISHED', 'INDEXED'].includes(p.status)) x.ready += 1; if (p.stage.builtRoute) x.built += 1; f.set(p.family, x) }
    return [...f.entries()].sort((a, b) => b[1].n - a[1].n)
  }, [pages])
  const issues = useMemo(() => validateRegistry(m, pages).filter((i) => i.kind !== 'ORPHAN'), [m, pages])
  const orphans = useMemo(() => pages.filter((p) => isOrphan(m, p) && (m.linksOut.size > 0)).length, [m, pages])
  const stages = useMemo(() => { const s = { PLANNED_URL: 0, BUILT_ROUTE: 0, PUBLISHED_URL: 0, INDEXED_URL: 0 }; for (const p of pages) s[registryStage(p)] += 1; return s }, [pages])
  const props = state.property ? [m.property.get(state.property)!] : m.dataset.properties
  const empty = pages.length === 0
  return (
    <div className="si-split is-wide">
      <section className="si-split__main si-card si-arch" aria-label="Site graph">
        <header className="si-card__h"><h3>Site graph</h3><span className="si-card__m">{state.property ? m.property.get(state.property)!.domain : 'portfolio'} · click to inspect · double-click to expand · scroll to zoom · drag to pan</span></header>
        {empty ? <LCEmpty title="No architecture registered yet" body="No page registry, sitemap or SEO plan was found for this property. Its architecture appears here once it is planned." icon="layers" /> : (
          <SiteGraph model={m} scope={state.property} selectedPageId={state.object?.kind === 'page' ? state.object.id : null} onSelectPage={(id) => actions.inspect({ kind: 'page', id })} highlightFamily={family} label="Site architecture graph" />
        )}
      </section>
      <aside className="si-split__side" aria-label="Architecture detail">
        <section className="si-card">
          <header className="si-card__h"><h3>URL registry</h3><span className="si-card__m">four facts, recorded separately</span></header>
          <div className="si-stagegrid">
            {(Object.keys(stages) as Array<keyof typeof stages>).map((k) => <Stat key={k} label={STAGE_LABEL[k]} value={k === 'INDEXED_URL' && stages[k] === 0 ? '—' : fmt(stages[k])} sub={k === 'INDEXED_URL' ? 'Search Console not connected' : undefined} />)}
          </div>
          {issues.length ? <div className="si-issues">{issues.slice(0, 6).map((i, n) => <p key={n} className="si-conflict">{i.detail}</p>)}</div> : <p className="si-ok-line">No duplicate routes, accidental aliases, conflicting canonicals or missing parents.{orphans ? ` ${orphans} orphan pages.` : ''}</p>}
        </section>
        <section className="si-card">
          <header className="si-card__h"><h3>Page families</h3><span className="si-card__m">click to highlight</span></header>
          <div className="si-fams">
            {families.map(([f, x]) => (
              <button key={f} type="button" className={cx('si-fam', family === f && 'is-on')} onClick={() => setFamily(family === f ? null : f)} aria-pressed={family === f}>
                <span className="si-fam__n">{f.replace(/-/g, ' ')}</span>
                <span className="si-fam__c">{fmt(x.n)}</span>
                <Meter value={x.n ? x.ready / x.n : 0} label={`${f} ready share`} />
              </button>
            ))}
          </div>
        </section>
        {props.map((p) => (
          <section key={p.id} className="si-card">
            <header className="si-card__h"><h3><BrandMark property={p} /> {p.brand} hierarchy</h3></header>
            <ol className="si-hier">{p.hierarchy.map((h) => <li key={h.family}>{h.label}<span className="si-mono">{h.family}</span></li>)}</ol>
            {p.reservedFamilies.length ? <LCFacts rows={p.reservedFamilies.map((r) => ({ label: `${r.family} (reserved)`, value: <span className="si-mono">{r.route}</span> }))} /> : null}
          </section>
        ))}
        <section className="si-card si-legend">
          <header className="si-card__h"><h3>Legend</h3></header>
          <ul>
            <li><i className="si-dot is-ok" />Ready / published</li><li><i className="si-dot is-exec" />Building / QA</li><li><i className="si-dot is-attn" />Needs work</li>
            <li><i className="si-dot is-hollow" />Planned only (no built route)</li><li><i className="si-dot is-gap" />Missing planned page (coverage gap)</li>
            <li><i className="si-dot is-ring" />Group of a family — arc shows the ready share</li><li><i className="si-dot is-orphan" />Orphan (no inbound link)</li>
          </ul>
        </section>
      </aside>
    </div>
  )
}

/* ── PAGES ──────────────────────────────────────────────────────────────── */

const PAGE_VIEWS = [
  { id: 'all', label: 'All' }, { id: 'planned', label: 'Planned' }, { id: 'building', label: 'Building' }, { id: 'ready', label: 'Ready' },
  { id: 'live', label: 'Live' }, { id: 'indexed', label: 'Indexed' }, { id: 'gaining', label: 'Gaining' }, { id: 'declining', label: 'Declining' },
  { id: 'opportunities', label: 'Opportunities' }, { id: 'technical', label: 'Technical issues' },
] as const

/** The Pages views as one predicate (counts and rows read the same rule). */
function inPageView(p: SearchPage, view: string, opPages: ReadonlySet<string>, techPages: ReadonlySet<string>): boolean {
  switch (view) {
    case 'planned': return !p.stage.builtRoute
    case 'building': return ['BUILDING', 'QA', 'NEEDS_WORK', 'COPY_READY'].includes(p.status) && p.stage.builtRoute
    case 'ready': return p.status === 'READY'
    case 'live': return p.stage.published
    case 'indexed': return p.stage.indexed === true
    case 'gaining': case 'declining': return false // needs two reported Search Console windows
    case 'opportunities': return opPages.has(p.id)
    case 'technical': return techPages.has(p.id)
    default: return true
  }
}

export function PagesView() {
  const { data, state, actions } = useSi()
  const m = data.model
  const all = pagesIn(m, state.property)
  const [sort, setSort] = useState<LCSort>(null)
  const opPages = useMemo(() => new Set(data.opportunities.flatMap((o) => [o.subject, ...o.related]).filter((r) => r.kind === 'page').map((r) => r.id)), [data.opportunities])
  const techPages = useMemo(() => {
    const s = new Set<string>()
    for (const i of validateRegistry(m, all)) for (const id of i.pageIds) s.add(id)
    for (const p of all) if (p.sourceFields?.some((f) => f.label === 'Technical issues')) s.add(p.id)
    return s
  }, [m, all])
  const filter = (p: SearchPage) => inPageView(p, state.pagesView, opPages, techPages)
  const rows = all.filter(filter)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const k = (p: SearchPage): string | number => sort.id === 'status' ? p.status : sort.id === 'family' ? p.family : sort.id === 'inbound' ? (m.linksIn.get(p.id)?.length ?? 0) : p.path
    return [...rows].sort((a, b) => { const x = k(a), y = k(b); const c = x < y ? -1 : x > y ? 1 : 0; return sort.dir === 'asc' ? c : -c })
  }, [rows, sort, m])
  const counts: Record<string, number | null> = Object.fromEntries(PAGE_VIEWS.map((v) => [v.id, v.id === 'gaining' || v.id === 'declining' ? null : all.filter((p) => inPageView(p, v.id, opPages, techPages)).length]))
  const columns: LCColumn<SearchPage>[] = [
    { id: 'path', header: 'Page', width: 340, sortable: true, render: (p) => <span className="si-cell-id"><span className="si-mono">{p.path}</span><em>{p.copy.title ?? (p.copy.state === 'NOT_WRITTEN' ? 'Copy not approved · not written' : '')}</em></span> },
    ...(state.property ? [] : [{ id: 'property', header: 'Property', width: 150, render: (p: SearchPage) => { const pr = m.property.get(p.propertyId)!; return <span className="si-cell-prop"><BrandMark property={pr} size={6} />{pr.brand}</span> } }]),
    { id: 'family', header: 'Family', width: 140, sortable: true, render: (p) => p.family.replace(/-/g, ' ') },
    { id: 'status', header: 'Status', width: 120, sortable: true, render: (p) => <StatusPill status={p.status} /> },
    { id: 'stage', header: 'Registry', width: 120, render: (p) => STAGE_LABEL[registryStage(p)] },
    { id: 'cluster', header: 'Owns', width: 200, render: (p) => { const c = p.primaryClusterId ? m.cluster.get(p.primaryClusterId) : null; return c ? (c.primaryKeyword ?? c.label) : <span className="si-muted">—</span> } },
    { id: 'copy', header: 'Copy', width: 120, render: (p) => (p.copy.state === 'APPROVED' ? 'Approved' : <span className="si-flag">Not approved</span>) },
    { id: 'inbound', header: 'Links in/out', width: 110, align: 'right', sortable: true, render: (p) => `${m.linksIn.get(p.id)?.length ?? 0} / ${m.linksOut.get(p.id)?.length ?? 0}` },
    { id: 'wave', header: 'Wave', width: 170, hideable: true, render: (p) => (p.launchWaveId ? m.wave.get(p.launchWaveId)?.label ?? '—' : '—') },
    { id: 'search', header: 'Impressions', width: 160, render: (p) => <MetricCell metric={pageSearchMetric('impressions', m.dataset.measures.page.get(p.id), searchMeasureGate(m.property.get(p.propertyId)!, m.dataset.connections))} /> },
    { id: 'conv', header: 'Conversions', width: 160, hideable: true, render: (p) => <MetricCell metric={unavailable(analyticsMeasureGate(m.property.get(p.propertyId)!, m.dataset.connections) ?? 'NOT_REPORTED', 'FIRST_PARTY')} /> },
  ]
  const emptyFor = state.pagesView === 'gaining' || state.pagesView === 'declining'
    ? { title: 'No ranking history yet', body: 'Gaining and declining pages need at least two reported Search Console windows.' }
    : state.pagesView === 'indexed' ? { title: 'Search Console not connected', body: 'Index status is reported only by a connected Search Console property.' }
      : state.pagesView === 'live' ? { title: 'Awaiting site launch', body: 'No page in scope is published on its production domain yet.' }
        : { title: 'No pages in this view', body: 'Nothing in the plan matches this view.' }
  return (
    <div className="si-pages">
      <LCTabs label="Page views" variant="line" value={state.pagesView} onChange={actions.setPagesView} items={PAGE_VIEWS.map((v) => ({ id: v.id, label: v.label, count: counts[v.id] ?? null }))} />
      <LCDataGrid<SearchPage>
        id="si-pages" label="Pages" rows={sorted} rowKey={(p) => p.id} columns={columns} sort={sort} onSortChange={setSort}
        activeKey={state.object?.kind === 'page' ? state.object.id : null} onActivate={(p) => actions.inspect({ kind: 'page', id: p.id })}
        rowTone={(p) => (p.status === 'NEEDS_WORK' ? 'attn' : null)} density="dense" empty={emptyFor} total={rows.length} height="100%"
        rowMenu={(p) => lcMenu([
          { label: 'Inspect', icon: 'eye', onSelect: () => actions.inspect({ kind: 'page', id: p.id }) },
          { label: 'Show in Architecture', icon: 'layers', onSelect: () => { actions.inspect({ kind: 'page', id: p.id }); actions.setView('architecture') } },
          ...(p.primaryClusterId ? [{ label: 'Inspect owned cluster', icon: 'hash' as const, onSelect: () => actions.inspect({ kind: 'cluster', id: p.primaryClusterId! }) }] : []),
          { label: 'Open live URL', icon: 'external-link', disabled: !p.stage.published, reason: 'Not published on its production domain', onSelect: () => window.open(`${m.property.get(p.propertyId)!.origin}${p.path}`, '_blank', 'noopener,noreferrer') },
        ])}
      />
    </div>
  )
}

/* ── KEYWORDS — universe + ownership ───────────────────────────────────── */

const OWN_LABEL: Record<OwnershipRow['state'], string> = { OWNED: 'Owned', CONTESTED: 'Contested', UNOWNED: 'No destination page', TEMPLATED: 'Owned per place' }

export function KeywordsView() {
  const { data, state, actions } = useSi()
  const m = data.model
  const rows = ownershipTable(m, state.property)
  const conflicts = ownershipConflicts(m, state.property).filter((c) => c.kind !== 'ORPHANED_KEYWORD')
  const keywords = keywordsIn(m, state.property)
  const [sort, setSort] = useState<LCSort>(null)
  const topics = useMemo(() => {
    const t = new Map<string, OwnershipRow[]>()
    for (const r of rows) { const k = r.cluster.parentTopic ?? 'unassigned'; (t.get(k) ?? t.set(k, []).get(k)!).push(r) }
    return [...t.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [rows])
  const sortedKw = useMemo(() => (sort ? [...keywords].sort((a, b) => { const x = sort.id === 'query' ? a.query : a.source, y = sort.id === 'query' ? b.query : b.source; return (x < y ? -1 : x > y ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1) }) : keywords), [keywords, sort])
  if (!rows.length) return <div className="si-pad"><LCEmpty title="No keyword plan yet" body="No cluster or keyword has been planned for this property. Planned clusters, Search Console queries and research imports all appear here, each labelled with its source." icon="hash" /></div>
  const kwCols: LCColumn<SearchKeyword>[] = [
    { id: 'query', header: 'Query', width: 300, sortable: true, render: (k) => k.query },
    { id: 'cluster', header: 'Cluster', width: 220, render: (k) => (k.clusterId ? m.cluster.get(k.clusterId)?.label ?? '—' : '—') },
    { id: 'page', header: 'Assigned page', width: 240, render: (k) => (k.assignedPageId ? <span className="si-mono">{m.page.get(k.assignedPageId)?.path}</span> : <span className="si-muted">—</span>) },
    { id: 'source', header: 'Source', width: 130, sortable: true, render: (k) => <LCStatus label={k.source.replace(/_/g, ' ').toLowerCase()} tone="neutral" quiet hollow /> },
    { id: 'volume', header: 'Volume', width: 150, render: () => <MetricCell metric={unavailable('RESEARCH_NOT_CONNECTED')} compact /> },
    { id: 'impr', header: 'Impressions', width: 120, render: (k) => <MetricCell compact metric={unavailable(searchMeasureGate(m.property.get(k.propertyId)!, m.dataset.connections) ?? 'NOT_REPORTED')} /> },
    { id: 'pos', header: 'Position', width: 100, render: (k) => <MetricCell compact metric={unavailable(searchMeasureGate(m.property.get(k.propertyId)!, m.dataset.connections) ?? 'NO_RANKING_HISTORY')} /> },
  ]
  return (
    <div className="si-kw">
      <section className="si-card si-universe" aria-label="Keyword universe">
        <header className="si-card__h"><h3>Keyword universe</h3><span className="si-card__m">{fmt(rows.length)} clusters · {fmt(keywords.length)} keywords · tiles sized by keyword count · colour = ownership</span></header>
        <div className="si-universe__topics">
          {topics.map(([topic, rs]) => (
            <div key={topic} className="si-topic">
              <span className="si-topic__h">{topic.replace(/-/g, ' ')}</span>
              <div className="si-topic__tiles">
                {rs.map((r) => (
                  <button key={r.cluster.id} type="button" className="si-tile" data-own={r.state} data-active={state.object?.kind === 'cluster' && state.object.id === r.cluster.id ? 'true' : undefined}
                    style={{ ['--w' as string]: String(Math.min(4, 1 + Math.log2(1 + r.keywords))) }} onClick={() => actions.inspect({ kind: 'cluster', id: r.cluster.id })}>
                    <b>{r.cluster.primaryKeyword ?? r.cluster.label}</b>
                    <span>{OWN_LABEL[r.state]}{r.owner ? ` · ${r.owner.path}` : ''}</span>
                    <em>{r.keywords ? `${r.keywords} kw` : 'not researched'}</em>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="si-card si-conflicts" aria-label="Ownership conflicts">
        <header className="si-card__h"><h3>Ownership</h3><span className="si-card__m">one canonical page per cluster</span></header>
        <div className="si-ownstats">
          {(['OWNED', 'TEMPLATED', 'CONTESTED', 'UNOWNED'] as const).map((s) => <Stat key={s} label={OWN_LABEL[s]} value={fmt(rows.filter((r) => r.state === s).length)} tone={s === 'CONTESTED' || s === 'UNOWNED' ? 'attn' : s === 'OWNED' ? 'ok' : 'exec'} />)}
        </div>
        {conflicts.length ? conflicts.slice(0, 40).map((c, i) => (
          <button key={i} type="button" className="si-conflict-row" onClick={() => actions.inspect(c.clusterIds[0] ? { kind: 'cluster', id: c.clusterIds[0] } : { kind: 'page', id: c.pageIds[0] })}>
            <span className="si-conflict-row__k">{c.kind.replace(/_/g, ' ').toLowerCase()}</span>
            <span>{c.message}</span>
          </button>
        )) : <p className="si-ok-line">Every cluster has exactly one owner.</p>}
      </section>
      <section className="si-card si-kwgrid" aria-label="Keywords">
        <LCDataGrid<SearchKeyword> id="si-keywords" label="Keywords" rows={sortedKw} rowKey={(k) => k.id} columns={kwCols} sort={sort} onSortChange={setSort} density="dense" height={420}
          activeKey={state.object?.kind === 'keyword' ? state.object.id : null} onActivate={(k) => actions.inspect({ kind: 'keyword', id: k.id })} total={keywords.length}
          empty={{ title: 'No keywords', body: 'Clusters exist but no keywords were researched.' }} />
      </section>
    </div>
  )
}

/* ── OPPORTUNITIES ──────────────────────────────────────────────────────── */

export function OpportunitiesView() {
  const { data, state } = useSi()
  const [rule, setRule] = useState<string | null>(null)
  const ops = data.opportunities.filter((o) => (!state.property || o.propertyId === state.property) && (!rule || o.ruleId === rule))
  const counts = new Map<string, number>()
  for (const o of data.opportunities) if (!state.property || o.propertyId === state.property) counts.set(o.ruleId, (counts.get(o.ruleId) ?? 0) + 1)
  return (
    <div className="si-split">
      <aside className="si-split__side si-card" aria-label="Rules">
        <header className="si-card__h"><h3>Rules</h3><span className="si-card__m">deterministic · every rule says why</span></header>
        {(['PRE_LAUNCH', 'LIVE'] as const).map((phase) => (
          <div key={phase} className="si-rules">
            <span className="si-eyebrow">{phase === 'PRE_LAUNCH' ? 'Pre-launch — reads the plan' : 'Live — waiting for Search Console'}</span>
            {RULES.filter((r) => r.phase === phase).map((r) => (
              <button key={r.id} type="button" className={cx('si-rule', rule === r.id && 'is-on')} onClick={() => setRule(rule === r.id ? null : r.id)} aria-pressed={rule === r.id} title={r.why}>
                <span>{r.title}</span>
                <b>{phase === 'LIVE' && !counts.get(r.id) ? 'Search Console not connected' : fmt(counts.get(r.id) ?? 0)}</b>
              </button>
            ))}
          </div>
        ))}
      </aside>
      <section className="si-split__main si-card" aria-label="Opportunities">
        <header className="si-card__h"><h3>{rule ? RULES.find((r) => r.id === rule)?.title : 'All opportunities'}</h3><span className="si-card__m">{fmt(ops.length)}</span></header>
        {rule ? <p className="si-why">{RULES.find((r) => r.id === rule)?.why}</p> : null}
        <div className="si-opps__list is-full">
          {ops.map((o) => <OpportunityRow key={o.id} o={o} />)}
          {!ops.length ? <LCEmpty title={rule && RULES.find((r) => r.id === rule)?.phase === 'LIVE' ? 'Search Console not connected' : 'Nothing found'} body={rule && RULES.find((r) => r.id === rule)?.phase === 'LIVE' ? 'This rule reads reported search data. It runs as soon as a property reports.' : 'This rule found nothing in the current plan.'} icon="target" compact /> : null}
        </div>
      </section>
    </div>
  )
}

/* ── LAUNCH ─────────────────────────────────────────────────────────────── */

export function LaunchView() {
  const { data, state } = useSi()
  const m = data.model
  const props = state.property ? [m.property.get(state.property)!] : m.dataset.properties
  return (
    <div className="si-launch">
      <section className="si-card" aria-label="Lifecycle">
        <header className="si-card__h"><h3>Launch command</h3><span className="si-card__m">lifecycle advances on evidence only</span></header>
        <div className="si-lifegrid" style={{ ['--cols' as string]: String(LIFECYCLE.length) }}>
          <span />
          {LIFECYCLE.map((l) => <span key={l} className="si-lifegrid__h">{LIFECYCLE_LABEL[l]}</span>)}
          {props.map((p) => {
            const cur = lifecycleIndex(p.lifecycle)
            return [
              <ObjLink key={`${p.id}-n`} to={{ kind: 'property', id: p.id }} className="si-lifegrid__p"><BrandMark property={p} />{p.brand}</ObjLink>,
              ...LIFECYCLE.map((l, i) => <span key={`${p.id}-${l}`} className="si-lifegrid__c" data-done={i < cur ? 'true' : undefined} data-current={i === cur ? 'true' : undefined}>{i === cur ? <em>{LIFECYCLE_EXIT[l]}</em> : null}</span>),
            ]
          })}
        </div>
      </section>
      <div className="si-waves">
        {props.map((p) => {
          const ws = wavesIn(m, p.id)
          return (
            <section key={p.id} className="si-card" aria-label={`${p.brand} launch waves`}>
              <header className="si-card__h"><h3><BrandMark property={p} /> {p.brand}</h3><span className="si-card__m">{ws.length ? `${ws.length} waves` : 'no waves planned'}</span></header>
              {!ws.length ? <LCEmpty compact title="No launch waves planned" body="The source plan defines no launch waves for this property." icon="flag" /> : null}
              {ws.map((w) => {
                const r = waveReadiness(m, w)
                return (
                  <ObjLink key={w.id} to={{ kind: 'wave', id: w.id }} className="si-wave">
                    <span className="si-wave__h"><b>{w.label}</b><LCStatus label={w.status.replace(/_/g, ' ').toLowerCase()} tone={w.status === 'IN_PROGRESS' ? 'exec' : 'neutral'} quiet /></span>
                    {r.pages ? <><Meter value={r.ready / r.pages} label={`${w.label} readiness`} /><StatusBar counts={r.byStatus} total={r.pages} /></> : null}
                    <span className="si-wave__m">{r.pages ? `${fmt(r.ready)} of ${fmt(r.pages)} ready (${pct(r.ready / r.pages)})` : 'No registered pages yet'} · {fmt(r.blockers.length)} blocker{r.blockers.length === 1 ? '' : 's'}</span>
                    {r.blockers.slice(0, 2).map((b, i) => <span key={i} className="si-wave__b">{b}</span>)}
                  </ObjLink>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/* ── ANALYTICS (live surfaces, honest) ──────────────────────────────────── */

export function AnalyticsView() {
  const { data, state } = useSi()
  const m = data.model
  const props = state.property ? [m.property.get(state.property)!] : m.dataset.properties
  const panes = [
    { id: 'gsc', title: 'Search Console', provider: 'SEARCH_CONSOLE' as const, rows: ['Queries — clicks, impressions, CTR, position', 'Pages — clicks, impressions, CTR, position', 'Countries and devices', 'Index coverage'] },
    { id: 'ga4', title: 'GA4', provider: 'GA4' as const, rows: ['Landing pages', 'Source / medium', 'Region and city', 'Realtime active users'] },
    { id: 'cf', title: 'Cloudflare', provider: 'CLOUDFLARE' as const, rows: ['Visits by path', 'Referrers', 'Countries'] },
    { id: 'fp', title: 'First-party', provider: 'FIRST_PARTY' as const, rows: ['Recent sessions', 'Trails and pulses', 'Form and valuation events'] },
  ]
  return (
    <div className="si-live">
      {panes.map((pane) => (
        <section key={pane.id} className="si-card si-live__pane" aria-label={pane.title}>
          <header className="si-card__h"><h3>{pane.title}</h3><span className="si-card__m">{PROVIDER_DESCRIPTORS[pane.provider].role}</span></header>
          <div className="si-live__props">
            {props.map((p) => {
              const c = m.connectionsOf.get(p.id)?.find((x) => x.provider === pane.provider)
              const gate = pane.provider === 'SEARCH_CONSOLE' ? searchMeasureGate(p, m.dataset.connections) : analyticsMeasureGate(p, m.dataset.connections)
              return (
                <div key={p.id} className="si-live__prop">
                  <span><BrandMark property={p} size={6} />{p.brand}</span>
                  {c ? <ConnectionPill state={c.state} /> : null}
                  <em>{gate === 'AWAITING_LAUNCH' ? 'Awaiting site launch' : gate === 'SEARCH_CONSOLE_NOT_CONNECTED' ? 'Search Console not connected' : gate === 'ANALYTICS_NOT_CONNECTED' ? 'Analytics not connected' : gate === 'BASELINE_PENDING' ? 'Baseline collection begins after launch' : 'Reporting'}</em>
                </div>
              )
            })}
          </div>
          <ul className="si-live__frames">{pane.rows.map((r) => <li key={r}><span>{r}</span><b>No data — not connected</b></li>)}</ul>
        </section>
      ))}
    </div>
  )
}

/* ── CONVERSIONS — journey + attribution model ──────────────────────────── */

export function ConversionsView() {
  const { data, state } = useSi()
  const offerrScope = !state.property || state.property === 'offerr'
  const prop = state.property ? data.model.property.get(state.property) : null
  return (
    <div className="si-conv">
      <section className="si-card" aria-label="Acquisition journey">
        <header className="si-card__h"><h3>From query to closed deal</h3><span className="si-card__m">Search Intelligence owns acquisition · LeadCommand owns the outcome</span></header>
        <ol className="si-journey">
          {JOURNEY.map((j) => (
            <li key={j.step} data-owner={j.owner}>
              <span className="si-journey__o">{j.owner === 'leadcommand' ? 'LeadCommand' : 'Search Intelligence'}</span>
              <b>{j.label}</b>
              <em>{j.owner === 'leadcommand' ? 'Not linked' : j.step === 'query' ? 'Search Console not connected' : j.step === 'session' ? 'Analytics not connected' : 'Awaiting site launch'}</em>
            </li>
          ))}
        </ol>
        <p className="si-muted">Only an opaque attribution token crosses the boundary. No seller record is copied into Search Intelligence, and Search Intelligence reads no LeadCommand table. Revenue appears only when LeadCommand records a realized close. It is never modeled.</p>
      </section>
      {offerrScope ? (
        <section className="si-card" aria-label="Offerr attribution model">
          <header className="si-card__h"><h3>Offerr attribution path</h3><span className="si-card__m">event model placeholders · no events exist</span></header>
          <ol className="si-funnel">
            {OFFERR_FUNNEL.map((f, i) => <li key={f.step}><span className="si-funnel__i">{i + 1}</span><b>{f.label}</b><span className="si-mono">{f.step}</span><em>{PROVIDER_DESCRIPTORS[f.source].label}</em></li>)}
          </ol>
        </section>
      ) : null}
      <section className="si-card" aria-label="Outcomes">
        <header className="si-card__h"><h3>Outcomes{prop ? ` · ${prop.brand}` : ''}</h3></header>
        <div className="si-metrics is-wide">
          {['Leads', 'Conversations', 'Offers', 'Contracts', 'Closes', 'Realized revenue'].map((l) => <div key={l}><span>{l}</span><MetricCell metric={unavailable('BRIDGE_NOT_CONNECTED', 'LEADCOMMAND')} /></div>)}
        </div>
      </section>
    </div>
  )
}

/* ── CONNECTIONS ────────────────────────────────────────────────────────── */

export function ConnectionsView() {
  const { data, state } = useSi()
  const m = data.model
  const props = state.property ? [m.property.get(state.property)!] : m.dataset.properties
  return (
    <div className="si-conns">
      <section className="si-card" aria-label="Connection matrix">
        <header className="si-card__h"><h3>Connections</h3><span className="si-card__m">read-only connectors · credentials live server-side only · none exist yet</span></header>
        <div className="si-matrix" style={{ ['--cols' as string]: String(PROVIDERS.length) }}>
          <span />
          {PROVIDERS.map((p) => <span key={p} className="si-matrix__h">{PROVIDER_DESCRIPTORS[p].label}{PROVIDER_DESCRIPTORS[p].optional ? <em>optional</em> : null}</span>)}
          {props.map((p) => [
            <span key={`${p.id}-n`} className="si-matrix__p"><BrandMark property={p} />{p.brand}</span>,
            ...PROVIDERS.map((pr) => { const c = m.connectionsOf.get(p.id)?.find((x) => x.provider === pr); return <span key={`${p.id}-${pr}`} className="si-matrix__c" title={c?.note ?? undefined}>{c ? <ConnectionPill state={c.state} /> : '—'}</span> }),
          ])}
        </div>
      </section>
      <div className="si-providers">
        {PROVIDERS.map((p) => {
          const d = PROVIDER_DESCRIPTORS[p]
          return (
            <section key={p} className="si-card si-provider" aria-label={d.label}>
              <header className="si-card__h"><h3>{d.label}</h3>{d.optional ? <span className="si-card__m">optional</span> : null}</header>
              <p>{d.role}</p>
              <LCFacts rows={[
                { label: 'Facts', value: d.grain.join(' · ') }, { label: 'Refresh', value: d.refresh }, { label: 'Scope', value: d.scope }, { label: 'Credential', value: d.credential },
                ...(d.vendors ? [{ label: 'Vendors', value: d.vendors.join(', ') }] : []),
              ]} />
            </section>
          )
        })}
      </div>
      <section className="si-card" aria-label="First-party telemetry design">
        <header className="si-card__h"><h3>First-party telemetry</h3><span className="si-card__m">designed · not deployed · no tracker runs</span></header>
        <div className="si-events">
          {TELEMETRY_EVENTS.map((e) => <div key={e}><span className="si-mono">{e}</span><em>{EVENT_SPEC[e].origin === 'site' ? 'site' : 'from LeadCommand'}</em><span>{EVENT_SPEC[e].meaning}</span></div>)}
        </div>
        <p className="si-muted">Identifiers are opaque random values. Contact data, raw addresses, coordinates, IP addresses and user agents are rejected by the validator and by the proposed table's constraint. An address becomes a server-side keyed hash plus a coarse state and county.</p>
      </section>
      <section className="si-card" aria-label="Setup">
        <header className="si-card__h"><h3>Setup</h3></header>
        <p>The exact steps for Ryan, with no secret values, are in <span className="si-mono">docs/search-intelligence/CONNECTOR_SETUP.md</span>. The proposed schema is in <span className="si-mono">supabase/migrations/PROPOSED_20261004120000_search_intelligence_os_v1.sql</span>, and it is not applied.</p>
        <div className="si-snapmeta">
          {data.snapshots.map((s) => <ProvenanceLine key={s.propertyId} source={{ kind: 'repo-registry', label: `${m.property.get(s.propertyId)?.brand ?? s.propertyId} plan snapshot`, repo: s.repo, branch: s.branch, commit: s.commit.slice(0, 12) }} />)}
        </div>
      </section>
    </div>
  )
}
