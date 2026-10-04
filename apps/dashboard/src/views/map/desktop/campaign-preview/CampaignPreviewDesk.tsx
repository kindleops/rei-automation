/**
 * CAMPAIGN MAP PREVIEW — Live Audience Geography on the existing Map (desktop).
 *
 * The Composer publishes what it is composing (domain/campaign-preview); this
 * pane consumes it: the bound preview's eligible cohort (part=geo — the same
 * server pipeline as the Composer's "Eligible") drawn on a dedicated layer,
 * a compact glass status (eligible · mapped · without coordinates · markets),
 * a keyboard-navigable market list, follow modes and the states.
 *
 * Observational in V1: no map gesture adds or removes a target, edits the
 * draft or affects a send. Points are real LC property objects (click opens,
 * Shift inspects, ⌘/Ctrl opens beside, right-click is the shared menu).
 * Future map-driven edits get a named event (CAMPAIGN_PREVIEW_INTENT_EVENT)
 * nothing listens to yet.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type maplibregl from 'maplibre-gl'
import { LCButton, LCCounter, LCIconButton, LCMenu, LCSegmented, cx } from '../../../../shared/lc'
import { Icon } from '../../../../shared/icons'
import { useRouteLocation } from '../../../../app/router'
import { useAppInstance } from '../../../../modules/desktop/workspace/instance-context'
import { handleObjectClick, objectMenuEntries, propertyObject, type ObjectRef } from '../../../../modules/desktop/objects'
import { writeMapPropertyFocus } from '../../../../domain/map/map-property-focus'
import { CAMPAIGN_PREVIEW_PARAM, useCampaignPreviewBinding } from '../../../../domain/campaign-preview/campaign-preview-context'
import { createAutoFramer, flightDuration, type AutoFramer } from '../../focus/focus-camera'
import { readCampaignGeography } from './preview-api'
import {
  FOLLOW_OPTIONS, fmt, marketNote, planCameraIntent, previewFeatures, previewPaint, previewTitle, readFollowMode, shortMarket,
  shouldCluster, statusLine, unionBounds, writeFollowMode,
  type CameraIntent, type FollowMode, type GeoMarket, type GeoPreview, type PreviewMode,
} from './preview-model'
import { CP_HIT_LAYERS, CP_LAYERS, CP_SOURCE, pulseArrival, removePreviewLayer, repaintPreviewLayer, setPreviewMode, syncPreviewLayer } from './preview-layer'
import './campaign-preview.css'

/** Reserved for future map-driven edits (exclude / include / territory / geo filter). Nothing dispatches it in V1. */
export const CAMPAIGN_PREVIEW_INTENT_EVENT = 'lc:campaign-preview-intent'
export type CampaignPreviewIntent =
  | { kind: 'exclude_property'; previewKey: string; propertyId: string }
  | { kind: 'include_property'; previewKey: string; propertyId: string }
  | { kind: 'territory'; previewKey: string; polygon: Array<[number, number]> }
  | { kind: 'explain_exclusion'; previewKey: string; propertyId: string }

type Geo = { identity: string; specKey: string; data: GeoPreview | null; error: string | null }
type Bounds = [[number, number], [number, number]]

const MARKET_MAX_ZOOM = 12.6

/** The latest value for handlers and effects, without reading a ref during render. */
function useLatest<T>(value: T) {
  const ref = useRef(value)
  useLayoutEffect(() => { ref.current = value })
  return ref
}

/** Theme / accent changes (html attributes + inline token updates) without polling. */
function useThemeEpoch() {
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined
    const obs = new MutationObserver(() => setEpoch((e) => e + 1))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-nexus-theme', 'style', 'class'] })
    return () => obs.disconnect()
  }, [])
  return epoch
}

function readTokens() {
  if (typeof document === 'undefined') return { accent: '', exec: '' }
  try {
    const cs = getComputedStyle(document.documentElement)
    return { accent: cs.getPropertyValue('--lc-accent-rgb').trim() || cs.getPropertyValue('--nexus-accent-rgb').trim(), exec: cs.getPropertyValue('--lc-exec-rgb').trim() }
  } catch { return { accent: '', exec: '' } }
}

type PreviewDeskProps = { map: maplibregl.Map | null; mapEpoch: number; reducedMotion: boolean; styleMode: string }

/**
 * Desktop, client-only. On a server render (no window) or outside the modern
 * desktop shell nothing mounts — the runtime below reads the route location,
 * the workspace and the map, all of which are browser-only.
 */
export function CampaignPreviewDesk(props: PreviewDeskProps) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  if (!document.documentElement.classList.contains('is-desktop-modern')) return null
  return <CampaignPreviewRuntime {...props} />
}

function CampaignPreviewRuntime({ map, mapEpoch, reducedMotion, styleMode }: PreviewDeskProps) {
  const { instanceId, pinned, follows, visible } = useAppInstance()
  const location = useRouteLocation()
  const pathKey = useMemo(() => new URLSearchParams(location.split('?')[1] ?? '').get(CAMPAIGN_PREVIEW_PARAM), [location])
  const { binding, context } = useCampaignPreviewBinding({ pathKey, pinned, follows })
  const identity = context ? `${context.key}|${context.draftId ?? ''}` : null
  const specKey = context?.specKey ?? null
  const hasFilters = Boolean(context && Object.values(context.spec.filters ?? {}).some((g) => Array.isArray(g) && g.length > 0))

  /* ── the server's answer, keyed by campaign identity + spec ─────────── */
  const [geo, setGeo] = useState<Geo | null>(null)
  const [nonce, setNonce] = useState(0)
  const specRef = useLatest(context?.spec ?? null)
  useEffect(() => {
    if (!identity || !specKey || !hasFilters) return undefined
    const ctl = new AbortController()
    const timer = window.setTimeout(() => {
      const spec = specRef.current
      if (!spec) return
      readCampaignGeography(spec, ctl.signal).then((r) => {
        if (ctl.signal.aborted) return
        setGeo({ identity, specKey, data: r.ok ? r.data : null, error: r.ok ? null : r.message })
      }).catch(() => { /* aborted */ })
    }, 450)
    return () => { window.clearTimeout(timer); ctl.abort() }
  }, [identity, specKey, hasFilters, nonce, specRef])

  // A preview never shows another campaign's points: a different identity is nothing.
  const mine = geo && geo.identity === identity ? geo : null
  const settled = mine?.specKey === specKey ? mine : null
  // keep the last answer for THIS campaign while a filter edit settles (counts move, never blank)
  const data = hasFilters ? (settled?.data ?? (mine?.error ? null : mine?.data) ?? null) : null
  const error = settled?.error ?? null
  const loading = Boolean(identity && hasFilters && !settled)
  const active = Boolean(binding.key && context)

  /* ── follow mode (per pane, per session) and view mode ──────────────── */
  const scope = instanceId ?? 'main'
  const [follow, setFollowState] = useState<FollowMode>(() => readFollowMode(scope))
  const [manualByGesture, setManualByGesture] = useState(false)
  const setFollow = useCallback((m: FollowMode) => { setFollowState(m); setManualByGesture(false); writeFollowMode(scope, m) }, [scope])
  const [mode, setMode] = useState<PreviewMode>('audience')
  // a pinned pane never flies on its own; only the operator's Frame / market click moves it
  const effectiveFollow: FollowMode = pinned ? 'manual' : follow

  /* ── the layer ───────────────────────────────────────────────────────── */
  const features = useMemo(() => previewFeatures(data), [data])
  const clustered = shouldCluster(features.features.length)
  const themeEpoch = useThemeEpoch()
  const paint = useMemo(() => {
    void themeEpoch
    const t = readTokens()
    return previewPaint({ accentRgb: t.accent, execRgb: t.exec, styleMode })
  }, [themeEpoch, styleMode])
  const paintRef = useLatest(paint)
  const modeRef = useLatest(mode)

  useEffect(() => {
    if (!map) return undefined
    if (!active || !data) { removePreviewLayer(map); return undefined }
    let tries = 0
    let t = 0
    const apply = () => {
      if (syncPreviewLayer(map, features, { clustered, mode: modeRef.current, paint: paintRef.current })) return
      if ((tries += 1) < 20) t = window.setTimeout(apply, 150) // the style is still arriving
    }
    apply()
    return () => window.clearTimeout(t)
  }, [map, mapEpoch, active, data, features, clustered, modeRef, paintRef])
  useEffect(() => { if (map) repaintPreviewLayer(map, paint) }, [map, paint])
  useEffect(() => { if (map) setPreviewMode(map, mode) }, [map, mode])
  useEffect(() => () => { if (map) removePreviewLayer(map) }, [map])

  /* ── camera: intent only, through the existing cinematic framer ────── */
  const framerRef = useRef<AutoFramer | null>(null)
  const consoleRef = useRef<HTMLElement | null>(null)
  const activeRef = useLatest(active)
  const followRef = useLatest(effectiveFollow)
  useEffect(() => {
    if (!map) return undefined
    const framer = createAutoFramer(map as unknown as Parameters<typeof createAutoFramer>[0])
    framerRef.current = framer
    // the operator touching the camera stops following (never the audience sync)
    const grab = (e: { originalEvent?: unknown }) => {
      if (!e?.originalEvent || !activeRef.current || followRef.current === 'manual') return
      setFollowState('manual')
      setManualByGesture(true)
    }
    const GESTURES = ['dragstart', 'rotatestart', 'pitchstart', 'wheel', 'touchstart'] as const
    for (const g of GESTURES) map.on(g, grab)
    return () => { for (const g of GESTURES) map.off(g, grab); framer.dispose(); framerRef.current = null }
  }, [map, activeRef, followRef])

  const flyToBounds = useCallback((b: Bounds, key: string, onLand?: () => void) => {
    const framer = framerRef.current
    if (!map || !framer) return
    try {
      const box = map.getContainer()
      const width = box.clientWidth || 1
      const height = box.clientHeight || 1
      const pad = (v: number, frac: number) => Math.round(Math.min(120, Math.max(24, v * frac)))
      const padding = { top: pad(height, 0.1) + 20, bottom: pad(height, 0.12), left: pad(width, 0.06) + 52, right: pad(width, 0.06) }
      // the console floats top-right: frame beside it on a wide pane, below it on a narrow one
      const own = consoleRef.current?.getBoundingClientRect()
      const at = box.getBoundingClientRect()
      if (own && own.width) {
        if (width > 900) padding.right += Math.max(0, at.right - own.left) + 8
        else padding.top += Math.max(0, own.bottom - at.top) + 4
      }
      const cam = map.cameraForBounds(b, { padding, maxZoom: MARKET_MAX_ZOOM })
      if (!cam?.center) return
      const center = cam.center as maplibregl.LngLat
      const to: [number, number] = [center.lng, center.lat]
      const zoom = Math.min(MARKET_MAX_ZOOM, cam.zoom ?? map.getZoom())
      const p = map.project(to)
      const distancePx = Number.isFinite(p.x) ? Math.hypot(p.x - width / 2, p.y - height / 2) : Math.hypot(width, height) * 4
      const dz = zoom - map.getZoom()
      const diag = Math.hypot(width, height)
      const duration = reducedMotion ? 0 : flightDuration(distancePx, diag, dz)
      const near = distancePx < diag * 0.75 && Math.abs(dz) < 2.5
      framer.run({ kind: reducedMotion ? 'jump' : near ? 'ease' : 'fly', center: to, zoom, duration }, key, { onLand })
    } catch { /* map not ready */ }
  }, [map, reducedMotion])

  const execute = useCallback((intent: CameraIntent, g: GeoPreview, opts: { explicit?: boolean } = {}) => {
    if (!visible && !opts.explicit) return
    const byName = new Map(g.markets.map((m, i) => [m.market, { m, i }]))
    const all = unionBounds(g.markets)
    const boxOf = (m: GeoMarket | undefined): Bounds | null => (m?.bbox ? [[m.bbox[0], m.bbox[1]], [m.bbox[2], m.bbox[3]]] : null)
    if (intent.kind === 'frame_all') { if (all) flyToBounds(all, `cp:all:${g.at}`); return }
    const hit = byName.get(intent.market)
    if (intent.kind === 'frame_market') { const b = boxOf(hit?.m); if (b) flyToBounds(b, `cp:m:${intent.market}:${g.at}`); return }
    // arrive: fit the combined audience (no out-and-back), and acknowledge the new market once
    if (all) flyToBounds(all, `cp:arrive:${intent.market}:${g.at}`, () => { if (map && hit) pulseArrival(map, hit.i, reducedMotion) })
    else if (map && hit) pulseArrival(map, hit.i, reducedMotion)
  }, [flyToBounds, map, reducedMotion, visible])

  // markets → intent, held until the answer for that spec lands
  const pending = useRef<{ intent: CameraIntent; specKey: string } | null>(null)
  const seen = useRef<{ identity: string | null; markets: string[] | null }>({ identity: null, markets: null })
  const marketsKey = context ? JSON.stringify(context.markets) : ''
  useEffect(() => {
    if (!identity || !context || !specKey) { seen.current = { identity: null, markets: null }; pending.current = null; return }
    const activated = seen.current.identity !== identity
    const intent = planCameraIntent({ cause: activated ? 'activated' : 'audience_changed', mode: followRef.current, prevMarkets: activated ? null : seen.current.markets, nextMarkets: context.markets })
    seen.current = { identity, markets: context.markets }
    if (intent) pending.current = { intent, specKey }
    else if (pending.current && pending.current.specKey !== specKey && !activated) pending.current = { ...pending.current, specKey } // a filter edit right after a market change still lands the market's framing
    // context is read through marketsKey / specKey / identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, marketsKey, specKey])
  useEffect(() => {
    const p = pending.current
    if (!p || !settled?.data || settled.specKey !== p.specKey) return
    pending.current = null
    if (followRef.current === 'manual') return
    execute(p.intent, settled.data)
  }, [settled, execute, followRef])

  const frameCampaign = useCallback(() => { if (data) execute({ kind: 'frame_all' }, data, { explicit: true }) }, [data, execute])
  const frameMarket = useCallback((market: string) => { if (data) execute({ kind: 'frame_market', market }, data, { explicit: true }) }, [data, execute])

  /* ── points are LC property objects ──────────────────────────────────── */
  const [menu, setMenu] = useState<{ ref: ObjectRef; x: number; y: number } | null>(null)
  const marketsRef = useLatest<GeoMarket[]>(data?.markets ?? [])
  useEffect(() => {
    if (!map || !active) return undefined
    const refOf = (f: maplibregl.MapGeoJSONFeature): ObjectRef | null => {
      const pid = String((f.properties as { pid?: unknown } | null)?.pid ?? '')
      if (!pid) return null
      const g = f.geometry as { coordinates?: [number, number] }
      const market = marketsRef.current[Number((f.properties as { m?: unknown }).m)]?.market ?? null
      return propertyObject({ propertyId: pid, source: 'map', label: market ? `Campaign target · ${shortMarket(market)}` : 'Campaign target', lat: g.coordinates?.[1] ?? null, lng: g.coordinates?.[0] ?? null })
    }
    const onDot = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const handled = (e as { _clickHandled?: boolean })._clickHandled
      const f = e.features?.[0]
      const ref = f ? refOf(f) : null
      if (!ref || !f) return
      const oe = e.originalEvent as MouseEvent | undefined
      const modified = Boolean(oe && (oe.shiftKey || oe.metaKey || oe.ctrlKey))
      // a plain click the Map's own pin already took is the same selection: don't double it
      if (handled && !modified) return
      ;(e as { _clickHandled?: boolean })._clickHandled = true
      const g = f.geometry as { coordinates?: [number, number] }
      handleObjectClick(oe ?? null, ref, () => {
        writeMapPropertyFocus({ propertyId: ref.id, label: ref.label ?? null, lat: g.coordinates?.[1] ?? null, lng: g.coordinates?.[0] ?? null, source: 'campaign-preview' })
      })
    }
    const onCluster = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const f = e.features?.[0]
      if (!f || (e as { _clickHandled?: boolean })._clickHandled) return
      ;(e as { _clickHandled?: boolean })._clickHandled = true
      const id = Number((f.properties as { cluster_id?: unknown }).cluster_id)
      const g = f.geometry as { coordinates?: [number, number] }
      const src = map.getSource(CP_SOURCE) as maplibregl.GeoJSONSource | undefined
      if (!src || !g.coordinates) return
      Promise.resolve(src.getClusterExpansionZoom(id)).then((z) => {
        map.easeTo({ center: g.coordinates!, zoom: Math.min(16, Number(z) + 0.2), duration: reducedMotion ? 0 : 600 })
      }).catch(() => { /* cluster gone */ })
    }
    const onContext = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const f = e.features?.[0]
      const ref = f ? refOf(f) : null
      if (!ref) return
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      setMenu({ ref, x: e.point.x, y: e.point.y })
    }
    const enter = () => { map.getCanvas().style.cursor = 'pointer' }
    const leave = () => { map.getCanvas().style.cursor = '' }
    map.on('click', CP_LAYERS.dot, onDot)
    map.on('click', CP_LAYERS.cluster, onCluster)
    map.on('contextmenu', CP_LAYERS.dot, onContext)
    for (const id of CP_HIT_LAYERS) { map.on('mouseenter', id, enter); map.on('mouseleave', id, leave) }
    return () => {
      map.off('click', CP_LAYERS.dot, onDot)
      map.off('click', CP_LAYERS.cluster, onCluster)
      map.off('contextmenu', CP_LAYERS.dot, onContext)
      for (const id of CP_HIT_LAYERS) { map.off('mouseenter', id, enter); map.off('mouseleave', id, leave) }
    }
  }, [map, mapEpoch, active, reducedMotion, marketsRef])

  /* ── the console ────────────────────────────────────────────────────── */
  const [listOpen, setListOpen] = useState(true)
  const listRef = useRef<HTMLOListElement | null>(null)
  const onListKey = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-cp-market]') ?? [])]
    if (!rows.length) return
    e.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)
    rows[next]?.focus()
  }
  // Esc closes this console's own transient surface (the market list) — nothing global
  const onConsoleKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && listOpen && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); setListOpen(false) }
  }

  if (!active || !context) return null
  const markets = data?.markets ?? []
  const shownMarkets = context.markets.length ? context.markets : markets.map((m) => m.market)
  const title = previewTitle(shownMarkets)
  const byName = new Map(markets.map((m) => [m.market, m]))
  // the selected markets first (in the order chosen), then any other market the cohort reached
  const rows: GeoMarket[] = [
    ...context.markets.map((m) => byName.get(m) ?? { market: m, eligible: 0, mapped: 0, unmapped: 0, not_routable: 0, no_greeting: 0, bbox: null }),
    ...markets.filter((m) => !context.markets.includes(m.market)),
  ]
  const ex = data?.excluded
  const exParts = ex ? [
    ex.held_by_build ? `${fmt(ex.held_by_build)} held by Build` : null,
    ex.not_routable ? `${fmt(ex.not_routable)} no sender route` : null,
    ex.no_greeting ? `${fmt(ex.no_greeting)} greeting can’t render` : null,
  ].filter(Boolean) : []
  const rec = data?.reconciliation
  const state: 'no_market' | 'loading' | 'error' | 'empty' | 'ready' = !hasFilters ? 'no_market' : error && !data ? 'error' : !data ? 'loading' : data.eligible === 0 ? 'empty' : 'ready'

  return (
    <>
      <section
        ref={consoleRef}
        className={cx('lc-cpv mxd-l2', loading && 'is-updating', `is-${state}`)}
        aria-label={title}
        data-campaign-preview={context.key}
        data-cp-follow={effectiveFollow}
        onKeyDown={onConsoleKey}
      >
        <header className="lc-cpv__head">
          <span className="lc-cpv__dot" aria-hidden="true" />
          <div className="lc-cpv__title">
            <h2>{title}</h2>
            <p>{context.name ? context.name : context.draftId ? 'Draft' : 'Unsaved composition'}{binding.reason === 'latest' ? ' · following Composer' : ''}</p>
          </div>
          <LCIconButton icon="target" size="sm" label="Frame campaign" onClick={frameCampaign} disabled={!data || !data.mapped} data-cp-frame />
          <LCIconButton icon={listOpen ? 'chevron-up' : 'chevron-down'} size="sm" label={listOpen ? 'Hide markets' : 'Show markets'} onClick={() => setListOpen((v) => !v)} aria-expanded={listOpen} />
        </header>

        {state === 'no_market' ? <p className="lc-cpv__state">Select a market to preview the campaign audience.</p> : null}
        {state === 'loading' ? <p className="lc-cpv__state is-quiet" role="status"><span className="lc-cpv__spin" aria-hidden="true" />Reading the campaign audience…</p> : null}
        {state === 'error' ? (
          <div className="lc-cpv__state is-error" role="status">
            <span>Preview unavailable — {/timeout|timed out/i.test(error ?? '') ? 'the audience read timed out' : (error ?? 'read failed').split(/[—(\n]/)[0].slice(0, 90)}. Composer is unaffected.</span>
            <LCButton size="sm" variant="quiet" onClick={() => setNonce((n) => n + 1)}>Retry</LCButton>
          </div>
        ) : null}
        {state === 'empty' ? <p className="lc-cpv__state">No properties match the current campaign filters.</p> : null}

        {data && state !== 'error' ? (
          <div className="lc-cpv__counts" role="status" aria-live="polite" aria-label={statusLine(data)}>
            <span className="lc-cpv__count is-primary"><b><LCCounter value={data.eligible} /></b><em>eligible</em></span>
            <span className="lc-cpv__count"><b><LCCounter value={data.mapped} /></b><em>mapped</em></span>
            {data.unmapped > 0 ? <span className="lc-cpv__count"><b><LCCounter value={data.unmapped} /></b><em>without coordinates</em></span> : null}
            <span className="lc-cpv__count"><b>{rows.length}</b><em>{rows.length === 1 ? 'market' : 'markets'}</em></span>
          </div>
        ) : null}
        {rec && rec.matches === false ? (
          <p className="lc-cpv__note" role="note">Composer counted {fmt(rec.composer_eligible)} · the preview’s per-target rule gives {fmt(data?.eligible)} ({rec.delta && rec.delta > 0 ? '+' : ''}{fmt(rec.delta)})</p>
        ) : null}

        {listOpen && rows.length && data ? (
          <ol className="lc-cpv__markets" ref={listRef} onKeyDown={onListKey} aria-label="Campaign markets">
            {rows.map((m) => {
              const note = marketNote(m)
              return (
                <li key={m.market}>
                  <button type="button" className={cx('lc-cpv__market', !m.bbox && 'is-unmapped')} data-cp-market={m.market} onClick={() => frameMarket(m.market)} disabled={!m.bbox} title={m.bbox ? `Fly to ${m.market}` : note ?? undefined}>
                    <i aria-hidden="true" />
                    <span className="lc-cpv__mname">{shortMarket(m.market)}{note ? <em>{note}</em> : null}</span>
                    <b className="lc-num">{fmt(m.eligible)}</b>
                  </button>
                </li>
              )
            })}
          </ol>
        ) : null}

        {listOpen && data ? (
          <div className="lc-cpv__controls">
            <LCSegmented size="sm" label="Preview follow" value={effectiveFollow} onChange={(v) => setFollow(v)} options={FOLLOW_OPTIONS.map((o) => ({ value: o.key, label: o.label, title: o.hint }))} />
            <LCSegmented size="sm" label="Preview view" value={mode} onChange={setMode} options={[{ value: 'audience', label: 'Audience' }, { value: 'density', label: 'Density' }]} />
          </div>
        ) : null}

        {effectiveFollow === 'manual' && data ? (
          <div className="lc-cpv__manual" role="status" data-cp-manual>
            <Icon name="compass" size={12} />
            <span>{pinned ? 'Pinned pane · the camera stays put' : manualByGesture ? 'Manual · you moved the map; points still sync' : 'Manual · points sync, the camera stays'}</span>
            {!pinned ? <button type="button" onClick={() => { setFollow('auto'); frameCampaign() }}>Resume</button> : null}
          </div>
        ) : null}

        {listOpen && exParts.length ? <p className="lc-cpv__foot">Not in preview: {exParts.join(' · ')}</p> : null}
        {listOpen && data?.capped_by_build_limit ? <p className="lc-cpv__foot">Counted to the build limit ({fmt(data.build_limit)})</p> : null}
        {mode === 'density' && data ? <p className="lc-cpv__foot">Density of the {fmt(data.mapped)} mapped targets · exact counts above</p> : null}
      </section>

      {menu ? (
        <LCMenu
          open
          onOpenChange={(o) => { if (!o) setMenu(null) }}
          label="Property actions"
          title={menu.ref.label ?? 'Property'}
          align="start"
          items={objectMenuEntries(menu.ref)}
          trigger={<button type="button" className="lc-cpv__anchor" style={{ left: menu.x, top: menu.y }} aria-hidden="true" tabIndex={-1} />}
        />
      ) : null}
    </>
  )
}
