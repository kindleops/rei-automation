import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { type OperationalKpi, type OpsMessageTypeSection, type OpsQueueHealthSection } from '../../../lib/data/inboxKpis'
import { useOperationalKpis } from '../../../lib/data/operationalKpis'
import { usePerformanceIntelligence, type TimeWindow } from '../../../lib/data/performanceIntelligence'
import type { CockpitOpsSections } from '../../../lib/api/backendClient'

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

const TONE_COLOR: Record<Tone, string> = {
  good: 'var(--nx-kpi-good, #00e87a)',
  warn: 'var(--nx-kpi-warn, #f97316)',
  bad:  'var(--nx-kpi-bad, #ff4466)',
  dim:  'var(--nx-kpi-dim, rgba(255,255,255,0.3))',
}

function MCard({ label, value, tone, span2 }: {
  label: string
  value: string | number
  tone?: Tone
  span2?: boolean
}) {
  const color = tone ? TONE_COLOR[tone] : 'var(--nx-kpi-card-value, rgba(255,255,255,0.92))'
  return (
    <div style={{
      background: 'var(--nx-kpi-card-bg, rgba(255,255,255,0.04))',
      border: '1px solid var(--nx-kpi-card-border, rgba(255,255,255,0.06))',
      borderRadius: '8px',
      padding: '9px 11px',
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      gridColumn: span2 ? 'span 2' : undefined,
    }}>
      <div style={{ fontSize: '9px', color: 'var(--nx-kpi-card-label, rgba(255,255,255,0.32))', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </div>
      <div style={{ fontSize: '17px', fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
        {value}
      </div>
    </div>
  )
}

function Grid({ children, cols = 3 }: { children: React.ReactNode; cols?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '5px' }}>
      {children}
    </div>
  )
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '9px', color: 'var(--nx-kpi-sublabel, rgba(255,255,255,0.28))', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: '4px' }}>
      {children}
    </div>
  )
}

function Empty() {
  return (
    <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--nx-kpi-empty, rgba(255,255,255,0.22))', fontSize: '12px', fontStyle: 'italic' }}>
      No activity in this window
    </div>
  )
}

function HighlightCard({ tone, eyebrow, title, detail }: {
  tone: 'good' | 'bad'
  eyebrow: string
  title: string
  detail: string
}) {
  const c = tone === 'good' ? 'var(--nx-kpi-good, #00e87a)' : 'var(--nx-kpi-bad, #ff4466)'
  const bg = tone === 'good' ? 'var(--nx-kpi-good-bg, rgba(0, 232, 122, 0.05))' : 'var(--nx-kpi-bad-bg, rgba(255, 68, 102, 0.05))'
  const border = tone === 'good' ? 'var(--nx-kpi-good-border, rgba(0, 232, 122, 0.15))' : 'var(--nx-kpi-bad-border, rgba(255, 68, 102, 0.15))'
  return (
    <div style={{
      padding: '9px 12px',
      background: bg,
      border: `1px solid ${border}`,
      borderRadius: '8px',
      fontSize: '11px',
    }}>
      <div style={{ fontSize: '8px', color: c, textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: '3px' }}>{eyebrow}</div>
      <div style={{ fontWeight: 600, marginBottom: '2px', color: 'var(--nx-kpi-highlight-title, rgba(255,255,255,0.85))' }}>{title}</div>
      <div style={{ color: 'var(--nx-kpi-highlight-detail, rgba(255,255,255,0.38))', fontSize: '10px' }}>{detail}</div>
    </div>
  )
}

// ── Section: Overview ──────────────────────────────────────────────────────

function OverviewSection({ kpis }: { kpis: KpiData }) {
  if (!kpis) return <Empty />
  const vol = kpis.volume ?? []
  const msg = kpis.messaging ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <Grid cols={4}>
        {vol.map(v => (
          <MCard
            key={v.id}
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

export const InboxKpiOrb = () => {
  const [isOpen, setIsOpen]   = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [timeWindow, setTimeWindow] = useState<OperationalKpi['timeWindow']>('24h')
  const [section, setSection] = useState<SectionId>(
    () => (localStorage.getItem('nexus.kpiSection') as SectionId | null) ?? 'overview'
  )
  const [autoStage, setAutoStage] = useState<AutoStage>('s1')

  const { kpis, isLive, recommendations, error: kpiError, refresh: refreshKpis } = useOperationalKpis(timeWindow)
  const { outliers } = usePerformanceIntelligence(timeWindow as TimeWindow)

  const allKpisList = useMemo(() => {
    if (!kpis) return []
    return [...kpis.messaging, ...kpis.quality, ...kpis.automation, ...kpis.pipeline, ...kpis.financial]
  }, [kpis])

  const headlineKpi = useMemo(
    () => allKpisList.find(k => k.id === 'reply-rate') ?? allKpisList[0],
    [allKpisList]
  )

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

  return (
    <div
      className={cls('nx-kpi-orb-container', (isOpen || isPinned) && 'is-open')}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => !isPinned && setIsOpen(false)}
    >
      {/* ── Orb capsule ─────────────────────────────────────────────────── */}
      <div
        className={cls('nx-kpi-orb', isPinned && 'is-pinned-active', isLive && 'is-live-pulsing', `is-${orbTone}`)}
        onClick={() => setIsPinned(p => !p)}
      >
        <div className="nx-kpi-orb__glow" />
        <div className="nx-kpi-orb__inner">
          <div className={cls('nx-kpi-orb__icon-box', isLive && 'is-active')}>
            <Icon name={isLive ? 'zap' : 'activity'} />
          </div>
          {headlineKpi && (
            <span className="nx-kpi-orb__mini-value">{headlineKpi.value}{headlineKpi.unit || '%'}</span>
          )}
          {isLive && <div className="nx-kpi-orb__live-tag">•</div>}
        </div>
      </div>

      {/* ── Intelligence panel ───────────────────────────────────────────── */}
      {(isOpen || isPinned) && (
        <div
          className="nx-orb-dashboard nx-glass-popover"
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
          {/* Header */}
          <div style={{
            padding: '11px 14px 10px',
            borderBottom: '1px solid var(--nx-kpi-border, rgba(255,255,255,0.06))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.03em', color: 'var(--nx-kpi-title, rgba(255,255,255,0.9))' }}>
                Operational Intelligence
              </div>
              <div style={{ fontSize: '9px', color: 'var(--nx-kpi-subtitle, rgba(255,255,255,0.3))', marginTop: '1px' }}>
                {isLive ? '⚡ Live' : 'System telemetry'}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
              {(['today', '24h', '7d', '30d'] as const).map(w => (
                <button
                  key={w}
                  onClick={e => { e.stopPropagation(); setTimeWindow(w) }}
                  style={{
                    padding: '3px 7px',
                    borderRadius: '5px',
                    border: 'none',
                    background: timeWindow === w ? 'var(--nx-kpi-active-btn-bg, rgba(56,208,240,0.14))' : 'var(--nx-kpi-btn-bg, rgba(255,255,255,0.06))',
                    color: timeWindow === w ? 'var(--nx-kpi-active-btn-color, #38d0f0)' : 'var(--nx-kpi-btn-color, rgba(255,255,255,0.38))',
                    fontSize: '9px',
                    fontWeight: timeWindow === w ? 700 : 400,
                    cursor: 'pointer',
                    letterSpacing: '0.04em',
                  }}
                >
                  {w.toUpperCase()}
                </button>
              ))}
              <button
                onClick={e => { e.stopPropagation(); refreshKpis() }}
                style={{
                  marginLeft: '2px',
                  padding: '3px 5px',
                  borderRadius: '5px',
                  border: 'none',
                  background: 'var(--nx-kpi-btn-bg, rgba(255,255,255,0.06))',
                  color: 'var(--nx-kpi-btn-color, rgba(255,255,255,0.35))',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <Icon name="refresh-cw" />
              </button>
            </div>
          </div>

          {/* Section pills */}
          <div style={{
            display: 'flex',
            gap: '4px',
            padding: '7px 10px',
            borderBottom: '1px solid var(--nx-kpi-border, rgba(255,255,255,0.06))',
            overflowX: 'auto',
            flexShrink: 0,
            scrollbarWidth: 'none',
          }}>
            {SECTIONS.map(s => (
              <button
                key={s.id}
                onClick={() => handleSection(s.id)}
                style={{
                  padding: '3px 9px',
                  borderRadius: '20px',
                  border: `1px solid ${section === s.id ? 'var(--nx-kpi-active-pill-border, #38d0f0)' : 'var(--nx-kpi-pill-border, rgba(255,255,255,0.08))'}`,
                  background: section === s.id ? 'var(--nx-kpi-active-pill-bg, rgba(56,208,240,0.1))' : 'transparent',
                  color: section === s.id ? 'var(--nx-kpi-active-pill-color, #38d0f0)' : 'var(--nx-kpi-pill-color, rgba(255,255,255,0.38))',
                  fontSize: '10px',
                  fontWeight: section === s.id ? 700 : 400,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
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
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '10px 12px',
            scrollbarWidth: 'thin',
            scrollbarColor: 'var(--nx-kpi-scrollbar, rgba(255,255,255,0.08)) transparent',
          }}>
            {!kpis ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100px', color: 'rgba(255,255,255,0.22)', fontSize: '12px' }}>
                Loading...
              </div>
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
          </div>

          {/* AI Recommendation strip */}
          {recommendations.length > 0 && (
            <div style={{
              borderTop: '1px solid var(--nx-kpi-border, rgba(255,255,255,0.06))',
              padding: '7px 12px',
              flexShrink: 0,
              background: 'var(--nx-kpi-rec-bg, rgba(99,102,241,0.05))',
            }}>
              <div style={{ fontSize: '8px', color: 'var(--nx-kpi-rec-label, #6366f1)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '3px' }}>
                AI Rec
              </div>
              <div style={{ fontSize: '10px', color: 'var(--nx-kpi-rec-text, rgba(255,255,255,0.52))', lineHeight: 1.4 }}>
                {recommendations[0]}
              </div>
            </div>
          )}

          {/* Footer */}
          <div style={{
            borderTop: '1px solid var(--nx-kpi-border, rgba(255,255,255,0.06))',
            padding: '5px 12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '9px', color: 'var(--nx-kpi-footer-text, rgba(255,255,255,0.28))' }}>
              <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: kpiError ? 'var(--nx-kpi-bad, #ff4466)' : 'var(--nx-kpi-good, #00e87a)' }} />
              {kpiError ? 'Error' : 'Nominal'}
            </div>
            <div style={{ fontSize: '9px', color: 'var(--nx-kpi-footer-sync, rgba(255,255,255,0.22))' }}>
              {kpis?.lastUpdated ? `Sync ${new Date(kpis.lastUpdated).toLocaleTimeString()}` : 'Connecting...'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
