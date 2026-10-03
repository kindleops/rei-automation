/**
 * Context overlays — the instruments: Layers plates, legend entries and the
 * glass preview for what was picked on the map (a camera, a reported
 * incident, an investor-presence area).
 *
 * Camera preview: location, direction, road, last updated and still vs
 * location-only. One still is fetched when the preview opens and again only
 * when the operator presses Refresh — nothing autoplays or polls. TxDOT
 * cameras are location-only (their imagery is not cleared for reuse) and
 * open on TxDOT's own page.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../../../../shared/icons'
import { callBackend, getBackendAuthHeaders, getBackendBaseUrl } from '../../../../lib/api/backendClient'
import { DeskSeg, Plate } from '../MapDeskLayers'
import type { SensorRow } from '../map-desk-model'
import {
  CRIME_FAMILY, PRESENCE_COLORS, agoFrom, cameraDetailPath, cameraMediaLabel, directionLabel, fmtDay,
  type CameraDetailReply, type CrimeDays, type CrimeFamily, type PresenceMonths, type PresenceView,
} from './context-model'
import type { ContextPick, MapContextOverlays } from './useMapContextOverlays'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const fmt = (n: number) => n.toLocaleString('en-US')

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
          <p className="mxd-ctl__note">Press a camera for its latest still. Solid dot = still image · ring = location only (picture on the agency’s page).</p>
          <Credits items={ctx.cameras.status.attributions} />
        </Plate>
      )
    case 'ctxCrime': {
      const cats = ctx.crime.reply?.categories.slice(0, 6) ?? []
      return (
        <Plate key={row.id} row={row} onToggle={(v) => setPrefs({ crime: v })}>
          <div className="mxd-ctl is-stack">
            <span className="mxd-ctl__label">Time</span>
            <DeskSeg<`${CrimeDays}`> size="sm" label="Reported within" value={`${prefs.crimeDays}`} onChange={(v) => setPrefs({ crimeDays: Number(v) as CrimeDays })} options={[{ key: '7', label: '7 days' }, { key: '30', label: '30 days' }, { key: '90', label: '90 days' }]} />
          </div>
          {cats.length ? (
            <ul className="mxd-ctx-cats" aria-label="Reported categories in view">
              {cats.map((c) => (
                <li key={`${c.family}|${c.category}`}><i style={{ background: CRIME_FAMILY[c.family].color }} aria-hidden="true" /><span>{c.category}</span><em>{fmt(c.count)}</em></li>
              ))}
            </ul>
          ) : null}
          <p className="mxd-ctl__note">As the city reports them — not a safety rating. {ctx.crime.reply?.sources.map((s) => s.location_note).filter(Boolean)[0] ?? ''}</p>
          <Credits items={ctx.crime.status.attributions} />
        </Plate>
      )
    }
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
  const fams = new Map<CrimeFamily, number>()
  for (const c of ctx.crime.reply?.categories ?? []) fams.set(c.family, (fams.get(c.family) ?? 0) + c.count)
  const quiet = (s: { state: string }) => s.state !== 'on'
  return (
    <div className="mxd-legend__bounds mxd-ctx-key" data-legend="context">
      {prefs.cameras ? (
        <span className={cls('mxd-legend__bound', quiet(ctx.cameras.status) && 'is-quiet')} title={ctx.cameras.status.reason ?? ctx.cameras.status.attributions.join(' · ')}>
          <i className="mxd-ctx-swatch is-cam" aria-hidden="true" />Cameras
          <em>{ctx.cameras.status.state === 'on' ? fmt(ctx.cameras.status.count) : ctx.cameras.status.reason ?? 'reading…'}</em>
        </span>
      ) : null}
      {prefs.crime ? (
        ctx.crime.status.state === 'on' && fams.size ? (
          [...fams.entries()].map(([f, n]) => (
            <span key={f} className="mxd-legend__bound" title={`${CRIME_FAMILY[f].label} · reported, last ${prefs.crimeDays} days`}>
              <i className="mxd-ctx-swatch is-dot" style={{ background: CRIME_FAMILY[f].color }} aria-hidden="true" />{CRIME_FAMILY[f].label.split(' (')[0]}<em>{fmt(n)}</em>
            </span>
          ))
        ) : (
          <span className="mxd-legend__bound is-quiet" title={ctx.crime.status.reason ?? undefined}><i className="mxd-ctx-swatch is-dot" aria-hidden="true" />Crime<em>{ctx.crime.status.reason ?? 'reading…'}</em></span>
        )
      ) : null}
      {prefs.presence ? (
        <>
          {prefs.presenceView !== 'entity' ? <span className={cls('mxd-legend__bound', quiet(ctx.presence.status) && 'is-quiet')}><i className="mxd-ctx-swatch is-dot" style={{ background: PRESENCE_COLORS.purchases }} aria-hidden="true" />Investor purchases<em>{ctx.presence.reply?.totals ? fmt(ctx.presence.reply.totals.investor_purchases) : ctx.presence.status.reason ?? 'reading…'}</em></span> : null}
          {prefs.presenceView !== 'purchases' ? <span className={cls('mxd-legend__bound', quiet(ctx.presence.status) && 'is-quiet')}><i className="mxd-ctx-swatch is-ring" style={{ borderColor: PRESENCE_COLORS.entity }} aria-hidden="true" />Entity-owned now<em>{ctx.presence.reply?.totals ? fmt(ctx.presence.reply.totals.entity_owned) : ''}</em></span> : null}
        </>
      ) : null}
      <span className="mxd-legend__bound-src">{[prefs.cameras ? 'DOT feeds' : null, prefs.crime ? `city open data · ${prefs.crimeDays} d · no scores` : null, prefs.presence ? `recorded sales · ${prefs.presenceMonths} mo` : null].filter(Boolean).join(' · ')}</span>
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
  const [still, setStill] = useState<{ key: string; url: string | null; capturedAt: string | null; failed: boolean }>({ key: '', url: null, capturedAt: null, failed: false })
  const key = `${path}|${nonce}`
  useEffect(() => {
    if (!path) return undefined
    const ctl = new AbortController()
    let objectUrl: string | null = null
    void (async () => {
      try {
        const res = await fetch(`${getBackendBaseUrl()}${path}`, { headers: await getBackendAuthHeaders(), signal: ctl.signal, credentials: 'include' })
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

function CameraPreview({ id, name, onClose }: { id: string; name: string | null; onClose: () => void }) {
  const { detail, failed } = useCameraDetail(id)
  const [nonce, setNonce] = useState(0)
  // The clock "ago" reads against: when the preview opened, or the last Refresh.
  const [now, setNow] = useState(() => Date.now())
  const stillPath = detail?.media?.still?.kind === 'proxy' ? detail.media.still.path ?? null : null
  const still = useCameraStill(stillPath, nonce)
  const cam = detail?.camera
  const media = detail ? cameraMediaLabel(detail) : null
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
      <div className={cls('mxd-ctx-still', media?.kind === 'link' && 'is-link')}>
        {still.url ? <img src={still.url} alt={`Latest still from ${cam?.name ?? 'the camera'}`} /> : null}
        {!still.url && media?.kind === 'still' ? <span className="mxd-ctx-still__state">{still.failed ? 'The agency did not return a picture just now' : 'Reading the latest still…'}</span> : null}
        {media?.kind === 'link' ? <span className="mxd-ctx-still__state">{media.label}</span> : null}
        {!detail && !failed ? <span className="mxd-ctx-still__state">Reading camera…</span> : null}
        {failed ? <span className="mxd-ctx-still__state">Camera details unavailable right now</span> : null}
        {media?.kind === 'still' ? <em className="mxd-ctx-still__tag">Still</em> : media?.kind === 'link' ? <em className="mxd-ctx-still__tag is-link">Location only</em> : null}
      </div>
      {cam ? (
        <dl className="mxd-ctx-facts">
          <div><dt>Direction</dt><dd>{directionLabel(cam.direction)}</dd></div>
          <div><dt>Location</dt><dd>{cam.lat.toFixed(4)}, {cam.lng.toFixed(4)}{cam.mile_marker !== null ? ` · MP ${cam.mile_marker}` : ''}</dd></div>
          <div><dt>Last updated</dt><dd>{captured ? `${agoFrom(captured, now)} · picture time from the agency` : cam.provider_updated_at ? `${agoFrom(cam.provider_updated_at, now)} · agency record` : media?.kind === 'link' ? 'On the agency’s page' : 'Not published'}</dd></div>
          <div><dt>Status</dt><dd>{cam.status === 'LIVE' ? 'Online (agency reports)' : cam.status === 'OFFLINE' ? 'Offline (agency reports)' : 'Not reported by the agency'}</dd></div>
        </dl>
      ) : null}
      <footer className="mxd-ctx-card__foot">
        <span className="mxd-ctx-credit" title={detail?.provider?.attribution}>{detail?.provider?.attribution ?? ''}</span>
        <span className="mxd-ctx-card__actions">
          {media?.kind === 'still' ? <button type="button" className="mxd-btn is-sm" onClick={() => { setNonce((n) => n + 1); setNow(Date.now()) }}>Refresh</button> : null}
          {detail?.media?.provider_page_url ? <a className="mxd-btn is-sm" href={detail.media.provider_page_url} target="_blank" rel="noopener noreferrer">Open on {detail.provider?.name ?? 'agency'}</a> : null}
        </span>
      </footer>
    </section>
  )
}

function CrimePreview({ ctx, pick, onClose }: { ctx: MapContextOverlays; pick: Extract<ContextPick, { kind: 'crime' }>; onClose: () => void }) {
  const i = pick.incident
  const src = ctx.crime.reply?.sources.find((s) => s.source_id === i.source_id)
  const fam = CRIME_FAMILY[i.family]
  return (
    <section className="mxd-ctx-card mxd-l3" role="dialog" aria-label={`Reported incident: ${i.category}`} data-map-card="crime">
      <header className="mxd-ctx-card__head">
        <span className="mxd-ctx-card__glyph" style={{ color: fam.color }} aria-hidden="true"><i className="mxd-ctx-dot" style={{ background: fam.color }} /></span>
        <div className="mxd-ctx-card__title"><h3>{i.category}</h3><p>{i.offense && i.offense !== i.category ? i.offense : fam.label}</p></div>
        <button type="button" className="mxd-icon-btn" aria-label="Close incident" onClick={onClose}><Icon name="close" size={13} /></button>
      </header>
      <dl className="mxd-ctx-facts">
        <div><dt>Occurred</dt><dd>{fmtDay(i.occurred_on)}</dd></div>
        <div><dt>Family</dt><dd>{fam.label}</dd></div>
        <div><dt>Source</dt><dd>{src ? `${src.publisher} · ${src.city}` : '—'}</dd></div>
        <div><dt>Location</dt><dd>{src?.location_note ?? 'As published'}</dd></div>
      </dl>
      <footer className="mxd-ctx-card__foot">
        <span className="mxd-ctx-credit" title={src?.licence}>{src ? `${src.attribution} · ${src.licence}` : ''}</span>
        {src ? <span className="mxd-ctx-card__actions"><a className="mxd-btn is-sm" href={src.dataset_url} target="_blank" rel="noopener noreferrer">Dataset</a></span> : null}
      </footer>
    </section>
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
