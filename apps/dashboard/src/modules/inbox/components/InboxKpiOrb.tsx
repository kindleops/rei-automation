import { createPortal } from 'react-dom'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { useBreakpoint } from '../../mobile/useBreakpoint'
import { CommandDrawer } from '../../shell/primitives/CommandDrawer'
import { type OperationalKpi, type OpsMessageTypeSection, type OpsQueueHealthSection } from '../../../lib/data/inboxKpis'
import { useOperationalKpis } from '../../../lib/data/operationalKpis'
import { usePerformanceIntelligence, type TimeWindow } from '../../../lib/data/performanceIntelligence'
import type { CockpitOpsSections } from '../../../lib/api/backendClient'
import { CountUp } from '../../../shared/motion/CountUp'
import './kpi-pulse.css'

// ── Types ──────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'overview',       label: 'Overview'     },
  { id: 'first-touch',    label: 'First Touch'  },
  { id: 'auto-replies',   label: 'Auto Replies' },
  { id: 'manual',         label: 'Manual'       },
  { id: 'queue',          label: 'Queue'        },
  { id: 'deliverability', label: 'Delivery'     },
  { id: 'templates',      label: 'Templates'    },
  { id: 'numbers',        label: 'Numbers'      },
  { id: 'pipeline',       label: 'Pipeline'     },
] as const

type SectionId = typeof SECTIONS[number]['id']
type AutoStage = 's1' | 's2' | 's3'
type KpiData = ReturnType<typeof useOperationalKpis>['kpis']
type OutlierData = ReturnType<typeof usePerformanceIntelligence>['outliers']

// ── Utilities ──────────────────────────────────────────────────────────────

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

function fmtRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return 'No data'
  return `${rate.toFixed(1)}%`
}

function fmtN(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—'
  return n.toLocaleString()
}

// ── Primitive components ───────────────────────────────────────────────────

type Tone = 'good' | 'warn' | 'bad' | 'dim'


/** A metric value that counts up when it is a plain number or a percentage. */
function MetricValue({ value }: { value: string | number }) {
  if (typeof value === 'number' && Number.isFinite(value)) return <CountUp value={value} format={(v) => Math.round(v).toLocaleString()} ms={900} />
  const text = String(value)
  const int = /^-?[\d,]+$/.test(text) ? Number(text.replace(/,/g, '')) : NaN
  if (Number.isFinite(int)) return <CountUp value={int} format={(v) => Math.round(v).toLocaleString()} ms={900} />
  const pctM = /^(-?\d+(?:\.\d+)?)%$/.exec(text)
  if (pctM) { const d = (pctM[1].split('.')[1] ?? '').length; return <CountUp value={Number(pctM[1])} format={(v) => `${v.toFixed(d)}%`} ms={900} /> }
  return <>{text}</>
}

// ── Pinning: hold any metric to put it in the top bar ─────────────────────

export interface PinnedKpi { id: string; label: string; value: string; tone?: Tone }
const PIN_KEY = 'nexus.kpiPin'
export function readPinnedKpi(): PinnedKpi | null {
  try { const raw = localStorage.getItem(PIN_KEY); return raw ? (JSON.parse(raw) as PinnedKpi) : null } catch { return null }
}
const PinCtx = createContext<{ section: string; pinnedId: string | null; onPin: (p: PinnedKpi) => void } | null>(null)

function MCard({ label, value, tone, span2, pinId }: {
  label: string
  value: string | number
  tone?: Tone
  span2?: boolean
  /** Stable id for pinning; defaults to `${section}:${label}`. */
  pinId?: string
}) {
  const ctx = useContext(PinCtx)
  const id = pinId ?? `${ctx?.section ?? 'kpi'}:${label}`
  const pinned = ctx?.pinnedId === id
  const timer = useRef<number | null>(null)
  const start = () => {
    if (!ctx) return
    timer.current = window.setTimeout(() => {
      try { navigator.vibrate?.(12) } catch { /* unsupported */ }
      ctx.onPin({ id, label, value: String(value), tone })
    }, 450)
  }
  const cancel = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null } }
  return (
    <div
      className={cls('nx-pulse-card', tone && `is-${tone}`, pinned && 'is-pinned')}
      style={span2 ? { gridColumn: 'span 2' } : undefined}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      title={ctx ? (pinned ? 'Hold to unpin from the top bar' : 'Hold to pin to the top bar') : undefined}
      data-kpi-pin={id}
    >
      <div className="nx-pulse-card__label">{label}</div>
      <div className="nx-pulse-card__value"><MetricValue value={value} /></div>
      {pinned && <span className="nx-pulse-card__pin" aria-label="Pinned to the top bar"><Icon name="pin" /></span>}
    </div>
  )
}

/** Every metric the panel can show, keyed like the cards, so a pin stays live. */
function flattenMetrics(k: KpiData): Record<string, PinnedKpi> {
  const out: Record<string, PinnedKpi> = {}
  if (!k) return out
  const st = (x?: string): Tone | undefined => (x === 'good' ? 'good' : x === 'critical' ? 'bad' : x === 'warning' ? 'warn' : undefined)
  for (const v of k.volume ?? []) out[`vol:${v.id}`] = { id: `vol:${v.id}`, label: v.label, value: fmtN(v.value), tone: st(v.tone) }
  for (const list of [k.messaging, k.quality, k.automation, k.pipeline, k.financial]) {
    for (const m of list ?? []) out[`kpi:${m.id}`] = { id: `kpi:${m.id}`, label: m.label, value: `${m.value}${m.unit ?? ''}`, tone: st(m.status) }
  }
  const sec = k.sections
  const add = (section: string, s: OpsMessageTypeSection | undefined) => {
    if (!s) return
    const put = (label: string, value: string) => { out[`${section}:${label}`] = { id: `${section}:${label}`, label, value } }
    put('Sent', fmtN(s.sent)); put('Delivered', fmtN(s.delivered)); put('Failed', fmtN(s.failed)); put('Replies', fmtN(s.replies))
    put('Delivery', fmtRate(s.delivery_rate)); put('Reply', fmtRate(s.reply_rate)); put('Failure', fmtRate(s.failure_rate))
  }
  add('first-touch', sec?.first_touch)
  add('manual', sec?.manual_replies)
  const q = sec?.queue_health
  if (q) {
    out['queue:Queued'] = { id: 'queue:Queued', label: 'Queued', value: fmtN(q.queued_active) }
    out['queue:Scheduled'] = { id: 'queue:Scheduled', label: 'Scheduled', value: fmtN(q.scheduled_future) }
    out['queue:Processing'] = { id: 'queue:Processing', label: 'Processing', value: fmtN(q.processing) }
    out['queue:Failed'] = { id: 'queue:Failed', label: 'Failed', value: fmtN(q.failed_total) }
  }
  return out
}

function Grid({ children, cols = 3 }: { children: React.ReactNode; cols?: number }) {
  return <div className="nx-pulse-grid" style={{ ['--cols' as string]: cols }}>{children}</div>
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return <div className="nx-pulse-sub">{children}</div>
}

function Empty() {
  return (
    <div className="nx-pulse-empty">
      <span className="nx-pulse-empty__orb" aria-hidden="true"><Icon name="activity" /></span>
      <strong>Quiet in this window</strong>
      <span>Nothing moved here yet — try a wider range.</span>
    </div>
  )
}

function HighlightCard({ tone, eyebrow, title, detail }: {
  tone: 'good' | 'bad'
  eyebrow: string
  title: string
  detail: string
}) {
  return (
    <div className={cls('nx-pulse-hl', `is-${tone}`)}>
      <div className="nx-pulse-hl__eyebrow">{eyebrow}</div>
      <div className="nx-pulse-hl__title">{title}</div>
      <div className="nx-pulse-hl__detail">{detail}</div>
    </div>
  )
}

// ── Section: Overview ──────────────────────────────────────────────────────

/** A ring that fills to a rate and counts up to it. */
function Gauge({ label, value, tone }: { label: string; value: number | null; tone: 'good' | 'warn' | 'bad' | 'dim' }) {
  const v = value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value))
  const C = 2 * Math.PI * 30
  return (
    <div className={cls('nx-pulse-gauge', `is-${tone}`)}>
      <svg viewBox="0 0 72 72" aria-hidden="true">
        <circle cx="36" cy="36" r="30" className="nx-pulse-gauge__track" />
        <circle cx="36" cy="36" r="30" className="nx-pulse-gauge__fill" style={{ strokeDasharray: `${v === null ? 0 : (C * v) / 100} ${C}` }} />
      </svg>
      <strong>{v === null ? '—' : <CountUp value={v} format={(x) => `${x.toFixed(v % 1 ? 1 : 0)}%`} ms={1200} />}</strong>
      <span>{label}</span>
    </div>
  )
}

function OverviewSection({ kpis }: { kpis: KpiData }) {
  if (!kpis) return <Empty />
  const vol = kpis.volume ?? []
  const msg = kpis.messaging ?? []
  const rate = (id: string) => { const k = msg.find((m) => m.id === id); const n = k ? Number(k.value) : NaN; return Number.isFinite(n) ? n : null }
  const toneOf = (id: string): 'good' | 'warn' | 'bad' | 'dim' => { const k = msg.find((m) => m.id === id); return !k ? 'dim' : k.status === 'good' ? 'good' : k.status === 'critical' ? 'bad' : k.status === 'warning' ? 'warn' : 'dim' }
  const sent = vol.find((v) => /sent/i.test(v.label))
  const received = vol.find((v) => /receiv|inbound|repl/i.test(v.label))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div className="nx-pulse-hero">
        <Gauge label="Delivered" value={rate('delivery-rate')} tone={toneOf('delivery-rate')} />
        <Gauge label="Reply rate" value={rate('reply-rate')} tone={toneOf('reply-rate')} />
        <div className="nx-pulse-hero__stack">
          <div><strong>{sent ? <MetricValue value={sent.value} /> : '—'}</strong><span>sent</span></div>
          <div><strong>{received ? <MetricValue value={received.value} /> : '—'}</strong><span>received</span></div>
        </div>
      </div>
      <Grid cols={4}>
        {vol.map(v => (
          <MCard
            key={v.id}
            pinId={`vol:${v.id}`}
            label={v.label}
            value={fmtN(v.value)}
            tone={v.tone === 'good' ? 'good' : v.tone === 'critical' ? 'bad' : v.tone === 'warning' ? 'warn' : undefined}
          />
        ))}
      </Grid>
      <Grid cols={3}>
        {msg.map(k => (
          <MCard
            key={k.id}
            pinId={`kpi:${k.id}`}
            label={k.label}
            value={`${k.value}${k.unit ?? ''}`}
            tone={k.status === 'good' ? 'good' : k.status === 'critical' ? 'bad' : k.status === 'warning' ? 'warn' : undefined}
          />
        ))}
      </Grid>
    </div>
  )
}

// ── Section: First Touch ───────────────────────────────────────────────────

function FirstTouchSection({ s }: { s: OpsMessageTypeSection | undefined }) {
  if (!s || (s.sent === 0 && s.queued === 0 && s.scheduled === 0)) return <Empty />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <Grid cols={3}>
        <MCard label="Queued"    value={fmtN(s.queued)}    />
        <MCard label="Scheduled" value={fmtN(s.scheduled)} />
        <MCard label="Sent"      value={fmtN(s.sent)}      />
        <MCard label="Delivered" value={fmtN(s.delivered)} tone={s.delivered > 0 ? 'good' : undefined} />
        <MCard label="Failed"    value={fmtN(s.failed)}    tone={s.failed > 0 ? 'bad' : undefined} />
        <MCard label="Replies"   value={fmtN(s.replies)}   />
      </Grid>

      <SubLabel>Rates</SubLabel>
      <Grid cols={4}>
        <MCard label="Delivery" value={fmtRate(s.delivery_rate)} tone={s.delivery_rate === null ? 'dim' : s.delivery_rate > 90 ? 'good' : 'bad'} />
        <MCard label="Failure"  value={fmtRate(s.failure_rate)}  tone={s.failure_rate === null ? 'dim' : s.failure_rate > 5 ? 'bad' : undefined} />
        <MCard label="Reply"    value={fmtRate(s.reply_rate)}    tone={s.reply_rate !== null && s.reply_rate > 8 ? 'good' : undefined} />
        <MCard label="Opt-Out"  value={fmtRate(s.opt_out_rate)}  tone={s.opt_out_rate === null ? 'dim' : s.opt_out_rate > 3 ? 'warn' : undefined} />
      </Grid>

      {(s.content_blocked > 0 || s.duplicate_blocked > 0 || s.invalid_number > 0 || s.opted_out > 0) && (
        <>
          <SubLabel>Blocks</SubLabel>
          <Grid cols={4}>
            {s.content_blocked > 0   && <MCard label="Content Blk"   value={fmtN(s.content_blocked)}   tone="warn" />}
            {s.duplicate_blocked > 0 && <MCard label="Dup Blk"       value={fmtN(s.duplicate_blocked)} tone="dim"  />}
            {s.invalid_number > 0    && <MCard label="Invalid #"      value={fmtN(s.invalid_number)}    tone="warn" />}
            {s.opted_out > 0         && <MCard label="Opted Out"      value={fmtN(s.opted_out)}         tone="bad"  />}
          </Grid>
        </>
      )}
    </div>
  )
}

// ── Section: Auto Replies ──────────────────────────────────────────────────

const STAGE_DEFS: { id: AutoStage; label: string; short: string; color: string }[] = [
  { id: 's1', label: 'Stage 1 — Ownership',        short: 'S1 Ownership', color: '#6366f1' },
  { id: 's2', label: 'Stage 2 — Selling Interest',  short: 'S2 Interest',  color: '#a855f7' },
  { id: 's3', label: 'Stage 3 — Price / Valuation', short: 'S3 Price',     color: '#eab308' },
]

function AutoRepliesSection({ sections, stage, onStage }: {
  sections: CockpitOpsSections | null | undefined
  stage: AutoStage
  onStage: (s: AutoStage) => void
}) {
  const s = stage === 's1' ? sections?.auto_replies.stage_1
          : stage === 's2' ? sections?.auto_replies.stage_2
          : sections?.auto_replies.stage_3

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Stage sub-tabs */}
      <div style={{ display: 'flex', gap: '4px' }}>
        {STAGE_DEFS.map(d => (
          <button
            key={d.id}
            onClick={() => onStage(d.id)}
            style={{
              flex: 1,
              padding: '5px 6px',
              borderRadius: '6px',
              border: `1px solid ${stage === d.id ? d.color : 'var(--nx-kpi-tab-inactive-border, rgba(255,255,255,0.08))'}`,
              background: stage === d.id ? `${d.color}1a` : 'var(--nx-kpi-tab-inactive-bg, rgba(255,255,255,0.03))',
              color: stage === d.id ? d.color : 'var(--nx-kpi-tab-inactive-text, rgba(255,255,255,0.38))',
              fontSize: '10px',
              fontWeight: stage === d.id ? 700 : 400,
              cursor: 'pointer',
            }}
          >
            {d.short}
          </button>
        ))}
      </div>

      {!s ? <Empty /> : (
        <>
          <Grid cols={3}>
            <MCard label="Sent"      value={fmtN(s.sent)}             />
            <MCard label="Delivered" value={fmtN(s.delivered)} tone={s.delivered > 0 ? 'good' : undefined} />
            <MCard label="Failed"    value={fmtN(s.failed)}    tone={s.failed > 0 ? 'bad' : undefined} />
            <MCard label="Replies"   value={fmtN(s.replies)}   />
            <MCard label="Positive"  value={fmtN(s.positive_replies)} tone={s.positive_replies > 0 ? 'good' : undefined} />
            <MCard label="Negative"  value={fmtN(s.negative_replies)} tone={s.negative_replies > 0 ? 'bad'  : undefined} />
          </Grid>

          <SubLabel>Rates</SubLabel>
          <Grid cols={4}>
            <MCard label="Delivery" value={fmtRate(s.delivery_rate)} tone={s.delivery_rate === null ? 'dim' : s.delivery_rate > 90 ? 'good' : 'bad'} />
            <MCard label="Reply"    value={fmtRate(s.reply_rate)}    />
            <MCard label="Positive" value={fmtRate(s.positive_rate)} tone={s.positive_rate !== null && s.positive_rate > 20 ? 'good' : undefined} />
            <MCard label="Opt-Out"  value={fmtRate(s.opt_out_rate)}  tone={s.opt_out_rate === null ? 'dim' : s.opt_out_rate > 3 ? 'warn' : undefined} />
          </Grid>

          {(s.unclear_replies > 0 || s.opt_outs > 0) && (
            <>
              <SubLabel>Reply breakdown</SubLabel>
              <Grid cols={3}>
                <MCard label="Positive" value={fmtN(s.positive_replies)} tone="good" />
                <MCard label="Negative" value={fmtN(s.negative_replies)} tone="bad"  />
                <MCard label="Unclear"  value={fmtN(s.unclear_replies)}  tone="dim"  />
              </Grid>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Section: Manual ────────────────────────────────────────────────────────

function ManualSection({ s }: { s: OpsMessageTypeSection | undefined }) {
  if (!s || (s.sent === 0 && s.queued === 0)) return <Empty />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <Grid cols={3}>
        <MCard label="Attempted"   value={fmtN(s.queued + s.sent + s.failed)} />
        <MCard label="Sent"        value={fmtN(s.sent)}      />
        <MCard label="Delivered"   value={fmtN(s.delivered)} tone={s.delivered > 0 ? 'good' : undefined} />
        <MCard label="Failed"      value={fmtN(s.failed)}    tone={s.failed > 0 ? 'bad' : undefined} />
        <MCard label="Replies"     value={fmtN(s.replies)}   />
        <MCard label="Content Blk" value={fmtN(s.content_blocked)} tone={s.content_blocked > 0 ? 'warn' : 'dim'} />
      </Grid>

      <SubLabel>Rates</SubLabel>
      <Grid cols={3}>
        <MCard label="Delivery" value={fmtRate(s.delivery_rate)} tone={s.delivery_rate === null ? 'dim' : s.delivery_rate > 90 ? 'good' : 'bad'} />
        <MCard label="Failure"  value={fmtRate(s.failure_rate)}  tone={s.failure_rate === null ? 'dim' : s.failure_rate > 5 ? 'bad' : undefined} />
        <MCard label="Reply"    value={fmtRate(s.reply_rate)}    tone={s.reply_rate !== null && s.reply_rate > 15 ? 'good' : undefined} />
      </Grid>
    </div>
  )
}

// ── Section: Queue Health ──────────────────────────────────────────────────

function QueueSection({ q }: { q: OpsQueueHealthSection | undefined }) {
  if (!q) return <Empty />
  const topReason = Object.entries(q.failed_by_reason ?? {}).sort((a, b) => b[1] - a[1])[0]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <SubLabel>Live state</SubLabel>
      <Grid cols={3}>
        <MCard label="Queued"     value={fmtN(q.queued_active)}    tone={q.queued_active > 100 ? 'warn' : undefined} />
        <MCard label="Scheduled"  value={fmtN(q.scheduled_future)} />
        <MCard label="Processing" value={fmtN(q.processing)}       />
      </Grid>

      <SubLabel>Issues</SubLabel>
      <Grid cols={3}>
        <MCard label="Stale Rows"  value={fmtN(q.stale_active)}         tone={q.stale_active > 0 ? 'bad' : 'dim'}  />
        <MCard label="Dup Blocked" value={fmtN(q.duplicate_blocked)}    tone={q.duplicate_blocked > 0 ? 'warn' : 'dim'} />
        <MCard label="Cnt Blocked" value={fmtN(q.content_blocked_today)} tone={q.content_blocked_today > 0 ? 'warn' : 'dim'} />
        <MCard label="Expired"     value={fmtN(q.expired)}    tone="dim" />
        <MCard label="Cancelled"   value={fmtN(q.cancelled)}  tone="dim" />
        <MCard label="Failed"      value={fmtN(q.failed_total)} tone={q.failed_total > 0 ? 'bad' : 'dim'} />
      </Grid>

      {topReason && (
        <div style={{ fontSize: '11px', color: 'var(--nx-kpi-info-muted, rgba(255,255,255,0.38))', padding: '7px 10px', background: 'var(--nx-kpi-info-bg, rgba(255,255,255,0.03))', borderRadius: '6px' }}>
          Top failure: <span style={{ color: 'var(--nx-kpi-warn, #f97316)', fontWeight: 600 }}>{topReason[0]}</span>
          {' '}({fmtN(topReason[1])})
        </div>
      )}
    </div>
  )
}

// ── Section: Deliverability ────────────────────────────────────────────────

function DeliverabilitySection({ kpis, sections }: { kpis: KpiData; sections: CockpitOpsSections | null | undefined }) {
  const fr = sections?.failure_reasons
  const sorted = fr ? Object.entries(fr.by_reason).sort((a, b) => b[1] - a[1]).slice(0, 5) : []
  const msg = kpis?.messaging ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <Grid cols={3}>
        {msg.filter(k => ['delivery-rate','failure-rate','opt-out-rate'].includes(k.id)).map(k => (
          <MCard
            key={k.id}
            label={k.label}
            value={`${k.value}${k.unit ?? ''}`}
            tone={k.status === 'good' ? 'good' : k.status === 'critical' ? 'bad' : k.status === 'warning' ? 'warn' : undefined}
          />
        ))}
        {fr && (
          <MCard label="Total Failures" value={fmtN(fr.total)} tone={fr.total > 0 ? 'bad' : 'dim'} />
        )}
        {sections && (
          <MCard
            label="Content Blk (all)"
            value={fmtN(
              (sections.first_touch.content_blocked ?? 0) +
              (sections.auto_replies.stage_1.content_blocked ?? 0) +
              (sections.auto_replies.stage_2.content_blocked ?? 0) +
              (sections.auto_replies.stage_3.content_blocked ?? 0) +
              (sections.manual_replies.content_blocked ?? 0)
            )}
            tone="warn"
          />
        )}
      </Grid>

      {sorted.length > 0 && (
        <>
          <SubLabel>Failure reasons</SubLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {sorted.map(([reason, count]) => (
              <div key={reason} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 10px', background: 'var(--nx-kpi-info-bg, rgba(255,255,255,0.03))', borderRadius: '6px',
              }}>
                <span style={{ fontSize: '10px', color: 'var(--nx-kpi-info-muted, rgba(255,255,255,0.5))', fontFamily: 'monospace' }}>{reason}</span>
                <span style={{ fontSize: '12px', fontWeight: 700, color: count > 5 ? 'var(--nx-kpi-bad, #ff4466)' : 'var(--nx-kpi-warn, #f97316)' }}>{fmtN(count)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Section: Templates ─────────────────────────────────────────────────────

function TemplatesSection({ sections, outliers }: { sections: CockpitOpsSections | null | undefined; outliers: OutlierData }) {
  const top = sections?.template_outliers.top ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        {outliers?.bestTemplate && (
          <HighlightCard
            tone="good"
            eyebrow="Best Template"
            title={outliers.bestTemplate.template_key}
            detail={`${(outliers.bestTemplate.positive_rate_pct ?? 0).toFixed(1)}% pos · ${outliers.bestTemplate.sends} sends`}
          />
        )}
        {outliers?.riskiestTemplate && (
          <HighlightCard
            tone="bad"
            eyebrow="Riskiest Template"
            title={outliers.riskiestTemplate.template_key}
            detail={`${(outliers.riskiestTemplate.opt_out_rate_pct ?? 0).toFixed(1)}% opt-out`}
          />
        )}
      </div>

      {top.length > 0 && (
        <>
          <SubLabel>Top by volume</SubLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {top.slice(0, 6).map(t => (
              <div key={t.template_id} style={{
                display: 'grid', gridTemplateColumns: '1fr auto auto auto',
                gap: '10px', padding: '6px 10px', background: 'var(--nx-kpi-info-bg, rgba(255,255,255,0.03))', borderRadius: '6px', alignItems: 'center',
              }}>
                <span style={{ fontFamily: 'monospace', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--nx-kpi-info-title, rgba(255,255,255,0.68))' }}>
                  {t.template_id}
                </span>
                <span style={{ fontSize: '10px', color: 'var(--nx-kpi-info-label, rgba(255,255,255,0.35))' }}>{fmtN(t.sent)} sent</span>
                <span style={{ fontSize: '10px', color: t.failed > 0 ? 'var(--nx-kpi-bad, #ff4466)' : 'var(--nx-kpi-info-muted, rgba(255,255,255,0.22))' }}>{fmtN(t.failed)} fail</span>
                <span style={{ fontSize: '10px', color: t.failure_rate !== null && t.failure_rate > 10 ? 'var(--nx-kpi-bad, #ff4466)' : 'var(--nx-kpi-info-label, rgba(255,255,255,0.32))' }}>
                  {fmtRate(t.failure_rate)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Section: Numbers ───────────────────────────────────────────────────────

function NumbersSection({ sections, outliers }: { sections: CockpitOpsSections | null | undefined; outliers: OutlierData }) {
  const top = sections?.number_outliers.top ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        {outliers?.bestNumber && (
          <HighlightCard
            tone="good"
            eyebrow="Best Number"
            title={outliers.bestNumber.textgrid_number_key}
            detail={`${(outliers.bestNumber.delivery_rate_pct ?? 0).toFixed(0)}% del · ${(outliers.bestNumber.reply_rate_pct ?? 0).toFixed(1)}% rep`}
          />
        )}
        {outliers?.riskiestNumber && (
          <HighlightCard
            tone="bad"
            eyebrow="Riskiest Number"
            title={outliers.riskiestNumber.textgrid_number_key}
            detail={`${(outliers.riskiestNumber.failure_rate_pct ?? 0).toFixed(1)}% fail · ${(outliers.riskiestNumber.opt_out_rate_pct ?? 0).toFixed(1)}% opt`}
          />
        )}
      </div>

      {top.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          {top.slice(0, 7).map(n => (
            <div key={n.number} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto auto auto',
              gap: '8px', padding: '6px 10px', background: 'var(--nx-kpi-info-bg, rgba(255,255,255,0.03))', borderRadius: '6px', alignItems: 'center',
            }}>
              <span style={{ fontFamily: 'monospace', fontSize: '10px', color: 'var(--nx-kpi-info-title, rgba(255,255,255,0.65))' }}>{n.number}</span>
              <span style={{ fontSize: '10px', color: 'var(--nx-kpi-info-muted, rgba(255,255,255,0.3))' }}>{fmtN(n.sent)}</span>
              <span style={{ fontSize: '10px', color: n.delivery_rate !== null && n.delivery_rate > 90 ? 'var(--nx-kpi-good, #00e87a)' : 'var(--nx-kpi-bad, #ff4466)' }}>{fmtRate(n.delivery_rate)}</span>
              <span style={{ fontSize: '10px', color: 'var(--nx-kpi-info-text, rgba(255,255,255,0.42))' }}>{fmtRate(n.reply_rate)}</span>
              <span style={{ fontSize: '10px', color: n.opt_out_rate !== null && n.opt_out_rate > 3 ? 'var(--nx-kpi-warn, #f97316)' : 'var(--nx-kpi-info-muted, rgba(255,255,255,0.28))' }}>{fmtRate(n.opt_out_rate)}</span>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto auto', gap: '8px', padding: '2px 10px', fontSize: '8px', color: 'var(--nx-kpi-info-muted, rgba(255,255,255,0.2))', letterSpacing: '0.05em' }}>
            <span />
            <span>SENT</span><span>DEL%</span><span>REP%</span><span>OPT%</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Section: Pipeline ──────────────────────────────────────────────────────

function PipelineSection({ kpis }: { kpis: KpiData }) {
  if (!kpis) return <Empty />

  const totalReplies = (kpis.volume ?? []).find(v => v.id === 'received')?.value ?? 0
  const sec = kpis.sections

  const totalPositive = sec
    ? sec.first_touch.positive_replies +
      sec.auto_replies.stage_1.positive_replies +
      sec.auto_replies.stage_2.positive_replies +
      sec.auto_replies.stage_3.positive_replies
    : null

  const totalNegative = sec
    ? sec.first_touch.negative_replies +
      sec.auto_replies.stage_1.negative_replies +
      sec.auto_replies.stage_2.negative_replies +
      sec.auto_replies.stage_3.negative_replies
    : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <Grid cols={3}>
        <MCard label="Total Replies"   value={fmtN(totalReplies)} />
        <MCard label="Positive Intent" value={totalPositive !== null ? fmtN(totalPositive) : '—'} tone="good" />
        <MCard label="Negative Intent" value={totalNegative !== null ? fmtN(totalNegative) : '—'} tone="bad" />
        {(kpis.quality ?? []).map(k => (
          <MCard
            key={k.id}
            label={k.label}
            value={k.isAvailable ? `${k.value}${k.unit ?? ''}` : 'No data'}
            tone={!k.isAvailable ? 'dim' : k.status === 'good' ? 'good' : undefined}
          />
        ))}
        {(kpis.pipeline ?? []).map(k => (
          <MCard
            key={k.id}
            label={k.label}
            value={k.isAvailable ? `${k.value}${k.unit ?? ''}` : 'No data'}
            tone={!k.isAvailable ? 'dim' : undefined}
          />
        ))}
      </Grid>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

const HOVER_CLOSE_MS = 140

export const InboxKpiOrb = () => {
  const { isMobile } = useBreakpoint()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dashboardRef = useRef<HTMLDivElement | null>(null)
  const hoverCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isTouchUi, setIsTouchUi] = useState(false)
  const [dashboardPosition, setDashboardPosition] = useState<{ top: number; left: number } | null>(null)
  const [isOpen, setIsOpen]   = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [timeWindow, setTimeWindow] = useState<OperationalKpi['timeWindow']>('24h')
  const [section, setSection] = useState<SectionId>(
    () => (localStorage.getItem('nexus.kpiSection') as SectionId | null) ?? 'overview'
  )
  const [autoStage, setAutoStage] = useState<AutoStage>('s1')

  useEffect(() => {
    const media = window.matchMedia('(hover: none), (pointer: coarse)')
    const apply = () => setIsTouchUi(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  const kpiPanelActive = isOpen || isPinned
  const useDrawerPanel = isMobile || isTouchUi
  // The phone bar carries a live readout, so telemetry runs while the panel is
  // closed there (realtime-driven, idle-deferred — cheap).
  const { kpis, isLive, recommendations, error: kpiError, refresh: refreshKpis } = useOperationalKpis(timeWindow, { enabled: kpiPanelActive || isMobile })

  // ── Pinned metric in the bar ──
  const [pin, setPin] = useState<PinnedKpi | null>(() => (typeof window === 'undefined' ? null : readPinnedKpi()))
  const [pinToast, setPinToast] = useState<string | null>(null)
  const flat = useMemo(() => flattenMetrics(kpis), [kpis])
  const onPin = useCallback((p: PinnedKpi) => {
    setPin((cur) => {
      const next = cur?.id === p.id ? null : p
      try { if (next) localStorage.setItem('nexus.kpiPin', JSON.stringify(next)); else localStorage.removeItem('nexus.kpiPin') } catch { /* private mode */ }
      setPinToast(next ? `${p.label} pinned to the bar` : `${p.label} unpinned`)
      window.setTimeout(() => setPinToast(null), 1800)
      return next
    })
  }, [])
  const { outliers } = usePerformanceIntelligence(timeWindow as TimeWindow, { enabled: kpiPanelActive })

  const allKpisList = useMemo(() => {
    if (!kpis) return []
    return [...kpis.messaging, ...kpis.quality, ...kpis.automation, ...kpis.pipeline, ...kpis.financial]
  }, [kpis])

  const headlineKpi = useMemo(
    () => allKpisList.find(k => k.id === 'reply-rate') ?? allKpisList[0],
    [allKpisList]
  )
  // What the bar shows: the pinned metric (kept live), else reply rate.
  const readout = useMemo(() => {
    if (pin) return flat[pin.id] ?? pin
    return headlineKpi ? { id: `kpi:${headlineKpi.id}`, label: headlineKpi.label, value: `${headlineKpi.value}${headlineKpi.unit ?? '%'}` } : null
  }, [pin, flat, headlineKpi])

  const orbTone = useMemo(() => {
    if (!kpis) return 'neutral'
    if (allKpisList.some(k => k.status === 'critical')) return 'critical'
    if (allKpisList.some(k => k.status === 'warning'))  return 'warning'
    return 'good'
  }, [allKpisList, kpis])

  const handleSection = (s: SectionId) => {
    setSection(s)
    localStorage.setItem('nexus.kpiSection', s)
  }

  const openPanel = useCallback(() => {
    if (hoverCloseRef.current) {
      clearTimeout(hoverCloseRef.current)
      hoverCloseRef.current = null
    }
    setIsOpen(true)
  }, [])

  const scheduleClose = useCallback(() => {
    if (isPinned) return
    if (hoverCloseRef.current) clearTimeout(hoverCloseRef.current)
    hoverCloseRef.current = setTimeout(() => setIsOpen(false), HOVER_CLOSE_MS)
  }, [isPinned])

  const updateDashboardPosition = useCallback(() => {
    const anchor = containerRef.current?.getBoundingClientRect()
    const panel = dashboardRef.current
    if (!anchor) return

    const panelWidth = panel?.offsetWidth || Math.min(380, window.innerWidth - 24)
    const gap = 16
    let left = anchor.right - panelWidth
    if (left < 12) left = 12
    if (left + panelWidth > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - panelWidth - 12)
    }

    setDashboardPosition({
      top: anchor.bottom + gap,
      left,
    })
  }, [])

  useLayoutEffect(() => {
    if (!kpiPanelActive || useDrawerPanel) {
      setDashboardPosition(null)
      return
    }
    updateDashboardPosition()
  }, [kpiPanelActive, useDrawerPanel, updateDashboardPosition, section, timeWindow])

  useEffect(() => {
    if (!kpiPanelActive) return
    const handleViewportChange = () => updateDashboardPosition()
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [kpiPanelActive, updateDashboardPosition])

  useEffect(() => () => {
    if (hoverCloseRef.current) clearTimeout(hoverCloseRef.current)
  }, [])

  useEffect(() => {
    if (!useDrawerPanel || !kpiPanelActive || isPinned) return
    const handlePointer = (event: Event) => {
      const target = event.target as Node
      if (containerRef.current?.contains(target)) return
      if (dashboardRef.current?.contains(target)) return
      setIsOpen(false)
    }
    window.addEventListener('mousedown', handlePointer)
    window.addEventListener('touchstart', handlePointer, { passive: true })
    return () => {
      window.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('touchstart', handlePointer)
    }
  }, [useDrawerPanel, kpiPanelActive, isPinned])

  const closePanel = useCallback(() => {
    setIsOpen(false)
    setIsPinned(false)
  }, [])

  const handleOrbClick = useCallback(() => {
    if (useDrawerPanel) {
      setIsOpen((open) => !open)
      return
    }
    setIsPinned((pinned) => !pinned)
  }, [useDrawerPanel])

  const dashboardBody = kpiPanelActive ? (
    <>
          {/* Header */}
          <div className="nx-orb-dashboard__header nx-pulse-head">
            <div className="nx-pulse-head__title">
              <strong>Operations pulse</strong>
              <span className={cls('nx-pulse-live', isLive && 'is-live')}>
                <i aria-hidden="true" />{isLive ? 'Live' : 'System telemetry'}
              </span>
            </div>
            <div className="nx-pulse-range" role="radiogroup" aria-label="Time window">
              {(['today', '24h', '7d', '30d'] as const).map(w => (
                <button
                  key={w}
                  type="button"
                  role="radio"
                  aria-checked={timeWindow === w}
                  className={cls('nx-pulse-range__btn', timeWindow === w && 'is-on')}
                  onClick={e => { e.stopPropagation(); setTimeWindow(w) }}
                >
                  {w === 'today' ? 'Today' : w.toUpperCase()}
                </button>
              ))}
              <button type="button" className={cls('nx-pulse-refresh', !kpis && 'is-spinning')} aria-label="Refresh" onClick={e => { e.stopPropagation(); refreshKpis() }}>
                <Icon name="refresh-cw" />
              </button>
            </div>
          </div>

          {/* Section tabs */}
          <div className="nx-pulse-tabs" role="tablist">
            {SECTIONS.map(s => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={section === s.id}
                className={cls('nx-pulse-tab', section === s.id && 'is-on')}
                onClick={() => handleSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* Error banner */}
          {kpiError && (
            <div style={{
              margin: '8px 12px 0',
              padding: '7px 10px',
              background: 'var(--nx-kpi-error-bg, rgba(255,0,0,0.08))',
              border: '1px solid var(--nx-kpi-error-border, rgba(255,0,0,0.2))',
              borderRadius: '6px',
              fontSize: '11px',
              color: 'var(--nx-kpi-error-text, #ff6b6b)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexShrink: 0,
            }}>
              <span>Telemetry error</span>
              <button
                onClick={() => refreshKpis()}
                style={{ background: 'rgba(255,255,255,0.1)', border: 'none', padding: '2px 8px', borderRadius: '4px', color: 'white', cursor: 'pointer', fontSize: '10px' }}
              >
                Retry
              </button>
            </div>
          )}

          {/* Section content */}
          {pinToast && <div className="nx-pulse-toast" role="status"><Icon name="pin" />{pinToast}</div>}
          <PinCtx.Provider value={{ section: section === 'overview' ? 'kpi' : section === 'queue' ? 'queue' : section, pinnedId: pin?.id ?? null, onPin }}>
          <div className="nx-pulse-body" key={`${section}:${timeWindow}`}>
            {!kpis ? (
              <div className="nx-pulse-skel" aria-label="Loading metrics"><i /><i /><i /><i /><i /><i /></div>
            ) : (
              <>
                {section === 'overview'       && <OverviewSection kpis={kpis} />}
                {section === 'first-touch'    && <FirstTouchSection s={kpis.sections?.first_touch} />}
                {section === 'auto-replies'   && <AutoRepliesSection sections={kpis.sections} stage={autoStage} onStage={setAutoStage} />}
                {section === 'manual'         && <ManualSection s={kpis.sections?.manual_replies} />}
                {section === 'queue'          && <QueueSection q={kpis.sections?.queue_health} />}
                {section === 'deliverability' && <DeliverabilitySection kpis={kpis} sections={kpis.sections} />}
                {section === 'templates'      && <TemplatesSection sections={kpis.sections} outliers={outliers} />}
                {section === 'numbers'        && <NumbersSection sections={kpis.sections} outliers={outliers} />}
                {section === 'pipeline'       && <PipelineSection kpis={kpis} />}
              </>
            )}
            <p className="nx-pulse-hint"><Icon name="pin" />Hold any metric to pin it to the top bar</p>
          </div>
          </PinCtx.Provider>

          {/* AI Recommendation strip */}
          {recommendations.length > 0 && (
            <div className="nx-pulse-rec">
              <span className="nx-pulse-rec__icon" aria-hidden="true"><Icon name="spark" /></span>
              <div>
                <div className="nx-pulse-rec__label">Recommendation</div>
                <div className="nx-pulse-rec__text">{recommendations[0]}</div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="nx-pulse-foot">
            <span className={cls('nx-pulse-foot__state', kpiError && 'is-bad')}><i aria-hidden="true" />{kpiError ? 'Unavailable' : 'Up to date'}</span>
            <span>{kpis?.lastUpdated ? `Synced ${new Date(kpis.lastUpdated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Connecting…'}</span>
          </div>
    </>
  ) : null

  const dashboardPopover = !useDrawerPanel && dashboardPosition && dashboardBody ? (
    <div
      ref={dashboardRef}
      className="nx-orb-dashboard nx-liquid-popover nx-shell-popover-portal"
      style={{
        position: 'fixed',
        top: dashboardPosition.top,
        left: dashboardPosition.left,
        zIndex: 13000,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      onMouseEnter={openPanel}
      onMouseLeave={scheduleClose}
    >
      {dashboardBody}
    </div>
  ) : null

  return (
    <div
      ref={containerRef}
      className={cls('nx-kpi-orb-container', kpiPanelActive && 'is-open')}
      onMouseEnter={useDrawerPanel ? undefined : openPanel}
      onMouseLeave={useDrawerPanel ? undefined : scheduleClose}
    >
      <div
        className={cls('nx-kpi-orb', isPinned && 'is-pinned-active', isLive && 'is-live-pulsing', `is-${orbTone}`)}
        onClick={handleOrbClick}
        role="button"
        tabIndex={0}
        aria-expanded={kpiPanelActive}
        aria-label="KPI Intelligence"
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            handleOrbClick()
          }
        }}
      >
        <div className="nx-kpi-orb__glow" />
        <div className="nx-kpi-orb__inner">
          <div className={cls('nx-kpi-orb__icon-box', isLive && 'is-active')}>
            <Icon name={isLive ? 'zap' : 'activity'} />
          </div>
          {headlineKpi && (
            <span className="nx-kpi-orb__mini-value">{headlineKpi.value}{headlineKpi.unit || '%'}</span>
          )}
          {readout && (
            <span className={cls('nx-kpi-orb__readout', pin && 'is-pinned')} key={readout.id}>
              <b>{readout.value}</b>
              <em>{readout.label}</em>
              <i className="nx-kpi-orb__flow" aria-hidden="true" />
            </span>
          )}
          {isLive && <div className="nx-kpi-orb__live-tag">•</div>}
        </div>
      </div>

      {useDrawerPanel ? (
        isMobile ? (
          kpiPanelActive && typeof document !== 'undefined'
            ? createPortal(
              <>
                <div className="nx-pulse-scrim" aria-hidden="true" />
                <div ref={dashboardRef} className="nx-orb-dashboard nx-pulse-drop" role="dialog" aria-label="Operations pulse">
                  <span className="nx-pulse-drop__liquid" aria-hidden="true"><i /><i /><i /></span>
                  {dashboardBody}
                </div>
              </>,
              document.body,
            )
            : null
        ) : (
          <CommandDrawer open={kpiPanelActive} title="KPI Intelligence" onClose={closePanel} fullWidth>
            <div ref={dashboardRef} className="nx-orb-dashboard nx-orb-dashboard--drawer">
              {dashboardBody}
            </div>
          </CommandDrawer>
        )
      ) : (
        typeof document !== 'undefined' && dashboardPopover
          ? createPortal(dashboardPopover, document.body)
          : null
      )}
    </div>
  )
}
