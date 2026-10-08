/**
 * The paired Command Wall: map hero + one glass rail + status + compact feed +
 * a top-right capsule + the preset's side panel (§11–§23, §45–§50, §67–§71).
 * Every value comes from the ONE channel; nothing here fetches on its own
 * except the map's cached context layers.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { WallChannel } from './wall-channel'
import { capsuleEvent, feedRows, marketActivity, pulseCandidates, pulseFunnel, placeLabel, visualTone, eventSeries, recentTotal, DISCOVERY_KINDS } from './wall-feed-model'
import { WallGlyph, RollNumber, Sparkline } from './WallUi'
import { effectiveLayers, presetFor, type WallPreset } from './wall-presets'
import { railCells, fmtInt, fmtUsdK, fmtPct, resolutionClass } from './wall-format'
import { surfaceDrift, railShift, mapDrift, dimLevel, feedSide } from './wall-oled'
import { idleMs } from './wall-feed-model'
import { WallMap, type WallMapTarget } from './map/WallMap'
import { WallAtlas, type AtlasMarket } from './map/WallAtlas'
import { activityFeatures, activityMarkets, boundsFor, footprintMarkets, marketGlowFeatures, miZipFeatures } from './map/wall-map-model'
import type { WallDisplayConfig, WallEvent, WallMarket, WallRenderMode, WallState } from './wall-types'

export interface WallStageProps {
  channel: WallChannel
  config: WallDisplayConfig
  presetId: WallDisplayConfig['preset']
  focusMarket: string | null
  renderMode: WallRenderMode
  reducedMotion: boolean
  now: number
  showFeed: boolean
  updating: boolean
  onMapFail: (reason: string) => void
  fetchLayer: (kind: 'cameras' | 'crime' | 'presence', bbox: string, zoom: number) => Promise<unknown>
  rotationLabel: string | null
}

const PRESET_TITLE: Record<string, string> = {
  national_command: 'National Command', acquisition_pulse: 'Acquisition Pulse', campaign_operations: 'Campaign Operations',
  market_intelligence: 'Market Intelligence', spatial_intelligence: 'Spatial Intelligence', custom: 'Command Wall',
}

function useChannel(channel: WallChannel) {
  return useSyncExternalStore(channel.subscribe, channel.getSnapshot, channel.getSnapshot)
}

function timeOfDay(now: number) {
  try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(now)) } catch { return '' }
}

function focusMarketFor(state: WallState | null, extra: WallMarket[], config: WallDisplayConfig, explicit: string | null, activityTop: string | null): WallMarket | null {
  // markets the server located + markets seen in live activity + MI markets (centroid of their ZIPs)
  const mi: WallMarket[] = (state?.mi?.markets || []).flatMap((m) => {
    const z = (m.top_zips || []).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng))
    if (!z.length) return []
    return [{ id: m.id, name: m.label || m.id, state: null, lat: z.reduce((a, x) => a + (x.lat as number), 0) / z.length, lng: z.reduce((a, x) => a + (x.lng as number), 0) / z.length }]
  })
  const markets = [...(state?.markets || []), ...extra, ...mi]
  const pick = (id: string | null | undefined) => (id ? markets.find((m) => m.id === id && Number.isFinite(m.lat)) || null : null)
  return pick(explicit) || pick(config.watched_markets[0]) || pick(activityTop) || pick(state?.campaigns.find((c) => c.status === 'active')?.market_id) || null
}

export function WallStage(props: WallStageProps) {
  const { channel, config, now } = props
  const snap = useChannel(channel)
  const preset = presetFor(props.presetId)
  const layers = effectiveLayers(preset, config.layers)
  const state = snap.state
  const res = typeof window === 'undefined' ? 'hd' : resolutionClass(window.innerHeight, window.devicePixelRatio || 1)
  const rows = res === 'uhd' ? 12 : res === 'qhd' ? 9 : 7

  const activity = useMemo(() => marketActivity(snap.events, now), [snap.events, now])
  const liveMarkets = useMemo(() => activityMarkets(snap.events.byId.values()), [snap.events])
  const busiest = useMemo(() => [...activity.values()].sort((a, b) => b.sends + b.replies * 20 - (a.sends + a.replies * 20))[0]?.marketId ?? null, [activity])
  const focus = focusMarketFor(state, liveMarkets, config, props.focusMarket, busiest)

  const footprint = useMemo(() => footprintMarkets(state?.markets || [], state?.campaigns || [], config.watched_markets, liveMarkets), [state?.markets, state?.campaigns, config.watched_markets, liveMarkets])
  const target: WallMapTarget = useMemo(() => {
    if (config.map_view && preset.id === 'custom') return { kind: 'center', ...config.map_view, key: `view:${config.map_view.lng},${config.map_view.lat},${config.map_view.zoom}` }
    // a 4K panel at DPR 1 shows twice the ground at the same zoom: frame the same area (+1 zoom)
    const zoom = preset.focusZoom + (res === 'uhd' ? 1 : res === 'qhd' ? 0.4 : 0)
    if (preset.framing === 'focus_market' && focus && Number.isFinite(focus.lat)) return { kind: 'center', lng: focus.lng as number, lat: focus.lat as number, zoom, key: `focus:${focus.id}:${zoom}` }
    const b = boundsFor(footprint)
    return { kind: 'bounds', bounds: b, key: `fp:${preset.id}:${footprint.map((m) => m.id).sort().join(',')}` }
  }, [config.map_view, preset.id, preset.framing, preset.focusZoom, focus, footprint, res])

  const glow = useMemo(() => marketGlowFeatures(footprint, state?.campaigns || [], activity), [footprint, state?.campaigns, activity])
  const actFc = useMemo(() => activityFeatures(snap.events.byId.values(), now), [snap.events, now])
  const miFc = useMemo(() => miZipFeatures(state?.mi?.markets || []), [state?.mi])
  const pulseFilter = useCallback((evs: WallEvent[]) => pulseCandidates(evs, Date.now()), [])
  const subscribeArrivals = useCallback((fn: (evs: WallEvent[]) => void) => channel.onArrivals(fn), [channel])

  const cells = railCells(state, preset.rail, now)
  const capsule = capsuleEvent(snap.events, now)
  const topSignal = (state?.signals || []).find((s) => s.severity === 'critical') || null
  const feed = feedRows(snap.events, { limit: rows + 1 })
  const level = config.oled_protection
  const drift = surfaceDrift(now, level)
  const rail = railShift(now, level)
  const mdrift = mapDrift(now, level)
  const dim = dimLevel({ idleMs: idleMs(snap.events, now), hour: new Date(now).getHours(), level, overnight: config.overnight_low_light })
  const side = feedSide(now, level)
  const feedOn = props.showFeed && preset.feed
  const panelOn = preset.panel !== 'none'
  const padding = useMemo(() => {
    const vw = typeof window === 'undefined' ? 1920 : window.innerWidth
    const vh = typeof window === 'undefined' ? 1080 : window.innerHeight
    const sideW = Math.round(vw * 0.25)
    return { top: Math.round(vh * 0.16), bottom: Math.round(vh * 0.2), left: Math.round(vw * 0.06) + (panelOn && side === 'right' ? sideW : 0) + (feedOn && side === 'left' ? sideW : 0), right: Math.round(vw * 0.06) + (feedOn && side === 'right' ? sideW : 0) + (panelOn && side === 'left' ? sideW : 0) }
  }, [panelOn, feedOn, side])

  const sys = state?.system
  const connection = snap.connection
  const sysLabel = !sys ? 'Connecting…' : sys.level === 'healthy' ? 'Healthy' : sys.level === 'attention' ? 'Attention' : sys.level === 'degraded' ? 'Degraded' : 'Critical'
  const activeCampaigns = (state?.campaigns || []).filter((c) => c.status === 'active').length
  const rich = props.renderMode !== 'safe'
  const roll = props.renderMode === 'full' && !props.reducedMotion
  const extras = useMemo(() => railExtras(snap.events, state, now), [snap.events, state, now])

  const atlasMarkets: AtlasMarket[] = useMemo(() => glow.features.map((f) => ({ id: String(f.properties?.id), name: String(f.properties?.name), lng: (f.geometry as GeoJSON.Point).coordinates[0], lat: (f.geometry as GeoJSON.Point).coordinates[1], active: f.properties?.active === 1, energy: Number(f.properties?.energy) || 0, discoveries: Number(f.properties?.discoveries) || 0 })), [glow])
  const capTone = topSignal ? 'red' : capsule ? visualTone(capsule.kind, capsule.tone) : 'cobalt'

  return (
    <div className="cw-stage" data-cw-res={res} data-cw-preset={preset.id} data-cw-side={side} data-cw-render={props.renderMode} style={{ ['--cw-dim' as string]: String(dim) }}>
      <div className="cw-stage__map" style={{ transform: `translate3d(${mdrift.x}px, ${mdrift.y}px, 0)` }}>
        {props.renderMode === 'safe'
          ? <WallAtlas markets={atlasMarkets} subscribeArrivals={subscribeArrivals} pulseFilter={pulseFilter} />
          : <WallMap mode={props.renderMode} theme={config.theme} layers={layers} target={target} padding={padding} glow={glow} activity={actFc} miZips={miFc} reducedMotion={props.reducedMotion} subscribeArrivals={subscribeArrivals} pulseFilter={pulseFilter} fetchLayer={props.fetchLayer} onFail={props.onMapFail} />}
        <div className="cw-stage__atmos" />
        <div className="cw-stage__vignette" />
      </div>

      <div className="cw-safe" style={{ transform: `translate3d(${drift.x}px, ${drift.y}px, 0)` }}>
        <header className="cw-head">
          <div className="cw-head__brand">
            <img className="cw-head__mark" src="/favicon.svg" alt="" />
            <div className="cw-head__text">
              <div className="cw-head__eyebrow">LeadCommand <i /> Command Wall</div>
              <div className="cw-head__title">{PRESET_TITLE[preset.id]}{focus && preset.framing === 'focus_market' ? <><span className="cw-head__sep" /><span className="cw-head__focus">{focus.name.replace(/,\s*[A-Z]{2}$/, '')}</span></> : null}</div>
              <div className="cw-head__sys" data-level={sys?.level ?? 'unknown'}>
                <span className="cw-dot" data-level={sys?.level ?? 'unknown'} />
                <span className="cw-head__sys-k">System</span><span className="cw-head__sys-v">{sysLabel}</span>
                {(sys?.parts || []).filter((p) => p.key !== 'feed').map((p) => <span key={p.key} className="cw-head__part" data-level={p.level}>{p.label}</span>)}
                {state && state.campaigns_status !== 'unavailable' ? <span className="cw-head__part">{activeCampaigns} campaign{activeCampaigns === 1 ? '' : 's'} active</span> : null}
              </div>
            </div>
          </div>
          <div className="cw-head__clock">
            <span className="cw-head__time">{timeOfDay(now)}</span>
            <span className="cw-head__meta">
              <span className="cw-head__date">{dateLine(now)}</span>
              <span className="cw-head__live" data-conn={connection}><i />{connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting…' : connection === 'offline' ? 'Offline' : 'Reconnecting…'}</span>
            </span>
            {props.rotationLabel ? <span className="cw-head__rot">{props.rotationLabel}</span> : null}
          </div>
        </header>

        {capsule || topSignal ? (
          <div className="cw-capsule" data-tone={capTone} role="status">
            <span className="cw-capsule__g"><WallGlyph kind={topSignal ? 'signal' : (capsule as WallEvent).kind} /></span>
            <span className="cw-capsule__k">{topSignal ? 'Signal' : capsule?.kind === 'interest' ? 'Interested' : capsule?.label}</span>
            <span className="cw-capsule__v">{topSignal ? topSignal.label : placeLabel(capsule as WallEvent) || '—'}</span>
          </div>
        ) : null}

        {connection === 'reconnecting' || connection === 'offline' ? (
          <div className="cw-conn" role="status">{connection === 'offline' ? 'Offline · Reconnecting…' : 'Connection lost · Reconnecting…'}{snap.lastOkAt ? <span className="cw-conn__age"> · last update {timeOfDay(snap.lastOkAt)}</span> : null}</div>
        ) : null}

        {panelOn ? <aside className="cw-panel" data-side={side === 'right' ? 'left' : 'right'}><PresetPanel preset={preset} state={state} snapEvents={snap.events} now={now} rows={rows} focusId={focus?.id ?? null} /></aside> : null}

        {feedOn ? (
          <aside className="cw-feed" data-side={side} aria-label="Live activity">
            <div className="cw-feed__k"><span className="cw-k"><WallGlyph kind="campaign" className="cw-k__g" />Live activity</span>{extras.discoveries30 ? <span className="cw-feed__disc">{extras.discoveries30} discover{extras.discoveries30 === 1 ? 'y' : 'ies'} · 30 min</span> : null}</div>
            <div className="cw-feed__list">
              {feed.length ? feed.map((r) => {
                const vt = visualTone(r.kind, r.tone)
                return (
                  <div key={r.id} className="cw-feed__row" data-p={r.priority} data-vt={vt}>
                    <span className="cw-feed__g"><WallGlyph kind={r.kind} /></span>
                    <span className="cw-feed__title">{r.title}</span>
                    <span className="cw-feed__t">{r.time}</span>
                    <span className="cw-feed__main">{r.place ? <span>{r.place}</span> : null}{r.detail ? <span className="cw-feed__d">{r.place ? ' · ' : ''}{r.detail}</span> : null}</span>
                  </div>
                )
              }) : <div className="cw-feed__quiet">{snap.lastEventsAt ? 'Quiet — no activity in the live window' : 'Connecting…'}</div>}
            </div>
          </aside>
        ) : null}

        <footer className="cw-rail" style={{ transform: `translate3d(${rail}px, 0, 0)` }}>
          {cells.map((c) => {
            const x = extras.cells[c.key]
            const gold = (c.key === 'positive' || c.key === 'offers') && c.state !== 'unavailable' && /^[1-9]/.test(c.value)
            return (
              <div key={c.key} className="cw-rail__cell" data-key={c.key} data-state={c.state} data-tone={c.tone ?? (gold ? 'gold' : undefined)}>
                <span className="cw-rail__k">{c.label}{x?.spark && rich && c.state !== 'unavailable' ? <span className="cw-rail__win">{x.window}</span> : null}</span>
                <span className={c.key === 'queue' && c.state !== 'unavailable' ? 'cw-rail__line cw-rail__line--pill' : 'cw-rail__line'}>
                  {c.key === 'queue' && c.state !== 'unavailable' ? <i className="cw-rail__qdot" /> : null}
                  <RollNumber className="cw-rail__v" value={c.value} animate={roll} />
                  {x?.spark && rich && c.state !== 'unavailable' ? <Sparkline className="cw-rail__spark" values={x.spark} tone={gold ? 'gold' : 'cobalt'} /> : null}
                </span>
                {c.note ? <span className="cw-rail__n">{c.note}</span>
                  : x?.bar !== undefined ? <span className="cw-rail__bar"><i style={{ width: `${Math.round(x.bar * 100)}%` }} /></span>
                  : x?.sub ? <span className="cw-rail__n cw-rail__n--sub" data-up={x.up ? 'true' : undefined}>{x.sub}</span> : null}
              </div>
            )
          })}
        </footer>
        {props.renderMode !== 'safe' ? <div className="cw-attrib">© OpenStreetMap · © CARTO</div> : null}
      </div>
      {props.updating ? <div className="cw-updating" role="status"><img src="/favicon.svg" alt="" /> Updating Command Wall…</div> : null}
    </div>
  )
}

function dateLine(now: number) {
  try { return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(now)) } catch { return '' }
}

type RailExtra = { spark?: (number | null)[]; window?: string; sub?: string; up?: boolean; bar?: number }

/** Rail enrichments — every one from the channel: event-stream series/deltas, fleet and queue facts. */
function railExtras(events: ReturnType<WallChannel['getSnapshot']>['events'], state: WallState | null, now: number): { cells: Record<string, RailExtra>; discoveries30: number } {
  const cells: Record<string, RailExtra> = {}
  const win = (from: number | null) => {
    if (from === null) return ''
    const mins = Math.round((now - from) / 60_000)
    return mins >= 115 ? '2 h' : mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} m` : `${Math.max(1, mins)} m`
  }
  const sends = eventSeries(events, now, { kinds: ['sends'], weight: 'count' })
  const replies = eventSeries(events, now, { kinds: ['reply', 'interest'], weight: 'events' })
  const d = (n: number | null) => (n === null ? undefined : n > 0 ? `+${fmtInt(n)} · 30 min` : '0 · 30 min')
  const s30 = recentTotal(events, now, ['sends'])
  const r30 = recentTotal(events, now, ['reply', 'interest'], undefined, 'events')
  const p30 = recentTotal(events, now, ['interest'], undefined, 'events')
  const disc30 = recentTotal(events, now, [...DISCOVERY_KINDS], undefined, 'events') ?? 0
  cells.sent = { spark: sends.total > 0 ? sends.values : undefined, window: win(sends.coveredFrom), sub: d(s30), up: (s30 ?? 0) > 0 }
  cells.replies = { spark: replies.total > 0 ? replies.values : undefined, window: win(replies.coveredFrom), sub: d(r30), up: (r30 ?? 0) > 0 }
  cells.positive = { sub: d(p30), up: (p30 ?? 0) > 0 }
  const q = state?.queue
  if (q && q.status !== 'unavailable') cells.queue = { sub: `${fmtInt(q.waiting)} waiting` }
  const f = state?.fleet
  if (f && f.status !== 'unavailable' && f.total > 0) cells.senders = { bar: Math.max(0, Math.min(1, f.online / f.total)) }
  if (state && state.campaigns_status !== 'unavailable') cells.campaigns = { sub: `of ${fmtInt(state.campaigns.length)} total` }
  return { cells, discoveries30: disc30 }
}

function PresetPanel({ preset, state, snapEvents, now, rows, focusId }: { preset: WallPreset; state: WallState | null; snapEvents: ReturnType<WallChannel['getSnapshot']>['events']; now: number; rows: number; focusId: string | null }) {
  if (preset.panel === 'funnel') {
    const f = pulseFunnel(snapEvents, now)
    let oldest = now
    for (const ev of snapEvents.byId.values()) oldest = Math.min(oldest, Date.parse(ev.occurred_at))
    const since = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(Math.max(oldest, now - 6 * 3600_000)))
    const steps: [string, number, WallEvent['kind']][] = [['Replies', f.replies, 'reply'], ['Interested', f.interested, 'interest'], ['Asking price', f.asking, 'asking_price'], ['Offers', f.offers, 'offer'], ['Deals opened', f.deals, 'deal']]
    const max = Math.max(1, ...steps.map((s) => s[1]))
    return (
      <div className="cw-funnel">
        <div className="cw-panel__k"><span className="cw-k"><WallGlyph kind="stage" className="cw-k__g" />Acquisition pulse</span><span className="cw-panel__sub">since {since}</span></div>
        {steps.map(([k, v, kind]) => (
          <div key={k} className="cw-funnel__row" data-vt={visualTone(kind, 'cyan')} data-zero={v === 0 ? 'true' : undefined}>
            <span className="cw-funnel__label"><WallGlyph kind={kind} className="cw-funnel__g" />{k}</span>
            <span className="cw-funnel__v">{fmtInt(v)}</span>
            <span className="cw-funnel__bar"><i style={{ width: `${(v / max) * 100}%` }} /></span>
          </div>
        ))}
      </div>
    )
  }
  if (preset.panel === 'campaigns') {
    const list = (state?.campaigns || []).slice().sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1)).slice(0, Math.max(4, rows - 2))
    return (
      <div className="cw-camps">
        <div className="cw-panel__k"><span className="cw-k"><WallGlyph kind="campaign" className="cw-k__g" />Campaigns</span><span className="cw-panel__sub">{state?.campaigns_status === 'unavailable' ? 'Unavailable' : `${list.filter((c) => c.status === 'active').length} active`}</span></div>
        {list.map((c) => (
          <div key={c.id} className="cw-camps__row" data-status={c.status}>
            <div className="cw-camps__top">
              <span className="cw-camps__name">{c.name || (c.market_name || 'Campaign').replace(/,\s*[A-Z]{2}$/, '')}</span>
              <span className="cw-camps__st">{c.status}</span>
            </div>
            <div className="cw-camps__bar"><i style={{ width: `${Math.min(100, c.progress_pct ?? 0)}%` }} /></div>
            <div className="cw-camps__facts">
              {Number.isFinite(c.sent) ? <span><b>{fmtInt(c.sent)}</b> sent</span> : null}
              {Number.isFinite(c.queued) ? <span><b>{fmtInt(c.queued)}</b> remaining</span> : null}
              {Number.isFinite(c.replied) ? <span><b>{fmtInt(c.replied)}</b> replies</span> : null}
              {Number.isFinite(c.progress_pct) ? <span className="cw-camps__pct">{Math.round(c.progress_pct as number)}%</span> : null}
            </div>
          </div>
        ))}
        {!list.length ? <div className="cw-panel__quiet">No live campaigns</div> : null}
      </div>
    )
  }
  if (preset.panel === 'mi_zips') {
    const mi = state?.mi
    const m = mi?.markets?.find((x) => x.id === focusId) || mi?.markets?.find((x) => x.status === 'ok') || null
    if (!mi || mi.status !== 'ok' || !m || m.status !== 'ok') return <div className="cw-mi"><div className="cw-panel__k"><span className="cw-k">Market intelligence</span></div><div className="cw-panel__quiet">{mi?.reason === 'summary_missing' ? 'Market summary is being built' : 'Market intelligence unavailable'}</div></div>
    const zips = (m.top_zips || []).slice(0, Math.max(5, rows - 1))
    const maxSales = Math.max(1, ...zips.map((z) => (Number.isFinite(z.sales) ? (z.sales as number) : 0)))
    return (
      <div className="cw-mi">
        <div className="cw-panel__k"><span className="cw-k">{(m.label || m.id).replace(/,\s*[A-Z]{2}$/, '')} · top ZIPs</span><span className="cw-panel__sub">{m.window?.label || 'last 12 months'}</span></div>
        <div className="cw-mi__head"><span>ZIP</span><span>Sales</span><span>Median</span><span>$/sf</span><span>Investor¹</span></div>
        {zips.map((z, i) => (
          <div key={z.id} className="cw-mi__row" style={{ ['--cw-share' as string]: String(Number.isFinite(z.sales) ? (z.sales as number) / maxSales : 0) }}>
            <span className="cw-mi__zip"><i>{String(i + 1).padStart(2, '0')}</i>{z.zip}</span>
            <span>{fmtInt(z.sales)}</span>
            <span>{fmtUsdK(z.median_price)}</span><span>{Number.isFinite(z.median_ppsf) ? `$${Math.round(z.median_ppsf as number)}` : '—'}</span>
            <span className={z.investor_recorded_share === null ? 'is-na' : ''}>{z.investor_recorded_share === null ? '—' : fmtPct(z.investor_recorded_share)}</span>
          </div>
        ))}
        <div className="cw-mi__foot">¹ Recorded investor buyers, share of sales with a known buyer{mi.inferred_available ? ' · inferred (owner-based) shown separately' : ' · inferred investor evidence not available'}</div>
      </div>
    )
  }
  if (preset.panel === 'spatial_legend') {
    return (
      <div className="cw-legend">
        <div className="cw-panel__k"><span className="cw-k">Spatial intelligence</span></div>
        <div className="cw-legend__row"><i className="cw-legend__sw cw-legend__sw--cam" />Public roadway cameras</div>
        <div className="cw-legend__row"><i className="cw-legend__sw cw-legend__sw--crime" />Reported incidents · 30 days</div>
        <div className="cw-legend__row"><i className="cw-legend__sw cw-legend__sw--buy" />Investor purchases (recorded)</div>
        <div className="cw-legend__row"><i className="cw-legend__sw cw-legend__sw--ent" />Entity-owned (current owner)</div>
        <div className="cw-legend__row"><i className="cw-legend__sw cw-legend__sw--act" />Seller activity · last 6 h</div>
        <div className="cw-panel__quiet">Crime and investor layers appear at city zoom.</div>
      </div>
    )
  }
  return null
}
