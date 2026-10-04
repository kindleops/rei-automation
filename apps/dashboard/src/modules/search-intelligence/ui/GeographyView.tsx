import { useEffect, useMemo, useState } from 'react'
import { LCEmpty, cx } from '../../../shared/lc'
import { loadCounties, loadStates, normCounty, frameBox, unionBox, FRAME, type AreaShape, type StateShape } from '../../../views/analytics/intelligence/intel-atlas'
import { project } from '../../../views/analytics/intelligence/intel-geo'
import { geoPath } from '../domain/model'
import { coverageGaps, drillChildren, geoCoverage } from '../domain/geography'
import { Meter, ObjLink, StatusPill } from './parts'
import { fmt, useSi } from './si-context'

/**
 * Search Map (§12). Before launch it shows exactly two facts per place —
 * pages PLANNED and pages READY — plus declared places with no page. The
 * impression / click / conversion layers are listed and say why they are
 * empty. Geometry: the Census outlines already shipped for Analytics
 * (pre-projected Albers USA, 975×610), reused read-only.
 */
export function GeographyView() {
  const { data, state, actions } = useSi()
  const m = data.model
  const cov = useMemo(() => geoCoverage(m, state.property), [m, state.property])
  const gapGeo = useMemo(() => new Set(coverageGaps(m, state.property).flatMap((g) => (g.kind === 'GEO_WITHOUT_PAGE' ? [g.geographyId] : []))), [m, state.property])
  const [states, setStates] = useState<StateShape[] | null>(null)
  const [counties, setCounties] = useState<{ abbr: string; shapes: AreaShape[] } | null>(null)
  useEffect(() => { let alive = true; loadStates().then((s) => { if (alive) setStates(s) }); return () => { alive = false } }, [])

  // the drill focus follows an inspected geography
  const focusId = state.object?.kind === 'geography' ? state.object.id : 'us'
  const path = geoPath(m, focusId)
  const stateGeo = path.find((g) => g.kind === 'STATE') ?? null
  const abbr = stateGeo?.code ?? null
  useEffect(() => {
    if (!abbr) return
    let alive = true
    loadCounties(abbr).then((shapes) => { if (alive) setCounties({ abbr, shapes }) })
    return () => { alive = false }
  }, [abbr])
  const countyShapes = counties && counties.abbr === abbr ? counties.shapes : []

  const stateShape = abbr && states ? states.find((s) => s.abbr === abbr) ?? null : null
  const box = stateShape ? frameBox(unionBox([stateShape.box]), 0.12) : { x: 0, y: 0, w: FRAME.width, h: FRAME.height }
  const maxPlanned = Math.max(1, ...[...cov.values()].filter((c) => c.geo.kind === 'STATE').map((c) => c.planned))
  const covByCode = new Map([...cov.values()].filter((c) => c.geo.kind === 'STATE').map((c) => [c.geo.code, c]))
  const countyCov = new Map([...cov.values()].filter((c) => c.geo.kind === 'COUNTY' && c.geo.stateCode === abbr).map((c) => [normCounty(c.geo.name), c]))
  const cityMarks = [...cov.values()].filter((c) => (c.geo.kind === 'CITY' || c.geo.kind === 'METRO') && c.geo.lat != null && c.geo.lng != null && (!abbr || c.geo.stateCode === abbr))
    .map((c) => ({ c, pt: project(c.geo.lng!, c.geo.lat!) })).filter((x): x is { c: typeof x.c; pt: [number, number] } => !!x.pt)
  const children = drillChildren(m, cov, focusId)
  const here = cov.get(focusId)
  const pages = (m.pagesAtGeo.get(focusId) ?? []).filter((p) => !state.property || p.propertyId === state.property)
  const strokeScale = box.w / FRAME.width

  if (!cov.size) return <div className="si-pad"><LCEmpty title="No geographic plan" body="No page in scope targets a place. Geography lights up as the architecture assigns pages to states, counties and cities." icon="map" /></div>
  return (
    <div className="si-split is-map">
      <section className="si-split__main si-card si-searchmap" aria-label="Search map">
        <header className="si-card__h">
          <h3>Search map</h3>
          <span className="si-card__m">planned and ready pages per place · not traffic</span>
        </header>
        <nav className="si-crumbs is-map" aria-label="Drill path">
          {path.map((g, i) => (
            <ObjLink key={g.id} to={{ kind: 'geography', id: g.id }} className={cx(i === path.length - 1 && 'is-here')}>{g.kind !== 'STATE' && g.kind !== 'COUNTRY' && g.stateCode ? `${g.name}, ${g.stateCode}` : g.name}</ObjLink>
          ))}
        </nav>
        <svg className="si-searchmap__svg" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} role="img" aria-label="Plan coverage by state and county">
          {(states ?? []).map((s) => {
            const c = covByCode.get(s.abbr)
            const isGap = gapGeo.has(`us-${s.abbr.toLowerCase()}`)
            const t = c ? 0.12 + 0.5 * (c.planned / maxPlanned) : 0
            return (
              <path key={s.id} d={s.d} className={cx('si-st', c && 'has-plan', isGap && 'is-gap', s.abbr === abbr && 'is-focus')}
                style={{ ['--t' as string]: String(t), ['--sw' as string]: String(strokeScale) }}
                onClick={() => actions.inspect({ kind: 'geography', id: `us-${s.abbr.toLowerCase()}` })}>
                <title>{s.name}{c ? ` — ${c.planned} planned, ${c.ready} ready` : isGap ? ' — declared, no page' : ' — no plan'}</title>
              </path>
            )
          })}
          {countyShapes.map((cs) => {
            const c = countyCov.get(normCounty(cs.name))
            return (
              <path key={cs.id} d={cs.d} className={cx('si-co', c && 'has-plan')} style={{ ['--sw' as string]: String(strokeScale) }}
                onClick={() => { if (c) actions.inspect({ kind: 'geography', id: c.geo.id }) }}>
                <title>{cs.name}{c ? ` — ${c.planned} planned, ${c.ready} ready` : ''}</title>
              </path>
            )
          })}
          {cityMarks.map(({ c, pt }) => (
            <g key={c.geo.id} className={cx('si-city', c.ready > 0 && 'is-ready', focusId === c.geo.id && 'is-focus')} transform={`translate(${pt[0]} ${pt[1]})`} onClick={() => actions.inspect({ kind: 'geography', id: c.geo.id })}>
              <circle r={(1.6 + Math.sqrt(c.planned) * 0.9) * strokeScale * 1.4} />
              <title>{c.geo.name}, {c.geo.stateCode} — {c.planned} planned, {c.ready} ready</title>
            </g>
          ))}
        </svg>
        <div className="si-searchmap__layers">
          <span className="is-on">Planned</span><span className="is-on">Ready</span>
          <span>Published · awaiting site launch</span><span>Indexed · Search Console not connected</span>
          <span>Impressions · Search Console not connected</span><span>Clicks · Search Console not connected</span><span>Conversions · analytics not connected</span>
        </div>
      </section>
      <aside className="si-split__side si-card" aria-label="Drill detail">
        <header className="si-card__h"><h3>{path[path.length - 1]?.name ?? 'United States'}</h3><span className="si-card__m">{here ? `${fmt(here.planned)} planned · ${fmt(here.built)} built · ${fmt(here.ready)} ready` : gapGeo.has(focusId) ? 'declared in the plan · no page yet' : 'no plan here'}</span></header>
        {here ? <Meter value={here.planned ? here.ready / here.planned : 0} label="Ready share" /> : null}
        {children.length ? (
          <div className="si-drill">
            <div className="si-drill__h"><span>Place</span><span>Planned</span><span>Built</span><span>Ready</span><span>Indexed</span></div>
            {children.map((c) => (
              <ObjLink key={c.geo.id} to={{ kind: 'geography', id: c.geo.id }} className="si-drill__r">
                <span>{c.geo.name}{gapGeo.has(c.geo.id) ? ' ·' : ''}</span><span>{fmt(c.planned)}</span><span>{fmt(c.built)}</span><span>{fmt(c.ready)}</span><span className="si-na">—</span>
              </ObjLink>
            ))}
          </div>
        ) : null}
        {focusId === 'us' && gapGeo.size ? (
          <div className="si-gapbox">
            <span className="si-eyebrow">Declared, no page of the expected family</span>
            <div className="si-chips">{[...gapGeo].map((g) => <ObjLink key={g} to={{ kind: 'geography', id: g }} className="si-chip is-gap">{m.geo.get(g)?.name ?? g}</ObjLink>)}</div>
          </div>
        ) : null}
        {pages.length ? (
          <div className="si-list">
            <span className="si-list__h">Pages and clusters here</span>
            {pages.slice(0, 30).map((p) => (
              <ObjLink key={p.id} to={{ kind: 'page', id: p.id }}>
                <span className="si-mono">{p.path}</span><StatusPill status={p.status} />
                {p.primaryClusterId ? <em>{m.cluster.get(p.primaryClusterId)?.primaryKeyword ?? m.cluster.get(p.primaryClusterId)?.label}</em> : null}
              </ObjLink>
            ))}
          </div>
        ) : null}
      </aside>
    </div>
  )
}
