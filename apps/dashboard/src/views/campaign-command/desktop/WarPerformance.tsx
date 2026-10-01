import { memo, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { LCLink, LCSkeleton, LCTooltip, cx } from '../../../shared/lc'
import type { CampaignIntel, SeriesBucket } from './war-room-api'
import { useWidth } from './war-room-hooks'
import {
  REPLY_META, SENDER_STATE_LABEL, formatPhone, localHour, moneyLines, nf, pct, performanceRates, plural, replySegments,
  type WarInput,
} from './war-room-model'
import { Plane } from './WarPlanes'

/**
 * PERFORMANCE — built-in campaign analytics, not the Analytics app.
 *
 * One axis per chart (replies, an order of magnitude smaller than sends, get
 * their own small multiple on the same time scale), thin 2 px lines, a
 * crosshair that snaps to the bucket and reads every series, a table view
 * for every chart, and rates only with their sample size. Series colours are
 * the semantic tones stepped into the validated chart band (war-room.css).
 */

const fmtTick = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(Math.round(n)))

function niceMax(v: number): number {
  if (v <= 4) return 4
  const p = 10 ** Math.floor(Math.log10(v))
  const steps = [1, 2, 2.5, 5, 10]
  for (const s of steps) if (s * p >= v) return s * p
  return 10 * p
}

type Series = { key: keyof SeriesBucket; label: string; tone: 'queued' | 'sent' | 'delivered' | 'replies' | 'failed'; dashed?: boolean; area?: boolean }

function bucketLabel(t: string, grain: 'hour' | 'day', tz: string | null): string {
  const d = new Date(t)
  return grain === 'hour'
    ? new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', timeZone: tz || undefined }).format(d)
    : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz || undefined }).format(d)
}

/** A time chart: thin lines on one axis, a crosshair and one tooltip for every series. */
function TimeChart({ buckets, grain, tz, series, height = 168, label }: { buckets: SeriesBucket[]; grain: 'hour' | 'day'; tz: string | null; series: Series[]; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)
  const W = Math.max(240, width)
  const padL = 34
  const padR = 10
  const padT = 8
  const padB = 22
  const max = niceMax(Math.max(1, ...buckets.flatMap((b) => series.map((s) => Number(b[s.key]) || 0))))
  const x = (i: number) => padL + (buckets.length <= 1 ? 0 : (i / (buckets.length - 1)) * (W - padL - padR))
  const y = (v: number) => padT + (1 - v / max) * (height - padT - padB)
  const ticks = [0, max / 2, max]
  // day boundaries as x labels (≤ 7)
  const xLabels = useMemo(() => {
    const out: Array<{ i: number; text: string }> = []
    let lastDay = ''
    buckets.forEach((b, i) => {
      const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz || undefined }).format(new Date(b.t))
      if (day !== lastDay) { out.push({ i, text: day }); lastDay = day }
    })
    const step = Math.ceil(out.length / 7)
    return out.filter((_, k) => k % step === 0)
  }, [buckets, tz])
  const path = (s: Series) => buckets.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(b[s.key]) || 0).toFixed(1)}`).join('')
  const area = (s: Series) => `${path(s)}L${x(buckets.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const i = Math.round(((px - padL) / (W - padL - padR)) * (buckets.length - 1))
    setActive(Math.max(0, Math.min(buckets.length - 1, i)))
  }
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); setActive((a) => Math.min(buckets.length - 1, (a ?? -1) + 1)) }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setActive((a) => Math.max(0, (a ?? buckets.length) - 1)) }
    if (e.key === 'Escape') setActive(null)
  }
  const a = active !== null ? buckets[active] : null
  return (
    <div className="cc3-chart" ref={ref}>
      <svg
        width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" tabIndex={0}
        aria-label={`${label}. ${series.map((s) => `${s.label}: ${nf(buckets.reduce((sum, b) => sum + (Number(b[s.key]) || 0), 0))}`).join(', ')}. Arrow keys inspect each ${grain}.`}
        onPointerMove={onMove} onPointerLeave={() => setActive(null)} onKeyDown={onKey} onBlur={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="cc3-chart__grid" />
            <text x={padL - 6} y={y(t) + 3.5} className="cc3-chart__tick" textAnchor="end">{fmtTick(t)}</text>
          </g>
        ))}
        {xLabels.map((l) => <text key={l.i} x={x(l.i)} y={height - 6} className="cc3-chart__tick" textAnchor="start">{l.text}</text>)}
        {series.map((s) => (s.area ? <path key={`a-${s.key}`} d={area(s)} className="cc3-chart__area" data-s={s.tone} /> : null))}
        {series.map((s) => <path key={s.key} d={path(s)} className={cx('cc3-chart__line', s.dashed && 'is-dashed')} data-s={s.tone} />)}
        {active !== null ? (
          <g>
            <line x1={x(active)} x2={x(active)} y1={padT} y2={height - padB} className="cc3-chart__cross" />
            {series.map((s) => <circle key={s.key} cx={x(active)} cy={y(Number(buckets[active][s.key]) || 0)} r={4} className="cc3-chart__dot" data-s={s.tone} />)}
          </g>
        ) : null}
      </svg>
      {a && active !== null ? (
        <div className="cc3-chart__tip" style={{ left: `${Math.min(Math.max(x(active), 90), W - 90)}px` }} role="status">
          <span className="cc3-chart__tipwhen">{bucketLabel(a.t, grain, tz)}</span>
          {series.map((s) => (
            <span key={s.key} className="cc3-chart__tiprow" data-s={s.tone}>
              <i aria-hidden="true" /><b className="lc-num">{nf(Number(a[s.key]) || 0)}</b><span>{s.label}</span>
            </span>
          ))}
        </div>
      ) : null}
      <ul className="cc3-chart__legend">
        {series.map((s) => <li key={s.key} data-s={s.tone} className={cx(s.dashed && 'is-dashed')}><i aria-hidden="true" />{s.label}<b className="lc-num">{nf(buckets.reduce((sum, b) => sum + (Number(b[s.key]) || 0), 0))}</b></li>)}
      </ul>
    </div>
  )
}

/** Columns by local hour of day — one row per measure, the window shaded. */
function HourOfDay({ buckets, tz, windowSpan }: { buckets: SeriesBucket[]; tz: string | null; windowSpan: [number, number] | null }) {
  const rows = useMemo(() => {
    const sums = { sent: new Array(24).fill(0), delivered: new Array(24).fill(0), replies: new Array(24).fill(0) }
    for (const b of buckets) {
      const h = Math.floor(localHour(Date.parse(b.t), tz)) % 24
      sums.sent[h] += b.sent
      sums.delivered[h] += b.delivered
      sums.replies[h] += b.replies
    }
    return [
      { key: 'sent', label: 'Texts / hour', tone: 'sent', values: sums.sent as number[] },
      { key: 'delivered', label: 'Delivered / hour', tone: 'delivered', values: sums.delivered as number[] },
      { key: 'replies', label: 'Replies / hour', tone: 'replies', values: sums.replies as number[] },
    ]
  }, [buckets, tz])
  return (
    <div className="cc3-hours">
      {rows.map((r) => {
        const max = Math.max(1, ...r.values)
        const peak = r.values.indexOf(Math.max(...r.values))
        return (
          <div key={r.key} className="cc3-hours__row">
            <span className="cc3-hours__label">{r.label}<b className="lc-num">{nf(r.values.reduce((s, v) => s + v, 0))}</b></span>
            <div className="cc3-hours__cols" role="img" aria-label={`${r.label} by local hour; peak at ${peak}:00`}>
              {windowSpan ? <span className="cc3-hours__window" style={{ left: `${(windowSpan[0] / 24) * 100}%`, width: `${((windowSpan[1] - windowSpan[0]) / 24) * 100}%` }} /> : null}
              {r.values.map((v, h) => (
                <LCTooltip key={h} content={`${String(h).padStart(2, '0')}:00 — ${nf(v)} ${r.label.split(' /')[0].toLowerCase()}`}>
                  <span className="cc3-hours__col" data-s={r.tone} tabIndex={-1}><i style={{ height: `${v ? Math.max(6, (v / max) * 100) : 0}%` }} /></span>
                </LCTooltip>
              ))}
            </div>
          </div>
        )
      })}
      <div className="cc3-hours__axis lc-num" aria-hidden="true">{[0, 6, 12, 18, 24].map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>)}</div>
    </div>
  )
}

function SeriesTable({ buckets, grain, tz }: { buckets: SeriesBucket[]; grain: 'hour' | 'day'; tz: string | null }) {
  const rows = buckets.filter((b) => b.queued || b.sent || b.delivered || b.failed || b.replies)
  return (
    <div className="cc3-tablewrap">
      <table className="cc3-table is-num">
        <thead><tr><th>{grain === 'hour' ? 'Hour' : 'Day'}</th><th>Queued</th><th>Left us</th><th>Delivered</th><th>Not delivered</th><th>Replies</th></tr></thead>
        <tbody>{rows.map((b) => <tr key={b.t}><th scope="row">{bucketLabel(b.t, grain, tz)}</th><td>{nf(b.queued)}</td><td>{nf(b.sent)}</td><td>{nf(b.delivered)}</td><td>{nf(b.failed)}</td><td>{nf(b.replies)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

const FUNNEL_ROWS: Array<{ key: keyof NonNullable<CampaignIntel['delivery']>; label: string; tone: string; note?: string }> = [
  { key: 'delivered', label: 'Delivered', tone: 'ok' },
  { key: 'awaiting_receipt', label: 'Sent — no receipt yet', tone: 'exec' },
  { key: 'filtered', label: 'Content filter (carrier spam)', tone: 'attn', note: 'Wording, not the number or the list' },
  { key: 'invalid_destination', label: 'Invalid destination (hard bounce)', tone: 'crit' },
  { key: 'soft_bounce', label: 'Soft bounce', tone: 'crit' },
  { key: 'carrier_dnc', label: 'Carrier DNC', tone: 'crit' },
  { key: 'carrier_undelivered', label: 'Carrier undelivered (unspecified)', tone: 'crit' },
  { key: 'provider_refused', label: 'Refused by the provider', tone: 'crit', note: 'Never accepted — no message id' },
  { key: 'held_at_send', label: 'Held at send (sender / template health)', tone: 'neutral', note: 'A hold, not a failure' },
  { key: 'expired_unsent', label: 'Expired unsent', tone: 'neutral' },
  { key: 'cancelled', label: 'Cancelled before sending', tone: 'neutral' },
  { key: 'waiting', label: 'Waiting in the queue', tone: 'exec' },
]

export const PerformanceMode = memo(function PerformanceMode({ input, onSender, onTemplate }: { input: WarInput; onSender: (phone: string) => void; onTemplate?: (id: string) => void }) {
  const intel = input.intel ?? null
  const tz = intel?.timezone ?? input.core?.lineage.timezone ?? null
  const [table, setTable] = useState(false)
  const segs = replySegments(intel?.replies?.buckets)
  const replyTotal = segs.reduce((s, x) => s + x.value, 0)
  const rates = performanceRates(input)
  const money = moneyLines(intel)
  const d = intel?.delivery ?? null
  const w = input.core?.window?.window?.match(/(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/)
  const windowSpan: [number, number] | null = w ? [Number(w[1]) + Number(w[2]) / 60, Number(w[3]) + Number(w[4]) / 60] : null
  const r = intel?.retries ?? null
  if (!intel) return <div className="cc3-perf"><LCSkeleton shape="chart" height={220} /><LCSkeleton shape="rows" count={6} /></div>
  const senders = (intel.fleet?.numbers ?? []).filter((s) => s.campaign.left_us > 0)
  return (
    <div className="cc3-perf">
      <Plane
        title="Execution over time"
        meta={intel.series ? `${intel.series.grain === 'hour' ? 'Hourly' : 'Daily'} · campaign texts only · ${tz ?? 'UTC'}` : null}
        action={intel.series ? <LCLink onClick={() => setTable((v) => !v)}>{table ? 'View as chart' : 'View as table'}</LCLink> : null}
        className="cc3-perf__series"
        id="cc3-ps"
      >
        {!intel.series ? <p className="cc3-muted">Nothing has been queued yet.</p> : table ? <SeriesTable buckets={intel.series.buckets} grain={intel.series.grain} tz={tz} /> : (
          <>
            <TimeChart
              buckets={intel.series.buckets} grain={intel.series.grain} tz={tz} label="Queued, sent and delivered over time"
              series={[{ key: 'queued', label: 'Queued', tone: 'queued', dashed: true }, { key: 'sent', label: 'Left us', tone: 'sent', area: true }, { key: 'delivered', label: 'Delivered', tone: 'delivered' }]}
            />
            <TimeChart buckets={intel.series.buckets} grain={intel.series.grain} tz={tz} height={92} label="Replies over time" series={[{ key: 'replies', label: 'Seller replies', tone: 'replies', area: true }]} />
          </>
        )}
      </Plane>

      <div className="cc3-perf__grid">
        <Plane title="Hourly throughput" meta={`Seller-local pacing · ${tz ?? 'UTC'}`} className="cc3-perf__hours" id="cc3-ph">
          {intel.series ? <HourOfDay buckets={intel.series.buckets} tz={tz} windowSpan={windowSpan} /> : <p className="cc3-muted">No sends yet.</p>}
        </Plane>
        <Plane title="Reply composition" meta={replyTotal ? `${plural(replyTotal, 'seller')} · latest reply each` : null} className="cc3-perf__replies" id="cc3-pr">
          {replyTotal ? (
            <>
              <div className="cc3-stack" role="img" aria-label={segs.map((s) => `${s.label} ${s.value}`).join(', ')}>
                {segs.filter((s) => s.value).map((s) => <i key={s.key} data-r={s.key} style={{ flexGrow: s.value }} title={`${s.label}: ${s.value}`} />)}
              </div>
              <ul className="cc3-legend is-table">
                {segs.map((s) => <li key={s.key} data-zero={s.value ? undefined : ''}><i data-r={s.key} aria-hidden="true" /><span>{REPLY_META[s.key].label}</span><b className="lc-num">{nf(s.value)}</b><em className="lc-num">{pct(s.value, replyTotal, 0) ?? ''}</em></li>)}
              </ul>
              <p className="cc3-foot">Classified by the inbound classifier; grouping never upgrades meaning (“confirmed owner” is not “interested”).</p>
            </>
          ) : <p className="cc3-muted">No seller has replied yet.</p>}
        </Plane>
      </div>

      <div className="cc3-perf__grid">
        <Plane title="Delivery — provider semantics" meta={d ? `${nf(d.left_us)} texts left us · ${nf(d.accepted)} accepted by the provider` : null} className="cc3-perf__delivery" id="cc3-pd">
          {d ? (
            <ul className="cc3-dfunnel">
              {FUNNEL_ROWS.filter((row) => Number(d[row.key]) > 0 || row.key === 'delivered' || row.key === 'filtered').map((row) => {
                const v = Number(d[row.key]) || 0
                return (
                  <li key={row.key} data-tone={row.tone}>
                    <span className="cc3-dfunnel__label">{row.label}{row.note ? <em>{row.note}</em> : null}</span>
                    <span className="cc3-dfunnel__bar"><i style={{ width: `${d.total ? Math.max(v ? 1 : 0, (v / d.total) * 100) : 0}%` }} /></span>
                    <b className="lc-num">{nf(v)}</b>
                    <span className="cc3-dfunnel__pct lc-num">{pct(v, d.total) ?? '—'}</span>
                  </li>
                )
              })}
            </ul>
          ) : <p className="cc3-muted">Delivery not available.</p>}
          {d?.receipt_lag ? <p className="cc3-alert" data-tone="attn">{plural(d.receipt_lag, 'text')} still read “sent” in the queue although the carrier already reported them undelivered.</p> : null}
        </Plane>
        <Plane title="Delivery recovery" meta="Filtered first texts retry once on a different approved template" className="cc3-perf__retry" id="cc3-pv">
          {r ? (
            <ol className="cc3-lineage">
              <li><b className="lc-num">{nf(r.originals_filtered)}</b><span>first texts filtered by the carrier</span></li>
              <li><b className="lc-num">{nf(r.recycled)}</b><span>put back in line on another template</span></li>
              <li><b className="lc-num">{nf(r.retry_rows)}</b><span>retries queued{r.retry_waiting ? ` · ${nf(r.retry_waiting)} awaiting` : ''}</span></li>
              <li data-tone="ok"><b className="lc-num">{nf(r.retry_delivered)}</b><span>retries delivered</span></li>
              <li data-tone="attn"><b className="lc-num">{nf(r.retry_filtered + r.retry_failed)}</b><span>retries not delivered ({nf(r.retry_filtered)} filtered again)</span></li>
            </ol>
          ) : null}
          {r && r.no_retry ? <p className="cc3-foot">Not retried: {Object.entries(r.no_retry_reasons).map(([k, n]) => `${k.toLowerCase()} ${nf(n)}`).join(' · ')} — a hard bounce or a second filtering never retries. One logical communication per seller per touch: a retry supersedes, it never duplicates.</p> : null}
        </Plane>
      </div>

      <Plane title="Message strategy & template performance" meta={intel.templates ? `${plural(intel.templates.length, 'template')} · rates need ≥ 20 sends` : null} className="cc3-perf__templates" id="cc3-pt">
        {intel.templates && intel.templates.length ? (
          <div className="cc3-tablewrap">
            <table className="cc3-table is-num">
              <thead><tr><th>Template</th><th>Language · stage</th><th>Sent</th><th>Delivered</th><th>Filtered</th><th>Replied</th><th>State</th></tr></thead>
              <tbody>
                {intel.templates.slice(0, 24).map((t, i) => (
                  <tr key={t.template_id} onClick={onTemplate ? () => onTemplate(t.template_id) : undefined} className={cx(!t.sample_ok && 'is-thin')}>
                    <th scope="row"><span className="cc3-tname">{t.name ?? t.template_id}</span>{i === 0 ? <em className="cc3-tag">primary</em> : null}</th>
                    <td>{[t.language, t.stage_code].filter(Boolean).join(' · ') || '—'}</td>
                    <td>{nf(t.attempted)}</td>
                    <td>{t.sample_ok ? pct(t.delivered, t.attempted) : `${nf(t.delivered)}`}</td>
                    <td>{t.sample_ok ? pct(t.filtered, t.attempted) : `${nf(t.filtered)}`}</td>
                    <td>{t.sellers_first_reached >= 20 ? pct(t.sellers_replied, t.sellers_first_reached) : nf(t.sellers_replied)}</td>
                    <td>{t.blocked_by_operator ? <span className="cc3-chip" data-state="block">Blocked</span> : t.quarantined ? <span className="cc3-chip" data-state="warn">Quarantined</span> : t.active === false ? <span className="cc3-chip" data-state="idle">Inactive</span> : <span className="cc3-chip" data-state="pass">In rotation</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="cc3-muted">No template has sent for this campaign yet.</p>}
        <p className="cc3-foot">Counts below 20 sends show raw numbers, not rates. Blocked templates are on the operator blocklist and are skipped by the planner.</p>
      </Plane>

      <div className="cc3-perf__grid">
        <Plane title="Sender performance" meta="Not a ranking — samples are small" className="cc3-perf__senders" id="cc3-pn">
          {senders.length ? (
            <table className="cc3-table is-num">
              <thead><tr><th>Number</th><th>State</th><th>Left us</th><th>Delivered</th><th>Replied</th></tr></thead>
              <tbody>
                {senders.map((s) => (
                  <tr key={s.phone} onClick={() => onSender(s.phone)}>
                    <th scope="row">{formatPhone(s.phone)}</th>
                    <td>{SENDER_STATE_LABEL[s.state]}</td>
                    <td>{nf(s.campaign.left_us)}</td>
                    <td>{s.campaign.sample_ok ? pct(s.campaign.delivered, s.campaign.left_us) : nf(s.campaign.delivered)}</td>
                    <td>{s.campaign.sellers >= 20 ? pct(s.campaign.sellers_replied, s.campaign.sellers) : nf(s.campaign.sellers_replied)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="cc3-muted">No number has sent for this campaign.</p>}
        </Plane>
        <Plane title="Campaign performance" meta="Each rate with its sample" className="cc3-perf__rates" id="cc3-pm">
          <ul className="cc3-rates">
            {rates.map((x) => (
              <li key={x.key} data-thin={x.thin ? '' : undefined}>
                <span>{x.label}</span>
                <b className="lc-num">{x.value ?? '—'}</b>
                <em className="lc-num">{nf(x.num)} / {nf(x.den)}{x.thin ? ' · small sample' : ''}</em>
              </li>
            ))}
          </ul>
        </Plane>
      </div>

      <Plane title="Acquisition economics" meta="Attributable to sellers who replied to this campaign" className="cc3-perf__money" id="cc3-pe">
        <dl className="cc3-money is-wide">
          {money.map((m) => (
            <div key={m.key} data-basis={m.basis}>
              <dt>{m.label}<span className="cc3-basis">{m.basis}</span></dt>
              <dd className="lc-num">{m.value}{m.n ? <small>{plural(m.n, m.key === 'recommended' ? 'deal' : 'record')}</small> : <small>none yet</small>}</dd>
            </div>
          ))}
        </dl>
        <p className="cc3-foot">Recommended offers are the engine’s model, not offers made; nothing here is realized profit until a closing confirms revenue.</p>
      </Plane>
    </div>
  )
})
