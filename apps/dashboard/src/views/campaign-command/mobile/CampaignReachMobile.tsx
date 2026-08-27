import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { CampaignPreviewResult } from '../campaignWizardAdapter'

/**
 * Campaign Creator — REACH, mobile 393pt.
 *
 * Counts, funnel math, the exclusive partition, routing semantics and the
 * preview lifecycle are frozen — this file changes presentation only.
 *
 * The contraction is ONE CONNECTED SILHOUETTE, not a stack of bands. A single
 * SVG polygon runs the height of the funnel: it holds each stage's proportional
 * width through that stage's row, then slopes inward across the transition row
 * where inventory is actually lost. Stage rows sit on the shape; loss reasons
 * sit in the transition where the narrowing happens. READY is the terminal,
 * emphasised with the luminous end of the accent ramp.
 *
 * An earlier version drew each stage as its own centred rectangle. With a real
 * contraction of only ~24% those rectangles were nearly identical and read as
 * floating highlight blocks rather than as an audience narrowing.
 *
 * Row heights are fixed constants shared by the CSS and the geometry so the
 * silhouette and the text align exactly without measuring the DOM.
 */

const nf = (n: number) => n.toLocaleString()

/** Row geometry, in px. Mirrored by .crx__row-* heights in the stylesheet. */
const STAGE_H = 56
const TRANS_H = 36
const READY_H = 70
/** viewBox is 1000 units wide; the shape is centred on 500. */
const VB_W = 1000

const LOSS_ORDER: Array<{ key: string; label: string }> = [
  { key: 'missing_phone', label: 'No phone on file' },
  { key: 'wrong_number', label: 'Known wrong number' },
  { key: 'non_sms_capable', label: 'Not SMS-capable' },
  { key: 'suppressed', label: 'Opted out / suppressed' },
  { key: 'pending_prior_touch', label: 'Contacted recently' },
  { key: 'active_queue_item', label: 'Already queued' },
  { key: 'no_sender_coverage', label: 'No sender route' },
]

/** Eases a number to its new value so results land rather than snap. */
function useCountUp(target: number | null, enabled: boolean): number | null {
  const [shown, setShown] = useState<number | null>(target)
  const fromRef = useRef<number>(target ?? 0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (target == null) { setShown(null); return }
    if (!enabled) { setShown(target); fromRef.current = target; return }
    const from = fromRef.current
    if (from === target) { setShown(target); return }
    const start = performance.now()
    const DURATION = 620
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION)
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(Math.round(from + (target - from) * eased))
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [target, enabled])

  return shown
}

function StageValue({ value, animate }: { value: number; animate: boolean }) {
  const shown = useCountUp(value, animate)
  return <>{nf(shown ?? value)}</>
}

type Row =
  | { kind: 'stage'; key: string; label: string; value: number; width: number; height: number }
  | { kind: 'transition'; key: string; short: string; value: number; from: number; to: number; height: number }

/**
 * Horizontal inset that puts a row inside the silhouette at its own width.
 * Without it the label and value of a narrow stage floated outside the shape,
 * which is exactly the "text layered on top of a block" reading being fixed.
 */
const inset = (widthPct: number) => `calc(${((100 - widthPct) / 2).toFixed(2)}% + 13px)`

/**
 * The silhouette outline for a row list. Walks the left edge top-to-bottom,
 * crosses the bottom, then walks the right edge back up.
 */
function silhouettePath(rows: Row[]): { d: string; height: number } {
  const half = (w: number) => (w / 100) * (VB_W / 2)
  const cx = VB_W / 2
  const segs: Array<{ y0: number; y1: number; w0: number; w1: number }> = []
  let y = 0
  for (const r of rows) {
    const w0 = r.kind === 'stage' ? r.width : r.from
    const w1 = r.kind === 'stage' ? r.width : r.to
    segs.push({ y0: y, y1: y + r.height, w0, w1 })
    y += r.height
  }
  if (segs.length === 0) return { d: '', height: 0 }

  let d = `M ${cx - half(segs[0].w0)} 0`
  for (const s of segs) d += ` L ${(cx - half(s.w1)).toFixed(2)} ${s.y1}`
  const last = segs[segs.length - 1]
  d += ` L ${(cx + half(last.w1)).toFixed(2)} ${last.y1}`
  for (let i = segs.length - 1; i >= 0; i--) d += ` L ${(cx + half(segs[i].w0)).toFixed(2)} ${segs[i].y0}`
  d += ' Z'
  return { d, height: y }
}

/** Counting state: the silhouette's real proportions, before the real numbers. */
const SKELETON_ROWS: Row[] = [
  { kind: 'stage', key: 's0', label: '', value: 0, width: 100, height: STAGE_H },
  { kind: 'transition', key: 't1', short: '', value: 0, from: 100, to: 84, height: TRANS_H },
  { kind: 'stage', key: 's1', label: '', value: 0, width: 84, height: STAGE_H },
  { kind: 'transition', key: 't2', short: '', value: 0, from: 84, to: 77, height: TRANS_H },
  { kind: 'stage', key: 's2', label: '', value: 0, width: 77, height: STAGE_H },
  { kind: 'transition', key: 't3', short: '', value: 0, from: 77, to: 76, height: TRANS_H },
  { kind: 'stage', key: 's3', label: '', value: 0, width: 76, height: STAGE_H },
  { kind: 'stage', key: 'ready', label: '', value: 0, width: 76, height: READY_H },
]

export function CampaignReachMobile({
  preview,
  loading,
  stale,
  updatedAt,
  onRefresh,
}: {
  preview: CampaignPreviewResult | null
  loading: boolean
  stale: boolean
  updatedAt: string | null
  onRefresh: () => void
}) {
  const [openLosses, setOpenLosses] = useState(false)
  const [openReady, setOpenReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  const blocks = preview?.exclusive_block_reasons?.counts ?? null
  const matched = Number(
    preview?.exclusive_block_reasons?.matched
    ?? preview?.total_matched_properties
    ?? preview?.total_matched
    ?? 0,
  )
  const canonical = (preview?.sender_coverage as { canonical?: Record<string, number | null> } | null)?.canonical ?? null
  const gap = Number(preview?.universe_gap?.not_in_target_graph ?? 0)
  const n = (v: unknown) => Number(v ?? 0)

  const model = blocks && matched > 0
    ? (() => {
        const resolved = matched - n(blocks.missing_phone)
        const sms = resolved - n(blocks.wrong_number) - n(blocks.non_sms_capable)
        const routed = sms - n(blocks.suppressed) - n(blocks.pending_prior_touch) - n(blocks.active_queue_item)
        const ready = routed - n(blocks.no_sender_coverage)
        const w = (v: number) => Math.max(6, Math.min(100, (v / matched) * 100))
        const stages = [
          { key: 'universe', label: 'Targeted universe', value: matched },
          { key: 'resolved', label: 'Contact resolved', value: resolved },
          { key: 'sms', label: 'SMS-capable', value: sms },
          // NOT "Sender-routed": routing has not been evaluated at this step.
          // The loss feeding this stage is suppression / prior touch / queued,
          // so labelling it for routing made the screen read "Sender-routed 5"
          // directly above "6 LOCAL / 0 NO ROUTE" — implying a routing loss that
          // did not happen. Routing is applied at the READY step below.
          { key: 'routed', label: 'Clear of suppression', value: routed },
          { key: 'ready', label: 'READY', value: ready },
        ]
        const losses = [
          null,
          { short: 'no phone', value: n(blocks.missing_phone) },
          { short: 'not SMS-capable', value: n(blocks.wrong_number) + n(blocks.non_sms_capable) },
          { short: 'suppressed / prior touch / queued', value: n(blocks.suppressed) + n(blocks.pending_prior_touch) + n(blocks.active_queue_item) },
          { short: 'no sender route', value: n(blocks.no_sender_coverage) },
        ]
        const rows: Row[] = []
        stages.forEach((s, i) => {
          const loss = losses[i]
          if (loss && loss.value > 0) {
            rows.push({
              kind: 'transition',
              key: `t-${s.key}`,
              short: loss.short,
              value: loss.value,
              from: w(stages[i - 1].value),
              to: w(s.value),
              height: TRANS_H,
            })
          }
          rows.push({
            kind: 'stage',
            key: s.key,
            label: s.label,
            value: s.value,
            width: w(s.value),
            height: s.key === 'ready' ? READY_H : STAGE_H,
          })
        })
        return { rows, ready, stages }
      })()
    : null

  // Animate only on the transition from "no funnel" to "funnel".
  const hadModel = useRef(false)
  useEffect(() => {
    if (model && !hadModel.current) { setAnimate(true); hadModel.current = true }
    if (!model) hadModel.current = false
  }, [model])

  const losses = blocks
    ? LOSS_ORDER.map((l) => ({ ...l, value: n(blocks[l.key]) })).filter((l) => l.value > 0)
    : []
  const lossTotal = losses.reduce((sum, l) => sum + l.value, 0)
  const ready = model?.ready ?? null
  const readyPct = model && matched > 0 ? ((ready ?? 0) / matched) * 100 : null
  const reconciles = model != null && ready != null && ready + lossTotal === matched

  const rows = model?.rows ?? SKELETON_ROWS
  const { d, height } = silhouettePath(rows)
  const readyTop = rows.slice(0, -1).reduce((sum, r) => sum + r.height, 0)
  const readyWidth = (rows[rows.length - 1] as Extract<Row, { kind: 'stage' }>).width
  const readyHalf = (readyWidth / 100) * (VB_W / 2)

  const routing = canonical && [
    { key: 'local', label: 'LOCAL', value: n(canonical.exact_market_match), bad: false },
    { key: 'cross', label: 'CROSS-STATE', value: n(canonical.approved_state_fallback), bad: false },
    { key: 'none', label: 'NO ROUTE', value: n(canonical.no_sender_route), bad: true },
  ]
  const routeTotal = routing ? routing.reduce((s, r) => s + r.value, 0) : 0

  return (
    <div className="crx">
      <div className="crx__head">
        <span className={`crx__state${stale ? ' is-stale' : ''}`}>
          {loading ? 'Counting…' : stale ? 'Stale — targeting changed' : updatedAt ? `Updated ${updatedAt}` : 'Not counted'}
        </span>
        <button type="button" className="crx__refresh" onClick={onRefresh} disabled={loading}>
          <Icon name="refresh-cw" size={13} />
          Refresh
        </button>
      </div>

      {/* The answer, before the shape is inspected. */}
      <section className={`crx__summary${stale ? ' is-stale' : ''}${model ? '' : ' is-skeleton'}`}>
        <span className="crx__summary-value">
          {model ? <StageValue value={ready ?? 0} animate={animate} /> : '—'}
        </span>
        <span className="crx__summary-unit">READY</span>
        <span className="crx__summary-sub">
          {model && readyPct != null ? `${readyPct.toFixed(1)}% of targeted audience` : 'counting targeted audience'}
        </span>
      </section>

      {gap > 0 && (
        <section className="cdb__band">
          <div className="cdb__key">DATA COVERAGE</div>
          <p className="crx__gap">{nf(gap)} properties awaiting graph refresh</p>
        </section>
      )}

      <section className={`cdb__band crx__funnel${stale ? ' is-stale' : ''}${model ? '' : ' is-counting'}`}>
        <div className="cdb__key">CONTRACTION<em>canonical</em></div>

        <div className="crx__shape" style={{ height }}>
          <svg
            className="crx__silhouette"
            viewBox={`0 0 ${VB_W} ${height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="crxFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--crx-a))" stopOpacity="0.10" />
                <stop offset="55%" stopColor="rgb(var(--crx-a))" stopOpacity="0.24" />
                <stop offset="100%" stopColor="rgb(var(--crx-a))" stopOpacity="0.40" />
              </linearGradient>
              <linearGradient id="crxReady" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--crx-a))" stopOpacity="0.62" />
                <stop offset="100%" stopColor="rgb(var(--crx-a))" stopOpacity="0.44" />
              </linearGradient>
            </defs>
            {/* One shape: the audience, narrowing. */}
            <path className="crx__silhouette-fill" d={d} fill="url(#crxFill)" />
            <path
              className="crx__silhouette-edge"
              d={d}
              fill="none"
              stroke="rgb(var(--crx-a))"
              strokeOpacity="0.42"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            {/* The terminal, carried by the same shape rather than a new box. */}
            <rect
              className="crx__silhouette-ready"
              x={VB_W / 2 - readyHalf}
              y={readyTop}
              width={readyHalf * 2}
              height={height - readyTop}
              fill="url(#crxReady)"
            />
          </svg>

          <ol className="crx__rows">
            {rows.map((r) => (
              r.kind === 'stage' ? (
                r.key === 'ready' ? (
                  // READY is the drill-in point for real targets. The sample view
                  // is not built yet, so the affordance is present and says so
                  // rather than opening an empty modal.
                  <li
                    key={r.key}
                    className="crx__row is-ready"
                    style={{ height: r.height, paddingLeft: inset(r.width), paddingRight: inset(r.width) }}
                  >
                    <button
                      type="button"
                      className="crx__row-btn"
                      aria-expanded={openReady}
                      onClick={() => setOpenReady((v) => !v)}
                      disabled={!model}
                    >
                      <span className="crx__row-label">{model ? r.label : ''}</span>
                      <span className="crx__row-value">
                        {model ? <StageValue value={r.value} animate={animate} /> : ''}
                      </span>
                      {model && <Icon name="chevron-right" size={15} />}
                    </button>
                  </li>
                ) : (
                  <li
                    key={r.key}
                    className="crx__row"
                    style={{ height: r.height, paddingLeft: inset(r.width), paddingRight: inset(r.width) }}
                  >
                    <span className="crx__row-label">{r.label}</span>
                    <span className="crx__row-value">
                      {model ? <StageValue value={r.value} animate={animate} /> : ''}
                    </span>
                  </li>
                )
              ) : (
                // The loss attaches to the transition, where the shape narrows.
                <li
                  key={r.key}
                  className="crx__trans"
                  style={{ height: r.height, paddingLeft: inset(r.to), paddingRight: inset(r.to) }}
                >
                  {model && (
                    <button type="button" className="crx__trans-btn" onClick={() => setOpenLosses(true)}>
                      <span className="crx__trans-value">−{nf(r.value)}</span>
                      <span className="crx__trans-label">{r.short}</span>
                    </button>
                  )}
                </li>
              )
            ))}
          </ol>
        </div>

        {model && openReady && (
          <p className="crx__ready-note">Target-level sampling opens at LAUNCH.</p>
        )}

        {model && (
          <button type="button" className="crx__drill" onClick={() => setOpenLosses((v) => !v)}>
            {openLosses ? 'Hide blocker detail' : 'Why the rest can’t send'}
            <Icon name={openLosses ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
        )}
      </section>

      {/* Routing as capacity intelligence, read horizontally. */}
      <section className="cdb__band crx__routing">
        {/* Scope is explicit: routing is evaluated across the whole targeted
            audience, so LOCAL 11,756 is not the funnel's Sender-routed 8,975. */}
        <div className="cdb__key">
          SENDER ROUTING
          <em>
            targeted audience
            {routing ? ` · ${routing[2].value === 0 ? 'all routes live' : 'partial coverage'}` : ''}
          </em>
        </div>
        <div className="crx__routes">
          {(routing ?? [
            { key: 'local', label: 'LOCAL', value: null, bad: false },
            { key: 'cross', label: 'CROSS-STATE', value: null, bad: false },
            { key: 'none', label: 'NO ROUTE', value: null, bad: true },
          ]).map((r) => (
            <div
              key={r.key}
              className={`crx__route${r.value == null ? ' is-skeleton' : r.value === 0 ? ' is-nil' : ''}${r.bad && (r.value ?? 0) > 0 ? ' is-bad' : ''}`}
            >
              <span className="crx__route-value">{r.value == null ? '—' : nf(r.value)}</span>
              <span className="crx__route-label">{r.label}</span>
              <span className="crx__route-meter" aria-hidden="true">
                <span style={{ width: `${r.value != null && routeTotal > 0 ? (r.value / routeTotal) * 100 : 0}%` }} />
              </span>
            </div>
          ))}
        </div>
      </section>

      {openLosses && losses.length > 0 && (
        <section className="cdb__band is-last">
          <div className="cdb__key">
            EXCLUDED
            <span className="cdb__count">{nf(lossTotal)} total</span>
          </div>
          <div className="cdb__rows">
            {losses.map((l) => (
              <div key={l.key} className="cdb__row">
                <span className={`cdb__row-label crx__loss-label${l.key === 'no_sender_coverage' ? ' is-route' : ''}`}>{l.label}</span>
                <span className="cdb__row-value">{nf(l.value)}</span>
              </div>
            ))}
          </div>
          <p className={`crx__reconcile${reconciles ? '' : ' is-off'}`}>
            {reconciles
              ? `${nf(ready ?? 0)} ready + ${nf(lossTotal)} excluded = ${nf(matched)} targeted`
              : 'These figures do not reconcile to the targeted total — treat them as approximate.'}
          </p>
        </section>
      )}
    </div>
  )
}
