/**
 * COMMUNICATIONS — delivery observability.
 *
 *   flow      every queue row in the period → its one outcome → its class:
 *             delivered · sent with no receipt yet · undelivered (carrier) ·
 *             refused (provider) · blocked (our guards) · held (gate /
 *             review) · expired · cancelled · waiting. Held by the send gate
 *             is the system's own brake, not a failure.
 *   health    the failure and hold classes, NEVER merged: content filter,
 *             invalid destination, DNC, provider failure, recipient block,
 *             sender-health block … each its own line, by where it happened
 *   time      sent · delivered · reply rate · failure rate · filter rate ·
 *             opt-out rate · median reply time, one switchable trend
 *   senders   per sending number, with n — a 2-message sender is not ranked
 *
 * Channels: SMS is the only channel that has ever sent. Email Command has
 * never sent a message (sending is off pending Brevo / DNS) and calls have no
 * source — both are said, never drawn as zero performance.
 */
import { useMemo, useState } from 'react'
import type { BreakdownRow, Heatmap, Histogram, LabQuery, MetricDef, SeriesPoint } from '../../../domain/analytics/analytics-lab-api'
import { fmtMetric } from '../../../domain/analytics/analytics-lab-api'
import { LCDataGrid, LCSegmented, LCSelect, cx } from '../../../shared/lc'
import type { LCColumn, LCSort } from '../../../shared/lc'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import { metricFormat, metricTick, useWidth } from './intel-hooks'
import type { FlowLink, FlowNode } from './intel-model'
import { DELIVERY_CLASSES, alignTrend } from './intel-model'
import { fmtInt, fmtPct } from './intel-format'
import { serverContext } from './intel-state'
import { IntelFlow } from './IntelFlow'
import { IntelTrend } from './IntelTrend'
import { LatencyHistogram, RhythmHeat } from './IntelCharts'

const DISPOSITION_TONE: Record<string, string> = { delivered: 'ok', sent: 'exec', undelivered: 'crit', rejected: 'crit', blocked: 'attn', held: 'neutral', expired: 'neutral', cancelled: 'neutral', waiting: 'exec', other: 'neutral' }
const DISPOSITION_ORDER = ['delivered', 'sent', 'undelivered', 'rejected', 'blocked', 'held', 'waiting', 'expired', 'cancelled', 'other']
const SERIES_METRICS = ['messages_sent', 'messages_delivered', 'reply_rate', 'transport_failure_rate', 'content_filter_rate', 'opt_out_rate', 'median_reply_latency'] as const

export function IntelComms({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { ctx, registry, overview, records, refreshing } = useLab()
  const base = serverContext(ctx, { metric: 'queue_rows', groupBy: null })
  const dispQ = useIntel<LabQuery>(paths.query({ ...base, groupBy: 'disposition', limit: 20 }, 'breakdown'))
  const clsQ = useIntel<LabQuery>(paths.query({ ...base, groupBy: 'failure_class', limit: 40 }, 'breakdown'))
  const disp = useMemo(() => (dispQ.data?.result?.rows || []) as BreakdownRow[], [dispQ.data])
  const cls = useMemo(() => (clsQ.data?.result?.rows || []) as BreakdownRow[], [clsQ.data])
  const total = dispQ.data?.metric?.cur?.value ?? null
  const [wRef, width] = useWidth<HTMLDivElement>()

  const { nodes, links } = useMemo(() => {
    const map = registry.classDisposition || {}
    const labels = registry.classLabels || {}
    const dLabels = registry.dispositionLabels || {}
    const n: FlowNode[] = []
    const l: FlowLink[] = []
    if (!disp.length) return { nodes: n, links: l }
    const sum = disp.reduce((a, r) => a + (r.value || 0), 0)
    n.push({ id: 'q', column: 0, label: 'Queue rows', value: sum, tone: 'neutral', hint: 'Every outbound queue row whose attempt time falls in the period' })
    for (const d of [...disp].sort((a, b) => DISPOSITION_ORDER.indexOf(a.key) - DISPOSITION_ORDER.indexOf(b.key))) {
      if (!d.value) continue
      n.push({ id: `d:${d.key}`, column: 1, label: dLabels[d.key] || d.label, value: d.value, tone: DISPOSITION_TONE[d.key] || 'neutral' })
      l.push({ from: 'q', to: `d:${d.key}`, value: d.value })
    }
    // a disposition with several classes branches; a one-class disposition ends at column 1.
    // Classes under 1% of the rows fold into one "other" ribbon per disposition (the list
    // below keeps every class apart); a disposition whose classes are ALL that small does not branch.
    const byDisp = new Map<string, BreakdownRow[]>()
    for (const c of cls) { const d = map[c.key]; if (!d || !c.value) continue; byDisp.set(d, [...(byDisp.get(d) || []), c]) }
    const floor = Math.max(1, sum * 0.01)
    for (const [d, list] of byDisp) {
      if (list.length < 2) continue
      const sorted = [...list].sort((a, b) => (b.value || 0) - (a.value || 0))
      let big = sorted.filter((c) => (c.value || 0) >= floor)
      let small = sorted.filter((c) => (c.value || 0) < floor)
      if (small.length === 1) { big = sorted; small = [] }
      if (big.length + (small.length ? 1 : 0) < 2) continue
      const tone = DISPOSITION_TONE[d] || 'neutral'
      for (const c of big) {
        n.push({ id: `c:${c.key}`, column: 2, label: labels[c.key] || c.label, value: c.value || 0, tone })
        l.push({ from: `d:${d}`, to: `c:${c.key}`, value: c.value || 0 })
      }
      if (small.length) {
        const v = small.reduce((a, c) => a + (c.value || 0), 0)
        n.push({ id: `o:${d}`, column: 2, label: `${small.length} smaller classes`, value: v, tone, hint: small.map((c) => `${labels[c.key] || c.label} · ${fmtInt(c.value)}`).join('\n') })
        l.push({ from: `d:${d}`, to: `o:${d}`, value: v })
      }
    }
    return { nodes: n, links: l }
  }, [disp, cls, registry])

  const delivered = disp.find((d) => d.key === 'delivered')?.value ?? null
  const health = DELIVERY_CLASSES.map((c) => ({ ...c, value: cls.find((r) => r.key === c.key)?.value ?? 0 })).filter((c) => c.value > 0)
  const healthMax = Math.max(1, ...health.map((h) => h.value))

  return (
    <section className={cx('ix-comms lc-plane is-clear is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} aria-label="Communication health">
      <header className="ix-plane__head">
        <div>
          <span className="ix-eyebrow">Communications · SMS</span>
          <h2>Where every message went</h2>
        </div>
        <p className="ix-muted">{total !== null ? <>{fmtInt(total)} queue rows · {fmtPct(total ? (delivered || 0) / total : null)} delivered</> : 'reading the queue…'} · held ≠ failed</p>
      </header>
      <div ref={wRef} className={cx('ix-comms__flow', (dispQ.stale || clsQ.stale) && 'is-stale')}>
        {nodes.length ? (
          <IntelFlow
            nodes={nodes}
            links={links}
            columns={nodes.some((x) => x.column === 2) ? 3 : 2}
            width={Math.max(320, width)}
            height={variant === 'lens' ? 360 : 260}
            label="Delivery flow: queue rows to outcome to class"
            onPick={(node) => {
              if (node.id === 'q') records({ cohort: { metric: 'queue_rows', window: 'current' }, title: 'Queue rows · this period' })
              else if (node.id.startsWith('d:')) records({ cohort: { metric: 'queue_rows', group: { dim: 'disposition', key: node.id.slice(2), label: node.label } }, title: `Queue rows · ${node.label}` })
              else if (node.id.startsWith('o:')) {
                const key = node.id.slice(2)
                const parent = registry.dispositionLabels?.[key] || key
                records({ cohort: { metric: 'queue_rows', group: { dim: 'disposition', key, label: parent } }, title: `Queue rows · ${parent}` })
              }
              else records({ cohort: { metric: 'queue_rows', group: { dim: 'failure_class', key: node.id.slice(2), label: node.label } }, title: `Queue rows · ${node.label}` })
            }}
          />
        ) : dispQ.loading ? <div className="ix-skel-block" /> : <p className="ix-note">No queue rows in this slice.</p>}
      </div>

      <div className="ix-comms__grid">
        <div className="ix-health">
          <div className="ix-subhead"><span className="ix-eyebrow">Delivery health · each class apart</span></div>
          {health.length ? (
            <ol className="ix-health__list">
              {(['carrier', 'provider', 'guard', 'gate'] as const).map((stage) => {
                const list = health.filter((h) => h.stage === stage)
                if (!list.length) return null
                return (
                  <li key={stage}>
                    <span className="ix-health__stage">{stage === 'carrier' ? 'At the carrier' : stage === 'provider' ? 'At the provider' : stage === 'guard' ? 'Our pre-send guards' : 'Our brakes'}</span>
                    <ul>
                      {list.map((h) => (
                        <li key={h.key}>
                          <button type="button" onClick={() => records({ cohort: { metric: 'queue_rows', group: { dim: 'failure_class', key: h.key, label: h.label } }, title: `Queue rows · ${h.label}` })} title="Open these messages">
                            <span>{h.label}</span>
                            <i className="ix-health__bar" data-tone={h.tone} style={{ width: `${Math.max(2, (h.value / healthMax) * 100)}%` }} />
                            <b>{fmtInt(h.value)}</b>
                            <small>{total ? fmtPct(h.value / total) : ''}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                )
              })}
            </ol>
          ) : clsQ.loading ? <div className="ix-skel-rows"><i /><i /><i /></div> : <p className="ix-note">No failures, blocks or holds in this slice.</p>}
        </div>
        {variant === 'lens' ? <CommsTrend compact={false} /> : null}
      </div>

      {variant === 'lens' ? <CommsDeep /> : null}

      <p className="ix-channels">
        <span><i data-tone="ok" />SMS · every figure here</span>
        <span><i data-tone="neutral" />Email · never sent (Email Command sending is off) — not zero performance</span>
        <span><i data-tone="neutral" />Calls · no call source connected</span>
        {overview?.thePeriod.exclusions.canarySends ? <span className="ix-muted">{fmtInt(overview.thePeriod.exclusions.canarySends)} canary messages excluded</span> : null}
      </p>
    </section>
  )
}

function CommsTrend({ compact }: { compact: boolean }) {
  const { ctx, defs, overview } = useLab()
  const [metric, setMetric] = useState<string>('messages_sent')
  const def: MetricDef | undefined = defs[metric]
  const q = useIntel<LabQuery>(overview ? paths.query(serverContext(ctx, { metric, groupBy: null }), 'series') : null)
  const series = q.data?.result
  const points = useMemo(() => (series ? alignTrend((series.current as SeriesPoint[]) || [], (series.comparison as SeriesPoint[] | null) ?? null) : []), [series])
  const [active, setActive] = useState<number | null>(null)
  return (
    <div className={cx('ix-commstrend', q.stale && 'is-stale')}>
      <div className="ix-subhead">
        <span className="ix-eyebrow">Over time</span>
        <LCSelect label="Communication metric" variant="quiet" size="sm" value={metric} onChange={(v) => { setMetric(v); setActive(null) }} options={SERIES_METRICS.filter((id) => defs[id]).map((id) => ({ value: id, label: defs[id].label }))} menuWidth={240} />
      </div>
      {points.length ? (
        <IntelTrend
          points={points}
          unit={def?.unit || 'count'}
          grain={String(series?.grain || 'day')}
          tz={ctx.tz}
          label={`${def?.label}, this period against the previous`}
          format={metricFormat(def)}
          formatTick={metricTick(def)}
          height={compact ? 180 : 230}
          minSample={def?.min_sample}
          showCompare={Boolean(overview?.compare.available)}
          active={active}
          onActive={setActive}
          tooltip
          compareLabel="Previous period"
          sampleLabel={def?.denominator?.label}
        />
      ) : <div className="ix-skel-block is-short" />}
    </div>
  )
}

const SENDER_METRICS = ['messages_sent', 'delivery_rate', 'content_filter_rate', 'transport_failure_rate', 'sender_health_blocks', 'reply_rate'] as const
type TableRow = { key: string; label: string; test?: boolean; values: Record<string, { value: number | null; num: number | null; den: number | null; n: number; insufficient?: boolean }> }

function CommsDeep() {
  const { ctx, act, defs, records } = useLab()
  const sendersQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: 'messages_sent', groupBy: 'sender', limit: 40, metrics: [...SENDER_METRICS] }), 'table'))
  const [heatMetric, setHeatMetric] = useState<'reply_rate' | 'sellers_replied' | 'messages_delivered'>('reply_rate')
  const heatQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: heatMetric, groupBy: null }), 'heatmap'))
  const latQ = useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: 'median_reply_latency', groupBy: null }), 'histogram'))
  const rows = useMemo(() => ((sendersQ.data?.result?.rows || []) as unknown as TableRow[]), [sendersQ.data])
  const [sort, setSort] = useState<LCSort>({ id: 'messages_sent', dir: 'desc' })
  const sorted = useMemo(() => {
    if (!sort) return rows
    const v = (r: TableRow) => (sort.id === 'label' ? r.label : r.values[sort.id]?.value ?? -1)
    return [...rows].sort((a, b) => { const x = v(a); const y = v(b); return (x > y ? 1 : x < y ? -1 : 0) * (sort.dir === 'asc' ? 1 : -1) })
  }, [rows, sort])
  const hm = (heatQ.data?.result as unknown as { current: Heatmap } | null)?.current
  const hist = (latQ.data?.result as unknown as { current: Histogram } | null)?.current
  const col = (id: string): LCColumn<TableRow> => {
    const def = defs[id]
    const rate = def?.unit === 'rate'
    return {
      id, header: def?.short || id, width: rate ? 128 : 100, align: 'right', sortable: true, hint: def?.description,
      render: (r) => {
        const v = r.values[id]
        if (!v) return <span className="ix-muted">—</span>
        return (
          <button type="button" className={cx('ix-cellbtn', v.insufficient && 'is-thin')} onClick={() => records({ cohort: { metric: id, part: rate ? 'numerator' : undefined, group: { dim: 'sender', key: r.key, label: r.label } }, title: `${def?.label} · ${r.label}` })} title={rate ? `${v.num} of ${v.den}${v.insufficient ? ' · below the minimum sample' : ''}` : undefined}>
            <b>{fmtMetric(def, v.value)}</b>{rate ? <small>{fmtInt(v.num)}/{fmtInt(v.den)}</small> : null}
          </button>
        )
      },
    }
  }
  const columns: LCColumn<TableRow>[] = [
    { id: 'label', header: 'Sender number', minWidth: 180, sortable: true, render: (r) => <button type="button" className="ix-link" onClick={() => act.pushSegment({ dim: 'sender', value: r.key, label: r.label })} title="Narrow the Lab to this sender">{r.label}</button> },
    ...SENDER_METRICS.filter((id) => defs[id]).map(col),
  ]
  return (
    <div className="ix-comms__deep">
      <div className="ix-subhead"><span className="ix-eyebrow">Senders · sample-aware</span><small className="ix-muted">faded = below the metric’s minimum sample; never ranked as certain</small></div>
      <div className="ix-grid">
        <LCDataGrid id="intel-senders" label="Sender comparison" rows={sorted} rowKey={(r) => r.key} columns={columns} sort={sort} onSortChange={setSort} loading={sendersQ.loading && !rows.length} error={sendersQ.error && !rows.length ? { what: 'Sender comparison didn’t load', onRetry: sendersQ.reload } : null} empty={{ title: 'No sender activity in this slice' }} height={Math.min(420, 44 + Math.max(3, sorted.length) * 36)} />
      </div>
      <div className="ix-duo">
        <div>
          <div className="ix-subhead">
            <span className="ix-eyebrow">When sellers answer · seller-local</span>
            <LCSegmented label="Rhythm metric" size="sm" value={heatMetric} onChange={setHeatMetric} options={[{ value: 'reply_rate', label: 'Reply rate' }, { value: 'sellers_replied', label: 'Replies' }, { value: 'messages_delivered', label: 'Delivered' }]} />
          </div>
          {hm ? <RhythmHeat data={hm} isRate={heatMetric === 'reply_rate'} format={(v) => (heatMetric === 'reply_rate' ? fmtPct(v, 0) : fmtInt(v))} onCell={(w, h) => records({ cohort: { metric: heatMetric, part: heatMetric === 'reply_rate' ? 'numerator' : undefined, cell: { weekday: w, hour: h } }, title: `${defs[heatMetric]?.label} · ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][w]} ${String(h).padStart(2, '0')}:00` })} /> : <div className="ix-skel-block" />}
          {heatMetric === 'reply_rate' ? <p className="ix-note">A reply-rate cell is the share of sellers FIRST REACHED in that local hour who replied — it places the outreach, not the reply.</p> : null}
        </div>
        <div>
          <div className="ix-subhead"><span className="ix-eyebrow">Reply time</span><small className="ix-muted">our last delivered message → the first reply</small></div>
          {hist ? (hist.dist.n ? <LatencyHistogram data={hist} format={(v) => fmtMetric(defs.median_reply_latency, v)} /> : <p className="ix-note">No replies with a prior delivered message.</p>) : <div className="ix-skel-block" />}
        </div>
      </div>
    </div>
  )
}
