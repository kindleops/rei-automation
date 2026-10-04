import type { ReactNode } from 'react'
import { LCButton, LCFacts, LCInspector, LCInspectorSection, LCStatus, lcToast } from '../../../shared/lc'
import { ancestors, geoPath } from '../domain/model'
import { LIFECYCLE_EXIT, LIFECYCLE_LABEL, lifecycleIndex } from '../domain/lifecycle'
import { pageSearchMetric, searchMeasureGate, analyticsMeasureGate, ctrOf, unavailable } from '../domain/metrics'
import { canonicalOwner, ownershipConflicts, ownershipTable } from '../domain/ownership'
import { coverageGaps, gapLabel, geoCoverage } from '../domain/geography'
import { isOrphan, registryStage, STAGE_LABEL } from '../domain/registry'
import { waveReadiness } from '../domain/brief'
import { RULE } from '../domain/opportunities'
import { LIFECYCLE, REGISTRY_STAGE, type ObjectRef, type SearchPage } from '../domain/types'
import { PROVIDER_DESCRIPTORS } from '../providers/registry'
import { BrandMark, ConnectionPill, CopyField, Meter, MetricCell, ObjLink, ProvenanceLine, StatusBar, StatusPill } from './parts'
import { SEVERITY_LABEL, SEVERITY_TONE, fmt, pct, refLabel, useSi } from './si-context'

interface Body { eyebrow: ReactNode; title: ReactNode; subtitle?: ReactNode; status?: ReactNode; actions?: ReactNode; content: ReactNode }

export function InspectorHost({ stack, onBack }: { stack: ObjectRef[]; onBack: () => void }) {
  const ctx = useSi()
  const ref = ctx.state.object
  if (!ref) return null
  const body = bodyFor(ctx, ref)
  if (!body) {
    return (
      <LCInspector open id="si-inspector" mode="dock" width={420} onClose={() => ctx.actions.inspect(null)} title="Not found" label="inspector">
        <p className="si-muted">This object is not in the current planning snapshot.</p>
      </LCInspector>
    )
  }
  const prev = stack.length > 1 ? stack[stack.length - 2] : null
  return (
    <LCInspector
      open id="si-inspector" mode="dock" width={420} minWidth={340} maxWidth={680} resizable
      onClose={() => ctx.actions.inspect(null)} eyebrow={body.eyebrow} title={body.title} subtitle={body.subtitle} status={body.status}
      contentKey={`${ref.kind}:${ref.id}`} back={prev ? { label: 'Back', onBack } : undefined} actions={body.actions} label={`${ref.kind} inspector`}
    >
      {body.content}
    </LCInspector>
  )
}

type Ctx = ReturnType<typeof useSi>

function bodyFor(ctx: Ctx, ref: ObjectRef): Body | null {
  const m = ctx.data.model
  switch (ref.kind) {
    case 'page': { const p = m.page.get(ref.id); return p ? pageBody(ctx, p) : null }
    case 'cluster': return clusterBody(ctx, ref.id)
    case 'keyword': return keywordBody(ctx, ref.id)
    case 'geography': return geographyBody(ctx, ref.id)
    case 'wave': return waveBody(ctx, ref.id)
    case 'opportunity': return opportunityBody(ctx, ref.id)
    case 'property': return propertyBody(ctx, ref.id)
    default: return null
  }
}

const copyPath = async (text: string) => {
  try { await navigator.clipboard.writeText(text); lcToast({ title: 'Copied', detail: text, severity: 'success', source: 'search-intelligence', silent: true }) }
  catch { lcToast({ title: 'Could not copy', detail: text, severity: 'warning', source: 'search-intelligence', silent: true }) }
}

/* ── page ───────────────────────────────────────────────────────────────── */

function pageBody(ctx: Ctx, p: SearchPage): Body {
  const m = ctx.data.model
  const prop = m.property.get(p.propertyId)!
  const gate = searchMeasureGate(prop, m.dataset.connections)
  const aGate = analyticsMeasureGate(prop, m.dataset.connections)
  const facts = m.dataset.measures.page.get(p.id)
  const imp = pageSearchMetric('impressions', facts, gate)
  const clk = pageSearchMetric('clicks', facts, gate)
  const stage = registryStage(p)
  const anc = ancestors(m, p.id)
  const kids = m.children.get(p.id) ?? []
  const inbound = (m.linksIn.get(p.id) ?? []).filter((l) => l.fromPageId !== p.id)
  const outbound = (m.linksOut.get(p.id) ?? []).filter((l) => l.toPageId !== p.id)
  const primary = p.primaryClusterId ? m.cluster.get(p.primaryClusterId) : null
  const conflicts = ownershipConflicts(m, p.propertyId).filter((c) => c.pageIds.includes(p.id))
  const ops = ctx.data.opportunities.filter((o) => (o.subject.kind === 'page' && o.subject.id === p.id) || o.related.some((r) => r.kind === 'page' && r.id === p.id)).slice(0, 6)
  const keywords = m.dataset.keywords.filter((k) => k.assignedPageId === p.id)
  const wave = p.launchWaveId ? m.wave.get(p.launchWaveId) : null
  return {
    eyebrow: <span className="si-insp-eyebrow"><BrandMark property={prop} /> {prop.brand} · {p.family.replace(/-/g, ' ')}</span>,
    title: <span className="si-mono">{p.path}</span>,
    subtitle: `${prop.domain}${p.path === '/' ? '' : p.path}`,
    status: <StatusPill status={p.status} />,
    actions: (
      <>
        <LCButton size="sm" variant="quiet" icon="layers" onClick={() => ctx.actions.setView('architecture')}>Architecture</LCButton>
        <LCButton size="sm" variant="quiet" icon="link" onClick={() => copyPath(`${prop.origin}${p.path === '/' ? '/' : p.path}`)}>Copy URL</LCButton>
      </>
    ),
    content: (
      <>
        <LCInspectorSection title="Thesis">
          {p.thesis ? <p className="si-thesis">{p.thesis}</p> : <p className="si-muted">The source plan records no thesis for this page.</p>}
          {p.notes ? <p className="si-note">{p.notes}</p> : null}
        </LCInspectorSection>
        <LCInspectorSection title="Registry" aside={STAGE_LABEL[stage]}>
          <ol className="si-ladder" aria-label="Registry stages">
            {REGISTRY_STAGE.map((s) => {
              const done = s === 'PLANNED_URL' ? p.stage.planned : s === 'BUILT_ROUTE' ? p.stage.builtRoute : s === 'PUBLISHED_URL' ? p.stage.published : p.stage.indexed === true
              const unknown = s === 'INDEXED_URL' && p.stage.indexed === null
              return <li key={s} data-done={done ? 'true' : undefined} data-unknown={unknown ? 'true' : undefined}><i />{STAGE_LABEL[s]}{unknown ? <em>Search Console not connected</em> : null}</li>
            })}
          </ol>
          <LCFacts rows={[
            { label: 'Canonical', value: <span className="si-mono">{p.canonical ?? '—'}</span> },
            { label: 'Indexability', value: p.indexability.replace(/_/g, ' ').toLowerCase() },
            { label: 'Robots', value: p.robots ?? 'Not declared in source' },
            { label: 'Sitemap', value: p.inSitemap === null ? 'Not declared' : p.inSitemap ? 'In production sitemap' : 'Excluded' },
            { label: 'Schema', value: p.schemaTypes.length ? p.schemaTypes.join(', ') : 'None declared' },
            { label: 'Launch wave', value: wave ? <ObjLink to={{ kind: 'wave', id: wave.id }}>{wave.label}</ObjLink> : 'Unassigned' },
            ...(p.aliases.length ? [{ label: 'Aliases (redirect here)', value: <span className="si-mono">{p.aliases.join(', ')}</span> }] : []),
          ]} />
        </LCInspectorSection>
        <LCInspectorSection title="SEO identity" aside={p.copy.state === 'APPROVED' ? 'Approved' : 'Not approved'}>
          <CopyField label="Title" text={p.copy.title} copy={p.copy} />
          <CopyField label="H1" text={p.copy.h1} copy={p.copy} />
          <CopyField label="Meta" text={p.copy.meta} copy={p.copy} />
          <LCFacts rows={[
            { label: 'Intent', value: p.intent ?? '—' },
            { label: 'Primary keyword', value: p.primaryKeyword ?? '—' },
            ...(p.secondaryKeywords.length ? [{ label: 'Secondary themes', value: p.secondaryKeywords.join(' · ') }] : []),
          ]} />
        </LCInspectorSection>
        <LCInspectorSection title="Ownership" aside={conflicts.length ? `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}` : undefined}>
          <LCFacts rows={[
            { label: 'Owns cluster', value: primary ? <ObjLink to={{ kind: 'cluster', id: primary.id }}>{primary.primaryKeyword ?? primary.label}</ObjLink> : 'None' },
            { label: 'Supports', value: p.secondaryClusterIds.length ? <span className="si-links">{p.secondaryClusterIds.map((id) => <ObjLink key={id} to={{ kind: 'cluster', id }}>{m.cluster.get(id)?.label ?? id}</ObjLink>)}</span> : 'None' },
            { label: 'Assigned keywords', value: keywords.length ? fmt(keywords.length) : 'None' },
          ]} />
          {conflicts.map((c, i) => <p key={i} className="si-conflict" data-kind={c.kind}>{c.message}</p>)}
        </LCInspectorSection>
        <LCInspectorSection title="Hierarchy">
          <nav className="si-crumbs" aria-label="Ancestors">
            <span>{prop.domain}</span>
            {anc.map((a) => <ObjLink key={a.id} to={{ kind: 'page', id: a.id }}>{a.path}</ObjLink>)}
          </nav>
          {kids.length ? (
            <div className="si-list">
              <span className="si-list__h">{fmt(kids.length)} child page{kids.length === 1 ? '' : 's'}</span>
              {kids.slice(0, 10).map((k) => <ObjLink key={k.id} to={{ kind: 'page', id: k.id }}><span className="si-mono">{k.path}</span><StatusPill status={k.status} /></ObjLink>)}
              {kids.length > 10 ? <span className="si-muted">+{kids.length - 10} more in Architecture</span> : null}
            </div>
          ) : <p className="si-muted">No child pages.</p>}
        </LCInspectorSection>
        <LCInspectorSection title="Internal links" aside={isOrphan(m, p) ? 'Orphan' : undefined}>
          <LCFacts rows={[
            { label: 'Inbound', value: `${fmt(inbound.length)}${m.navTargets.has(p.id) ? ' · reachable from navigation' : ''}` },
            { label: 'Outbound', value: fmt(outbound.length) },
            { label: 'Contextual inbound sources', value: fmt(new Set(inbound.filter((l) => l.kind === 'content').map((l) => l.fromPageId)).size) },
          ]} />
        </LCInspectorSection>
        {p.geographyIds.length ? (
          <LCInspectorSection title="Geography">
            <span className="si-links">{p.geographyIds.map((g) => <ObjLink key={g} to={{ kind: 'geography', id: g }}>{geoPath(m, g).slice(1).map((x) => x.name).join(' → ')}</ObjLink>)}</span>
          </LCInspectorSection>
        ) : null}
        <LCInspectorSection title="Search performance">
          <div className="si-metrics">
            <div><span>Impressions</span><MetricCell metric={imp} /></div>
            <div><span>Clicks</span><MetricCell metric={clk} /></div>
            <div><span>CTR</span><MetricCell metric={ctrOf(clk, imp)} unit="rate" /></div>
            <div><span>Avg position</span><MetricCell metric={pageSearchMetric('position', facts, gate)} unit="position" /></div>
          </div>
        </LCInspectorSection>
        <LCInspectorSection title="Analytics & attribution">
          <div className="si-metrics">
            <div><span>Sessions</span><MetricCell metric={unavailable(aGate ?? 'NOT_REPORTED', 'GA4')} /></div>
            <div><span>Conversions</span><MetricCell metric={unavailable(aGate ?? 'NOT_REPORTED', 'FIRST_PARTY')} /></div>
            <div><span>Leads → deals</span><MetricCell metric={unavailable('BRIDGE_NOT_CONNECTED', 'LEADCOMMAND')} /></div>
          </div>
        </LCInspectorSection>
        {p.legacy ? (
          <LCInspectorSection title="Legacy authority (imported, not live)">
            <p className="si-muted">{p.legacy.label}. This is a historical Search Console export for the legacy site, {p.legacy.window.start} → {p.legacy.window.end}. It describes the old URL. It does not measure this page.</p>
            <LCFacts rows={[
              { label: 'Legacy path', value: <span className="si-mono">{p.legacy.legacyPath ?? '—'}</span> },
              { label: 'Clicks (window)', value: p.legacy.clicks == null ? '—' : fmt(p.legacy.clicks) },
              { label: 'Impressions (window)', value: p.legacy.impressions == null ? '—' : fmt(p.legacy.impressions) },
              { label: 'Avg position (window)', value: p.legacy.averagePosition == null ? '—' : p.legacy.averagePosition.toFixed(1) },
              { label: 'Authority tier', value: p.legacy.tier ?? '—' },
              { label: 'Migration decision', value: p.legacy.decision ?? '—' },
            ]} />
            <ProvenanceLine source={p.legacy.source} />
          </LCInspectorSection>
        ) : null}
        {ops.length ? (
          <LCInspectorSection title="Opportunities">
            <div className="si-list">{ops.map((o) => <ObjLink key={o.id} to={{ kind: 'opportunity', id: o.id }}><LCStatus label={SEVERITY_LABEL[o.severity]} tone={SEVERITY_TONE[o.severity]} quiet /> {o.title}</ObjLink>)}</div>
          </LCInspectorSection>
        ) : null}
        <LCInspectorSection title="Source">
          {p.sourceFields?.length ? <LCFacts rows={p.sourceFields.map((f) => ({ label: f.label, value: f.value }))} /> : null}
          <ProvenanceLine source={p.source} />
        </LCInspectorSection>
      </>
    ),
  }
}

/* ── cluster ────────────────────────────────────────────────────────────── */

function clusterBody(ctx: Ctx, id: string): Body | null {
  const m = ctx.data.model
  const c = m.cluster.get(id)
  if (!c) return null
  const prop = m.property.get(c.propertyId)!
  const row = ownershipTable(m, c.propertyId).find((r) => r.cluster.id === id)!
  const owner = canonicalOwner(m, c)
  const kws = m.keywordsOfCluster.get(id) ?? []
  const conflicts = ownershipConflicts(m, c.propertyId).filter((x) => x.clusterIds.includes(id))
  const gate = searchMeasureGate(prop, m.dataset.connections)
  const wave = c.wave ? m.wave.get(c.wave) : null
  const STATE: Record<typeof row.state, { label: string; tone: 'ok' | 'attn' | 'neutral' | 'exec' }> = {
    OWNED: { label: 'Owned', tone: 'ok' }, CONTESTED: { label: 'Contested', tone: 'attn' }, UNOWNED: { label: 'No destination page', tone: 'attn' }, TEMPLATED: { label: 'Owned per place', tone: 'exec' },
  }
  return {
    eyebrow: <span className="si-insp-eyebrow"><BrandMark property={prop} /> {prop.brand} · keyword cluster</span>,
    title: c.primaryKeyword ?? c.label,
    subtitle: c.primaryKeyword ? c.label : 'This family is named, but no keyword research exists yet',
    status: <LCStatus label={STATE[row.state].label} tone={STATE[row.state].tone} />,
    content: (
      <>
        <LCInspectorSection title="Ownership">
          <LCFacts rows={[
            { label: 'Canonical owner', value: owner ? <ObjLink to={{ kind: 'page', id: owner.id }}><span className="si-mono">{owner.path}</span></ObjLink> : c.ownerRef ? `${c.ownerRef} (not registered)` : 'None named' },
            { label: 'Pages claiming it', value: row.primaries.length ? <span className="si-links">{row.primaries.slice(0, 8).map((p) => <ObjLink key={p.id} to={{ kind: 'page', id: p.id }}><span className="si-mono">{p.path}</span></ObjLink>)}{row.primaries.length > 8 ? <span className="si-muted">+{row.primaries.length - 8}</span> : null}</span> : 'None' },
            { label: 'Supporting pages', value: row.supporting.length ? fmt(row.supporting.length) : 'None' },
          ]} />
          {conflicts.map((x, i) => <p key={i} className="si-conflict" data-kind={x.kind}>{x.message}</p>)}
        </LCInspectorSection>
        <LCInspectorSection title="Definition">
          <LCFacts rows={[
            { label: 'Intent', value: c.intent ?? 'Not classified' },
            { label: 'Parent topic', value: c.parentTopic ?? '—' },
            { label: 'Geographic template', value: c.geoLevel ? c.geoLevel.toLowerCase() : 'National' },
            { label: 'Launch wave', value: wave ? <ObjLink to={{ kind: 'wave', id: wave.id }}>{wave.label}</ObjLink> : '—' },
            { label: 'Source', value: c.source },
          ]} />
          {c.notes ? <p className="si-note">{c.notes}</p> : null}
        </LCInspectorSection>
        <LCInspectorSection title="Keywords" aside={fmt(kws.length)}>
          {kws.length ? <div className="si-chips">{kws.slice(0, 40).map((k) => <ObjLink key={k.id} to={{ kind: 'keyword', id: k.id }} className="si-chip">{k.query}</ObjLink>)}</div> : <p className="si-muted">No keywords have been researched for this cluster.</p>}
        </LCInspectorSection>
        <LCInspectorSection title="Demand & performance">
          <div className="si-metrics">
            <div><span>Search volume</span><MetricCell metric={unavailable('RESEARCH_NOT_CONNECTED', 'EXTERNAL_RESEARCH')} /></div>
            <div><span>Difficulty</span><MetricCell metric={unavailable('RESEARCH_NOT_CONNECTED', 'EXTERNAL_RESEARCH')} /></div>
            <div><span>Impressions</span><MetricCell metric={unavailable(gate ?? 'NOT_REPORTED', 'SEARCH_CONSOLE')} /></div>
            <div><span>Business outcome</span><MetricCell metric={unavailable('BRIDGE_NOT_CONNECTED', 'LEADCOMMAND')} /></div>
          </div>
        </LCInspectorSection>
        <LCInspectorSection title="Source"><ProvenanceLine source={c.provenance} /></LCInspectorSection>
      </>
    ),
  }
}

/* ── keyword ────────────────────────────────────────────────────────────── */

function keywordBody(ctx: Ctx, id: string): Body | null {
  const m = ctx.data.model
  const k = m.keyword.get(id)
  if (!k) return null
  const prop = m.property.get(k.propertyId)!
  const c = k.clusterId ? m.cluster.get(k.clusterId) : null
  const page = k.assignedPageId ? m.page.get(k.assignedPageId) : null
  const gate = searchMeasureGate(prop, m.dataset.connections)
  const sc = (u: Parameters<typeof unavailable>[0]) => unavailable(u, 'SEARCH_CONSOLE')
  return {
    eyebrow: <span className="si-insp-eyebrow"><BrandMark property={prop} /> {prop.brand} · keyword</span>,
    title: k.query,
    status: <LCStatus label={k.source.replace(/_/g, ' ').toLowerCase()} tone="neutral" quiet />,
    content: (
      <>
        <LCInspectorSection title="Mapping">
          <LCFacts rows={[
            { label: 'Cluster', value: c ? <ObjLink to={{ kind: 'cluster', id: c.id }}>{c.primaryKeyword ?? c.label}</ObjLink> : 'None' },
            { label: 'Assigned page', value: page ? <ObjLink to={{ kind: 'page', id: page.id }}><span className="si-mono">{page.path}</span></ObjLink> : 'None' },
            { label: 'Intent', value: k.intent ?? '—' },
            { label: 'Status', value: k.status.toLowerCase() },
            { label: 'Source', value: k.source },
          ]} />
        </LCInspectorSection>
        <LCInspectorSection title="Search performance">
          <div className="si-metrics">
            <div><span>Volume</span><MetricCell metric={unavailable('RESEARCH_NOT_CONNECTED', 'EXTERNAL_RESEARCH')} /></div>
            <div><span>Difficulty</span><MetricCell metric={unavailable('RESEARCH_NOT_CONNECTED', 'EXTERNAL_RESEARCH')} /></div>
            <div><span>Impressions</span><MetricCell metric={sc(gate ?? 'NOT_REPORTED')} /></div>
            <div><span>Clicks</span><MetricCell metric={sc(gate ?? 'NOT_REPORTED')} /></div>
            <div><span>CTR</span><MetricCell metric={sc(gate ?? 'NOT_REPORTED')} /></div>
            <div><span>Avg position</span><MetricCell metric={sc(gate ?? 'NOT_REPORTED')} /></div>
            <div><span>Change</span><MetricCell metric={sc(gate ? gate : 'NO_RANKING_HISTORY')} /></div>
            <div><span>Outcome</span><MetricCell metric={unavailable('BRIDGE_NOT_CONNECTED', 'LEADCOMMAND')} /></div>
          </div>
        </LCInspectorSection>
        <LCInspectorSection title="Source"><ProvenanceLine source={k.provenance} /></LCInspectorSection>
      </>
    ),
  }
}

/* ── geography ──────────────────────────────────────────────────────────── */

function geographyBody(ctx: Ctx, id: string): Body | null {
  const m = ctx.data.model
  const g = m.geo.get(id)
  if (!g) return null
  const scope = ctx.state.property
  const cov = geoCoverage(m, scope).get(id)
  const path = geoPath(m, id)
  const kids = (m.geoChildren.get(id) ?? []).filter((x) => geoCoverage(m, scope).has(x.id))
  const gaps = coverageGaps(m, scope).filter((x) => x.kind === 'GEO_WITHOUT_PAGE' && x.geographyId === id)
  const pages = (m.pagesAtGeo.get(id) ?? []).filter((p) => !scope || p.propertyId === scope)
  return {
    eyebrow: <span className="si-insp-eyebrow">{g.kind.toLowerCase()} · {path.slice(0, -1).map((x) => x.name).join(' → ') || 'world'}</span>,
    title: g.kind !== 'STATE' && g.stateCode ? `${g.name}, ${g.stateCode}` : g.name,
    status: cov ? <LCStatus label={`${fmt(cov.planned)} planned`} tone="exec" quiet /> : <LCStatus label="No plan here" tone="neutral" quiet />,
    actions: <LCButton size="sm" variant="quiet" icon="globe" onClick={() => ctx.actions.setView('globe')}>Show on globe</LCButton>,
    content: (
      <>
        <LCInspectorSection title="Plan coverage">
          {cov ? (
            <>
              <LCFacts rows={[
                { label: 'Pages planned (incl. inside)', value: fmt(cov.planned) },
                { label: 'Built routes', value: fmt(cov.built) },
                { label: 'Ready', value: fmt(cov.ready) },
                { label: 'Published', value: fmt(cov.published) },
                { label: 'Indexed', value: cov.indexed == null ? 'Search Console not connected' : fmt(cov.indexed) },
                { label: 'Properties', value: cov.properties.map((p) => m.property.get(p)?.brand ?? p).join(', ') },
              ]} />
              <Meter value={cov.planned ? cov.ready / cov.planned : 0} label="Ready share" />
            </>
          ) : <p className="si-muted">No page in scope targets this place.</p>}
          {gaps.map((x) => <p key={x.id} className="si-conflict">{gapLabel(m, x)}</p>)}
        </LCInspectorSection>
        {kids.length ? (
          <LCInspectorSection title="Drill" aside={`${kids.length}`}>
            <div className="si-list">{kids.map((k) => <ObjLink key={k.id} to={{ kind: 'geography', id: k.id }}>{k.name}<span className="si-muted">{geoCoverage(m, scope).get(k.id)?.planned ?? 0} planned</span></ObjLink>)}</div>
          </LCInspectorSection>
        ) : null}
        <LCInspectorSection title="Pages targeting this place" aside={fmt(pages.length)}>
          {pages.length ? <div className="si-list">{pages.slice(0, 14).map((p) => <ObjLink key={p.id} to={{ kind: 'page', id: p.id }}><span className="si-mono">{p.path}</span><StatusPill status={p.status} /></ObjLink>)}</div> : <p className="si-muted">None directly. Coverage above includes places inside this one.</p>}
        </LCInspectorSection>
        <LCInspectorSection title="Search demand here">
          <div className="si-metrics">
            <div><span>Impressions</span><MetricCell metric={unavailable('AWAITING_LAUNCH', 'SEARCH_CONSOLE')} /></div>
            <div><span>Clicks</span><MetricCell metric={unavailable('AWAITING_LAUNCH', 'SEARCH_CONSOLE')} /></div>
            <div><span>Sessions</span><MetricCell metric={unavailable('AWAITING_LAUNCH', 'GA4')} /></div>
          </div>
        </LCInspectorSection>
      </>
    ),
  }
}

/* ── wave ───────────────────────────────────────────────────────────────── */

function waveBody(ctx: Ctx, id: string): Body | null {
  const m = ctx.data.model
  const w = m.wave.get(id)
  if (!w) return null
  const prop = m.property.get(w.propertyId)!
  const r = waveReadiness(m, w)
  const pages = (m.pagesOf.get(w.propertyId) ?? []).filter((p) => p.launchWaveId === id)
  const clusters = (m.clustersOf.get(w.propertyId) ?? []).filter((c) => c.wave === id)
  return {
    eyebrow: <span className="si-insp-eyebrow"><BrandMark property={prop} /> {prop.brand} · launch wave</span>,
    title: w.label,
    status: <LCStatus label={w.status.replace(/_/g, ' ').toLowerCase()} tone={w.status === 'BLOCKED' ? 'attn' : w.status === 'LAUNCHED' ? 'ok' : 'exec'} />,
    content: (
      <>
        <LCInspectorSection title="Readiness" aside={r.pages ? pct(r.ready / r.pages) : 'No pages assigned'}>
          {r.pages ? <><Meter value={r.ready / r.pages} label="Wave readiness" /><StatusBar counts={r.byStatus} total={r.pages} /></> : <p className="si-muted">The source plan assigns no registered page to this wave yet{clusters.length ? `, but it scopes ${clusters.length} clusters` : ''}.</p>}
          <LCFacts rows={[
            { label: 'Pages', value: fmt(r.pages) }, { label: 'Ready', value: fmt(r.ready) }, { label: 'Clusters in scope', value: fmt(clusters.length) },
            { label: 'Depends on', value: w.dependsOn.length ? <span className="si-links">{w.dependsOn.map((d) => <ObjLink key={d} to={{ kind: 'wave', id: d }}>{m.wave.get(d)?.label ?? d}</ObjLink>)}</span> : 'Nothing' },
            { label: 'Target date', value: w.targetDate ?? 'Not set in the plan' },
          ]} />
        </LCInspectorSection>
        <LCInspectorSection title="Blockers" aside={fmt(r.blockers.length)}>
          {r.blockers.length ? <ul className="si-blockers">{r.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul> : <p className="si-muted">The plan names no blockers.</p>}
        </LCInspectorSection>
        {w.notes ? <LCInspectorSection title="Thesis"><p className="si-thesis">{w.notes}</p></LCInspectorSection> : null}
        {clusters.length ? <LCInspectorSection title="Clusters"><div className="si-chips">{clusters.map((c) => <ObjLink key={c.id} to={{ kind: 'cluster', id: c.id }} className="si-chip">{c.primaryKeyword ?? c.label}</ObjLink>)}</div></LCInspectorSection> : null}
        {pages.length ? <LCInspectorSection title="Pages" aside={fmt(pages.length)}><div className="si-list">{pages.slice(0, 16).map((p) => <ObjLink key={p.id} to={{ kind: 'page', id: p.id }}><span className="si-mono">{p.path}</span><StatusPill status={p.status} /></ObjLink>)}</div></LCInspectorSection> : null}
        <LCInspectorSection title="Source"><ProvenanceLine source={w.source} /></LCInspectorSection>
      </>
    ),
  }
}

/* ── opportunity ────────────────────────────────────────────────────────── */

function opportunityBody(ctx: Ctx, id: string): Body | null {
  const m = ctx.data.model
  const o = ctx.data.opportunities.find((x) => x.id === id)
  if (!o) return null
  const rule = RULE.get(o.ruleId)
  const prop = m.property.get(o.propertyId)
  return {
    eyebrow: <span className="si-insp-eyebrow">{prop ? <><BrandMark property={prop} /> {prop.brand} · </> : null}{rule?.title ?? o.ruleId}</span>,
    title: o.title,
    status: <LCStatus label={SEVERITY_LABEL[o.severity]} tone={SEVERITY_TONE[o.severity]} />,
    content: (
      <>
        <LCInspectorSection title="Why">
          <p className="si-thesis">{o.why}</p>
          <p className="si-muted">Deterministic rule <code>{o.ruleId}</code> · {o.phase === 'PRE_LAUNCH' ? 'reads the plan' : 'reads provider facts'}. No inference, prediction or AI judgement.</p>
        </LCInspectorSection>
        <LCInspectorSection title="Evidence"><LCFacts rows={o.evidence.map((e) => ({ label: e.label, value: e.value }))} /></LCInspectorSection>
        <LCInspectorSection title="Subject">
          <ObjLink to={o.subject}>{refLabel(ctx, o.subject)}</ObjLink>
          {o.related.length ? <div className="si-list">{o.related.slice(0, 16).map((r) => <ObjLink key={`${r.kind}:${r.id}`} to={r}>{refLabel(ctx, r)}</ObjLink>)}{o.related.length > 16 ? <span className="si-muted">+{o.related.length - 16} more</span> : null}</div> : null}
        </LCInspectorSection>
      </>
    ),
  }
}

/* ── property ───────────────────────────────────────────────────────────── */

function propertyBody(ctx: Ctx, id: string): Body | null {
  const m = ctx.data.model
  const p = m.property.get(id)
  if (!p) return null
  const s = ctx.data.summaries.find((x) => x.property.id === id)!
  const conns = m.connectionsOf.get(id) ?? []
  const cur = lifecycleIndex(p.lifecycle)
  return {
    eyebrow: <span className="si-insp-eyebrow"><BrandMark property={p} /> web property</span>,
    title: p.brand,
    subtitle: p.domain,
    status: <LCStatus label={LIFECYCLE_LABEL[p.lifecycle]} tone="exec" />,
    actions: <LCButton size="sm" variant="quiet" icon="target" onClick={() => ctx.actions.setProperty(id)}>Focus</LCButton>,
    content: (
      <>
        <LCInspectorSection title="Lifecycle">
          <ol className="si-ladder" aria-label="Lifecycle">
            {LIFECYCLE.map((l, i) => <li key={l} data-done={i < cur ? 'true' : undefined} data-current={i === cur ? 'true' : undefined}><i />{LIFECYCLE_LABEL[l]}</li>)}
          </ol>
          <p className="si-note">{p.lifecycleNote}</p>
          <p className="si-muted">Next: {LIFECYCLE_EXIT[p.lifecycle]}.</p>
        </LCInspectorSection>
        <LCInspectorSection title="Plan">
          <LCFacts rows={[
            { label: 'Pages planned', value: fmt(s.pagesPlanned) }, { label: 'Built routes', value: fmt(s.pagesBuilt) }, { label: 'Ready', value: fmt(s.pagesReady) },
            { label: 'Published', value: fmt(s.pagesPublished) }, { label: 'Indexed', value: s.pagesIndexed == null ? 'Search Console not connected' : fmt(s.pagesIndexed) },
            { label: 'Keyword clusters', value: `${fmt(s.clustersOwned)} of ${fmt(s.clusters)} owned` }, { label: 'Keywords', value: fmt(s.keywords) },
            { label: 'Places', value: fmt(s.geographies) }, { label: 'Launch waves', value: fmt(s.waves) },
            { label: 'Next-wave readiness', value: s.launchReadiness == null ? 'No wave' : pct(s.launchReadiness) },
          ]} />
        </LCInspectorSection>
        <LCInspectorSection title="Connections">
          <div className="si-conn-list">
            {conns.map((c) => <div key={c.provider}><span>{PROVIDER_DESCRIPTORS[c.provider].label}</span><ConnectionPill state={c.state} />{c.note ? <em>{c.note}</em> : null}</div>)}
          </div>
        </LCInspectorSection>
        {p.facts.length ? <LCInspectorSection title="Source audit (not search data)"><LCFacts rows={p.facts.map((f) => ({ label: f.label, value: f.value }))} /><ProvenanceLine source={p.facts[0].source} /></LCInspectorSection> : null}
        {p.reservedFamilies.length ? <LCInspectorSection title="Reserved families"><LCFacts rows={p.reservedFamilies.map((r) => ({ label: r.family, value: <span><span className="si-mono">{r.route}</span> — {r.note}</span> }))} /></LCInspectorSection> : null}
        {p.excludedHosts.length ? <LCInspectorSection title="Not part of this property"><p className="si-mono">{p.excludedHosts.join(', ')}</p></LCInspectorSection> : null}
        <LCInspectorSection title="Sources">{p.sources.length ? p.sources.map((src, i) => <ProvenanceLine key={i} source={src} />) : <p className="si-muted">No planning source was found for this property.</p>}</LCInspectorSection>
      </>
    ),
  }
}
