/**
 * ANALYTICS — presentational sections. Every number, comparison, tone and
 * sentence comes from the server's performance model; nothing here counts.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import type { AnalyticsPerformance, Change, MarketRow, Stage } from '../../../domain/analytics/analytics-performance-api'
import { fmtDelta, fmtDuration, fmtInt, fmtMinutes, fmtPct, fmtPctPts } from '../../../domain/analytics/analytics-performance-api'

export const cls = (...t: Array<string | false | null | undefined | 0>) => t.filter(Boolean).join(' ')

export function Count({ value, fmt = fmtInt }: { value: number | null | undefined; fmt?: (n: number) => string }) {
  const [v, setV] = useState(value ?? 0)
  const from = useRef(0)
  useEffect(() => {
    if (value === null || value === undefined) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setV(value); from.current = value; return }
    const a = from.current
    const t0 = performance.now()
    let raf = 0
    const tick = (t: number) => { const p = Math.min(1, (t - t0) / 850); setV(a + (value - a) * (1 - (1 - p) ** 4)); if (p < 1) raf = requestAnimationFrame(tick); else from.current = value }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  if (value === null || value === undefined) return <>—</>
  return <>{fmt(v)}</>
}

const toneOf = (good: string | undefined, delta: number | null | undefined) => (!delta || !good || good === 'neutral' ? 'neutral' : (delta > 0) === (good === 'up') ? 'good' : 'bad')

function Delta({ w, k }: { w: AnalyticsPerformance; k: string }) {
  const c = w.compare[k]
  if (!w.priorHasData) return <em className="anx-delta is-muted">no prior data</em>
  if (!c) return null
  if (!c.delta) return <em className="anx-delta is-muted">no change</em>
  return <em className={cls('anx-delta', `t-${toneOf(w.metrics[k]?.good, c.delta)}`)}>{fmtDelta(c)}<span> vs prior</span></em>
}

/* ── hero ── */

export function Hero({ w, onCohort }: { w: AnalyticsPerformance; onCohort: (kind: 'replies') => void }) {
  const c = w.totals.cur
  const rr = w.rates.reply_rate
  const spark = w.series.map((s) => s.replied)
  const max = Math.max(1, ...spark)
  const path = spark.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(1, spark.length - 1)) * 300},${58 - (v / max) * 50}`).join(' ')
  return (
    <section className="anx-hero">
      <div className="anx-hero__glow" aria-hidden="true" />
      <span className="anx-eyebrow"><i />Acquisition activity{w.scope.marketName ? ` · ${w.scope.marketName}` : ''}</span>
      <button type="button" className="anx-hero__primary" onClick={() => onCohort('replies')}>
        <strong><Count value={c.replied_conversations ?? 0} /></strong>
        <span>sellers replied<Delta w={w} k="replied_conversations" /></span>
      </button>
      <svg className="anx-hero__spark" viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="anx-spark" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--anx-aqua)" stopOpacity="0.45" /><stop offset="100%" stopColor="var(--anx-aqua)" stopOpacity="0" /></linearGradient></defs>
        {spark.length > 1 ? <><path d={`${path} L300,60 L0,60 Z`} fill="url(#anx-spark)" /><path d={path} className="line" /></> : null}
      </svg>
      <div className="anx-hero__row">
        <div><b><Count value={c.delivered_conversations ?? 0} /></b><span>reached</span></div>
        <div><b>{rr.cur === null ? '—' : fmtPct(rr.cur)}</b><span>reply rate{rr.pp !== null ? <em className={cls('anx-delta', `t-${toneOf('up', rr.pp)}`)}> {fmtPctPts(rr.pp)}</em> : !rr.reliable ? <em className="anx-delta is-muted"> n={rr.sample.cur}</em> : null}</span></div>
        <div><b><Count value={w.flow.advancements} /></b><span>advanced</span></div>
        <div><b><Count value={c.offers_issued ?? 0} /></b><span>offers</span></div>
        <div><b><Count value={c.contracts ?? 0} /></b><span>contracts</span></div>
        <div><b><Count value={c.closed ?? 0} /></b><span>closed</span></div>
      </div>
      <p className="anx-hero__meta">
        {w.latency.medianMinutes !== null ? <>Median seller reply {fmtMinutes(w.latency.medianMinutes)} after our message (n={w.latency.sample}). </> : null}
        Conversation grain: one seller counts once however many messages.
      </p>
    </section>
  )
}

/* ── story + changes ── */

export function Story({ w }: { w: AnalyticsPerformance }) {
  if (!w.story.lines.length && !w.story.notes.length) return null
  return (
    <section className="anx-panel anx-story">
      <div className="anx-head"><span>The period</span><em>{periodLabel(w)}</em></div>
      <ol className="anx-story__flow">
        {w.story.lines.map((l, i) => <li key={l.k} style={{ '--i': i } as CSSProperties}><b><Count value={l.value} /></b><span>{l.text.replace(/^[\d,]+\s/, '')}</span></li>)}
      </ol>
      {w.story.notes.map((n) => <p key={n} className="anx-story__note">{n}</p>)}
    </section>
  )
}

export function Changes({ w, onMarket }: { w: AnalyticsPerformance; onMarket: (id: string) => void }) {
  if (!w.priorHasData) return (
    <section className="anx-panel"><div className="anx-head"><span>What changed</span><em>vs previous {w.period.days} days</em></div><p className="anx-note">The previous period predates any recorded traffic, so there is nothing to compare against.</p></section>
  )
  return (
    <section className="anx-panel anx-changes">
      <div className="anx-head"><span>What changed</span><em>vs previous {Math.round(w.period.days)} days</em></div>
      {w.changes.length ? (
        <ul>
          {w.changes.map((c: Change, i) => (
            <li key={`${c.key}-${c.market ?? i}`} className={`t-${c.tone}`} style={{ '--i': i } as CSSProperties}>
              <button type="button" onClick={() => c.market && onMarket(c.market)} disabled={!c.market}>
                <i className="dot" />
                <span className="t">{c.kind === 'market' ? <>{c.label}<em> · seller replies</em></> : c.label}</span>
                <b>{c.kind === 'rate' ? fmtPctPts(c.pp) : `${(c.delta ?? 0) > 0 ? '+' : ''}${fmtInt(c.delta)}`}</b>
                <em className="sub">{c.kind === 'rate' ? `${fmtPct(c.prev)} → ${fmtPct(c.cur)}` : `${fmtInt(c.prev)} → ${fmtInt(c.cur)}${c.pct !== null && c.pct !== undefined ? ` · ${c.pct > 0 ? '+' : ''}${c.pct}%` : ''}`}</em>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="anx-note">Nothing moved materially — every change is below its floor (±5 and 25% on counts; ±3 pts with ≥30 on rates).</p>}
    </section>
  )
}

export const periodLabel = (w: AnalyticsPerformance) => {
  const f = (s: string) => new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${f(w.period.start)} – ${f(w.period.end)}`
}

/* ── trend (touch scrub) ── */

const SERIES = [
  { key: 'replied', label: 'Replies' }, { key: 'delivered', label: 'Delivered' }, { key: 'failed', label: 'Failures' }, { key: 'optOuts', label: 'Opt-outs' }, { key: 'advancements', label: 'Advanced' },
] as const
export function Trend({ w }: { w: AnalyticsPerformance }) {
  const [key, setKey] = useState<(typeof SERIES)[number]['key']>('replied')
  const [idx, setIdx] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement | null>(null)
  const pts = w.series.map((s) => ({ at: s.at, v: Number(s[key] ?? 0) }))
  const max = Math.max(1, ...pts.map((p) => p.v))
  const X = (i: number) => 8 + (i / Math.max(1, pts.length - 1)) * 304
  const Y = (v: number) => 108 - (v / max) * 92
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(i)},${Y(p.v)}`).join(' ')
  const active = idx ?? pts.length - 1
  const at = pts[active]
  const scrub = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r || pts.length < 2) return
    setIdx(Math.max(0, Math.min(pts.length - 1, Math.round(((clientX - r.left) / r.width) * (pts.length - 1)))))
  }
  const fmtAt = (s: string) => new Date(s).toLocaleDateString('en-US', w.period.bucket === 'hour' ? { hour: 'numeric' } : { month: 'short', day: 'numeric' })
  return (
    <section className="anx-panel anx-trend">
      <div className="anx-head"><span>Trend</span><em>per {w.period.bucket}</em></div>
      <div className="anx-tabs">{SERIES.map((s) => <button key={s.key} type="button" className={cls(key === s.key && 'is-on')} onClick={() => setKey(s.key)}>{s.label}</button>)}</div>
      <div className="anx-trend__read"><b>{fmtInt(at?.v ?? 0)}</b><span>{at ? `${w.period.bucket === 'week' ? 'week of ' : ''}${fmtAt(at.at)}` : ''}</span></div>
      <svg ref={ref} className="anx-trend__svg" viewBox="0 0 320 116" preserveAspectRatio="none"
        onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); scrub(e.clientX) }}
        onPointerMove={(e) => e.buttons && scrub(e.clientX)} onPointerUp={() => setIdx(null)} onPointerCancel={() => setIdx(null)}>
        <defs><linearGradient id="anx-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--anx-aqua)" stopOpacity="0.35" /><stop offset="100%" stopColor="var(--anx-aqua)" stopOpacity="0" /></linearGradient></defs>
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="8" x2="312" y1={108 - g * 92} y2={108 - g * 92} className="grid" />)}
        {pts.length > 1 ? <><path d={`${d} L${X(pts.length - 1)},108 L${X(0)},108 Z`} fill="url(#anx-area)" /><path d={d} className="line" key={key} /></> : null}
        {at ? <><line x1={X(active)} x2={X(active)} y1="8" y2="108" className="cursor" /><circle cx={X(active)} cy={Y(at.v)} r="4.5" className="knob" /></> : null}
      </svg>
      <div className="anx-trend__axis"><span>{pts[0] ? fmtAt(pts[0].at) : ''}</span><span>{pts.length ? fmtAt(pts[pts.length - 1].at) : ''}</span></div>
    </section>
  )
}

/* ── lifecycle flow ── */

export function Flow({ w, onStage }: { w: AnalyticsPerformance; onStage: (s: Stage, kind: 'entered' | 'stalled') => void }) {
  const stages = w.flow.stages.filter((s) => s.code !== 'closed')
  const maxLive = Math.max(1, ...stages.map((s) => s.live))
  const b = w.flow.bottleneck
  return (
    <section className="anx-panel anx-flow">
      <div className="anx-head"><span>Acquisition flow</span><em>S1–S9 · period + now</em></div>
      <div className="anx-flow__sum">
        <div><b><Count value={w.flow.created} /></b><span>opportunities created</span></div>
        <div><b><Count value={w.flow.advancements} /></b><span>advancements{w.flow.advancements ? <em> · {w.flow.bySource.autopilot ?? 0} by autopilot</em> : null}</span></div>
      </div>
      {b ? (
        <button type="button" className="anx-bottleneck" onClick={() => { const s = stages.find((x) => x.code === b.code); if (s) onStage(s, 'stalled') }}>
          <span className="anx-eyebrow is-warn"><i />Bottleneck</span>
          <b>S{w.flow.stages.find((s) => s.code === b.code)?.index} · {b.label}</b>
          <em>{b.stalled} of {b.live} live deals past {b.thresholdDays} days · median age {b.medianAgeDays?.toFixed(1)} days</em>
          <Icon name="chevron-right" />
        </button>
      ) : null}
      <ol className="anx-stages">
        {stages.map((s, i) => (
          <li key={s.code} style={{ '--i': i, '--w': `${(s.live / maxLive) * 100}%` } as CSSProperties} className={cls(!s.live && !s.entered && 'is-quiet', b?.code === s.code && 'is-hot')}>
            <button type="button" onClick={() => onStage(s, s.stalled ? 'stalled' : 'entered')} disabled={!s.entered && !s.stalled}>
              <span className="code">S{s.index}</span>
              <span className="name">{s.label}</span>
              <span className="live"><b>{s.live}</b><em>live</em></span>
              <span className="bar"><i /></span>
              <span className="meta">
                {s.entered ? <em>+{s.entered} entered</em> : <em className="muted">no entries</em>}
                {s.medianHoursInStage !== null ? <em>{fmtDuration(s.medianHoursInStage)} median dwell</em> : s.dwellSample ? <em className="muted">dwell n={s.dwellSample}</em> : null}
                {s.stalled ? <em className="warn">{s.stalled} stalled</em> : null}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="anx-note">Entered and dwell come from recorded stage transitions in the period (certification rows excluded); dwell shows once ≥3 exits exist. Live = active and touched within 30 days; stalled = past the stage’s own threshold.</p>
    </section>
  )
}

/* ── campaigns ── */

export function Campaigns({ w, onOpen }: { w: AnalyticsPerformance; onOpen: (id: string) => void }) {
  const rows = w.campaigns.slice(0, 8)
  if (!rows.length) return <section className="anx-panel"><div className="anx-head"><span>Campaign quality</span></div><p className="anx-note">No campaign sends in this period.</p></section>
  return (
    <section className="anx-panel anx-campaigns">
      <div className="anx-head"><span>Campaign quality</span><em>reached → replied → interested → pipeline</em></div>
      {rows.map((c, i) => {
        const steps = [['Reached', c.reached], ['Replied', c.replied], ['Interested', c.positive], ['In pipeline', c.opportunities]] as const
        const top = Math.max(1, c.reached)
        return (
          <button type="button" key={c.id} className={cls('anx-camp', c.test && 'is-test')} style={{ '--i': i } as CSSProperties} onClick={() => onOpen(c.id)}>
            <div className="anx-camp__head"><b>{c.name}</b>{c.test ? <em className="tag">test</em> : null}<span>{c.replyRate !== null ? `${c.replyRate}% reply` : c.reached ? `n=${c.reached}` : ''}</span></div>
            <div className="anx-camp__steps">
              {steps.map(([k, v]) => <div key={k} style={{ '--w': `${Math.max(2, (v / top) * 100)}%` } as CSSProperties}><i /><b>{fmtInt(v)}</b><span>{k}</span></div>)}
            </div>
            {c.optOuts || c.failed ? <em className="anx-camp__foot">{c.optOuts ? `${c.optOuts} opt-outs` : ''}{c.optOuts && c.failed ? ' · ' : ''}{c.failed ? `${c.failed} failed sends` : ''}</em> : null}
          </button>
        )
      })}
      <p className="anx-note">Replies are attributed to the campaign whose send preceded them on the same thread. “In pipeline” is the current count of active opportunities linked to the campaign.</p>
    </section>
  )
}

/* ── down-funnel truth ── */

export function DownFunnel({ w, onClosing }: { w: AnalyticsPerformance; onClosing: () => void }) {
  const c = w.totals.cur
  const d = w.disposition
  const chain: Array<[string, number | null | undefined]> = [
    ['Offers issued', c.offers_issued], ['Seller counters', c.seller_counters], ['Offers accepted', c.offers_accepted], ['Contracts', c.contracts],
    ['Buyer outreach', d.outreachTargets], ['Buyer offers', d.offers], ['Buyer selected', d.selected], ['Committed', d.committed], ['Agreement executed', d.agreementsExecuted], ['EMD received', d.emdReceived], ['Closed', c.closed],
  ]
  const any = chain.some(([, v]) => (v ?? 0) > 0)
  return (
    <section className="anx-panel anx-down">
      <div className="anx-head"><span>Offers → contracts → closing</span><em>actual records only</em></div>
      <ol className="anx-chain">{chain.map(([k, v], i) => <li key={k} className={cls((v ?? 0) > 0 && 'is-on')} style={{ '--i': i } as CSSProperties}><b>{v === null || v === undefined ? '—' : v}</b><span>{k}</span></li>)}</ol>
      {!any ? <p className="anx-note">No offers, contracts, buyer commitments or closings were recorded in this period. Nothing here is projected — estimated economics never appear as revenue.</p> : null}
      {w.deals.closings.length ? <button type="button" className="anx-btn" onClick={onClosing}><Icon name="briefcase" />Open Closing Desk</button> : null}
    </section>
  )
}

/* ── operating health ── */

export function Operations({ w, onQueue }: { w: AnalyticsPerformance; onQueue: () => void }) {
  const a = w.automation
  const o = w.operations
  const sends = a.sendsAutomated + a.sendsOperator + a.sendsUnattributed
  const pct = (n: number) => (sends ? `${Math.round((n / sends) * 100)}%` : '—')
  const dr = w.rates.delivery_rate
  const reasons = Object.entries(a.blockReasons).sort((x, y) => y[1] - x[1]).slice(0, 5)
  const LABEL: Record<string, string> = { execution_gated: 'Held by send gates', unclear_low_confidence: 'Reply unclear', missing_context: 'Missing context', auto_reply_mode_disabled: 'Auto-reply off', hostile_or_legal_intent: 'Hostile / legal', opt_out_intent_no_marketing: 'Opted out', property_relationship_review_required: 'Relationship review', automation_review_required: 'Review required', wrong_number: 'Wrong number' }
  return (
    <section className="anx-panel anx-ops">
      <div className="anx-head"><span>Operating health</span><em>automation · transport</em></div>
      <span className="anx-sub">Who sent the messages</span>
      <div className="anx-split" aria-label="Send origin">
        <i className="a" style={{ flexGrow: a.sendsAutomated || 0.0001 }} /><i className="o" style={{ flexGrow: a.sendsOperator || 0.0001 }} /><i className="u" style={{ flexGrow: a.sendsUnattributed || 0.0001 }} />
      </div>
      <div className="anx-split__legend">
        <span><i className="a" />System {pct(a.sendsAutomated)} <em>{fmtInt(a.sendsAutomated)}</em></span>
        <span><i className="o" />Operator {pct(a.sendsOperator)} <em>{fmtInt(a.sendsOperator)}</em></span>
        {a.sendsUnattributed ? <span><i className="u" />Unlabelled {pct(a.sendsUnattributed)} <em>{fmtInt(a.sendsUnattributed)}</em></span> : null}
      </div>
      <span className="anx-sub">Autopilot runs · {fmtInt(a.runs)}</span>
      <div className="anx-grid">
        <div><b>{fmtInt(a.succeeded)}</b><span>executed</span></div>
        <div><b>{fmtInt(a.heldByGate)}</b><span>held by send gate</span></div>
        <div className={cls(a.needsReview && 'is-warn')}><b>{fmtInt(a.needsReview)}</b><span>needs review</span></div>
        <div><b>{fmtInt(a.policyBlocks)}</b><span>policy holds</span></div>
      </div>
      {reasons.length ? <div className="anx-reasons">{reasons.map(([k, n]) => <span key={k}><b>{fmtInt(n)}</b>{LABEL[k] ?? k.replace(/_/g, ' ')}</span>)}</div> : null}
      <p className="anx-note">“Held by send gate” is the system’s own brake (sending paused), not a failure. {a.decisions ? `${a.escalated} of ${a.decisions} recorded decisions escalated to a human.` : ''}</p>
      <span className="anx-sub">Transport</span>
      <div className="anx-grid">
        <div><b>{dr.cur === null ? '—' : fmtPct(dr.cur)}</b><span>delivered{dr.pp !== null ? <em className={cls('anx-delta', `t-${toneOf('up', dr.pp)}`)}> {fmtPctPts(dr.pp)}</em> : null}</span></div>
        <div className={cls(o.failed && 'is-warn')}><b>{fmtInt(o.failed)}</b><span>failed<Delta w={w} k="failed" /></span></div>
        <div className={cls(o.healthGuardBlocks && 'is-warn')}><b>{fmtInt(o.healthGuardBlocks)}</b><span>sender-health blocks</span></div>
        <div><b>{fmtInt(o.contentBlocks)}</b><span>content blocks</span></div>
        <div><b>{fmtInt(o.expired)}</b><span>expired unsent</span></div>
        <div><b>{o.medianSendDelayMin === null ? '—' : fmtMinutes(o.medianSendDelayMin)}</b><span>median send delay</span></div>
      </div>
      <p className="anx-note">Now: {fmtInt(o.backlogPending)} messages waiting{o.backlogOldest ? `, oldest scheduled ${new Date(o.backlogOldest).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''} (current state, not the period).</p>
      <button type="button" className="anx-btn" onClick={onQueue}><Icon name="list" />Open Queue</button>
    </section>
  )
}

/* ── method ── */

export function Method({ w }: { w: AnalyticsPerformance }) {
  const keys = ['delivered_conversations', 'replied_conversations', 'reply_rate', 'positive_conversations', 'opt_out_conversations', 'opportunities_created', 'stage_advancements', 'offers_issued', 'contracts', 'closed', 'buyer_purchases']
  return (
    <details className="anx-panel anx-method">
      <summary><span>Metric definitions &amp; lineage</span><Icon name="chevron-down" /></summary>
      <dl>
        {keys.map((k) => { const m = w.metrics[k]; return m ? <div key={k}><dt>{m.label}<em>{m.kind === 'rate' ? 'rate' : m.kind === 'state' ? 'now' : 'period'} · {m.grain}</em></dt><dd>{m.definition}<small>{m.source}</small></dd></div> : null })}
        {Object.entries(w.lineage).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        <div><dt>Computed</dt><dd>{new Date(w.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · live on every visit · {w.queryMs} ms · {periodLabel(w)} vs {new Date(w.period.prevStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {new Date(w.period.prevEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</dd></div>
      </dl>
    </details>
  )
}

/* ── sheets ── */

export function Sheet({ theme, title, eyebrow, onClose, children }: { theme: string; title: ReactNode; eyebrow?: string; onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div className="anx-sheet" data-theme={theme} role="dialog" aria-label={typeof title === 'string' ? title : 'Detail'}>
      <button type="button" className="anx-sheet__scrim" aria-label="Close" onClick={onClose} />
      <div className="anx-sheet__panel">
        <div className="anx-sheet__grab" />
        <div className="anx-sheet__head"><div>{eyebrow ? <span className="anx-eyebrow"><i />{eyebrow}</span> : null}<h3>{title}</h3></div><button type="button" className="anx-x" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function MarketInspector({ m, w, theme, onClose, onScope, onMap, onPipeline, onCampaigns, onReplies }: {
  m: MarketRow; w: AnalyticsPerformance; theme: string; onClose: () => void
  onScope: () => void; onMap: () => void; onPipeline: () => void; onCampaigns: () => void; onReplies: () => void
}) {
  const rows: Array<[string, number, number | null, string]> = [
    ['Sellers reached', m.cur.delivered_conversations ?? 0, m.prev.delivered_conversations ?? 0, 'neutral'],
    ['Sellers replied', m.cur.replied_conversations ?? 0, m.prev.replied_conversations ?? 0, 'up'],
    ['Opt-outs', m.cur.opt_out_conversations ?? 0, m.prev.opt_out_conversations ?? 0, 'down'],
    ['Opportunities created', m.cur.opportunities_created ?? 0, m.prev.opportunities_created ?? 0, 'up'],
    ['Stage advancements', m.cur.stage_advancements ?? 0, m.prev.stage_advancements ?? 0, 'up'],
    ['Delivery failures', m.cur.failed ?? 0, m.prev.failed ?? 0, 'down'],
    ['Automation exceptions', m.cur.automation_exceptions ?? 0, m.prev.automation_exceptions ?? 0, 'down'],
    ['Buyer purchases', m.cur.buyer_purchases ?? 0, m.prev.buyer_purchases ?? 0, 'neutral'],
  ]
  return (
    <Sheet theme={theme} eyebrow={`${m.state} · canonical market`} title={m.name} onClose={onClose}>
      <div className="anx-insp__kpis">
        <div><b>{fmtInt(m.cur.replied_conversations)}</b><span>replied</span></div>
        <div><b>{m.replyRate === null ? '—' : `${m.replyRate}%`}</b><span>reply rate{m.replyRate === null ? ' (n<20)' : ''}</span></div>
        <div><b>{fmtInt(m.activeOpportunities - m.dormantOpportunities)}</b><span>live deals now</span></div>
      </div>
      <table className="anx-table">
        <thead><tr><th /><th>{w.period.range.toUpperCase()}</th><th>Prior</th><th>Δ</th></tr></thead>
        <tbody>{rows.map(([k, c, p, g]) => {
          // Buyer purchases past the recorded corpus are "not yet recorded", not a decline.
          const coverageGap = k === 'Buyer purchases' && !!w.buyers.dataThrough && new Date(w.buyers.dataThrough) < new Date(w.period.end)
          const d = c - (p ?? 0)
          const show = w.priorHasData && !!d && !coverageGap
          return <tr key={k}><th>{k}</th><td>{fmtInt(c)}</td><td>{w.priorHasData ? fmtInt(p) : '—'}</td><td className={cls(show && `t-${toneOf(g, d)}`)}>{show ? `${d > 0 ? '+' : ''}${d}` : coverageGap ? 'n/a' : ''}</td></tr>
        })}</tbody>
      </table>
      {w.buyers.dataThrough ? <p className="anx-note">Buyer purchases from recorded transactions through {new Date(w.buyers.dataThrough).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.</p> : null}
      <div className="anx-actions">
        <button type="button" className="anx-btn is-primary" onClick={onScope}><Icon name="target" />Analytics for {m.name.split(',')[0]}</button>
        <button type="button" className="anx-btn" onClick={onReplies}><Icon name="message" />Seller cohort</button>
        <button type="button" className="anx-btn" onClick={onMap}><Icon name="map" />Open in Map</button>
        <button type="button" className="anx-btn" onClick={onPipeline}><Icon name="list" />Pipeline</button>
        <button type="button" className="anx-btn" onClick={onCampaigns}><Icon name="send" />Campaigns</button>
      </div>
    </Sheet>
  )
}

export type CohortItem = { key: string; title: string; sub: string; at: string | null; tag?: string; tone?: 'good' | 'bad' | 'neutral'; onOpen: () => void }
export function CohortSheet({ theme, title, eyebrow, items, note, onClose, onMap }: { theme: string; title: string; eyebrow: string; items: CohortItem[]; note?: string; onClose: () => void; onMap?: () => void }) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => items.filter((i) => !q || `${i.title} ${i.sub}`.toLowerCase().includes(q.toLowerCase())), [items, q])
  return (
    <Sheet theme={theme} eyebrow={eyebrow} title={`${items.length} ${title}`} onClose={onClose}>
      {items.length > 8 ? <input className="anx-search" placeholder="Filter by address or market" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
      <ul className="anx-cohort">
        {shown.slice(0, 120).map((i, n) => (
          <li key={i.key} style={{ '--i': Math.min(n, 12) } as CSSProperties}>
            <button type="button" onClick={i.onOpen}>
              <span className="t"><b>{i.title}</b><em>{i.sub}</em></span>
              {i.tag ? <span className={cls('tag', i.tone && `t-${i.tone}`)}>{i.tag}</span> : null}
              <span className="d">{i.at ? new Date(i.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}</span>
              <Icon name="chevron-right" />
            </button>
          </li>
        ))}
      </ul>
      {!items.length ? <p className="anx-note">No records in this cohort for the period.</p> : null}
      {note ? <p className="anx-note">{note}</p> : null}
      {onMap && items.length ? <button type="button" className="anx-btn" onClick={onMap}><Icon name="map" />Show cohort on Map</button> : null}
    </Sheet>
  )
}
