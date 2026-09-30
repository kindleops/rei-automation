/**
 * ANALYTICS LAB — MODES. Each mode is the same registry and engine seen from
 * one angle, composed from the shared chart library. A mode whose data is not
 * trustworthy says so (partial / unavailable) instead of drawing anyway.
 */
import { useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import type { BreakdownRow, Heatmap, Histogram, LabContext, LabOverview, LabQuery, LabView, MetricDef } from '../../../domain/analytics/analytics-lab-api'
import { fetchLabQuery, fmtCount, fmtMetric, fmtRate } from '../../../domain/analytics/analytics-lab-api'
import type { LabActions } from './lab-state'
import { useLabData } from './lab-state'
import { Empty, Segmented, cls } from './LabUi'
import { RankedBars } from './charts/Bars'
import { DistributionHistogram, HourHeatmap, OutcomeStack } from './charts/Analytic'
import { TrendChart } from './charts/TrendChart'
import { clamp, fmtRangeShort, niceTicks } from './charts/chart-kit'
import { LabGeoMap } from './LabGeoMap'
import type { OpenRecords } from './LabOverview'

type ModeProps = {
  ctx: LabContext
  act: LabActions
  defs: Record<string, MetricDef>
  dims: Record<string, { label: string }>
  overview: LabOverview | null
  theme: string
  onInspect: (id: string) => void
  onRecords: OpenRecords
}

const sliceKey = (ctx: LabContext) => JSON.stringify([ctx.range, ctx.compare, ctx.filters, ctx.segment, ctx.tz, ctx.grain])
function useView(ctx: LabContext, over: Partial<LabContext> & { metrics?: string[] }, view: LabView, enabled = true) {
  const merged = { ...ctx, ...over } as LabContext & { metrics?: string[] }
  return useLabData<LabQuery>(enabled ? `${view}|${JSON.stringify(over)}|${sliceKey(ctx)}` : null, (signal) => fetchLabQuery(merged, view, signal))
}

function Panel({ title, sub, children, tools, className }: { title: string; sub?: string; children: ReactNode; tools?: ReactNode; className?: string }) {
  return (
    <section className={cls('lab-sec', className)}>
      <header className="lab-sec__head"><h2>{title}</h2>{sub ? <span>{sub}</span> : null}{tools ? <div className="lab-sec__tools">{tools}</div> : null}</header>
      {children}
    </section>
  )
}
function QueryState({ q }: { q: { loading: boolean; error: string | null; data: unknown } }) {
  if (q.error) return <p className="lab-note is-bad">{q.error}</p>
  if (!q.data && q.loading) return <p className="lab-note">Reading…</p>
  return null
}

/* ── generic metric table (metrics × groups) ─────────────────────────────── */

type TableRow = { key: string; label: string; test?: boolean; values: Record<string, { value: number | null; num: number | null; den: number | null; n: number; insufficient?: boolean }>; prev?: Record<string, { value: number | null }> | null }
function MetricTable({ rows, metrics, defs, dimLabel, onRow, onCell }: { rows: TableRow[]; metrics: string[]; defs: Record<string, MetricDef>; dimLabel: string; onRow?: (r: TableRow) => void; onCell?: (r: TableRow, id: string) => void }) {
  return (
    <div className="lab-tablewrap">
      <table className="lab-table is-metrics">
        <thead>
          <tr><th>{dimLabel}</th>{metrics.map((id) => <th key={id} title={defs[id]?.description}>{defs[id]?.short || id}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={cls(r.test && 'is-test')}>
              <th>
                <button type="button" className="lab-link" disabled={!onRow || r.test || r.key === '__unresolved' || r.key === '__none'} onClick={() => onRow?.(r)}>{r.label}</button>
                {r.test ? <em className="lab-tag">test · not ranked</em> : null}
              </th>
              {metrics.map((id) => {
                const v = r.values[id]
                const def = defs[id]
                if (!v) return <td key={id} className="is-na">—</td>
                return (
                  <td key={id} className={cls(v.insufficient && 'is-small')}>
                    <button type="button" className="lab-cell" onClick={() => onCell?.(r, id)} disabled={!onCell} title={def?.unit === 'rate' ? `${v.num}/${v.den}${v.insufficient ? ' · below minimum sample' : ''}` : undefined}>
                      <b>{fmtMetric(def, v.value)}</b>{def?.unit === 'rate' ? <small>{v.num}/{v.den}</small> : null}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── scatter of two independent rates ────────────────────────────────────── */

function RateScatter({ rows, x, y, defs, onPick }: { rows: TableRow[]; x: string; y: string; defs: Record<string, MetricDef>; onPick?: (r: TableRow) => void }) {
  const pts = rows.filter((r) => !r.test && r.values[x]?.value !== null && r.values[x] && r.values[y]?.value !== null && r.values[y])
  const [hover, setHover] = useState<string | null>(null)
  if (pts.length < 2) return <p className="lab-note">Fewer than two groups have both rates; a scatter would say nothing.</p>
  const W = 520; const H = 260; const M = { l: 44, r: 12, t: 12, b: 30 }
  const xt = niceTicks(0, Math.max(...pts.map((p) => p.values[x].value as number)) * 1.05, 4)
  const yt = niceTicks(0, Math.max(...pts.map((p) => p.values[y].value as number)) * 1.05, 4)
  const sx = (v: number) => M.l + (v / (xt.hi || 1)) * (W - M.l - M.r)
  const sy = (v: number) => M.t + (H - M.t - M.b) - (v / (yt.hi || 1)) * (H - M.t - M.b)
  const maxN = Math.max(1, ...pts.map((p) => p.values[y].n))
  const h = pts.find((p) => p.key === hover)
  return (
    <div className="lab-scatter">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${defs[y]?.label} against ${defs[x]?.label} by group`}>
        {yt.ticks.map((t) => <g key={`y${t}`}><line x1={M.l} x2={W - M.r} y1={sy(t)} y2={sy(t)} className="lab-gridline" /><text x={M.l - 6} y={sy(t)} dy="0.32em" textAnchor="end" className="lab-tick">{fmtRate(t, 0)}</text></g>)}
        {xt.ticks.map((t) => <text key={`x${t}`} x={sx(t)} y={H - 10} textAnchor="middle" className="lab-tick">{fmtRate(t, 0)}</text>)}
        {pts.map((p) => {
          const small = p.values[y].insufficient || p.values[x].insufficient
          return (
            <g key={p.key} onPointerEnter={() => setHover(p.key)} onPointerLeave={() => setHover(null)} onClick={() => onPick?.(p)} className="lab-scatter__pt" role="button" tabIndex={0} aria-label={`${p.label}: ${defs[x]?.short} ${fmtRate(p.values[x].value)}, ${defs[y]?.short} ${fmtRate(p.values[y].value)}`}>
              <circle cx={sx(p.values[x].value as number)} cy={sy(p.values[y].value as number)} r={14} fill="transparent" />
              <circle cx={sx(p.values[x].value as number)} cy={sy(p.values[y].value as number)} r={4 + 10 * Math.sqrt(p.values[y].n / maxN)} className={cls('lab-scatter__dot', small && 'is-small', hover === p.key && 'is-hover')} />
            </g>
          )
        })}
      </svg>
      <div className="lab-scatter__axes"><span>x · {defs[x]?.label}</span><span>y · {defs[y]?.label} · size = {defs[defs[y]?.denominator?.metric || '']?.label?.toLowerCase() || 'denominator'}</span></div>
      <p className="lab-note lab-scatter__read">{h ? `${h.label} · ${defs[x]?.short} ${fmtRate(h.values[x].value)} (${h.values[x].num}/${h.values[x].den}) · ${defs[y]?.short} ${fmtRate(h.values[y].value)} (${h.values[y].num}/${h.values[y].den})` : 'Two independently measured rates per group. Association only — neither explains the other.'}</p>
    </div>
  )
}

/* ═══ ACQUISITION + PIPELINE ═══════════════════════════════════════════════ */

type StageRow = {
  code: string; index: number; label: string; entered: number; enteredBySystem: number; enteredByHuman: number
  exits: number; forward: number; backward: number; forwardShare: number | null; forwardCi: { low: number; high: number } | null
  dwell: { n: number; p50: number | null; p75: number | null }; active: number; live: number; dormant: number; stalled: number; stallThresholdDays: number | null
  liveAge: { n: number; p50: number | null }; stalledIds: string[]
}
function useStages(ctx: LabContext) {
  const q = useView(ctx, { metric: 'stage_advancements', groupBy: null }, 'stages')
  const r = q.data?.result as unknown as { current: StageRow[]; comparison: StageRow[] | null; bottleneck: { code: string; label: string; live: number; stalled: number; thresholdDays: number } | null; dormantDays: number } | null
  return { q, r }
}
const minutesAsDays = (m: number | null | undefined) => (m === null || m === undefined ? '—' : m < 60 * 24 ? `${(m / 60).toFixed(m < 600 ? 1 : 0)} h` : `${(m / 1440).toFixed(1)} d`)

export function ModeAcquisition({ ctx, defs, overview, onInspect, onRecords }: ModeProps) {
  const { q, r } = useStages(ctx)
  const f = overview?.funnel
  return (
    <div className="lab-mode">
      {f ? (
        <Panel title="From reach to opportunity" sub="the period’s reached cohort · each step a subset of the one before">
          <div className="lab-bigfunnel">
            {f.steps.map((s, i) => (
              <button key={s.id} type="button" className="lab-bigfunnel__step" onClick={() => onInspect(s.id)} style={{ '--w': `${f.steps[0].value ? Math.max(4, ((s.value ?? 0) / (f.steps[0].value || 1)) * 100) : 0}%` } as CSSProperties}>
                <span>{s.label}</span><b>{fmtCount(s.value)}</b><em>{i === 0 ? 'cohort' : s.conversion !== null ? `${fmtRate(s.conversion)} of ${f.steps[i - 1]?.label.toLowerCase()}` : '—'}</em><i />
              </button>
            ))}
          </div>
        </Panel>
      ) : null}
      <Panel title="Stage matrix · S1 → S10" sub="events in the period (canonical history) · inventory now · certification rows excluded">
        <QueryState q={q} />
        {r ? (
          <>
            {r.bottleneck ? <div className="lab-callout t-bad"><Icon name="alert" /><span><b>Bottleneck · S{r.current.find((s) => s.code === r.bottleneck?.code)?.index} {r.bottleneck.label}</b> — {r.bottleneck.stalled} of {r.bottleneck.live} live opportunities are past its {r.bottleneck.thresholdDays}-day threshold (current state, not the period).</span></div> : null}
            <div className="lab-tablewrap">
              <table className="lab-table is-stages">
                <thead>
                  <tr><th>Stage</th><th title="Transitions into the stage (incl. created at it)">Entered</th><th title="autopilot / operator">By system · human</th><th title="Transitions out of the stage">Exits</th><th title="Forward exits ÷ exits (Wilson 95%)">Forward share</th><th>Dwell median · P75</th><th title="Active and touched within 30 days">Live now</th><th>Dormant</th><th title="Live past the stage threshold">Stalled</th></tr>
                </thead>
                <tbody>
                  {r.current.map((s) => (
                    <tr key={s.code} className={cls(!s.entered && !s.exits && !s.active && 'is-quiet', r.bottleneck?.code === s.code && 'is-hot')}>
                      <th><span className="lab-stage">S{s.index}</span>{s.label}</th>
                      <td>{fmtCount(s.entered)}{s.entered ? <button type="button" className="lab-link is-mini" onClick={() => onRecords({ metric: 'stage_advancements', group: { dim: 'stage', key: s.code, label: s.label } }, `Forward moves into ${s.label}`)} title="Forward moves into this stage (records)">fwd</button> : null}</td>
                      <td>{s.entered ? `${s.enteredBySystem} · ${s.enteredByHuman}` : '—'}</td>
                      <td>{fmtCount(s.exits)}{s.backward ? <small> ({s.backward} back)</small> : null}</td>
                      <td>{s.forwardShare === null ? '—' : <>{fmtRate(s.forwardShare, 0)}<small>{s.forward}/{s.exits}{s.exits < 10 ? ' · small n' : ''}</small></>}</td>
                      <td>{s.dwell.n ? <>{minutesAsDays(s.dwell.p50)} · {minutesAsDays(s.dwell.p75)}<small>n={s.dwell.n}</small></> : '—'}</td>
                      <td>{fmtCount(s.live)}{s.liveAge?.n ? <small>median age {minutesAsDays(s.liveAge.p50)}</small> : null}</td>
                      <td>{fmtCount(s.dormant)}</td>
                      <td className={cls(s.stalled && 't-bad')}>{s.stallThresholdDays ? <>{fmtCount(s.stalled)}<small>&gt; {s.stallThresholdDays} d</small></> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="lab-note">Forward share is a proportion of exits (it cannot exceed 100%); a stage’s entries and exits in one period are different opportunities, so entries ÷ exits is never shown as a conversion. Dormant = active but untouched for {r.dormantDays} days (the June backfill). {defs.stage_advancements ? 'Opportunities created without a creation event (the June backfill) are never counted as entered.' : ''}</p>
          </>
        ) : null}
      </Panel>
    </div>
  )
}

export function ModePipeline({ ctx, defs, onRecords }: ModeProps) {
  const { q, r } = useStages(ctx)
  const flow = useView(ctx, { metric: 'stage_advancements', groupBy: null }, 'series')
  const series = flow.data?.result as unknown as { grain: string; current: Array<{ start: number; end: number; value: number | null }>; comparison: Array<{ start: number; end: number; value: number | null }> | null } | null
  const inv = r?.current.filter((s) => s.active > 0 || s.stalled > 0) || []
  const maxA = Math.max(1, ...inv.map((s) => s.active))
  return (
    <div className="lab-mode">
      <Panel title="Inventory and aging" sub="active opportunities by canonical stage · live vs dormant · stalled past the stage’s own threshold (current state)">
        <QueryState q={q} />
        {inv.length ? (
          <ol className="lab-aging">
            {inv.map((s) => (
              <li key={s.code}>
                <span className="lab-aging__label"><span className="lab-stage">S{s.index}</span>{s.label}</span>
                <span className="lab-aging__bar">
                  <i className="is-live" style={{ width: `${(s.live / maxA) * 100}%` } as CSSProperties} title={`${s.live} live`} />
                  <i className="is-dormant" style={{ width: `${(s.dormant / maxA) * 100}%` } as CSSProperties} title={`${s.dormant} dormant`} />
                </span>
                <b>{s.active}</b>
                <em className={cls(s.stalled && 't-bad')}>{s.stalled ? `${s.stalled} stalled` : s.live ? `median ${minutesAsDays(s.liveAge.p50)}` : 'all dormant'}</em>
              </li>
            ))}
          </ol>
        ) : r ? <p className="lab-note">No active opportunities in this slice.</p> : null}
        <div className="lab-legend"><span><i className="lab-key is-primary" />live (touched ≤ 30 d)</span><span><i className="lab-key is-muted" />dormant</span></div>
      </Panel>
      <Panel title="Flow · forward stage moves" sub={`per ${series?.grain || ctx.grain} · recorded history only`}>
        <QueryState q={flow} />
        {series ? <TrendChart current={series.current} comparison={series.comparison} unit="count" grain={series.grain} tz={ctx.tz} format={(v) => fmtCount(v)} label="Stage advancements" currentLabel="This period" compareLabel="Comparison" height={200}
          onPick={(_, p) => onRecords({ metric: 'stage_advancements', bucket: { start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() } }, `Stage advancements · ${new Date(p.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)} /> : null}
        <p className="lab-note">{defs.stage_advancements?.v1.note}</p>
      </Panel>
    </div>
  )
}

/* ═══ CAMPAIGNS ════════════════════════════════════════════════════════════ */

const CAMPAIGN_METRICS = ['sellers_reached', 'reply_rate', 'interest_rate', 'opt_out_rate', 'messages_sent', 'delivery_rate', 'content_filter_rate', 'transport_failures', 'provider_rejections', 'sender_health_blocks', 'send_gate_holds']
export function ModeCampaigns({ ctx, act, defs, dims, onRecords }: ModeProps) {
  const t = useView(ctx, { metric: 'sellers_reached', groupBy: 'campaign', metrics: CAMPAIGN_METRICS, limit: 60 }, 'table')
  const src = useView(ctx, { metric: 'sellers_reached', groupBy: 'campaign_source', metrics: ['sellers_reached', 'reply_rate', 'interest_rate', 'delivery_rate', 'content_filter_rate'], limit: 20 }, 'table')
  const rows = (t.data?.result?.rows || []) as unknown as TableRow[]
  const srows = (src.data?.result?.rows || []) as unknown as TableRow[]
  const onRow = (dim: string) => (r: TableRow) => act.pushSegment({ dim, value: r.key, label: r.label })
  const onCell = (dim: string) => (r: TableRow, id: string) => onRecords({ metric: id, part: defs[id]?.unit === 'rate' ? 'numerator' : undefined, group: { dim, key: r.key, label: r.label } }, `${defs[id]?.label} · ${r.label}`)
  return (
    <div className="lab-mode">
      <Panel title="Campaign comparison" sub="sellers attributed to the campaign of their first delivered message in the period · held ≠ undelivered ≠ refused · test campaigns never rank" className="is-wide">
        <QueryState q={t} />
        {rows.length ? <MetricTable rows={rows} metrics={CAMPAIGN_METRICS} defs={defs} dimLabel={dims.campaign?.label || 'Campaign'} onRow={onRow('campaign')} onCell={onCell('campaign')} /> : t.data ? <Empty title="No campaign activity in this slice" /> : null}
        <p className="lab-note">Rates show their numerator/denominator; a faded cell is below the metric’s minimum sample. “Undelivered” is the carrier’s verdict after sending; “refused” is the provider declining before sending; sender-health blocks and send-gate holds never left the queue.</p>
      </Panel>
      <div className="lab-duo">
        <Panel title="Where campaigns came from" sub="Map area vs Entity Graph vs builder filters">
          <QueryState q={src} />
          {srows.length ? <MetricTable rows={srows} metrics={['sellers_reached', 'reply_rate', 'interest_rate', 'delivery_rate', 'content_filter_rate']} defs={defs} dimLabel="Source" onRow={onRow('campaign_source')} onCell={onCell('campaign_source')} /> : null}
        </Panel>
        <Panel title="Delivery vs reply, by campaign" sub="two independent rates · size = sellers reached">
          {rows.length ? <RateScatter rows={rows} x="delivery_rate" y="reply_rate" defs={defs} onPick={onRow('campaign')} /> : null}
        </Panel>
      </div>
    </div>
  )
}

/* ═══ COMMUNICATIONS ═══════════════════════════════════════════════════════ */

export function ModeCommunications({ ctx, act, defs, dims, onRecords }: ModeProps) {
  const [heatMetric, setHeatMetric] = useState<'reply_rate' | 'messages_delivered' | 'sellers_replied'>('reply_rate')
  const heat = useView(ctx, { metric: heatMetric, groupBy: null }, 'heatmap')
  const lat = useView(ctx, { metric: 'median_reply_latency', groupBy: null }, 'histogram')
  const touch = useView(ctx, { metric: 'reply_rate', groupBy: 'touch', limit: 10 }, 'breakdown')
  const tpl = useView(ctx, { metric: 'sellers_reached', groupBy: 'template', metrics: ['sellers_reached', 'reply_rate', 'interest_rate', 'opt_out_rate'], limit: 25 }, 'table')
  const snd = useView(ctx, { metric: 'messages_sent', groupBy: 'sender', metrics: ['messages_sent', 'delivery_rate', 'content_filter_rate', 'transport_failure_rate', 'sender_health_blocks'], limit: 25 }, 'table')
  const hm = (heat.data?.result as unknown as { current: Heatmap } | null)?.current
  const hist = (lat.data?.result as unknown as { current: Histogram } | null)?.current
  const trows = (touch.data?.result?.rows || []) as BreakdownRow[]
  return (
    <div className="lab-mode">
      <div className="lab-callout"><Icon name="message" /><span><b>Channel · SMS only.</b> The email channel has never sent a message (sending is hard-off pending Brevo / DNS), so every figure here is SMS. Email appears as unavailable, never as zero performance.</span></div>
      <Panel title="When sellers answer" sub="seller-local hour × weekday (property timezone) · click a cell for its records"
        tools={<Segmented label="Heatmap metric" value={heatMetric} onChange={setHeatMetric} options={[{ key: 'reply_rate', label: 'Reply rate' }, { key: 'sellers_replied', label: 'Replies' }, { key: 'messages_delivered', label: 'Delivered' }]} />}>
        <QueryState q={heat} />
        {hm ? <HourHeatmap data={hm} isRate={heatMetric === 'reply_rate'} minSample={20} format={(v) => (heatMetric === 'reply_rate' ? fmtRate(v, 0) : fmtCount(v))} onCell={(w, h) => onRecords({ metric: heatMetric, part: heatMetric === 'reply_rate' ? 'numerator' : undefined, cell: { weekday: w, hour: h } }, `${defs[heatMetric]?.label} · ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][w]} ${String(h).padStart(2, '0')}:00`)} /> : null}
        {heatMetric === 'reply_rate' ? <p className="lab-note">A reply-rate cell is the share of sellers FIRST REACHED in that local hour who replied — it places the outreach, not the reply.</p> : null}
      </Panel>
      <div className="lab-duo">
        <Panel title="Reply latency" sub="minutes from our last delivered message to the first reply · reached cohort">
          <QueryState q={lat} />
          {hist ? (hist.dist.n ? <DistributionHistogram data={hist} format={(v) => fmtMetric(defs.median_reply_latency, v)} /> : <Empty title="No replies with a prior delivered message" />) : null}
        </Panel>
        <Panel title="Reply rate by touch" sub="the touch number of the seller’s first delivered message in the period">
          <QueryState q={touch} />
          {trows.length ? <RankedBars rows={trows} unit="rate" format={(v) => fmtRate(v)} onPick={(r) => act.pushSegment({ dim: 'touch', value: r.key, label: r.label })} onRecords={(r) => onRecords({ metric: 'reply_rate', part: 'denominator', group: { dim: 'touch', key: r.key, label: r.label } }, `Sellers reached · ${r.label}`)} /> : null}
        </Panel>
      </div>
      <Panel title="Templates" sub="first-touch attribution · sample-guarded (faded below the minimum n)" className="is-wide">
        <QueryState q={tpl} />
        {tpl.data ? <MetricTable rows={(tpl.data.result?.rows || []) as unknown as TableRow[]} metrics={['sellers_reached', 'reply_rate', 'interest_rate', 'opt_out_rate']} defs={defs} dimLabel={dims.template?.label || 'Template'} onRow={(r) => act.pushSegment({ dim: 'template', value: r.key, label: r.label })} onCell={(r, id) => onRecords({ metric: id, part: defs[id]?.unit === 'rate' ? 'numerator' : undefined, group: { dim: 'template', key: r.key, label: r.label } }, `${defs[id]?.label} · ${r.label}`)} /> : null}
      </Panel>
      <Panel title="Senders" sub="message grain · carrier filtering and health blocks by sending number" className="is-wide">
        <QueryState q={snd} />
        {snd.data ? <MetricTable rows={(snd.data.result?.rows || []) as unknown as TableRow[]} metrics={['messages_sent', 'delivery_rate', 'content_filter_rate', 'transport_failure_rate', 'sender_health_blocks']} defs={defs} dimLabel={dims.sender?.label || 'Sender'} onRow={(r) => act.pushSegment({ dim: 'sender', value: r.key, label: r.label })} onCell={(r, id) => onRecords({ metric: id, part: defs[id]?.unit === 'rate' ? 'numerator' : undefined, group: { dim: 'sender', key: r.key, label: r.label } }, `${defs[id]?.label} · ${r.label}`)} /> : null}
      </Panel>
    </div>
  )
}

/* ═══ GEOGRAPHY ════════════════════════════════════════════════════════════ */

const GEO_METRICS = ['reply_rate', 'sellers_reached', 'interest_rate', 'delivery_rate', 'content_filter_rate', 'opportunities_created']
export function ModeGeography({ ctx, act, defs, theme, onRecords }: ModeProps) {
  const [metric, setMetric] = useState('reply_rate')
  const [level, setLevel] = useState<'market' | 'zip'>('market')
  const q = useView(ctx, { metric, groupBy: level, limit: level === 'zip' ? 400 : 80 }, 'breakdown')
  const def = defs[metric]
  const isRate = def?.unit === 'rate'
  const rows = useMemo(() => (q.data?.result?.rows || []) as Array<BreakdownRow & { centroid?: { lat: number; lng: number; n: number } }>, [q.data])
  const selected = ctx.segment.find((s) => s.dim === level)?.value || null
  const format = (v: number | null) => fmtMetric(def, v)
  const unresolved = rows.find((r) => r.key === '__unresolved')
  const status = q.data?.metric?.cur?.status
  return (
    <div className="lab-mode">
      <Panel title="Geography" sub={`${def?.label} by ${level === 'zip' ? 'ZIP (top 400 by volume)' : 'canonical market'} · centroids from the group’s own properties`} className="is-wide"
        tools={<>
          <Segmented label="Level" value={level} onChange={setLevel} options={[{ key: 'market', label: 'Market' }, { key: 'zip', label: 'ZIP' }]} />
          <Segmented label="Metric" value={metric} onChange={setMetric} options={GEO_METRICS.map((id) => ({ key: id, label: defs[id]?.short || id }))} />
        </>}>
        <QueryState q={q} />
        {status === 'not_applicable' || status === 'unavailable' ? <Empty title={def?.label || metric}>{q.data?.metric?.cur?.reason}</Empty> : (
          <div className="lab-geo2">
            <LabGeoMap rows={rows} isRate={isRate} minSample={def?.min_sample || 30} theme={theme} selected={selected} format={format} onPick={(r) => act.pushSegment({ dim: level, value: r.key, label: r.label })} />
            <div className="lab-geo2__list">
              <RankedBars rows={rows.filter((r) => r.key !== '__unresolved')} unit={def?.unit || 'count'} format={format} maxRows={level === 'zip' ? 14 : 16}
                onPick={(r) => act.pushSegment({ dim: level, value: r.key, label: r.label })}
                onRecords={(r) => onRecords({ metric, part: isRate ? 'denominator' : undefined, group: { dim: level, key: r.key, label: r.label } }, `${def?.label} · ${r.label}`)} />
              {unresolved ? <p className="lab-note">{fmtCount(unresolved.n)} {isRate ? 'in the denominator' : ''} could not be placed (no canonical {level}); counted, never assigned.</p> : null}
            </div>
          </div>
        )}
        <p className="lab-note">{isRate ? 'Colour is the rate; size is its denominator; faint circles are below the minimum sample — a small market with a high rate is not a finding.' : 'Size is the count. Counts are never shaded as intensity; switch to a rate to compare markets.'}</p>
      </Panel>
    </div>
  )
}

/* ═══ AUTOMATION ═══════════════════════════════════════════════════════════ */

const ROLE_OF: Record<string, 'primary' | 'bad' | 'violet' | 'gold' | 'muted'> = { executed: 'primary', failed: 'bad', human_review: 'violet', send_gate: 'muted', auto_reply_off: 'gold', policy: 'muted', other: 'muted' }
export function ModeAutomation({ ctx, act, defs, onRecords, onInspect }: ModeProps) {
  const out = useView(ctx, { metric: 'autopilot_runs', groupBy: 'hold_class', limit: 12 }, 'breakdown')
  const reasons = useView(ctx, { metric: 'autopilot_runs', groupBy: 'block_reason', limit: 20 }, 'breakdown')
  const trend = useView(ctx, { metric: 'human_intervention_rate', groupBy: null }, 'series')
  const wf = useView(ctx, { metric: 'autopilot_runs', groupBy: null }, 'orchestrator')
  const rows = (out.data?.result?.rows || []) as BreakdownRow[]
  const total = out.data?.metric?.cur?.value ?? 0
  const s = trend.data?.result as unknown as { grain: string; current: Array<{ start: number; end: number; value: number | null; num?: number; den?: number }>; comparison: Array<{ start: number; end: number; value: number | null }> | null } | null
  const w = wf.data?.result as unknown as { total: number; workflows: Array<{ key: string; runs: number; states: Record<string, number> }>; note: string } | null
  return (
    <div className="lab-mode">
      <Panel title="Autopilot run outcomes" sub="every run ends in exactly one class · held is not failed">
        <QueryState q={out} />
        {rows.length ? <OutcomeStack total={total ?? 0} format={(n) => fmtCount(n)} parts={rows.map((r) => ({ key: r.key, label: r.label, value: r.value ?? 0, role: ROLE_OF[r.key] || 'muted', onPick: () => onRecords({ metric: 'autopilot_runs', group: { dim: 'hold_class', key: r.key, label: r.label } }, `Autopilot runs · ${r.label}`) }))} /> : out.data ? <Empty title="No autopilot runs in this slice" /> : null}
        <p className="lab-note">“Held by send gate” is the system’s own brake (review-only mode); “routed to a human” is the autopilot asking for judgement — that is the <button type="button" className="lab-link" onClick={() => onInspect('human_intervention_rate')}>human-intervention rate</button>, not a failure rate.</p>
      </Panel>
      <div className="lab-duo">
        <Panel title="Human-intervention rate" sub={`per ${s?.grain || ctx.grain} · runs routed to a person ÷ all runs`}>
          <QueryState q={trend} />
          {s ? <TrendChart current={s.current} comparison={s.comparison} unit="rate" grain={s.grain} tz={ctx.tz} format={(v) => fmtRate(v)} label="Human-intervention rate" currentLabel="This period" compareLabel="Comparison" minSample={defs.human_intervention_rate?.min_sample} height={200}
            onPick={(_, p) => onRecords({ metric: 'human_intervention_rate', part: 'numerator', bucket: { start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() } }, `Runs routed to a human · ${new Date(p.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)} /> : null}
        </Panel>
        <Panel title="Why runs were held" sub="block reason · click to drill">
          <QueryState q={reasons} />
          {reasons.data ? <RankedBars rows={((reasons.data.result?.rows || []) as BreakdownRow[])} unit="count" format={(v) => fmtCount(v)} maxRows={9} onPick={(r) => act.pushSegment({ dim: 'block_reason', value: r.key, label: r.label })} onRecords={(r) => onRecords({ metric: 'autopilot_runs', group: { dim: 'block_reason', key: r.key, label: r.label } }, `Autopilot runs · ${r.label}`)} /> : null}
        </Panel>
      </div>
      <Panel title="Workflow orchestrator (wf_*)" sub="partial · live since 2026-09-29">
        <QueryState q={wf} />
        {w ? (w.total ? (
          <ul className="lab-wf">{w.workflows.map((x) => <li key={x.key}><b>{x.key}</b><span>{fmtCount(x.runs)} run{x.runs === 1 ? '' : 's'}</span><em>{Object.entries(x.states).map(([k, n]) => `${n} ${k}`).join(' · ')}</em></li>)}</ul>
        ) : <p className="lab-note">No orchestrator runs started in this period.</p>) : null}
        <p className="lab-note">{w?.note} Version comparison needs at least two versions with runs; today only one workflow version has run, so no comparison is drawn.</p>
      </Panel>
    </div>
  )
}

/* ═══ BUYERS ═══════════════════════════════════════════════════════════════ */

export function ModeBuyers({ ctx }: ModeProps) {
  const q = useView(ctx, { metric: 'sellers_reached', groupBy: null }, 'buyers')
  const r = q.data?.result as unknown as { dataThrough: string | null; coverage: 'full' | 'partial' | 'none' | 'unknown'; purchases: number | null; entities: number | null; repeat: number | null; prevPurchases: number | null; markets: Array<{ key: string; label: string; cur: number; prev: number; entities: number }>; zips: unknown[]; unresolved: number | null; note: string } | null
  const through = r?.dataThrough ? new Date(r.dataThrough).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null
  return (
    <div className="lab-mode">
      <div className={cls('lab-callout', r?.coverage === 'none' && 't-warn')}><Icon name="database" /><span><b>DATA THROUGH {through || '—'}.</b> {r?.coverage === 'none' ? 'This period starts after the recorded corpus ends: buyer activity here is NOT YET RECORDED, not zero.' : r?.coverage === 'partial' ? 'The corpus ends inside this period; days after it are not yet recorded.' : 'The corpus covers this whole period.'}</span></div>
      <Panel title="Observed buyer activity" sub="recorded transactions · identity-resolved buyers · reads the reconciled v1 corpus (filters do not apply)">
        <QueryState q={q} />
        {r ? (
          <div className="lab-kpis3">
            <div><span>Recorded purchases</span><b>{r.purchases === null ? '—' : fmtCount(r.purchases)}</b>{r.coverage === 'none' ? <em>not yet recorded</em> : null}</div>
            <div><span>Distinct buyers</span><b>{r.entities === null ? '—' : fmtCount(r.entities)}</b></div>
            <div><span>By repeat buyers</span><b>{r.repeat === null ? '—' : fmtCount(r.repeat)}</b></div>
          </div>
        ) : null}
        {r?.markets.length ? (
          <div className="lab-tablewrap"><table className="lab-table"><thead><tr><th>Market</th><th>Purchases</th><th>Comparison</th><th>Buyers</th></tr></thead><tbody>{r.markets.slice(0, 20).map((m) => <tr key={m.key}><th>{m.label}</th><td>{fmtCount(m.cur)}</td><td>{fmtCount(m.prev)}</td><td>{fmtCount(m.entities)}</td></tr>)}</tbody></table></div>
        ) : r ? <p className="lab-note">No recorded purchases in this window{r.coverage !== 'full' ? ' (outside the recorded corpus)' : ''}.</p> : null}
        {r ? <p className="lab-note">{r.note} Not a demand score.</p> : null}
      </Panel>
    </div>
  )
}

/* ═══ FINANCIAL ════════════════════════════════════════════════════════════ */

export function ModeFinancial() {
  return (
    <div className="lab-mode">
      <Empty icon="dollar-sign" title="Financial analytics are unavailable">
        No canonical cost or revenue exists yet, so nothing is drawn. Measured 2026-09-30: <b>send_queue.estimated_cost</b> is populated on 0 of 11,007 sent rows (no expected spend), <b>closing_cases</b> holds 0 rows with confirmed or net revenue (no actual revenue), and there are 0 closings. When either source exists, expected and actual will be shown separately — an estimate is never presented as revenue.
      </Empty>
    </div>
  )
}

export const MODES = [
  { key: 'overview', label: 'Overview' },
  { key: 'acquisition', label: 'Acquisition' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'communications', label: 'Communications' },
  { key: 'geography', label: 'Geography' },
  { key: 'automation', label: 'Automation', badge: 'partial' },
  { key: 'buyers', label: 'Buyers', badge: 'data thru Jul 28' },
  { key: 'financial', label: 'Financial', badge: 'unavailable' },
] as const

export const rangeWord = (ctx: LabContext, env: { period: { start: string; end: string } } | null) => (env ? fmtRangeShort(env.period.start, env.period.end, ctx.tz) : '')
export { clamp }
