/**
 * PIPELINE — the S1–S10 lifecycle as evidence.
 *
 *   now        population per stage and WHO HAS THE BALL (Pipeline Command's
 *              own waiting-on lanes: system · seller · operator · external ·
 *              blocked · dormant) — the same read model the Pipeline app uses
 *   the period entered / exited / forward share of exits / dwell (median ·
 *              P75) from the append-only stage history
 *   aging      how long LIVE deals have sat in each stage (min · P25–P75 ·
 *              median · P90) against the stage's own clock
 *   bottleneck the stage where most live deals are past their clock — stated
 *              as the counts, never as a score
 *
 * S10 counts only closings with closing evidence; a row parked at S10 without
 * it is reported apart.
 */
import type { CSSProperties } from 'react'
import { cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { useLab } from './intel-context'
import { usePipelineData } from './intel-hooks'
import { LANES, STAGE_ORDER, STAGE_SHORT } from './intel-model'
import { fmtDays, fmtInt, fmtMoney, fmtPct } from './intel-format'
import { AgeRanges } from './IntelCharts'

export function IntelPipeline({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { inspect, refreshing } = useLab()
  const { stagesQ, moneyQ, stages, money } = usePipelineData()
  const byCode = new Map((stages?.current || []).map((s) => [s.code, s]))
  const mByCode = new Map((money?.stages || []).map((s) => [s.code, s]))
  // every stage S1 → S10 is drawn; a stage with no deals and no entries is "quiet" and
  // folds away when the plane is too narrow to show all ten (container query)
  const quiet = (code: string) => variant !== 'lens' && !((mByCode.get(code)?.deals || 0) > 0 || (byCode.get(code)?.entered || 0) > 0 || code === 'offer')
  const maxDeals = Math.max(1, ...STAGE_ORDER.map((c) => mByCode.get(c)?.deals || 0))
  const bottleneck = stages?.bottleneck || null
  const lanesTotal = money ? money.totals.lanes : null

  return (
    <section className={cx('ix-pipe lc-plane is-clear is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} aria-label="Pipeline flow">
      <header className="ix-plane__head">
        <div>
          <span className="ix-eyebrow">Pipeline · S1 → S10</span>
          <h2>Who has the ball, and where deals sit</h2>
        </div>
        <p className="ix-muted">population now · moves in the period · age against each stage’s clock</p>
      </header>

      {bottleneck ? (
        <button type="button" className="ix-callout is-attn" onClick={() => inspect({ kind: 'stage', code: bottleneck.code })}>
          <Icon name="alert" size={14} />
          <span><b>{STAGE_SHORT[bottleneck.code]} {bottleneck.label}</b> — {bottleneck.stalled} of {bottleneck.live} live deals past its {bottleneck.thresholdDays}-day clock{byCode.get(bottleneck.code)?.liveAge.p50 !== null && byCode.get(bottleneck.code)?.liveAge.p50 !== undefined ? ` · median age ${fmtDays(byCode.get(bottleneck.code)?.liveAge.p50 ?? null)}` : ''}. Evidence, not a score.</span>
          <Icon name="chevron-right" size={13} />
        </button>
      ) : null}

      <div className={cx('ix-pipe__flow', (stagesQ.stale || moneyQ.stale) && 'is-stale')} role="list" aria-label="Stages">
        {STAGE_ORDER.map((code) => {
          const s = byCode.get(code)
          const mm = mByCode.get(code)
          const deals = mm?.deals ?? 0
          const hot = bottleneck?.code === code
          return (
            <button key={code} type="button" role="listitem" className={cx('ix-stagecol', hot && 'is-hot', !deals && 'is-empty', quiet(code) && 'is-quiet')} onClick={() => inspect({ kind: 'stage', code })} title={`${STAGE_SHORT[code]} ${s?.label || code}: open deals, money and evidence`}>
              <span className="ix-stagecol__code">{STAGE_SHORT[code]}</span>
              <span className="ix-stagecol__label">{s?.label || mm?.label || code}</span>
              <b className="ix-stagecol__n">{money ? fmtInt(deals) : '…'}</b>
              <span className="ix-stagecol__lanes" aria-label={mm ? LANES.filter((l) => mm.lanes[l.key]).map((l) => `${mm.lanes[l.key]} ${l.label.toLowerCase()}`).join(', ') : undefined}>
                {mm ? LANES.filter((l) => mm.lanes[l.key]).map((l) => <i key={l.key} data-tone={l.tone} style={{ flexGrow: mm.lanes[l.key] } as CSSProperties} />) : null}
              </span>
              <span className="ix-stagecol__scale" aria-hidden="true"><i style={{ height: `${Math.max(deals ? 4 : 0, (deals / maxDeals) * 100)}%` }} /></span>
              <span className="ix-stagecol__meta">
                {s ? <><em>{fmtInt(s.entered)} in</em><em>{fmtInt(s.exits)} out</em></> : <em>—</em>}
              </span>
              <span className={cx('ix-stagecol__clock', (s?.stalled || 0) > 0 && 'is-over')}>{s?.stallThresholdDays ? `${fmtInt(s.stalled)} > ${s.stallThresholdDays}d` : ' '}</span>
            </button>
          )
        })}
      </div>

      <div className="ix-legend ix-pipe__legend" aria-hidden="true">
        {LANES.filter((l) => !lanesTotal || lanesTotal[l.key] > 0).map((l) => <span key={l.key}><i className="ix-key is-lane" data-tone={l.tone} />{l.label}{lanesTotal ? ` · ${fmtInt(lanesTotal[l.key])}` : ''}</span>)}
      </div>
      {money?.totals.closedWithoutEvidence ? <p className="ix-note">{money.totals.closedWithoutEvidence} active row{money.totals.closedWithoutEvidence === 1 ? ' is' : 's are'} parked at S10 without closing evidence — not counted as closed.</p> : null}

      {variant === 'lens' ? (
        <>
          <div className="ix-subhead"><span className="ix-eyebrow">Stage evidence · this period and now</span></div>
          <div className="ix-tablewrap lc-scroll">
            <table className="ix-table is-stages">
              <thead>
                <tr>
                  <th>Stage</th><th title="Pipeline Command active scope">Now</th><th title="Moves into the stage this period (incl. created at it)">Entered</th><th title="Autopilot · operator">By system · human</th>
                  <th>Exited</th><th title="Forward exits ÷ exits (Wilson 95%)">Forward share</th><th>Dwell median · P75</th><th title="Live = touched in the last 30 days">Live age median · P75</th><th>Past clock</th><th title="Sum of the county / AVM estimate on the stage's deals">County estimate</th><th title="Engine offers the readiness rule authorizes">Authorized offers</th>
                </tr>
              </thead>
              <tbody>
                {STAGE_ORDER.map((code) => {
                  const s = byCode.get(code)
                  const mm = mByCode.get(code)
                  return (
                    <tr key={code} className={cx(!(mm?.deals || s?.entered || s?.exits) && 'is-quiet', bottleneck?.code === code && 'is-hot')}>
                      <th><button type="button" className="ix-link" onClick={() => inspect({ kind: 'stage', code })}><span className="ix-stage">{STAGE_SHORT[code]}</span>{s?.label || mm?.label || code}</button></th>
                      <td>{fmtInt(mm?.deals ?? null)}</td>
                      <td>{fmtInt(s?.entered ?? null)}</td>
                      <td>{s?.entered ? `${s.enteredBySystem} · ${s.enteredByHuman}` : '—'}</td>
                      <td>{fmtInt(s?.exits ?? null)}{s?.backward ? <small> {s.backward} back</small> : null}</td>
                      <td>{s?.forwardShare === null || s?.forwardShare === undefined ? '—' : <>{fmtPct(s.forwardShare, 0)}<small> {s.forward}/{s.exits}{s.exits < 10 ? ' · small n' : ''}</small></>}</td>
                      <td>{s?.dwell.n ? <>{fmtDays(s.dwell.p50)} · {fmtDays(s.dwell.p75)}<small> n={s.dwell.n}</small></> : '—'}</td>
                      <td>{s?.liveAge.n ? <>{fmtDays(s.liveAge.p50)} · {fmtDays(s.liveAge.p75)}<small> n={s.liveAge.n}</small></> : '—'}</td>
                      <td className={cx((s?.stalled || 0) > 0 && 'is-bad')}>{s?.stallThresholdDays ? <>{fmtInt(s.stalled)}<small> &gt; {s.stallThresholdDays}d</small></> : '—'}</td>
                      <td>{mm?.record.n ? <>{fmtMoney(mm.record.sum)}<small> {mm.record.n}/{mm.deals}</small></> : '—'}</td>
                      <td>{mm?.authorized.n ? <>{fmtMoney(mm.authorized.offer)}<small> {mm.authorized.n}</small></> : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="ix-subhead"><span className="ix-eyebrow">Live deal age by stage</span><small className="ix-muted">box = P25–P75 · line = median · whisker = min–P90 · tick = the stage’s clock</small></div>
          {stages ? (
            <AgeRanges
              rows={stages.current.filter((s) => s.code !== 'closed').map((s) => ({ code: s.code, label: s.label, short: STAGE_SHORT[s.code], n: s.liveAge.n, min: s.liveAge.min, p25: s.liveAge.p25, p50: s.liveAge.p50, p75: s.liveAge.p75, p90: s.liveAge.p90, threshold: s.stallThresholdDays, over: s.stalled }))}
              onPick={(code) => inspect({ kind: 'stage', code })}
            />
          ) : <div className="ix-skel-rows"><i /><i /><i /></div>}
          <p className="ix-note">“Now” and the ownership lanes are Pipeline Command’s (active, waiting, paused and nurture deals). Entered, exited and dwell come from the append-only stage history in the period; certification rows are excluded and the June backfill has no creation events. Forward share is a proportion of exits, never entries ÷ exits.</p>
        </>
      ) : null}
      {stagesQ.error && !stages ? <p className="ix-note is-bad">Stage evidence didn’t load · {stagesQ.error}</p> : null}
      {moneyQ.error && !money ? <p className="ix-note is-bad">The pipeline read model didn’t load · {moneyQ.error}</p> : null}
    </section>
  )
}
