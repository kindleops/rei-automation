/**
 * PIPELINE DEAL INSPECTOR — one opportunity, told as a story.
 *
 * Automation-first: this sheet explains what the machine is doing with the
 * deal and what happens next. It never offers a stage move, a task, or a
 * checklist — stages move by the autopilot and the authority registry. The
 * only thing that reads as "yours" is the lane banner when the lane is an
 * exception (operator / blocked), and it says exactly why.
 *
 * Everything rendered comes from /pipeline/command/story/:id — canonical
 * history, messages, offers, closing events, the Decision Engine row. Nothing
 * is synthesised; an absent section is hidden, an absent engine run is stated.
 *
 * Portalled to <body>, so all tokens are defined on `.pli`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../../shared/icons'
import {
  fetchPipelineDealStory,
  LANE_META,
  STAGE_TONE,
  compactMoney,
  relTime,
  type PipelineCommandCard,
  type PipelineDealStory,
  type PipelineStoryBeat,
} from '../../../domain/pipeline/pipeline-command-api'
import './pipeline-command-tokens.css'
import './pipeline-deal-inspector.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export type PipelineDealInspectorProps = {
  opportunityId: string | null
  seed?: PipelineCommandCard | null
  open: boolean
  onClose: () => void
  onOpenConversation: (threadKey: string) => void
  onOpenDealIntelligence: (threadKey: string | null) => void
  onOpenEntityGraph: (propertyId: string) => void
  onShowOnMap: (card: PipelineCommandCard) => void
  onOpenBuyerMatch: (propertyId: string) => void
  onOpenClosingDesk: (card: PipelineCommandCard) => void
}

/* ── Canonical lifecycle (S1 → S10) ─────────────────────────────────────── */

const STAGES: Array<{ code: string; short: string; label: string; group: string }> = [
  { code: 'ownership_confirmation', short: 'S1', label: 'Ownership', group: 'Discovery' },
  { code: 'offer_interest', short: 'S2', label: 'Interest', group: 'Discovery' },
  { code: 'asking_price', short: 'S3', label: 'Asking price', group: 'Qualify' },
  { code: 'property_condition', short: 'S4', label: 'Condition', group: 'Qualify' },
  { code: 'offer', short: 'S5', label: 'Offer', group: 'Negotiate' },
  { code: 'formal_contract', short: 'S6', label: 'Contract', group: 'Contract' },
  { code: 'disposition', short: 'S7', label: 'Dispo', group: 'Dispo' },
  { code: 'under_contract', short: 'S8', label: 'Under contract', group: 'Closing' },
  { code: 'prepared_to_close', short: 'S9', label: 'Escrow', group: 'Closing' },
  { code: 'closed', short: 'S10', label: 'Closed', group: 'Closed' },
]
const RAIL_GROUPS = [
  { label: 'Discovery', from: 0, to: 1 },
  { label: 'Qualify', from: 2, to: 3 },
  { label: 'Offer', from: 4, to: 4 },
  { label: 'Sign', from: 5, to: 5 },
  { label: 'Dispo', from: 6, to: 6 },
  { label: 'Closing', from: 7, to: 9 },
]

const BEAT_META: Record<string, { icon: IconName; tone: string; label: string }> = {
  contact: { icon: 'send', tone: 'var(--plc-l-system)', label: 'Outreach' },
  reply: { icon: 'message', tone: 'var(--plc-s-qualify)', label: 'Seller' },
  advance: { icon: 'trending-up', tone: 'var(--plc-s-negotiate)', label: 'Stage' },
  regress: { icon: 'arrow-down-left', tone: 'var(--plc-l-seller)', label: 'Stage' },
  price: { icon: 'dollar-sign', tone: 'var(--plc-s-qualify)', label: 'Price' },
  offer: { icon: 'dollar-sign', tone: 'var(--plc-s-negotiate)', label: 'Offer' },
  counter: { icon: 'refresh-cw', tone: 'var(--plc-l-operator)', label: 'Counter' },
  accepted: { icon: 'check', tone: 'var(--plc-s-dispo)', label: 'Accepted' },
  exit: { icon: 'x', tone: 'var(--plc-l-blocked)', label: 'Status' },
  closing: { icon: 'key', tone: 'var(--plc-s-closing)', label: 'Closing' },
  heat: { icon: 'zap', tone: 'var(--plc-l-operator)', label: 'Heat' },
  created: { icon: 'spark', tone: 'var(--plc-l-system)', label: 'Opened' },
  now: { icon: 'activity', tone: 'var(--plc-l-system)', label: 'Now' },
}

const TIER_LABEL: Record<string, string> = {
  PURSUE: 'Pursue', STRONG: 'Strong', NURTURE: 'Nurture', PASS: 'Pass', WATCH: 'Watch',
}
const STRATEGY_LABEL: Record<string, string> = {
  CASH: 'Cash', SELLER_FINANCE: 'Seller finance', SUBJECT_TO: 'Subject-to', NOVATION: 'Novation', LEASE_OPTION: 'Lease option', WHOLESALE: 'Wholesale',
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

const titleize = (s: string | null | undefined) =>
  s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null

function beatDate(iso: string): { md: string; y: string | null } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { md: '—', y: null }
  const md = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const y = d.getFullYear() !== new Date().getFullYear() ? String(d.getFullYear()) : null
  return { md, y }
}

function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function fullMoney(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null
  return `$${Math.round(n).toLocaleString()}`
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

/* ── Pieces ─────────────────────────────────────────────────────────────── */

function Section({
  id, title, icon, meta, tone, open, onToggle, children, index = 0,
}: {
  id: string
  title: string
  icon: IconName
  meta?: ReactNode
  tone?: string
  open: boolean
  onToggle: (id: string) => void
  children: ReactNode
  index?: number
}) {
  return (
    <section className={cls('pli-sec', open && 'is-open')} style={{ '--i': index, ...(tone ? { '--tone': tone } : {}) } as CSSProperties}>
      <button type="button" className="pli-sec__head" onClick={() => onToggle(id)} aria-expanded={open}>
        <span className="pli-sec__icon"><Icon name={icon} /></span>
        <span className="pli-sec__title">{title}</span>
        {meta ? <span className="pli-sec__meta">{meta}</span> : null}
        <span className="pli-sec__chev"><Icon name={open ? 'chevron-up' : 'chevron-down'} /></span>
      </button>
      {open ? <div className="pli-sec__body">{children}</div> : null}
    </section>
  )
}

function Fig({ label, value, sub, strong }: { label: string; value: string | null; sub?: string | null; strong?: boolean }) {
  return (
    <div className={cls('pli-fig', strong && 'is-strong', !value && 'is-empty')}>
      <span className="pli-fig__label">{label}</span>
      <b className="pli-fig__value">{value ?? '—'}</b>
      {sub ? <span className="pli-fig__sub">{sub}</span> : null}
    </div>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="pli-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

function StageRail({ card }: { card: PipelineCommandCard }) {
  const current = card.stageIndex ? card.stageIndex - 1 : -1
  const resolved = card.lane.key === 'complete'
  const closedOut = card.lane.key === 'closed_out'
  return (
    <div className={cls('pli-rail', closedOut && 'is-out')} aria-label={`Stage ${card.stageIndex ?? '—'} of 10`}>
      <div className="pli-rail__track">
        <span className="pli-rail__fill" style={{ '--p': `${Math.max(0, current) / 9 * 100}%` } as CSSProperties} />
        {STAGES.map((s, i) => (
          <span
            key={s.code}
            className={cls('pli-rail__dot', i < current && 'is-past', i === current && 'is-now', resolved && i === current && 'is-resolved')}
            style={{ '--tone': STAGE_TONE[s.code] } as CSSProperties}
            title={`${s.short} · ${s.label}`}
          >
            {i === current ? <i /> : null}
          </span>
        ))}
      </div>
      <div className="pli-rail__groups">
        {RAIL_GROUPS.map((g) => (
          <span
            key={g.label}
            className={cls(current >= g.from && current <= g.to && 'is-now')}
            style={{ '--from': g.from, '--span': g.to - g.from + 1 } as CSSProperties}
          >
            {g.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function LaneBanner({ card }: { card: PipelineCommandCard }) {
  const meta = LANE_META[card.lane.key] ?? LANE_META.system
  const exception = card.lane.key === 'operator' || card.lane.key === 'blocked'
  const since = relTime(card.lane.since)
  return (
    <div className={cls('pli-lane', `is-${card.lane.key}`, exception && 'is-exception')} style={{ '--tone': meta.tone } as CSSProperties}>
      <span className="pli-lane__orb"><Icon name={meta.icon as IconName} /></span>
      <span className="pli-lane__text">
        <span className="pli-lane__eyebrow">{exception ? 'Exception' : meta.label}</span>
        <b>{card.lane.label}</b>
        {card.lane.detail ? <small>{card.lane.detail}{since ? ` · ${since}` : ''}</small> : since ? <small>{since}</small> : null}
      </span>
      {card.stall ? <span className="pli-stall"><Icon name="clock" />{card.stall.label}</span> : null}
    </div>
  )
}

function Hero({ card, loading }: { card: PipelineCommandCard; loading: boolean }) {
  const stage = STAGES.find((s) => s.code === card.stage)
  const tone = STAGE_TONE[card.stage] ?? 'var(--plc-s-early)'
  const place = [card.market || [card.city, card.state].filter(Boolean).join(', ') || null, card.propertyType, card.units && card.units > 1 ? `${card.units} units` : null]
    .filter(Boolean).join(' · ')
  return (
    <header className="pli-hero" style={{ '--stage': tone } as CSSProperties}>
      <div className="pli-hero__top">
        <span className="pli-chip is-stage">
          <b>S{card.stageIndex ?? '—'}</b>
          <span>{card.stageLabel || stage?.label}</span>
        </span>
        {card.hot ? <span className="pli-chip is-hot"><Icon name="zap" />Hot</span> : null}
        {card.daysInStage !== null ? <span className="pli-chip is-quiet">{card.daysInStage}d in stage</span> : null}
        {loading ? <span className="pli-chip is-quiet is-sync"><i />Syncing</span> : null}
      </div>
      <h2 className="pli-hero__title">{card.address || 'Address not on file'}</h2>
      <p className="pli-hero__seller">
        <Icon name="user" />
        <span>{card.seller || 'Owner not resolved'}</span>
        {card.sellerSource === 'property_owner_name' ? <em>from title</em> : null}
      </p>
      {place ? <p className="pli-hero__place">{place}</p> : null}
      <StageRail card={card} />
      <LaneBanner card={card} />
    </header>
  )
}

function Story({ beats }: { beats: PipelineStoryBeat[] }) {
  return (
    <ol className="pli-story">
      {beats.map((b, i) => {
        const meta = BEAT_META[b.kind] ?? BEAT_META.created
        const isNow = b.kind === 'now'
        const tone = isNow
          ? (b.lane ? LANE_META[b.lane]?.tone : undefined) ?? meta.tone
          : b.kind === 'advance' && b.stage ? STAGE_TONE[b.stage] ?? meta.tone : meta.tone
        const d = beatDate(b.at)
        return (
          <li key={`${b.at}-${i}`} className={cls('pli-beat', `is-${b.kind}`, isNow && 'is-now')} style={{ '--tone': tone, '--i': i } as CSSProperties}>
            <span className="pli-beat__date">
              {isNow ? <b>Today</b> : <b>{d.md}</b>}
              {!isNow && d.y ? <small>{d.y}</small> : null}
            </span>
            <span className="pli-beat__node"><Icon name={meta.icon} /></span>
            <span className="pli-beat__body">
              <b>{b.title}</b>
              {b.detail ? (
                b.kind === 'reply' || b.kind === 'contact'
                  ? <q className="pli-beat__quote">{b.detail}</q>
                  : <small>{b.detail}</small>
              ) : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function DecisionBand({ d, asking }: { d: NonNullable<PipelineDealStory['decision']>; asking: number | null }) {
  const pts = [d.floor, d.offer, d.valueLow, d.valueMid, d.valueHigh, asking].filter((v): v is number => typeof v === 'number' && v > 0)
  if (pts.length < 2) return null
  const min = Math.min(...pts) * 0.96
  const max = Math.max(...pts) * 1.04
  const at = (v: number) => `${((v - min) / (max - min)) * 100}%`
  return (
    <div className="pli-band" aria-label="Offer range against valuation">
      <div className="pli-band__track">
        {d.valueLow && d.valueHigh ? <span className="pli-band__value" style={{ left: at(d.valueLow), width: `calc(${at(d.valueHigh)} - ${at(d.valueLow)})` }} /> : null}
        {d.floor && d.offer ? <span className="pli-band__offer" style={{ left: at(d.floor), width: `calc(${at(d.offer)} - ${at(d.floor)})` }} /> : null}
        {d.valueMid ? <span className="pli-band__tick is-mid" style={{ left: at(d.valueMid) }} /> : null}
        {asking ? <span className="pli-band__tick is-ask" style={{ left: at(asking) }} /> : null}
      </div>
      <div className="pli-band__legend">
        {d.floor && d.offer ? <span className="is-offer"><i />Offer {compactMoney(d.floor)}–{compactMoney(d.offer)}</span> : null}
        {d.valueLow && d.valueHigh ? <span className="is-value"><i />Value {compactMoney(d.valueLow)}–{compactMoney(d.valueHigh)}</span> : null}
        {asking ? <span className="is-ask"><i />Ask {compactMoney(asking)}</span> : null}
      </div>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="pli-skel" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}
    </div>
  )
}

/* ── Main ───────────────────────────────────────────────────────────────── */

type LoadState = { key: string; status: 'loading' | 'ready' | 'missing' | 'error'; data: PipelineDealStory | null }

export function PipelineDealInspector({
  opportunityId,
  seed = null,
  open,
  onClose,
  onOpenConversation,
  onOpenDealIntelligence,
  onOpenEntityGraph,
  onShowOnMap,
  onOpenBuyerMatch,
  onOpenClosingDesk,
}: PipelineDealInspectorProps) {
  const [load, setLoad] = useState<LoadState>({ key: '', status: 'loading', data: null })
  const [attempt, setAttempt] = useState(0)
  const [snap, setSnap] = useState<Snap>('half')
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(['story', 'economics']))
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const requestKey = `${opportunityId ?? ''}#${attempt}`
  const current = load.key === requestKey
  const status = !opportunityId ? 'missing' : current ? load.status : 'loading'
  const data = current ? load.data : null

  useEffect(() => {
    if (!open || !opportunityId) return
    const ctrl = new AbortController()
    fetchPipelineDealStory(opportunityId, ctrl.signal)
      .then((d) => { if (!ctrl.signal.aborted) setLoad({ key: requestKey, status: d ? 'ready' : 'missing', data: d }) })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        const msg = err instanceof Error ? err.message : String(err)
        setLoad({ key: requestKey, status: /not_found|404/i.test(msg) ? 'missing' : 'error', data: null })
      })
    return () => ctrl.abort()
  }, [open, opportunityId, requestKey])

  // A new deal opens at the top, half-height, with its story showing.
  useEffect(() => {
    if (!open) return
    setSnap('half')
    bodyRef.current?.scrollTo({ top: 0 })
  }, [opportunityId, open])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  const { offset, handlers } = useSheetDrag(snap, setSnap, onClose)

  const toggle = useCallback((id: string) => {
    setOpenSections((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const card = data?.card ?? (seed && seed.id === opportunityId ? seed : null)

  // Late-stage deals open on their closing picture, early ones on the story.
  const stageIndex = card?.stageIndex ?? 0
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!data || seededFor.current === data.card.id) return
    seededFor.current = data.card.id
    const next = new Set(['story', 'economics'])
    if ((data.card.stageIndex ?? 0) >= 6 || data.closing) next.add('closing')
    if ((data.card.stageIndex ?? 0) >= 7 || data.disposition.matched > 0) next.add('disposition')
    if (data.card.lane.key === 'operator' || data.card.lane.key === 'blocked') next.add('conversation')
    setOpenSections(next)
  }, [data])

  const counts = useMemo(() => {
    if (!data) return null
    return {
      beats: data.story.filter((b) => b.kind !== 'now').length,
      offers: data.negotiation.offers.length,
    }
  }, [data])

  if (!open || typeof document === 'undefined') return null

  const tone = card ? STAGE_TONE[card.stage] ?? 'var(--plc-s-early)' : 'var(--plc-s-early)'
  const showDispo = Boolean(data && (stageIndex >= 7 || data.disposition.matched > 0))
  const showClosing = Boolean(data && (stageIndex >= 6 || data.closing))
  const resolved = card?.lane.key === 'complete'

  const sheet = (
    <div className="pli" data-snap={snap}>
      <button type="button" className="pli-scrim" aria-label="Close deal" onClick={onClose} />
      <aside
        className={cls('pli-sheet', `is-${snap}`, offset !== 0 && 'is-dragging', resolved && 'is-resolved')}
        style={{ '--drag': `${offset}px`, '--stage': tone } as CSSProperties}
        role="dialog"
        aria-modal="true"
        aria-label={card?.address ?? 'Deal'}
      >
        <div className="pli-field" aria-hidden="true"><i /><i /><i /></div>
        <div className="pli-grip" {...handlers}><span className="pli-grip__pill" /></div>
        <button type="button" className="pli-close" aria-label="Close" onClick={onClose}><Icon name="close" /></button>

        <div className="pli-body" ref={bodyRef}>
          {card ? <Hero card={card} loading={status === 'loading'} /> : null}

          {status === 'loading' ? <Skeleton /> : null}

          {status === 'error' ? (
            <div className="pli-state">
              <Icon name="alert-circle" />
              <strong>The deal story didn’t load</strong>
              <span>Nothing was changed. The lifecycle data may be refreshing.</span>
              <button type="button" className="pli-btn" onClick={() => setAttempt((a) => a + 1)}><Icon name="refresh-cw" />Try again</button>
            </div>
          ) : null}

          {status === 'missing' ? (
            <div className="pli-state">
              <Icon name="slash" />
              <strong>This opportunity no longer exists</strong>
              <span>It may have been merged into another opportunity.</span>
            </div>
          ) : null}

          {status === 'ready' && data && card ? (
            <div className="pli-sections">
              {resolved ? (
                <div className="pli-resolved">
                  <span className="pli-resolved__seal"><Icon name="check" /></span>
                  <span>
                    <b>Closed</b>
                    <small>{longDate(data.closing?.date) ?? 'Closing recorded'}</small>
                  </span>
                </div>
              ) : null}

              <Section
                id="story" title="Deal story" icon="activity" index={0}
                meta={counts ? `${counts.beats} event${counts.beats === 1 ? '' : 's'}` : null}
                open={openSections.has('story')} onToggle={toggle}
              >
                {data.story.length > 1
                  ? <Story beats={data.story} />
                  : <p className="pli-note">No recorded lifecycle events yet — the story begins with the next canonical event.</p>}
              </Section>

              <Section id="economics" title="Economics" icon="dollar-sign" index={1} open={openSections.has('economics')} onToggle={toggle}
                meta={data.decision ? titleize(TIER_LABEL[data.decision.tier ?? ''] ?? data.decision.tier) : null}
              >
                <div className="pli-figs">
                  <Fig label="Asking" value={compactMoney(data.negotiation.asking)} strong />
                  <Fig label="Offer" value={compactMoney(data.negotiation.offer)} />
                  <Fig label="Counter" value={compactMoney(data.negotiation.counter)} />
                  <Fig label="Est. value" value={compactMoney(card.money.value)} />
                  <Fig label="Equity" value={compactMoney(card.money.equity)} />
                  <Fig label="Recommended" value={compactMoney(data.negotiation.recommended)} />
                </div>
                {data.decision ? (
                  <div className="pli-engine">
                    <div className="pli-engine__head">
                      <span className="pli-engine__badge"><Icon name="brain" />Decision Engine</span>
                      <span className="pli-engine__when">Underwriting {relTime(data.decision.computedAt) ?? '—'} ago</span>
                    </div>
                    <DecisionBand d={data.decision} asking={data.negotiation.asking} />
                    <div className="pli-engine__meta">
                      {data.decision.tier ? <span>{TIER_LABEL[data.decision.tier] ?? titleize(data.decision.tier)}</span> : null}
                      {data.decision.strategy ? <span>{STRATEGY_LABEL[data.decision.strategy] ?? titleize(data.decision.strategy)}</span> : null}
                      {data.decision.confidence !== null ? <span>{Math.round(data.decision.confidence)}% confidence</span> : null}
                      {data.decision.assignmentFee ? <span>Fee {compactMoney(data.decision.assignmentFee)}</span> : null}
                    </div>
                    <button type="button" className="pli-btn is-ghost" onClick={() => onOpenDealIntelligence(card.threadKey)}>
                      <Icon name="stats" />Deal Intelligence<Icon name="arrow-up-right" />
                    </button>
                  </div>
                ) : (
                  <p className="pli-note">The Decision Engine hasn’t run for this property yet.</p>
                )}
              </Section>

              <Section id="conversation" title="Conversation" icon="message" index={2} open={openSections.has('conversation')} onToggle={toggle}
                meta={data.conversation.messages ? `${data.conversation.inbound} in · ${data.conversation.messages - data.conversation.inbound} out` : null}
              >
                {data.conversation.lastInbound ? (
                  <div className="pli-msg is-in">
                    <span className="pli-msg__meta">Seller · {relTime(data.conversation.lastInbound.at)}{data.conversation.lastInbound.intent ? ` · ${titleize(data.conversation.lastInbound.intent)}` : ''}</span>
                    <q>{data.conversation.lastInbound.body || '—'}</q>
                  </div>
                ) : <p className="pli-note">The seller hasn’t replied on this thread.</p>}
                {data.conversation.lastOutbound?.message_body ? (
                  <div className="pli-msg is-out">
                    <span className="pli-msg__meta">Autopilot · {relTime(data.conversation.lastOutbound.created_at)}</span>
                    <q>{data.conversation.lastOutbound.message_body}</q>
                  </div>
                ) : null}
                {card.threadKey ? (
                  <button type="button" className="pli-btn" onClick={() => onOpenConversation(card.threadKey as string)}>
                    <Icon name="message" />Open conversation
                  </button>
                ) : null}
              </Section>

              {data.negotiation.offers.length > 0 || data.negotiation.counter ? (
                <Section id="negotiation" title="Negotiation" icon="refresh-cw" index={3} open={openSections.has('negotiation')} onToggle={toggle}
                  meta={counts?.offers ? `${counts.offers} offer${counts.offers === 1 ? '' : 's'}` : null}
                >
                  <ul className="pli-offers">
                    {data.negotiation.offers.map((o) => (
                      <li key={o.id} className={cls(o.acceptedAt && 'is-accepted')}>
                        <span className="pli-offers__v">v{o.version ?? 1}</span>
                        <b>{fullMoney(o.price) ?? '—'}</b>
                        <span>{o.acceptedAt ? `Accepted ${relTime(o.acceptedAt)}` : o.sentAt ? `Sent ${relTime(o.sentAt)}` : titleize(o.status) ?? 'Draft'}</span>
                      </li>
                    ))}
                    {data.negotiation.counter ? (
                      <li className="is-counter">
                        <span className="pli-offers__v">Seller</span>
                        <b>{fullMoney(data.negotiation.counter)}</b>
                        <span>Counter</span>
                      </li>
                    ) : null}
                  </ul>
                  {data.negotiation.gap !== null && data.negotiation.gap !== 0 ? (
                    <p className="pli-note">Offer-to-ask gap {compactMoney(Math.abs(data.negotiation.gap))}</p>
                  ) : null}
                </Section>
              ) : null}

              {showDispo ? (
                <Section id="disposition" title="Disposition" icon="target" index={4} tone="var(--plc-s-dispo)" open={openSections.has('disposition')} onToggle={toggle}
                  meta={`${data.disposition.matched} matched`}
                >
                  <div className="pli-figs is-4">
                    <Fig label="Matched" value={String(data.disposition.matched)} strong />
                    <Fig label="A-grade" value={String(data.disposition.aGrade)} />
                    <Fig label="Packages" value={String(data.disposition.packagesSent)} />
                    <Fig label="Interested" value={String(data.disposition.interested)} />
                  </div>
                  <div className="pli-buyerstate">
                    <Row label="Selected buyer" value={data.disposition.selected ?? 'None yet'} />
                    <Row label="Buyer commitment" value={data.closing?.hasBuyer ? 'Committed on the closing case' : 'Not committed'} />
                  </div>
                  {data.disposition.top.length ? (
                    <ul className="pli-buyers">
                      {data.disposition.top.map((b) => (
                        <li key={b.name}>
                          <span className="pli-buyers__grade">{b.grade ?? '—'}</span>
                          <b>{b.name}</b>
                          <span>{titleize(b.status) ?? 'Not contacted'}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {card.propertyId ? (
                    <button type="button" className="pli-btn" onClick={() => onOpenBuyerMatch(card.propertyId as string)}>
                      <Icon name="target" />Buyer Match
                    </button>
                  ) : null}
                </Section>
              ) : null}

              {showClosing ? (
                <Section id="closing" title={resolved ? 'Closing — recorded' : 'Contract & closing'} icon="key" index={5} tone="var(--plc-s-closing)" open={openSections.has('closing')} onToggle={toggle}
                  meta={data.closing?.date ? longDate(data.closing.date) : null}
                >
                  {data.closing ? (
                    <div className="pli-closing">
                      <Row label="Contract" value={titleize(data.closing.contract)} />
                      <Row label="Title" value={titleize(data.closing.title)} />
                      <Row label="Closing" value={titleize(data.closing.status)} />
                      <Row label="Closing date" value={longDate(data.closing.date)} />
                      <Row label="Earnest money" value={fullMoney(data.closing.emd)} />
                      <Row label="Disposition" value={titleize(data.closing.disposition)} />
                      <Row label="Contract price" value={fullMoney(card.money.contractPrice)} />
                      <Row label="Buyer price" value={fullMoney(card.money.buyerPrice)} />
                    </div>
                  ) : (
                    <p className="pli-note">No closing case yet — it opens when the formal contract is recorded.</p>
                  )}
                  <button type="button" className="pli-btn" onClick={() => onOpenClosingDesk(card)}>
                    <Icon name="key" />Closing Desk
                  </button>
                </Section>
              ) : null}
            </div>
          ) : null}
        </div>

        {card ? (
          <footer className="pli-actions">
            <button type="button" className="pli-act is-primary" disabled={!card.threadKey} onClick={() => card.threadKey && onOpenConversation(card.threadKey)}>
              <Icon name="message" /><span>Inbox</span>
            </button>
            <button type="button" className="pli-act" disabled={!card.propertyId} onClick={() => card.propertyId && onOpenEntityGraph(card.propertyId)}>
              <Icon name="link" /><span>Graph</span>
            </button>
            <button type="button" className="pli-act" disabled={!card.propertyId} onClick={() => onShowOnMap(card)}>
              <Icon name="map" /><span>Map</span>
            </button>
            <button type="button" className="pli-act" onClick={() => onOpenDealIntelligence(card.threadKey)}>
              <Icon name="stats" /><span>Deal Intel</span>
            </button>
            {stageIndex >= 5 || (data?.disposition.matched ?? 0) > 0 ? (
              <button type="button" className="pli-act" disabled={!card.propertyId} onClick={() => card.propertyId && onOpenBuyerMatch(card.propertyId)}>
                <Icon name="target" /><span>Buyers</span>
              </button>
            ) : null}
            {stageIndex >= 6 || data?.closing ? (
              <button type="button" className="pli-act" onClick={() => onOpenClosingDesk(card)}>
                <Icon name="key" /><span>Closing</span>
              </button>
            ) : null}
          </footer>
        ) : null}
      </aside>
    </div>
  )
  return createPortal(sheet, document.body)
}

export default PipelineDealInspector
