/**
 * CAMPAIGN INDEX CARD — mobile.
 *
 * One shell, ten compositions. The previous card rendered every campaign as the
 * same rectangle — a name, a pill, a sentence, a number, a label — so a draft,
 * a live send and a finished run all read identically and the operator had to
 * read every word to tell them apart. Here the STATE picks the anatomy:
 *
 *   live / paused / test   progress owns the card; outcomes beneath it
 *   scheduled              when it starts, and who it will reach
 *   ready                  how much of the audience can be messaged
 *   draft                  how far setup has come, and the next step
 *   attention / hold       what is wrong, then what to do about it
 *   completed / archived   the outcome, compactly; nothing live
 *
 * A metric appears only when it means something for that state. A scheduled
 * campaign has no delivery rate; a draft has no replies. Absent, not zero.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CampaignSummary } from '../campaigns.types'
import { formatRatePct, formatWhen, compactNumber, RATE_MIN_SAMPLE } from '../campaign-operator-language'
import { useCampaignResponses } from './useCampaignResponses'
import {
  attentionIssue,
  cardKindOf,
  displayName,
  holdEvidence,
  liveHealthLabel,
  plural,
  setupSteps,
  type CardKind,
} from './campaign-index-model'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString()

export type CardAction = { id: 'setup' | 'open'; label: string; style: 'pill' | 'strip' }

type Props = {
  campaign: CampaignSummary
  onOpen: (campaign: CampaignSummary) => void
  onMenu: (campaign: CampaignSummary) => void
  onContinueSetup: (campaign: CampaignSummary) => void
  /** Stagger index for the first paint only; undefined once the list has settled. */
  enterIndex?: number
}

// ── Primitives ──────────────────────────────────────────────────────────────

const MARKER: Record<CardKind, string> = {
  live: 'Live',
  test: 'Test',
  paused: 'Paused',
  scheduled: 'Scheduled',
  ready: 'Ready',
  draft: 'Draft',
  attention: 'Needs attention',
  hold: 'On hold',
  completed: 'Completed',
  archived: 'Archived',
}

export function CampaignStateMarker({ kind, qualifier }: { kind: CardKind; qualifier?: string | null }) {
  return (
    <span className={cls('cxc-marker', `is-${kind}`)}>
      <span className="cxc-marker__dot" aria-hidden="true" />
      <span className="cxc-marker__label">{MARKER[kind]}</span>
      {qualifier ? <span className="cxc-marker__qual">{qualifier}</span> : null}
    </span>
  )
}

/**
 * A number that changes in place. It ticks when its value changes after the
 * first paint — never on mount, so a return from detail doesn't replay it.
 */
export function LiveNumber({ value, className }: { value: string; className?: string }) {
  const prev = useRef(value)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value
      setTick((t) => t + 1)
    }
  }, [value])
  return <span key={tick} className={cls(className, tick > 0 && 'is-ticking')}>{value}</span>
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Values already shown this session, by key — a return never recounts. */
const shownValues = new Map<string, number>()

/**
 * A real number that arrives in motion: it rises from zero the first time it
 * is shown in a session, then eases between values when a refresh changes it.
 * It never invents an intermediate figure the data didn't pass through — the
 * frames are an interpolation of two real values, settling on the real one.
 */
export function CountUp({
  value,
  format = (n: number) => n.toLocaleString(),
  className,
  id,
}: {
  value: number
  format?: (n: number) => string
  className?: string
  id?: string
}) {
  const key = id ?? `${className}:${format(1000)}`
  const from = shownValues.get(key) ?? 0
  // Without a browser (server/static render) there is no animation: the real
  // figure is the first and only frame.
  const [shown, setShown] = useState(() => (typeof window === 'undefined' || reducedMotion() ? value : from))
  useEffect(() => {
    const start = shownValues.get(key) ?? 0
    shownValues.set(key, value)
    if (reducedMotion() || start === value) { setShown(value); return }
    const t0 = performance.now()
    const dur = start === 0 ? 900 : 600
    let raf = 0
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      const e = 1 - Math.pow(2, -10 * p) // ease-out expo
      setShown(p >= 1 ? value : start + (value - start) * e)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [key, value])
  return <span className={className}>{format(Math.round(shown))}</span>
}

/**
 * Last width painted per campaign, across mounts. A progress rail starts from
 * where the operator last saw it and eases to the new value — it does not
 * sweep up from zero on every refresh or every return from detail.
 */
const lastPct = new Map<string, number>()

export function CampaignProgress({
  id,
  value,
  total,
  tone,
  unit,
}: {
  id: string
  value: number
  total: number
  tone: 'live' | 'paused' | 'test' | 'ready' | 'attention'
  unit: string
}) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0
  const [width, setWidth] = useState(() => lastPct.get(id) ?? pct)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setWidth(pct))
    lastPct.set(id, pct)
    return () => cancelAnimationFrame(frame)
  }, [id, pct])
  const shown = Math.round(pct)
  // One sheen pass across the rail when the value moves — not on a loop.
  const prevValue = useRef(value)
  const [sweep, setSweep] = useState(0)
  useEffect(() => {
    if (prevValue.current !== value) { prevValue.current = value; setSweep((n) => n + 1) }
  }, [value])
  return (
    <span className={cls('cxc-progress', `is-${tone}`)}>
      <span className="cxc-progress__line">
        <CountUp className="cxc-progress__value" value={value} id={`progress:${id}`} />
        <span className="cxc-progress__of">of {nf(total)} {unit}</span>
        <LiveNumber className="cxc-progress__pct" value={`${pct > 0 && shown === 0 ? '<1' : shown}%`} />
      </span>
      <span
        className="cxc-progress__rail"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={value}
        aria-label={`${nf(value)} of ${nf(total)} ${unit}`}
      >
        <span className="cxc-progress__fill" style={{ width: `${width}%` }}>
          {sweep > 0 && <span key={sweep} className="cxc-progress__sheen" />}
        </span>
      </span>
    </span>
  )
}

export function CampaignMetric({ value, label, tone }: { value: string; label: string; tone?: 'good' | 'warn' | 'muted' }) {
  return (
    <span className={cls('cxc-metric', tone && `is-${tone}`)}>
      <LiveNumber className="cxc-metric__value" value={value} />
      <span className="cxc-metric__label">{label}</span>
    </span>
  )
}

/** "12m ago" today, then "Sep 18". Real timestamps only. */
export function whenAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || t > now + 60_000) return null
  const mins = Math.round((now - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ── Outcomes that need the message log ─────────────────────────────────────

/**
 * Delivery from the row; replies and stops from the campaign's responses
 * (the list row's reply_count is a target-status artifact that is always 0).
 * Only mounted for campaigns that have sent, so drafts never ask.
 */
function Outcomes({ campaign, compact, withSent }: { campaign: CampaignSummary; compact?: boolean; withSent?: boolean }) {
  const { data } = useCampaignResponses(campaign.id)
  const sent = Number(campaign.sent_count ?? 0)
  const out: ReactNode[] = []
  if (withSent) out.push(<CampaignMetric key="sent" value={compactNumber(sent)} label="sent" />)
  if (sent >= RATE_MIN_SAMPLE && Number.isFinite(campaign.delivery_rate)) {
    out.push(<CampaignMetric key="dlv" value={formatRatePct(campaign.delivery_rate)} label="delivered" />)
  } else if (Number(campaign.delivered_count ?? 0) > 0) {
    out.push(<CampaignMetric key="dlv" value={compactNumber(campaign.delivered_count)} label="delivered" />)
  }
  if (data && data.sellers_replied > 0) {
    out.push(<CampaignMetric key="rep" value={compactNumber(data.sellers_replied)} label={data.sellers_replied === 1 ? 'reply' : 'replies'} tone="good" />)
  }
  if (data && data.sellers_asked_to_stop > 0) {
    out.push(<CampaignMetric key="stop" value={compactNumber(data.sellers_asked_to_stop)} label="opted out" tone="muted" />)
  }
  if (!compact && campaign.failed_count > 0 && sent >= RATE_MIN_SAMPLE) {
    out.push(<CampaignMetric key="fail" value={compactNumber(campaign.failed_count)} label="failed" tone="warn" />)
  }
  if (out.length === 0) return null
  return <span className="cxc-metrics">{out}</span>
}

// ── Bodies ──────────────────────────────────────────────────────────────────

function SendingBody({ campaign, tone }: { campaign: CampaignSummary; tone: 'live' | 'paused' | 'test' | 'attention' }) {
  const sent = Number(campaign.sent_count ?? 0)
  const total = Number(campaign.total_targets ?? 0)
  // Audience and sends: the rail. Sends with no audience on the row (older
  // campaigns built before targets were recorded): the outcomes alone. An
  // audience that has never been sent to: say that, not "0 of 39 · 0%".
  if (total > 0 && sent > 0) {
    return (
      <>
        <CampaignProgress id={campaign.id} value={sent} total={total} tone={tone} unit="sent" />
        <Outcomes campaign={campaign} />
      </>
    )
  }
  if (sent > 0) return <Outcomes campaign={campaign} withSent />
  if (total > 0) {
    return (
      <span className="cxc-note">
        Hasn’t sent yet · {campaign.ready_targets >= total
          ? `all ${plural(total, 'seller')} ready`
          : `${nf(campaign.ready_targets)} of ${plural(total, 'seller')} ready`}
      </span>
    )
  }
  return null
}

function ScheduledBody({ campaign }: { campaign: CampaignSummary }) {
  const at = campaign.next_send_at ? Date.parse(campaign.next_send_at) : NaN
  const future = Number.isFinite(at) && at > Date.now()
  return (
    <>
      <span className="cxc-when">
        <span className="cxc-when__label">{future ? 'Starts' : 'Start time'}</span>
        <span className="cxc-when__value">{future ? formatWhen(campaign.next_send_at as string) : 'not set'}</span>
      </span>
      {campaign.total_targets > 0 && (
        <span className="cxc-metrics">
          <CampaignMetric value={nf(campaign.ready_targets)} label="ready" />
          <CampaignMetric value={nf(campaign.total_targets)} label={campaign.total_targets === 1 ? 'seller' : 'sellers'} tone="muted" />
        </span>
      )}
    </>
  )
}

function ReadyBody({ campaign }: { campaign: CampaignSummary }) {
  const ready = Number(campaign.ready_targets ?? 0)
  const total = Number(campaign.total_targets ?? 0)
  if (total > 0 && ready > 0) {
    return <CampaignProgress id={`${campaign.id}:ready`} value={ready} total={total} tone="ready" unit={total === 1 ? 'seller ready' : 'sellers ready'} />
  }
  return (
    <span className="cxc-note">
      {total > 0
        ? `None of the ${plural(total, 'seller')} can be messaged yet.`
        : 'The audience hasn’t been built yet.'}
    </span>
  )
}

/**
 * Setup as a three-segment meter on one line — the whole draft story in the
 * space of a footer: how far, and which step is next.
 */
function SetupMeter({ campaign }: { campaign: CampaignSummary }) {
  const steps = setupSteps(campaign)
  const done = steps.filter((s) => s.done).length
  const next = steps.find((s) => !s.done)
  return (
    <span className="cxc-setup" aria-label={`Setup ${done} of ${steps.length}`}>
      <span className="cxc-setup__meter" aria-hidden="true">
        {steps.map((s) => <span key={s.key} className={cls('cxc-setup__seg', s.done && 'is-done')} />)}
      </span>
      <span className="cxc-setup__text">
        {done} of {steps.length}
        {next ? <em> · {next.label} next</em> : null}
      </span>
    </span>
  )
}

function AttentionBody({ campaign, kind }: { campaign: CampaignSummary; kind: 'attention' | 'hold' }) {
  const evidence = holdEvidence(campaign)
  const sent = Number(campaign.sent_count ?? 0)
  return (
    <>
      <span className={cls('cxc-issue', `is-${kind}`)}>{attentionIssue(campaign)}</span>
      {evidence && <span className="cxc-note">{evidence}</span>}
      {kind === 'attention' && campaign.total_targets > 0 && sent > 0 && (
        <CampaignProgress id={campaign.id} value={sent} total={campaign.total_targets} tone="attention" unit="sent" />
      )}
    </>
  )
}

function OutcomeBody({ campaign }: { campaign: CampaignSummary }) {
  const sent = Number(campaign.sent_count ?? 0)
  if (sent === 0) {
    return (
      <span className="cxc-note">
        Never sent{campaign.total_targets > 0 ? ` · ${plural(campaign.total_targets, 'seller')}` : ''}
      </span>
    )
  }
  return (
    <span className="cxc-metrics">
      <CampaignMetric value={compactNumber(sent)} label="sent" />
      <OutcomeResponses campaign={campaign} />
    </span>
  )
}

function OutcomeResponses({ campaign }: { campaign: CampaignSummary }) {
  const { data } = useCampaignResponses(campaign.id)
  return (
    <>
      {Number(campaign.delivered_count ?? 0) > 0 && (
        <CampaignMetric value={compactNumber(campaign.delivered_count)} label="delivered" />
      )}
      {data && data.sellers_replied > 0 && (
        <CampaignMetric value={compactNumber(data.sellers_replied)} label={data.sellers_replied === 1 ? 'reply' : 'replies'} tone="good" />
      )}
    </>
  )
}

// ── The card ────────────────────────────────────────────────────────────────

function qualifierFor(campaign: CampaignSummary, kind: CardKind): string | null {
  if (kind === 'live') return liveHealthLabel(campaign)
  if (kind === 'test') return 'Seller delivery off'
  if (kind === 'paused') return campaign.operator_state === 'test_mode' ? 'Test mode' : null
  if (kind === 'completed' || kind === 'archived') {
    const t = Date.parse(campaign.last_send_at ?? '')
    return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null
  }
  return null
}

function footerFor(campaign: CampaignSummary, kind: CardKind, subtitle: string | null): string | null {
  const bits: string[] = []
  // A hold card already states the selection in its evidence line.
  if (subtitle && !(kind === 'hold' && holdEvidence(campaign))) bits.push(subtitle)
  if (campaign.market_label) bits.push(campaign.market_label)
  if (kind === 'live' || kind === 'test' || kind === 'paused' || kind === 'attention') {
    const ago = whenAgo(campaign.last_send_at)
    if (ago && Number(campaign.sent_count ?? 0) > 0) bits.push(`Last send ${ago}`)
  }
  return bits.length ? bits.join(' · ') : null
}

function actionFor(campaign: CampaignSummary, kind: CardKind): CardAction | null {
  if (kind === 'draft') return { id: 'setup', label: 'Continue', style: 'pill' }
  if (kind === 'ready') return campaign.ready_targets > 0
    ? { id: 'open', label: 'Schedule', style: 'pill' }
    : { id: 'open', label: 'Review', style: 'pill' }
  if (kind === 'hold') return { id: 'open', label: 'Review targeting', style: 'strip' }
  if (kind === 'attention') return { id: 'open', label: 'Review issue', style: 'strip' }
  return null
}

export function CampaignIndexCard({ campaign, onOpen, onMenu, onContinueSetup, enterIndex }: Props) {
  const kind = cardKindOf(campaign)
  const { title, subtitle } = displayName(campaign)
  const qualifier = qualifierFor(campaign, kind)
  const footer = footerFor(campaign, kind, subtitle)
  const action = actionFor(campaign, kind)
  const compact = kind === 'archived' || kind === 'completed'

  let body: ReactNode = null
  switch (kind) {
    case 'live': body = <SendingBody campaign={campaign} tone="live" />; break
    case 'test': body = <SendingBody campaign={campaign} tone="test" />; break
    case 'paused': body = <SendingBody campaign={campaign} tone="paused" />; break
    case 'scheduled': body = <ScheduledBody campaign={campaign} />; break
    case 'ready': body = <ReadyBody campaign={campaign} />; break
    case 'draft': body = null; break
    case 'attention':
    case 'hold': body = <AttentionBody campaign={campaign} kind={kind} />; break
    default: body = <OutcomeBody campaign={campaign} />
  }

  return (
    <article
      className={cls('cxc', `is-${kind}`, compact && 'is-compact', enterIndex != null && 'is-entering')}
      style={enterIndex != null ? { animationDelay: `${Math.min(enterIndex, 6) * 45}ms` } : undefined}
      data-campaign-card
      data-kind={kind}
      role="listitem"
    >
      <button
        type="button"
        className="cxc__hit"
        onClick={() => onOpen(campaign)}
        aria-label={`${title}${subtitle ? `, ${subtitle}` : ''} — ${MARKER[kind]}`}
      >
        <span className="cxc__top">
          <CampaignStateMarker kind={kind} qualifier={qualifier} />
        </span>
        <span className="cxc__name">{title}</span>
        {body ? <span className="cxc__body">{body}</span> : null}
        {action?.style === 'pill' ? (
          // The last row carries the pill's space; the pill itself sits over it.
          <span className="cxc__foot has-pill">
            {kind === 'draft' ? <SetupMeter campaign={campaign} /> : <span className="cxc__foot-text">{footer}</span>}
          </span>
        ) : footer ? (
          <span className="cxc__foot">{footer}</span>
        ) : null}
      </button>

      <button
        type="button"
        className="cxc__more"
        aria-label={`Actions for ${title}`}
        onClick={() => onMenu(campaign)}
      >
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.6" fill="currentColor" /><circle cx="10" cy="10" r="1.6" fill="currentColor" /><circle cx="15.5" cy="10" r="1.6" fill="currentColor" />
        </svg>
      </button>

      {action?.style === 'pill' && (
        <button
          type="button"
          className={cls('cxc__pill', `is-${kind}`)}
          onClick={() => (action.id === 'setup' ? onContinueSetup(campaign) : onOpen(campaign))}
        >
          {action.label}
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}

      {action?.style === 'strip' && (
        <button
          type="button"
          className={cls('cxc__action', `is-${kind}`)}
          onClick={() => (action.id === 'setup' ? onContinueSetup(campaign) : onOpen(campaign))}
        >
          <span>{action.label}</span>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
    </article>
  )
}

/** A structural placeholder: marker, name, rail — the shape of the card to come. */
export function CampaignCardSkeleton() {
  return (
    <div className="cxc cxc--skeleton" aria-hidden="true">
      <span className="cxc-sk cxc-sk--marker" />
      <span className="cxc-sk cxc-sk--name" />
      <span className="cxc-sk cxc-sk--line" />
      <span className="cxc-sk cxc-sk--rail" />
    </div>
  )
}
