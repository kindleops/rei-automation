/**
 * BUYER INSPECTOR — one buyer entity, read as intelligence rather than a contact card.
 *
 * Who they are (identity + evidence), what they do (activity, price, hold vs
 * flip, asset mix), where they buy, what they own here, who they are connected
 * to — and what the operator can do next (Map, Buyer Match, save a segment).
 *
 * Buyers are observational intelligence (W8C read model). There is no verified
 * buyer contact data in this layer, so there are no outbound actions here.
 * Natural-person buyers are never named: the server withholds the name and the
 * sheet says so rather than guessing.
 *
 * Portalled to <body> with its own drag-to-snap chrome — the shared sheets
 * either do not portal or render their handle as a <button>, which the global
 * 44px tap floor inflates into a grey disc.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../../shared/icons'
import { CountUp } from '../../../shared/motion/CountUp'
import {
  ARCHETYPE_LABEL,
  ASSET_FAMILY_LABEL,
  EVIDENCE_LABEL,
  HOLD_FLIP_LABEL,
  fetchBuyerProfile,
  type BuyerProfile,
  type BuyerTransaction,
  type EvidenceTier,
  type Share,
} from '../../../domain/entity-graph/entity-graph-intel-api'
import './buyer-inspector.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export type BuyerMapPoint = { propertyId?: string; lat: number; lng: number; address?: string }

export type BuyerInspectorProps = {
  buyerId: string | null
  open: boolean
  onClose: () => void
  onOpenProperty: (propertyId: string) => void
  onOpenBuyer: (buyerId: string) => void
  onShowOnMap: (points: BuyerMapPoint[]) => void
  onOpenBuyerMatch: (propertyId?: string) => void
  onSaveSegment?: (profile: BuyerProfile) => void
  /** Deep link (`?section=owned`): open this section and bring it into view once the profile loads. */
  focusSection?: string | null
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

const fmtInt = (n: number) => Math.round(n).toLocaleString()
function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `$${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}
const pct = (n: number | null | undefined, digits = 0) => (n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`)
function monthYear(d: string | null | undefined): string {
  if (!d) return '—'
  const date = new Date(`${String(d).slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(d)
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}
function fullDate(d: string | null | undefined): string {
  if (!d) return '—'
  const date = new Date(`${String(d).slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(d)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
function daysAgo(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n <= 0) return 'today'
  if (n < 45) return `${n}d ago`
  if (n < 540) return `${Math.round(n / 30)}mo ago`
  return `${(n / 365).toFixed(1)}y ago`
}
const titleish = (s: string | null | undefined) =>
  String(s ?? '').toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Llc|Lp|Llp|Inc|Ne|Nw|Se|Sw)\b/g, (w) => w.toUpperCase())
const humanize = (s: string | null | undefined) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
const jurisdictionLabel = (code: string | null | undefined) => {
  const m = /^us_([a-z]{2})$/i.exec(String(code ?? ''))
  return m ? m[1].toUpperCase() : (code ? String(code).toUpperCase() : null)
}

const STATUS_LABEL: Record<string, string> = { active: 'Active', slowing: 'Slowing', inactive: 'Inactive', unknown: 'Unknown' }

const METHOD_TEXT: Record<string, string> = {
  exact_registry_company_identity: 'Exact company-registry identity',
  seller_transaction_registry_exact: 'Registry match on the deed',
  seller_transaction_company_corroboration: 'Corroborated by company records',
  transaction_linked_company_evidence: 'Company evidence on the transaction',
  transaction_linked_contact_evidence: 'Contact evidence on the transaction',
  property_linked_contact_tokenset: 'Name + property contact match',
  officer_operator_corroboration: 'Officer / operator corroboration',
}

/* ── Small primitives ────────────────────────────────────────────────────── */

function Tier({ tier, title }: { tier: EvidenceTier; title?: string }) {
  return <span className={cls('egb-tier', `is-${tier}`)} title={title}>{EVIDENCE_LABEL[tier]}</span>
}

function Ring({ value, size = 30 }: { value: number | null; size?: number }) {
  const r = (size - 4) / 2
  const c = 2 * Math.PI * r
  const v = value == null ? 0 : Math.max(0, Math.min(1, value))
  return (
    <svg className="egb-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} className="egb-ring__track" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="egb-ring__arc"
        strokeDasharray={`${c * v} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}

function Meter({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  const v = value == null ? null : Math.max(0, Math.min(1, value))
  return (
    <div className="egb-meter">
      <div className="egb-meter__top">
        <span>{label}</span>
        <b>{pct(v)}</b>
      </div>
      <div className="egb-meter__track">
        <i style={{ '--v': v ?? 0 } as CSSProperties} />
      </div>
      {hint ? <small>{hint}</small> : null}
    </div>
  )
}

function Section({
  id,
  icon,
  title,
  meta,
  open,
  onToggle,
  index,
  children,
}: {
  id: string
  icon: IconName
  title: string
  meta?: ReactNode
  open: boolean
  onToggle: (id: string) => void
  index: number
  children: ReactNode
}) {
  return (
    <section className={cls('egb-sec', open && 'is-open')} data-sec={id} style={{ '--i': index } as CSSProperties}>
      <button type="button" className="egb-sec__head" aria-expanded={open} onClick={() => onToggle(id)}>
        <span className="egb-sec__glyph"><Icon name={icon} /></span>
        <span className="egb-sec__title">{title}</span>
        {meta != null ? <span className="egb-sec__meta">{meta}</span> : null}
        <span className="egb-sec__chev"><Icon name="chevron-down" /></span>
      </button>
      {open ? <div className="egb-sec__body">{children}</div> : null}
    </section>
  )
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="egb-fact">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

/* ── Charts ──────────────────────────────────────────────────────────────── */

function YearBars({ rows }: { rows: BuyerProfile['activity']['byYear'] }) {
  const series = useMemo(() => {
    if (!rows.length) return []
    const byYear = new Map(rows.map((r) => [r.year, r]))
    const years = rows.map((r) => r.year)
    const max = Math.max(...years)
    const min = Math.max(Math.min(...years), max - 11)
    const out: Array<{ year: number; count: number; volume: number | null }> = []
    for (let y = min; y <= max; y += 1) out.push(byYear.get(y) ?? { year: y, count: 0, volume: null })
    return out
  }, [rows])
  const [active, setActive] = useState<number | null>(null)
  if (!series.length) return <p className="egb-empty">No dated purchases on record.</p>
  const peak = Math.max(1, ...series.map((s) => s.count))
  const shown = series.find((s) => s.year === active) ?? series[series.length - 1]
  return (
    <div className="egb-years">
      <div className="egb-years__readout" aria-live="polite">
        <b>{shown.year}</b>
        <span>{shown.count} purchase{shown.count === 1 ? '' : 's'}</span>
        {shown.volume ? <span>{money(shown.volume)} volume</span> : null}
      </div>
      <div className="egb-years__plot" role="list">
        {series.map((s, i) => (
          <button
            key={s.year}
            type="button"
            role="listitem"
            className={cls('egb-years__bar', s.year === shown.year && 'is-on', s.count === 0 && 'is-zero')}
            style={{ '--h': s.count / peak, '--i': i } as CSSProperties}
            aria-label={`${s.year}: ${s.count} purchases`}
            onPointerDown={() => setActive(s.year)}
            onClick={() => setActive(s.year)}
          >
            <i />
            <em>{String(s.year).slice(2)}</em>
          </button>
        ))}
      </div>
    </div>
  )
}

function PriceBand({ price }: { price: BuyerProfile['price'] }) {
  const lo = price.p10 ?? price.p25
  const hi = price.p90 ?? price.p75
  if (lo == null || hi == null || price.p50 == null) return <p className="egb-empty">Not enough priced purchases to draw a band.</p>
  const span = Math.max(1, hi - lo)
  const at = (v: number | null) => (v == null ? null : ((v - lo) / span) * 100)
  const box = [at(price.p25), at(price.p75)]
  return (
    <div className="egb-band">
      <div className="egb-band__head">
        <span>Typical purchase</span>
        <b>{money(price.p50)}</b>
        <small>median</small>
      </div>
      <div className="egb-band__track">
        <i className="egb-band__whisker" />
        {box[0] != null && box[1] != null ? (
          <i className="egb-band__box" style={{ left: `${box[0]}%`, width: `${Math.max(2, box[1] - box[0])}%` }} />
        ) : null}
        <i className="egb-band__median" style={{ left: `${at(price.p50)}%` }} />
      </div>
      <div className="egb-band__scale">
        <span>{money(lo)}</span>
        <span>{money(price.p25)} – {money(price.p75)}</span>
        <span>{money(hi)}</span>
      </div>
      {price.recentMedian != null ? (
        <p className="egb-band__recent">Last 12 months: median {money(price.recentMedian)} across {price.recentCount ?? 0}</p>
      ) : null}
    </div>
  )
}

function AssetMix({ families }: { families: Share[] }) {
  const total = families.reduce((sum, f) => sum + f.count, 0)
  if (!total) return null
  return (
    <div className="egb-mix">
      <div className="egb-mix__bar">
        {families.map((f, i) => (
          <i key={f.key} style={{ '--w': f.count / total, '--i': i } as CSSProperties} className={`is-${i % 6}`} />
        ))}
      </div>
      <ul className="egb-mix__legend">
        {families.map((f, i) => (
          <li key={f.key}>
            <i className={`is-${i % 6}`} />
            <span>{ASSET_FAMILY_LABEL[f.key] ?? humanize(f.key)}</span>
            <b>{pct(f.share ?? f.count / total)}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RankRows({ rows, limit = 6 }: { rows: Share[]; limit?: number }) {
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const peak = Math.max(...rows.map((r) => r.count), 1)
  const shown = all ? rows : rows.slice(0, limit)
  return (
    <>
      <ol className="egb-rank">
        {shown.map((r, i) => (
          <li key={r.key} style={{ '--i': i } as CSSProperties}>
            <span className="egb-rank__label">{r.label}</span>
            <span className="egb-rank__track"><i style={{ '--v': r.count / peak } as CSSProperties} /></span>
            <b>{r.count}</b>
          </li>
        ))}
      </ol>
      {rows.length > limit ? (
        <button type="button" className="egb-more" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      ) : null}
    </>
  )
}

/* ── Transactions ───────────────────────────────────────────────────────── */

function TxRow({ tx, kind, onOpen }: { tx: BuyerTransaction; kind: 'purchase' | 'disposition'; onOpen?: () => void }) {
  const body = (
    <>
      <span className="egb-tx__rail" aria-hidden="true"><i /></span>
      <span className="egb-tx__main">
        <span className="egb-tx__top">
          <b>{tx.price ? money(tx.price) : 'No price'}</b>
          <span>{fullDate(tx.date)}</span>
        </span>
        <span className="egb-tx__addr">{tx.address ? titleish(tx.address) : 'Address not recorded'}</span>
        <span className="egb-tx__meta">
          {kind === 'purchase' && tx.seller ? <span>from {titleish(tx.seller)}</span> : null}
          {kind === 'disposition' && tx.buyer ? <span>to {titleish(tx.buyer)}</span> : null}
          {tx.docType ? <span>{tx.docType}</span> : null}
          {tx.cash === true ? <span className="egb-chip is-cash">Cash</span> : null}
          {tx.cash === false ? <span className="egb-chip">Financed{tx.lender ? ` · ${titleish(tx.lender)}` : ''}</span> : null}
          {tx.armsLength === false ? <span className="egb-chip is-muted">Non-arm's length</span> : null}
        </span>
        <span className="egb-tx__ev">
          <Tier tier={tx.evidence.tier} title={tx.evidence.method ?? undefined} />
          {tx.evidence.method ? <small>{tx.evidence.method}</small> : null}
          {tx.inUniverse ? <small className="egb-tx__here">In our universe</small> : null}
        </span>
      </span>
      {onOpen ? <span className="egb-tx__go"><Icon name="chevron-right" /></span> : null}
    </>
  )
  return onOpen ? (
    <button type="button" className="egb-tx is-tap" onClick={onOpen}>{body}</button>
  ) : (
    <div className="egb-tx">{body}</div>
  )
}

/* ── Sheet chrome ───────────────────────────────────────────────────────── */

type Snap = 'half' | 'full'

function useSheetDrag(snap: Snap, setSnap: (s: Snap) => void, onClose: () => void) {
  const start = useRef<{ y: number; t: number } | null>(null)
  const [offset, setOffset] = useState(0)
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    start.current = { y: e.clientY, t: performance.now() }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!start.current) return
    setOffset(Math.max(-120, e.clientY - start.current.y))
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const s = start.current
    start.current = null
    setOffset(0)
    if (!s) return
    const dy = e.clientY - s.y
    const velocity = dy / Math.max(1, performance.now() - s.t)
    if (dy > 90 || velocity > 0.9) {
      if (snap === 'full') setSnap('half')
      else onClose()
    } else if (dy < -60 || velocity < -0.7) {
      setSnap('full')
    }
  }, [onClose, setSnap, snap])
  return { offset, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } }
}

/* ── Main ───────────────────────────────────────────────────────────────── */

type LoadState = { key: string; status: 'loading' | 'ready' | 'missing' | 'error'; profile: BuyerProfile | null }

export function BuyerInspectorSheet({
  buyerId,
  open,
  onClose,
  onOpenProperty,
  onOpenBuyer,
  onShowOnMap,
  onOpenBuyerMatch,
  onSaveSegment,
  focusSection = null,
}: BuyerInspectorProps) {
  const [load, setLoad] = useState<LoadState>({ key: '', status: 'loading', profile: null })
  const [attempt, setAttempt] = useState(0)
  const [snap, setSnap] = useState<Snap>('half')
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(['activity', 'behaviour', 'purchases']))
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const requestKey = `${buyerId ?? ''}#${attempt}`
  const current = load.key === requestKey
  const status = !buyerId ? 'missing' : current ? load.status : 'loading'
  const profile = current ? load.profile : null

  useEffect(() => {
    if (!open || !buyerId) return
    const ctrl = new AbortController()
    fetchBuyerProfile(buyerId, ctrl.signal)
      .then((p) => { if (!ctrl.signal.aborted) setLoad({ key: requestKey, status: p ? 'ready' : 'missing', profile: p }) })
      .catch(() => { if (!ctrl.signal.aborted) setLoad({ key: requestKey, status: 'error', profile: null }) })
    return () => ctrl.abort()
  }, [open, buyerId, requestKey])

  // A new buyer starts at the top, half-height.
  useEffect(() => {
    if (!open) return
    setSnap('half')
    bodyRef.current?.scrollTo({ top: 0 })
  }, [buyerId, open])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  // A deep-linked section (Buyer Match → "View portfolio") opens and scrolls into view.
  useEffect(() => {
    if (!open || !focusSection || status !== 'ready') return
    setOpenSections((cur) => (cur.has(focusSection) ? cur : new Set(cur).add(focusSection)))
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const raf = requestAnimationFrame(() => {
      bodyRef.current?.querySelector(`[data-sec="${CSS.escape(focusSection)}"]`)?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [open, focusSection, status, buyerId])

  const { offset, handlers } = useSheetDrag(snap, setSnap, onClose)

  const toggle = useCallback((id: string) => {
    setOpenSections((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const points = useMemo<BuyerMapPoint[]>(() => {
    if (!profile) return []
    const seen = new Set<string>()
    const out: BuyerMapPoint[] = []
    const push = (p: { propertyId?: string | null; lat?: number | null; lng?: number | null; address?: string | null }) => {
      if (p.lat == null || p.lng == null || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return
      const k = p.propertyId || `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
      if (seen.has(k)) return
      seen.add(k)
      out.push({ propertyId: p.propertyId ?? undefined, lat: p.lat, lng: p.lng, address: p.address ?? undefined })
    }
    profile.owned.forEach(push)
    profile.portfolio.forEach(push)
    profile.purchases.forEach(push)
    return out
  }, [profile])

  if (!open || typeof document === 'undefined') return null

  const sheetStyle = {
    '--drag': `${offset}px`,
  } as CSSProperties

  const sheet = (
    <div className="egb" data-snap={snap}>
      <button type="button" className="egb-scrim" aria-label="Close buyer" onClick={onClose} />
      <aside className={cls('egb-sheet', `is-${snap}`, offset !== 0 && 'is-dragging')} style={sheetStyle} role="dialog" aria-modal="true" aria-label={profile?.name ?? 'Buyer'}>
        <div className="egb-field" aria-hidden="true"><i /><i /><i /></div>
        <div className="egb-grip" {...handlers}>
          <span className="egb-grip__pill" />
        </div>
        <button type="button" className="egb-close" aria-label="Close" onClick={onClose}><Icon name="close" /></button>

        <div className="egb-body" ref={bodyRef}>
          {status === 'loading' ? <Skeleton /> : null}
          {status === 'error' ? (
            <div className="egb-state">
              <Icon name="alert-circle" />
              <strong>Buyer intelligence didn't load</strong>
              <span>The read model may be refreshing. Nothing was changed.</span>
              <button type="button" className="egb-btn" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
            </div>
          ) : null}
          {status === 'missing' ? (
            <div className="egb-state">
              <Icon name="users" />
              <strong>No buyer on record</strong>
              <span>This entity isn't in the buyer-intelligence model.</span>
            </div>
          ) : null}
          {status === 'ready' && profile ? (
            <Profile
              profile={profile}
              openSections={openSections}
              onToggle={toggle}
              onOpenProperty={onOpenProperty}
              onOpenBuyer={onOpenBuyer}
              onShowOnMap={onShowOnMap}
            />
          ) : null}
        </div>

        {status === 'ready' && profile ? (
          <footer className="egb-actions">
            <button type="button" className="egb-act" disabled={!points.length} onClick={() => onShowOnMap(points)}>
              <Icon name="map" />
              <span>Show on Map{points.length ? <em>{points.length}</em> : null}</span>
            </button>
            <button type="button" className="egb-act" onClick={() => onOpenBuyerMatch()}>
              <Icon name="target" />
              <span>Buyer Match</span>
            </button>
            {onSaveSegment ? (
              <button type="button" className="egb-act is-primary" onClick={() => onSaveSegment(profile)}>
                <Icon name="bookmark" />
                <span>Save</span>
              </button>
            ) : null}
          </footer>
        ) : null}
      </aside>
    </div>
  )
  return createPortal(sheet, document.body)
}

function Skeleton() {
  return (
    <div className="egb-skel" aria-busy="true" aria-label="Loading buyer">
      <i className="is-title" />
      <i className="is-line" />
      <div className="egb-skel__row"><i /><i /><i /><i /></div>
      <i className="is-block" />
      <i className="is-block" />
    </div>
  )
}

function Profile({
  profile: p,
  openSections,
  onToggle,
  onOpenProperty,
  onOpenBuyer,
  onShowOnMap,
}: {
  profile: BuyerProfile
  openSections: Set<string>
  onToggle: (id: string) => void
  onOpenProperty: (id: string) => void
  onOpenBuyer: (id: string) => void
  onShowOnMap: (points: BuyerMapPoint[]) => void
}) {
  const status = p.activity.status ?? 'unknown'
  const archetype = p.behavior.archetype ? ARCHETYPE_LABEL[p.behavior.archetype] ?? humanize(p.behavior.archetype) : null
  const jurisdiction = jurisdictionLabel(p.identity.jurisdiction)
  const identityTier: EvidenceTier = (p.identity.confidence ?? 0) >= 0.95 && p.identity.grade === 'canonical' ? 'resolved' : 'inferred'
  const isOpen = (id: string) => openSections.has(id)
  let idx = 0
  const next = () => { idx += 1; return idx }

  const ownedPoints = p.owned.filter((o) => o.lat != null && o.lng != null).map((o) => ({ propertyId: o.propertyId, lat: o.lat as number, lng: o.lng as number, address: o.address ?? undefined }))
  const purchasePoints = p.purchases.filter((t) => t.lat != null && t.lng != null).map((t) => ({ propertyId: t.propertyId ?? undefined, lat: t.lat as number, lng: t.lng as number, address: t.address ?? undefined }))
  const portfolioPoints = p.portfolio.filter((o) => o.lat != null && o.lng != null).map((o) => ({ propertyId: o.propertyId, lat: o.lat as number, lng: o.lng as number, address: o.address ?? undefined }))
  const canonicalAliases = [...p.aliases].sort((a, b) => Number(b.canonical) - Number(a.canonical))

  return (
    <div className="egb-profile">
      {/* ── HERO ── */}
      <header className="egb-hero">
        <div className="egb-hero__row">
          <span className={cls('egb-glyph', `is-${p.kind}`)}><Icon name={p.kind === 'company' ? 'briefcase' : 'user'} /></span>
          <div className="egb-hero__id">
            <span className="egb-hero__eyebrow">{p.kind === 'company' ? 'Buyer · Company' : 'Buyer · Individual'}</span>
            <h2 className="egb-hero__name">{p.nameWithheld ? 'Individual buyer' : titleish(p.name)}</h2>
            {p.nameWithheld ? <span className="egb-hero__withheld">Name withheld — individual</span> : null}
          </div>
        </div>
        <div className="egb-hero__pills">
          <span className={cls('egb-status', `is-${status}`)}><i />{STATUS_LABEL[status] ?? humanize(status)}</span>
          {archetype ? <span className="egb-pill">{archetype}</span> : null}
          {p.behavior.holdFlip ? <span className="egb-pill is-quiet">{HOLD_FLIP_LABEL[p.behavior.holdFlip] ?? humanize(p.behavior.holdFlip)}</span> : null}
          {p.roles.crossover ? <span className="egb-pill is-cross"><Icon name="refresh-cw" />Buys and sells</span> : null}
        </div>
        <div className="egb-hero__identity">
          <Ring value={p.identity.confidence} />
          <span>
            {[jurisdiction, p.identity.companyNumber ? `#${p.identity.companyNumber}` : null, p.identity.grade ? humanize(p.identity.grade) : null]
              .filter(Boolean).join(' · ') || 'Identity'}
          </span>
          <b>{pct(p.identity.confidence)}</b>
          <Tier tier={identityTier} />
        </div>
        <div className="egb-roles">
          <div className="egb-role"><b><CountUp value={p.roles.purchases} format={fmtInt} /></b><span>Bought</span></div>
          <div className="egb-role"><b><CountUp value={p.roles.sold} format={fmtInt} /></b><span>Sold</span></div>
          <div className="egb-role"><b><CountUp value={p.roles.owned} format={fmtInt} /></b><span>Owns here</span></div>
          <div className="egb-role"><b><CountUp value={p.roles.portfolio} format={fmtInt} /></b><span>Portfolio</span></div>
        </div>
      </header>

      {/* ── ACTIVITY ── */}
      <Section id="activity" icon="activity" title="Activity" index={next()} open={isOpen('activity')} onToggle={onToggle}
        meta={p.activity.last ? `Last ${daysAgo(p.activity.daysSinceLast)}` : null}>
        <YearBars rows={p.activity.byYear} />
        <div className="egb-facts is-4">
          <Fact label="90 days" value={p.activity.trailing90 ?? '—'} />
          <Fact label="180 days" value={p.activity.trailing180 ?? '—'} />
          <Fact label="12 months" value={p.activity.trailing365 ?? '—'} />
          <Fact label="Per year" value={p.activity.perYear != null ? p.activity.perYear.toFixed(1) : '—'} />
        </div>
        <div className="egb-facts">
          <Fact label="First purchase" value={monthYear(p.activity.first)} />
          <Fact label="Latest purchase" value={monthYear(p.activity.last)} />
        </div>
      </Section>

      {/* ── BEHAVIOUR ── */}
      <Section id="behaviour" icon="brain" title="Buying behaviour" index={next()} open={isOpen('behaviour')} onToggle={onToggle}
        meta={p.price.p50 ? money(p.price.p50) : null}>
        <PriceBand price={p.price} />
        <div className="egb-meters">
          <Meter label="Cash purchases" value={p.price.cashShare} />
          <Meter label="Arm's-length" value={p.price.armsLengthShare} />
        </div>
        {p.behavior.holdFlip ? (
          <div className="egb-facts">
            <Fact label="Hold vs flip" value={HOLD_FLIP_LABEL[p.behavior.holdFlip] ?? humanize(p.behavior.holdFlip)} />
            <Fact label="Median hold" value={p.behavior.medianHoldDays != null ? `${Math.round(p.behavior.medianHoldDays)} days` : '—'} />
          </div>
        ) : null}
        {p.assets.families.length ? (
          <>
            <h4 className="egb-h4">Asset mix</h4>
            <AssetMix families={p.assets.families} />
          </>
        ) : null}
        {p.behavior.archetypeReasons.length ? (
          <ul className="egb-reasons">
            {p.behavior.archetypeReasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        ) : null}
      </Section>

      {/* ── GEOGRAPHY ── */}
      {p.geography.counties.length || p.geography.states.length ? (
        <Section id="geo" icon="globe" title="Where they buy" index={next()} open={isOpen('geo')} onToggle={onToggle}
          meta={p.geography.primaryMarkets[0] ?? p.geography.states[0]?.label ?? null}>
          {p.geography.primaryMarkets.length ? (
            <div className="egb-markets">
              {p.geography.primaryMarkets.map((m) => <span key={m} className="egb-pill">{m}</span>)}
            </div>
          ) : null}
          {p.geography.counties.length ? (<><h4 className="egb-h4">Counties</h4><RankRows rows={p.geography.counties} /></>) : null}
          {p.geography.cities.length ? (<><h4 className="egb-h4">Cities</h4><RankRows rows={p.geography.cities} limit={5} /></>) : null}
          {p.geography.zips.length ? (<><h4 className="egb-h4">ZIPs</h4><RankRows rows={p.geography.zips} limit={5} /></>) : null}
          {p.geography.concentration != null ? (
            <Meter label="Geographic concentration" value={p.geography.concentration} hint="Higher means purchases cluster in fewer places." />
          ) : null}
        </Section>
      ) : null}

      {/* ── BUY BOX ── */}
      {p.buybox ? (
        <Section id="buybox" icon="target" title="Buy box" index={next()} open={isOpen('buybox')} onToggle={onToggle}
          meta={p.buybox.priceLow != null && p.buybox.priceHigh != null ? `${money(p.buybox.priceLow)}–${money(p.buybox.priceHigh)}` : null}>
          <div className="egb-facts">
            <Fact label="Price" value={p.buybox.priceLow != null || p.buybox.priceHigh != null ? `${money(p.buybox.priceLow)} – ${money(p.buybox.priceHigh)}` : '—'} />
            <Fact label="Building" value={p.buybox.sqftLow != null ? `${fmtInt(p.buybox.sqftLow)}–${fmtInt(p.buybox.sqftHigh ?? p.buybox.sqftLow)} sqft` : '—'} />
            <Fact label="Units" value={p.buybox.unitsLow != null ? `${Math.round(p.buybox.unitsLow)}–${Math.round(p.buybox.unitsHigh ?? p.buybox.unitsLow)}` : '—'} />
            <Fact label="Evidence" value={p.buybox.evidenceDepth != null ? `${p.buybox.evidenceDepth} deals · ${pct(p.buybox.confidence)}` : '—'} />
          </div>
          {p.buybox.families.length ? <div className="egb-markets">{p.buybox.families.map((f) => <span key={f} className="egb-pill is-quiet">{ASSET_FAMILY_LABEL[f] ?? humanize(f)}</span>)}</div> : null}
          {p.buybox.counties.length ? <div className="egb-markets">{p.buybox.counties.map((c) => <span key={c} className="egb-pill">{c.split('|').reverse().join(', ')}</span>)}</div> : null}
          {p.buybox.states.length ? <div className="egb-markets">{p.buybox.states.map((s) => <span key={s} className="egb-pill is-quiet">{s}</span>)}</div> : null}
        </Section>
      ) : null}

      {/* ── PURCHASES ── */}
      <Section id="purchases" icon="dollar-sign" title="Purchase history" index={next()} open={isOpen('purchases')} onToggle={onToggle}
        meta={p.purchases.length ? `${p.purchases.length}${p.roles.purchases > p.purchases.length ? ` of ${p.roles.purchases}` : ''}` : null}>
        {p.purchases.length ? (
          <>
            {purchasePoints.length ? (
              <button type="button" className="egb-inline" onClick={() => onShowOnMap(purchasePoints)}>
                <Icon name="map" />Show {purchasePoints.length} on Map
              </button>
            ) : null}
            <div className="egb-timeline">
              {p.purchases.map((tx) => (
                <TxRow
                  key={`p-${tx.id}`}
                  tx={tx}
                  kind="purchase"
                  onOpen={tx.propertyId && tx.inUniverse ? () => onOpenProperty(tx.propertyId as string) : undefined}
                />
              ))}
            </div>
          </>
        ) : <p className="egb-empty">No linked purchases.</p>}
      </Section>

      {/* ── DISPOSITIONS ── */}
      {p.kind === 'company' && p.dispositions.length ? (
        <Section id="sold" icon="arrow-up-right" title="Sold" index={next()} open={isOpen('sold')} onToggle={onToggle}
          meta={<Tier tier="observed" />}>
          <p className="egb-note">Matched on the seller name recorded on the deed.</p>
          <div className="egb-timeline">
            {p.dispositions.map((tx) => (
              <TxRow key={`d-${tx.id}`} tx={tx} kind="disposition" onOpen={tx.propertyId ? () => onOpenProperty(tx.propertyId as string) : undefined} />
            ))}
          </div>
        </Section>
      ) : null}

      {/* ── OWNS HERE ── */}
      {p.owned.length ? (
        <Section id="owned" icon="home" title="Owns in our universe" index={next()} open={isOpen('owned')} onToggle={onToggle}
          meta={String(p.roles.owned)}>
          {ownedPoints.length ? (
            <button type="button" className="egb-inline" onClick={() => onShowOnMap(ownedPoints)}><Icon name="map" />Show on Map</button>
          ) : null}
          <ul className="egb-props">
            {p.owned.map((o, i) => (
              <li key={o.propertyId} style={{ '--i': i } as CSSProperties}>
                <button type="button" onClick={() => onOpenProperty(o.propertyId)}>
                  <span className="egb-props__addr">{titleish(o.address) || o.propertyId}</span>
                  <span className="egb-props__meta">
                    {[o.propertyType, o.value != null ? money(o.value) : null, o.equityPercent != null ? `${Math.round(o.equityPercent)}% equity` : null].filter(Boolean).join(' · ')}
                  </span>
                  <Tier tier={o.evidence.tier} />
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* ── PORTFOLIO (persons) ── */}
      {p.portfolio.length ? (
        <Section id="portfolio" icon="layers" title="Observed portfolio" index={next()} open={isOpen('portfolio')} onToggle={onToggle}
          meta={p.roles.portfolioValue ? money(p.roles.portfolioValue) : String(p.roles.portfolio)}>
          {portfolioPoints.length ? (
            <button type="button" className="egb-inline" onClick={() => onShowOnMap(portfolioPoints)}><Icon name="map" />Show on Map</button>
          ) : null}
          <p className="egb-note">Only properties already in your universe are listed; {Math.max(0, p.roles.portfolio - p.portfolio.length)} more are counted, not shown.</p>
          <ul className="egb-props">
            {p.portfolio.map((o, i) => (
              <li key={o.propertyId} style={{ '--i': i } as CSSProperties}>
                <button type="button" onClick={() => onOpenProperty(o.propertyId)}>
                  <span className="egb-props__addr">{titleish(o.address) || o.propertyId}</span>
                  <span className="egb-props__meta">{[o.propertyType, o.value != null ? money(o.value) : null, o.equity != null ? `${money(o.equity)} equity` : null].filter(Boolean).join(' · ')}</span>
                  {o.attribution ? <span className="egb-tier is-inferred">{humanize(o.attribution)}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* ── COMPANY NETWORK ── */}
      {canonicalAliases.length || p.network.length || p.registry ? (
        <Section id="network" icon="link" title={p.kind === 'company' ? 'Company network' : 'Connections'} index={next()} open={isOpen('network')} onToggle={onToggle}
          meta={p.network.length ? `${p.network.length} linked` : canonicalAliases.length ? `${canonicalAliases.length} names` : null}>
          {p.registry ? (
            <div className="egb-registry">
              <div className="egb-registry__top">
                <b>{titleish(p.registry.company_name) || p.name}</b>
                {p.registry.status ? <span className={cls('egb-pill', p.registry.inactive ? 'is-quiet' : 'is-live')}>{p.registry.status}</span> : null}
              </div>
              <div className="egb-facts">
                <Fact label="Jurisdiction" value={jurisdictionLabel(p.registry.jurisdiction) ?? '—'} />
                <Fact label="Company #" value={p.registry.company_number ?? '—'} />
                <Fact label="Incorporated" value={fullDate(p.registry.incorporated)} />
                {p.registry.dissolved ? <Fact label="Dissolved" value={fullDate(p.registry.dissolved)} /> : null}
              </div>
              {p.registry.address ? (
                <p className="egb-registry__addr">{titleish([p.registry.address, p.registry.city].filter(Boolean).join(', '))}{p.registry.state ? `, ${p.registry.state}` : ''} {p.registry.zip ?? ''}</p>
              ) : null}
              {p.registry.registry_url ? (
                <a className="egb-inline" href={p.registry.registry_url} target="_blank" rel="noopener noreferrer"><Icon name="external-link" />Registry record</a>
              ) : null}
            </div>
          ) : null}
          {p.network.length ? (
            <>
              <h4 className="egb-h4">People & companies</h4>
              <ul className="egb-links">
                {p.network.map((rel, i) => rel.other ? (
                  <li key={`${rel.other.id}-${i}`}>
                    <button type="button" onClick={() => onOpenBuyer(rel.other!.id)}>
                      <span className={cls('egb-glyph is-sm', `is-${rel.other.kind === 'person' ? 'person' : 'company'}`)}><Icon name={rel.other.kind === 'person' ? 'user' : 'briefcase'} /></span>
                      <span className="egb-links__main">
                        <b>{rel.other.kind === 'person' ? 'Individual' : titleish(rel.other.name)}</b>
                        <small>{[rel.role ? (rel.direction === 'officer_of' ? `${humanize(rel.role)} there` : humanize(rel.role)) : null, rel.other.purchases ? `${rel.other.purchases} purchases` : null].filter(Boolean).join(' · ') || 'Linked'}</small>
                      </span>
                      <Tier tier={(rel.confidence ?? 0) >= 0.95 ? 'resolved' : 'inferred'} />
                    </button>
                  </li>
                ) : null)}
              </ul>
            </>
          ) : null}
          {canonicalAliases.length ? (
            <>
              <h4 className="egb-h4">Names on record</h4>
              <ul className="egb-aliases">
                {canonicalAliases.map((a) => (
                  <li key={a.name}>
                    <span>{titleish(a.name)}</span>
                    {a.canonical ? <em className="is-canon">Canonical</em> : null}
                    {a.provisional ? <em>Provisional</em> : null}
                    {a.forms.length > 1 ? <small>{a.forms.length} spellings</small> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Section>
      ) : null}

      {/* ── EVIDENCE ── */}
      <Section id="evidence" icon="shield" title="Evidence" index={next()} open={isOpen('evidence')} onToggle={onToggle}
        meta={<Tier tier={identityTier} />}>
        <div className="egb-evidence">
          <p>
            <b>Identity.</b>{' '}
            {p.identity.method ? (METHOD_TEXT[p.identity.method] ?? humanize(p.identity.method)) : 'Resolved by the buyer-intelligence model'}
            {p.identity.confidence != null ? `, ${pct(p.identity.confidence)} confidence` : ''}
            {p.identity.grade ? ` (${humanize(p.identity.grade)} grade)` : ''}.
          </p>
          <p><b>Behaviour.</b> Built from {p.behavior.evidenceCount ?? p.roles.purchases} observed transactions{p.behavior.confidence != null ? ` at ${pct(p.behavior.confidence)} confidence` : ''}.</p>
          <ul className="egb-legend">
            <li><Tier tier="resolved" /><span>Registry number, engine link ≥ 95%, or the owner's own record.</span></li>
            <li><Tier tier="observed" /><span>An exact name on a deed matched this entity's unambiguous alias.</span></li>
            <li><Tier tier="inferred" /><span>Engine link below 95% confidence — treat as a lead.</span></li>
          </ul>
          {p.identity.modelAsOf ? <small>Model as of {fullDate(p.identity.modelAsOf)}. Observational — never used for pricing or outreach.</small> : null}
        </div>
      </Section>
    </div>
  )
}

export default BuyerInspectorSheet
