/**
 * PIPELINE DESK · TELEMETRY RAIL — one instrument strip instead of KPI boxes.
 * Each reading is the server's number with its kind named (estimated value,
 * stated asks); the ones that lead somewhere are buttons.
 */
import { LCSparkline, cx } from '../../../shared/lc'
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import type { DeskFlow, DeskOffers, DeskOverview } from './pipeline-desk-api'
import { fmtInt, type LiveOwner } from './pipeline-desk-model'

export function DeskRail({ overview, flow, offers, periodLabel, onOwner, onOffers }: {
  overview: DeskOverview | null
  flow: DeskFlow | null
  offers: DeskOffers | null
  periodLabel: string
  onOwner: (o: LiveOwner) => void
  onOffers: () => void
}) {
  const t = overview?.totals
  const own = overview?.ownership
  const machine = t?.machine ?? null
  const series = flow?.series.buckets.map((b) => b.moves) ?? []
  return (
    <div className="pd2-rail" role="group" aria-label="Pipeline telemetry">
      <span className="pd2-tel is-lead" data-pd2-tel="live">
        <b className="lc-num">{t ? fmtInt(t.working) : '—'}</b>
        <span>live deals</span>
        <small>{own ? `${fmtInt(own.dormant)} dormant` : ' '}</small>
      </span>
      <span className="pd2-tel" data-pd2-tel="value">
        <b className="lc-num">{t ? compactMoney(t.value) ?? '—' : '—'}</b>
        <span>est. value</span>
        <small>{t ? `${fmtInt(t.valued)} valued · estimated` : ' '}</small>
      </span>
      <span className="pd2-tel is-wide-only" data-pd2-tel="asks">
        <b className="lc-num">{t ? compactMoney(t.asking) ?? '—' : '—'}</b>
        <span>seller asks</span>
        <small>stated by sellers</small>
      </span>
      <span className="pd2-tel" data-pd2-tel="moved">
        <b className="lc-num">{flow ? fmtInt(flow.totals.moved) : '—'}</b>
        <span>moved · {periodLabel}</span>
        {series.length > 1 ? <LCSparkline values={series} width={64} height={16} tone="exec" label={`Movement over the ${periodLabel}`} className="pd2-tel__spark" /> : <small>{flow ? `${fmtInt(flow.totals.replies)} replies` : ' '}</small>}
      </span>
      <span className="pd2-tel__sep" aria-hidden="true" />
      <span className="pd2-tel is-exec" data-pd2-tel="machine" title="Autopilot, scheduled, waiting on the seller or an outside party — nobody inside has to act">
        <i aria-hidden="true" />
        <b className="lc-num">{machine === null ? '—' : fmtInt(machine)}</b>
        <span>machine-held</span>
        <small>{own ? `${fmtInt(own.autopilot + own.scheduled)} acting · ${fmtInt(own.seller)} on seller` : ' '}</small>
      </span>
      <button type="button" className={cx('pd2-tel is-attn', !(t?.needsYou) && 'is-calm')} data-pd2-tel="needs" onClick={() => onOwner('needs_you')} title="Open the deals that need a human decision">
        <i aria-hidden="true" />
        <b className="lc-num">{t?.needsYou === undefined ? '—' : fmtInt(t.needsYou)}</b>
        <span>need you</span>
        <small>policy holds · drafts</small>
      </button>
      <button type="button" className={cx('pd2-tel is-crit', !(t?.blocked) && 'is-calm')} data-pd2-tel="blocked" onClick={() => onOwner('blocked')} title="Open the deals the machine could not move">
        <i aria-hidden="true" />
        <b className="lc-num">{t?.blocked === undefined ? '—' : fmtInt(t.blocked)}</b>
        <span>blocked</span>
        <small>send failures · contact</small>
      </button>
      <span className="pd2-tel is-wide-only" data-pd2-tel="stalled" title="Past the stage's own clock">
        <b className="lc-num">{t ? fmtInt(t.stalled) : '—'}</b>
        <span>stalled</span>
        <small>past the stage clock</small>
      </span>
      <span className="pd2-tel__sep" aria-hidden="true" />
      <button type="button" className="pd2-tel is-offers" data-pd2-tel="offers" onClick={onOffers} title="Offers by who resolves them">
        <b className="lc-num">{offers ? `${fmtInt(offers.autonomy.autonomous)} · ${fmtInt(offers.autonomy.resolving)} · ${fmtInt(offers.autonomy.exception)}` : '—'}</b>
        <span>offers</span>
        <small>auto · resolving · exception</small>
      </button>
    </div>
  )
}
