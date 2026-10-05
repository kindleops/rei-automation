/**
 * Context overlays — the instruments: Layers plates, legend entries and the
 * glass preview for what was picked on the map (a camera, a reported
 * incident, an investor-presence area).
 *
 * Camera preview: location, direction, road, last updated and still vs live.
 * One still is fetched when the preview opens and again only when the
 * operator presses Refresh — nothing autoplays or polls. Where the agency
 * publishes official live video (MnDOT streamable, Caltrans), a "Play live"
 * control starts it — click only; it is destroyed and released when the
 * preview closes, the pane hides or the tab goes to the background, and any
 * failure falls back to the still. TxDOT stills are an internal-use
 * pass-through, labelled as such.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../../../shared/icons'
import { callBackend, getBackendAuthHeaders, getBackendBaseUrl } from '../../../../lib/api/backendClient'
import { DeskSeg, Plate } from '../MapDeskLayers'
import type { SensorRow } from '../map-desk-model'
import {
  CRIME_WINDOWS, PRESENCE_COLORS, agoFrom, cameraDetailPath, cameraMediaLabel, crimeWindowWords, daysAgo, directionLabel, fmtDay, fmtLocalTime,
  type CameraDetailReply, type CrimeDays, type PresenceMonths, type PresenceView,
} from './context-model'
import { CRIME_CATS, CRIME_CAT_STYLE, CRIME_TYPES, CRIME_TYPE_LABEL, GLYPH_PATHS, TYPE_CAT, crimeGlyph, type CrimeCat, type CrimeType, type GlyphId } from './context-icons'
import type { ContextPick, MapContextOverlays } from './useMapContextOverlays'
import { startLiveVideo, type LiveSession } from './hls-player'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const fmt = (n: number) => n.toLocaleString('en-US')

/* ── glyph tiles (the same drawings the map uses) ─────────────────────────── */

/** A context glyph tile for panels and the legend — the map's own drawing, in CSS. */
export function CtxGlyph({ id, size = 16, className }: { id: GlyphId; size?: number; className?: string }) {
  const crime = id.startsWith('crime-') ? TYPE_CAT[id.slice(6) as CrimeType] : null
  return (
    <span className={cls('mxd-ctx-glyph', crime ? `is-${crime}` : id === 'cam-video' ? 'is-live' : id === 'cam-link' ? 'is-link' : 'is-cam', className)} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.66)} height={Math.round(size * 0.66)}><path d={GLYPH_PATHS[id]} fillRule="evenodd" /></svg>
    </span>
  )
}

/* ── Layers plates ────────────────────────────────────────────────────────── */

function Credits({ items }: { items: string[] }) {
  if (!items.length) return null
  return <p className="mxd-ctl__note mxd-ctx-credit">{items.join(' · ')}</p>
}

/** The Layers plate for one context row (null for any other row). */
export function ContextPlate({ row, ctx }: { row: SensorRow; ctx: MapContextOverlays }): ReactNode {
  const { prefs, setPrefs } = ctx
  switch (row.id) {
    case 'ctxCameras':
      return (
        <Plate key={row.id} row={row} onToggle={(v) => setPrefs({ cameras: v })}>
          <ul className="mxd-ctx-keyrow" aria-label="Camera marks">
            <li><CtxGlyph id="cam-still" />Still image</li>
            <li><CtxGlyph id="cam-video" />Live video · MN, CA</li>
            <li><CtxGlyph id="cam-link" />Location only</li>
          </ul>
          <p className="mxd-ctl__note">Press a camera for its latest still; live video plays only when you press Play. Groups open on press. Cameras sit under your pins and comps.</p>
          <Credits items={ctx.cameras.status.attributions} />
        </Plate>
      )
    case 'ctxCrime':
      return (
        <Plate key={row.id} row={row} onToggle={(v) => setPrefs({ crime: v })}>
          <CrimeFilters ctx={ctx} />
          <Credits items={ctx.crime.status.attributions} />
        </Plate>
      )
    case 'ctxPresence': {
      const t = ctx.presence.reply?.totals
      return (
        <Plate key={row.id} row={row} onToggle={(v) => setPrefs({ presence: v })}>
          <div className="mxd-ctl is-stack">
            <span className="mxd-ctl__label">Show</span>
            <DeskSeg<PresenceView> size="sm" label="Investor presence view" value={prefs.presenceView} onChange={(v) => setPrefs({ presenceView: v })} options={[{ key: 'composite', label: 'Both' }, { key: 'purchases', label: 'Purchases' }, { key: 'entity', label: 'Entity owners' }]} />
          </div>
          <div className="mxd-ctl is-stack">
            <span className="mxd-ctl__label">Time</span>
            <DeskSeg<`${PresenceMonths}`> size="sm" label="Purchases within" value={`${prefs.presenceMonths}`} onChange={(v) => setPrefs({ presenceMonths: Number(v) as PresenceMonths })} options={[{ key: '12', label: '12 mo' }, { key: '24', label: '24 mo' }]} />
          </div>
          {t ? (
            <dl className="mxd-ctx-split" aria-label="Investor presence in view">
              <div><dt><i style={{ background: PRESENCE_COLORS.purchases }} aria-hidden="true" />Investor purchases</dt><dd>{fmt(t.investor_purchases)}<span> of {fmt(t.sales_in_window)} recorded sales</span></dd></div>
              <div><dt><i className="is-ring" style={{ borderColor: PRESENCE_COLORS.entity }} aria-hidden="true" />Entity-owned now</dt><dd>{fmt(t.entity_owned)}<span> properties</span></dd></div>
            </dl>
          ) : null}
          <p className="mxd-ctl__note">Two separate signals, never added together: a purchase is a sale in the window; entity ownership is who owns it now.</p>
        </Plate>
      )
    }
    default:
      return null
  }
}

/* ── legend ───────────────────────────────────────────────────────────────── */

export function ContextKey({ ctx }: { ctx: MapContextOverlays }) {
  const { prefs } = ctx
  if (!prefs.cameras && !prefs.crime && !prefs.presence) return null
  const types = ctx.crime.reply?.counts?.types
  const shownTypes = types ? CRIME_TYPES.filter((t) => types[t] > 0 && prefs.crimeCats.includes(TYPE_CAT[t])).sort((x, y) => types[y] - types[x]).slice(0, 6) : []
  const quiet = (s: { state: string }) => s.state !== 'on'
  return (
    <div className="mxd-legend__bounds mxd-ctx-key" data-legend="context">
      {prefs.cameras ? (
        <span className={cls('mxd-legend__bound', quiet(ctx.cameras.status) && 'is-quiet')} title={ctx.cameras.status.reason ?? ctx.cameras.status.attributions.join(' · ')}>
          <CtxGlyph id="cam-still" size={14} />Cameras
          <em>{ctx.cameras.status.state === 'on' ? fmt(ctx.cameras.status.count) : ctx.cameras.status.reason ?? 'reading…'}</em>
        </span>
      ) : null}
      {prefs.cameras && ctx.cameras.reply?.cameras.some((c) => c.video) ? (
        <span className="mxd-legend__bound" title="Official agency live video — plays only when you press Play">
          <CtxGlyph id="cam-video" size={14} />Live video<em>{fmt(ctx.cameras.reply.cameras.filter((c) => c.video).length)}</em>
        </span>
      ) : null}
      {prefs.crime ? (
        ctx.crime.status.state === 'on' && shownTypes.length ? (
          shownTypes.map((t) => (
            <span key={t} className="mxd-legend__bound" title={`${CRIME_TYPE_LABEL[t]} · reported, ${crimeWindowWords(prefs.crimeDays)}`}>
              <CtxGlyph id={crimeGlyph(t)} size={14} />{CRIME_TYPE_LABEL[t].split(' /')[0]}<em>{fmt(types?.[t] ?? 0)}</em>
            </span>
          ))
        ) : (
          <span className="mxd-legend__bound is-quiet" title={ctx.crime.status.reason ?? undefined}><CtxGlyph id="crime-other" size={14} />Crime<em>{ctx.crime.status.reason ?? (ctx.crime.status.state === 'on' ? 'none reported in view' : 'reading…')}</em></span>
        )
      ) : null}
      {prefs.presence ? (
        <>
          {prefs.presenceView !== 'entity' ? <span className={cls('mxd-legend__bound', quiet(ctx.presence.status) && 'is-quiet')}><i className="mxd-ctx-swatch is-dot" style={{ background: PRESENCE_COLORS.purchases }} aria-hidden="true" />Investor purchases<em>{ctx.presence.reply?.totals ? fmt(ctx.presence.reply.totals.investor_purchases) : ctx.presence.status.reason ?? 'reading…'}</em></span> : null}
          {prefs.presenceView !== 'purchases' ? <span className={cls('mxd-legend__bound', quiet(ctx.presence.status) && 'is-quiet')}><i className="mxd-ctx-swatch is-ring" style={{ borderColor: PRESENCE_COLORS.entity }} aria-hidden="true" />Entity-owned now<em>{ctx.presence.reply?.totals ? fmt(ctx.presence.reply.totals.entity_owned) : ''}</em></span> : null}
        </>
      ) : null}
      <span className="mxd-legend__bound-src">{[prefs.cameras ? 'DOT feeds' : null, prefs.crime ? `city open data · ${prefs.crimeDays === 'all' ? 'all published' : `${prefs.crimeDays} d`} · no scores` : null, prefs.presence ? `recorded sales · ${prefs.presenceMonths} mo` : null].filter(Boolean).join(' · ')}</span>
    </div>
  )
}

/* ── the preview ──────────────────────────────────────────────────────────── */

function useCameraDetail(id: string) {
  const [state, setState] = useState<{ id: string; detail: CameraDetailReply | null; failed: boolean }>({ id: '', detail: null, failed: false })
  useEffect(() => {
    const ctl = new AbortController()
    void callBackend<CameraDetailReply>(cameraDetailPath(id), { signal: ctl.signal, timeoutMs: 20_000 }).then((res) => {
      if (ctl.signal.aborted) return
      const body = res.ok ? (res.data as CameraDetailReply | undefined) : undefined
      setState({ id, detail: body?.ok ? body : null, failed: !body?.ok })
    })
    return () => ctl.abort()
  }, [id])
  return state.id === id ? state : { id, detail: null, failed: false }
}

/** One still per open and per Refresh press — never a timer. */
function useCameraStill(path: string | null, nonce: number) {
  const [still, setStill] = useState<{ key: string; url: string | null; capturedAt: string | null; failed: boolean; limited?: boolean }>({ key: '', url: null, capturedAt: null, failed: false })
  const key = `${path}|${nonce}`
  useEffect(() => {
    if (!path) return undefined
    const ctl = new AbortController()
    let objectUrl: string | null = null
    void (async () => {
      try {
        // cache: 'no-store' — internal-use pass-through stills (TxDOT) must not sit in the browser cache either.
        const res = await fetch(`${getBackendBaseUrl()}${path}`, { headers: await getBackendAuthHeaders(), signal: ctl.signal, credentials: 'include', cache: 'no-store' })
        if (res.status === 429) { if (!ctl.signal.aborted) setStill({ key, url: null, capturedAt: null, failed: true, limited: true }); return }
        if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) throw new Error('no_still')
        objectUrl = URL.createObjectURL(await res.blob())
        if (!ctl.signal.aborted) setStill({ key, url: objectUrl, capturedAt: res.headers.get('x-camera-captured-at') || null, failed: false })
      } catch {
        if (!ctl.signal.aborted) setStill({ key, url: null, capturedAt: null, failed: true })
      }
    })()
    return () => { ctl.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [path, key])
  return still.key === key ? still : { key, url: null, capturedAt: null, failed: false }
}

/**
 * One live stream, started by the click that mounted it. Stops (and releases
 * the stream) on unmount, when the element leaves the viewport (pane hidden /
 * scrolled away) and when the tab is hidden. Any failure hands back to the still.
 */
function LiveVideo({ url, label, onEnd }: { url: string; label: string; onEnd: (reason: string | null) => void }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const endRef = useRef(onEnd)
  useEffect(() => { endRef.current = onEnd })
  useEffect(() => {
    const video = ref.current
    if (!video) return undefined
    let session: LiveSession | null = null
    let done = false
    const finish = (reason: string | null) => { if (done) return; done = true; session?.stop(); endRef.current(reason) }
    void startLiveVideo(video, url, { onError: (r) => finish(r) }).then((s) => {
      if (done) { s.stop(); return }
      session = s
      setPlaying(true)
    }).catch(() => finish('live_unavailable'))
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => { if (entries.some((e) => !e.isIntersecting)) finish(null) }) : null
    io?.observe(video)
    const onVis = () => { if (document.visibilityState === 'hidden') finish(null) }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      io?.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      done = true
      session?.stop()
    }
  }, [url])
  return (
    <>
      <video ref={ref} className="mxd-ctx-video" muted playsInline controls={playing} preload="none" aria-label={label} />
      {!playing ? <span className="mxd-ctx-still__state is-over">Connecting to the live stream…</span> : null}
    </>
  )
}

function CameraPreview({ id, name, onClose }: { id: string; name: string | null; onClose: () => void }) {
  const { detail, failed } = useCameraDetail(id)
  const [nonce, setNonce] = useState(0)
  // The clock "ago" reads against: when the preview opened, or the last Refresh.
  const [now, setNow] = useState(() => Date.now())
  // Live video: off until the operator presses Play; a failure leaves a note and the still.
  const [live, setLive] = useState<{ on: boolean; note: string | null }>({ on: false, note: null })
  const stillPath = detail?.media?.still?.kind === 'proxy' ? detail.media.still.path ?? null : null
  const still = useCameraStill(stillPath, nonce)
  const cam = detail?.camera
  const media = detail ? cameraMediaLabel(detail) : null
  const stream = detail?.media?.stream && /^https:\/\//.test(detail.media.stream.url) && detail.media.stream.type === 'HLS' ? detail.media.stream : null
  const captured = still.capturedAt ? new Date(still.capturedAt).toISOString() : null
  return (
    <section className="mxd-ctx-card mxd-l3" role="dialog" aria-label={`Traffic camera: ${cam?.name ?? name ?? 'camera'}`} data-map-card="camera">
      <header className="mxd-ctx-card__head">
        <span className="mxd-ctx-card__glyph is-cam" aria-hidden="true"><Icon name="eye" size={14} /></span>
        <div className="mxd-ctx-card__title">
          <h3>{cam?.name ?? name ?? 'Traffic camera'}</h3>
          <p>{detail?.provider?.name ?? 'Camera'}{cam?.road ? ` · ${cam.road}` : ''}{detail?.corridor ? ` · ${detail.corridor.index} of ${detail.corridor.total} on this road` : ''}</p>
        </div>
        <button type="button" className="mxd-icon-btn" aria-label="Close camera" onClick={onClose}><Icon name="close" size={13} /></button>
      </header>
      <div className={cls('mxd-ctx-still', media?.kind === 'link' && 'is-link', live.on && 'is-live')}>
        {live.on && stream ? <LiveVideo url={stream.url} label={`Live video from ${cam?.name ?? 'the camera'}`} onEnd={(reason) => setLive({ on: false, note: reason ? 'Live video unavailable right now — showing the latest still' : null })} /> : null}
        {!live.on && still.url ? <img src={still.url} alt={`Latest still from ${cam?.name ?? 'the camera'}`} /> : null}
        {!live.on && !still.url && media?.kind === 'still' ? <span className="mxd-ctx-still__state">{still.limited ? 'Too many stills opened in the last minute — try Refresh shortly' : still.failed ? 'The agency did not return a picture just now — location, direction and the agency’s page are below' : 'Reading the latest still…'}</span> : null}
        {media?.kind === 'link' ? <span className="mxd-ctx-still__state">{media.label}</span> : null}
        {!detail && !failed ? <span className="mxd-ctx-still__state">Reading camera…</span> : null}
        {failed ? <span className="mxd-ctx-still__state">Camera details unavailable right now</span> : null}
        {live.on ? <em className="mxd-ctx-still__tag is-live">Live</em> : media?.kind === 'still' ? <em className="mxd-ctx-still__tag">{stream ? 'Still · live available' : 'Still'}</em> : media?.kind === 'link' ? <em className="mxd-ctx-still__tag is-link">Location only</em> : null}
        {stream && !live.on ? (
          <button type="button" className="mxd-ctx-play" onClick={() => setLive({ on: true, note: null })} aria-label={`Play live video from ${cam?.name ?? 'this camera'}`}>
            <Icon name="play" size={13} /><span>Play live</span>
          </button>
        ) : null}
      </div>
      {live.note ? <p className="mxd-ctx-internal is-note">{live.note}</p> : null}
      {detail?.provider?.internal_use ? <p className="mxd-ctx-internal" data-camera-use="internal">{detail.provider.attribution}</p> : null}
      {cam ? (
        <dl className="mxd-ctx-facts">
          <div><dt>Direction</dt><dd>{directionLabel(cam.direction)}</dd></div>
          <div><dt>Location</dt><dd>{cam.lat.toFixed(4)}, {cam.lng.toFixed(4)}{cam.mile_marker !== null ? ` · MP ${cam.mile_marker}` : ''}</dd></div>
          <div><dt>Last updated</dt><dd>{captured ? `${agoFrom(captured, now)} · picture time from the agency` : cam.provider_updated_at ? `${agoFrom(cam.provider_updated_at, now)} · agency record` : media?.kind === 'link' ? 'On the agency’s page' : 'Not published'}</dd></div>
          <div><dt>Status</dt><dd>{cam.status === 'LIVE' ? 'Online (agency reports)' : cam.status === 'OFFLINE' ? 'Offline (agency reports)' : 'Not reported by the agency'}</dd></div>
        </dl>
      ) : null}
      <footer className="mxd-ctx-card__foot">
        <span className="mxd-ctx-credit" title={detail?.provider?.attribution}>{detail?.provider?.internal_use ? `Source: ${detail.provider.name.replace(/ ITS$/, '')}` : detail?.provider?.attribution ?? ''}</span>
        <span className="mxd-ctx-card__actions">
          {live.on ? <button type="button" className="mxd-btn is-sm" onClick={() => setLive({ on: false, note: null })}>Stop live</button> : null}
          {media?.kind === 'still' && !live.on ? <button type="button" className="mxd-btn is-sm" onClick={() => { setNonce((n) => n + 1); setNow(Date.now()) }}>Refresh</button> : null}
          {detail?.media?.provider_page_url ? <a className="mxd-btn is-sm" href={detail.media.provider_page_url} target="_blank" rel="noopener noreferrer">Open on {detail.provider?.name ?? 'agency'}</a> : null}
        </span>
      </footer>
    </section>
  )
}

function CrimePreview({ ctx, pick, onClose }: { ctx: MapContextOverlays; pick: Extract<ContextPick, { kind: 'crime' }>; onClose: () => void }) {
  const i = pick.incident
  const src = ctx.crime.reply?.sources.find((s) => s.source_id === i.source_id)
  const fresh = ctx.crime.reply?.per_source?.find((p) => p.source_id === i.source_id)
  // The clock "N days ago" reads against: when the card opened.
  const [now] = useState(() => Date.now())
  const behind = daysAgo(fresh?.latest_on, now)
  const time = fmtLocalTime(i.occurred_at)
  const cat = CRIME_CAT_STYLE[i.cat] ?? CRIME_CAT_STYLE.other
  return (
    <section className="mxd-ctx-card mxd-l3" role="dialog" aria-label={`Reported incident: ${i.category}`} data-map-card="crime">
      <header className="mxd-ctx-card__head">
        <CtxGlyph id={crimeGlyph(i.type)} size={28} className="mxd-ctx-card__tile" />
        <div className="mxd-ctx-card__title"><h3>{i.category}</h3><p>{CRIME_TYPE_LABEL[i.type] ?? 'Other'} · {cat.label}{i.offense && i.offense !== i.category ? ` · ${i.offense}` : ''}</p></div>
        <button type="button" className="mxd-icon-btn" aria-label="Close incident" onClick={onClose}><Icon name="close" size={13} /></button>
      </header>
      <dl className="mxd-ctx-facts">
        <div><dt>Occurred</dt><dd>{fmtDay(i.occurred_on)}{time ? ` · ${time}` : ''}</dd></div>
        <div><dt>Time</dt><dd>{time ? 'City’s own clock' : 'Not published by the city'}</dd></div>
        <div><dt>Location</dt><dd>{src?.location_note ?? 'As published'}</dd></div>
        <div><dt>Source</dt><dd>{src ? `${src.publisher} · ${src.city}` : '—'}</dd></div>
        <div className="is-wide"><dt>Freshness</dt><dd>{fresh?.latest_on ? `City data in this view runs to ${fmtDay(fresh.latest_on)}${behind !== null ? ` (${behind === 0 ? 'today' : `${behind} d ago`})` : ''}` : 'Not reported'}{src?.lag_note ? ` · ${src.lag_note}` : ''}</dd></div>
      </dl>
      <footer className="mxd-ctx-card__foot">
        <span className="mxd-ctx-credit" title={src?.licence}>{src ? `${src.attribution} · ${src.licence}` : ''}</span>
        {src ? <span className="mxd-ctx-card__actions"><a className="mxd-btn is-sm" href={src.dataset_url} target="_blank" rel="noopener noreferrer">Dataset</a></span> : null}
      </footer>
    </section>
  )
}

/**
 * The crime filter panel: time window chips, category toggles with the count
 * IN VIEW for each (counted before the toggle, so a switched-off category
 * still says what it holds), and the glyph per type. Filtering is done by the
 * server on its cached read — a toggle never re-reads a city.
 */
function CrimeFilters({ ctx }: { ctx: MapContextOverlays }) {
  const { prefs, setPrefs } = ctx
  const counts = ctx.crime.reply?.mode === 'incidents' ? ctx.crime.reply.counts : undefined
  const toggle = (c: CrimeCat) => {
    const on = prefs.crimeCats.includes(c)
    if (on && prefs.crimeCats.length === 1) return // at least one category stays on
    setPrefs({ crimeCats: on ? prefs.crimeCats.filter((x) => x !== c) : [...prefs.crimeCats, c] })
  }
  return (
    <>
      <div className="mxd-ctl is-stack">
        <span className="mxd-ctl__label">Time</span>
        <DeskSeg<CrimeDays> size="sm" label="Reported within" value={prefs.crimeDays} onChange={(v) => setPrefs({ crimeDays: v })} options={CRIME_WINDOWS} />
      </div>
      <div className="mxd-ctl is-stack">
        <span className="mxd-ctl__label">Categories{counts ? <em className="mxd-ctx-inview"> · in view</em> : null}</span>
        <div className="mxd-ctx-cats" role="group" aria-label="Crime categories">
          {CRIME_CATS.map((c) => {
            const on = prefs.crimeCats.includes(c)
            const n = counts?.cats[c]
            return (
              <button key={c} type="button" className={cls('mxd-ctx-cat', `is-${c}`, on && 'is-on')} aria-pressed={on} disabled={on && prefs.crimeCats.length === 1} onClick={() => toggle(c)}>
                <i aria-hidden="true" /><span>{CRIME_CAT_STYLE[c].label}</span><em>{typeof n === 'number' ? fmt(n) : '—'}</em>
              </button>
            )
          })}
        </div>
      </div>
      {counts ? (
        <ul className="mxd-ctx-types" aria-label="Reported types in view">
          {CRIME_TYPES.filter((t) => counts.types[t] > 0).sort((a, b) => counts.types[b] - counts.types[a]).map((t) => (
            <li key={t} className={cls(!prefs.crimeCats.includes(TYPE_CAT[t]) && 'is-off')}><CtxGlyph id={crimeGlyph(t)} size={16} /><span>{CRIME_TYPE_LABEL[t]}</span><em>{fmt(counts.types[t])}</em></li>
          ))}
        </ul>
      ) : null}
      <p className="mxd-ctl__note">As the city reports them — not a safety rating. {ctx.crime.reply?.sources.map((s) => s.location_note).filter(Boolean)[0] ?? ''}</p>
      {ctx.crime.reply?.not_covered?.length && ctx.crime.reply.mode !== 'incidents' ? (
        <p className="mxd-ctl__note mxd-ctx-credit">Not covered: {ctx.crime.reply.not_covered.slice(0, 4).map((c) => `${c.city} (${c.reason})`).join(' · ')}</p>
      ) : null}
    </>
  )
}

function PresencePreview({ ctx, pick, onClose }: { ctx: MapContextOverlays; pick: Extract<ContextPick, { kind: 'presence' }>; onClose: () => void }) {
  const c = pick.cell
  const months = ctx.presence.reply?.window_months ?? ctx.prefs.presenceMonths
  const comp = ctx.presence.reply?.components
  return (
    <section className="mxd-ctx-card mxd-l3" role="dialog" aria-label="Investor presence breakdown" data-map-card="presence">
      <header className="mxd-ctx-card__head">
        <span className="mxd-ctx-card__glyph" aria-hidden="true"><i className="mxd-ctx-dot" style={{ background: PRESENCE_COLORS.purchases, boxShadow: `0 0 0 3px ${PRESENCE_COLORS.entity}55` }} /></span>
        <div className="mxd-ctx-card__title"><h3>Investor presence</h3><p>This area · two separate signals</p></div>
        <button type="button" className="mxd-icon-btn" aria-label="Close breakdown" onClick={onClose}><Icon name="close" size={13} /></button>
      </header>
      <dl className="mxd-ctx-split is-card">
        <div>
          <dt><i style={{ background: PRESENCE_COLORS.purchases }} aria-hidden="true" />Investor purchases</dt>
          <dd>{fmt(c.investor_purchases)}<span> of {fmt(c.sales)} recorded sales · last {months} mo</span></dd>
          <p>{comp?.purchases.basis}</p>
        </div>
        <div>
          <dt><i className="is-ring" style={{ borderColor: PRESENCE_COLORS.entity }} aria-hidden="true" />Entity-owned now</dt>
          <dd>{fmt(c.entity_owned)}<span> properties</span></dd>
          <p>{comp?.entity.basis}</p>
        </div>
      </dl>
      <footer className="mxd-ctx-card__foot">
        <span className="mxd-ctx-credit">{ctx.presence.reply?.latest_sale_on ? `Latest recorded sale here ${fmtDay(ctx.presence.reply.latest_sale_on)} · ` : ''}public record + MLS</span>
      </footer>
    </section>
  )
}

export function ContextPreview({ ctx }: { ctx: MapContextOverlays }) {
  const p = ctx.pick
  useEffect(() => {
    if (!p) return undefined
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); ctx.setPick(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p, ctx])
  if (!p) return null
  const close = () => ctx.setPick(null)
  if (p.kind === 'camera') return <CameraPreview key={p.id} id={p.id} name={p.name} onClose={close} />
  if (p.kind === 'crime') return <CrimePreview ctx={ctx} pick={p} onClose={close} />
  return <PresencePreview ctx={ctx} pick={p} onClose={close} />
}
