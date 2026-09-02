import { Icon } from '../../../shared/icons'
import { computeCampaignCostMetrics } from '../campaign-cost'
import { computeCampaignReadiness } from '../campaign-health'
import { fmtInterval, resolveNextSend } from '../campaign-formatters'
import type { CampaignSummary } from '../campaigns.types'

/**
 * Campaign Detail — Overview, mobile.
 *
 * Same grammar as the frozen Detail header (zones A–G): True Black ground, one
 * gutter, full-width bands separated by hairlines, four-level type ramp,
 * instrument rows. The previous body was the desktop composition — a lighter
 * blue panel holding rounded cards holding more rounded cards, with decorative
 * accent progress bars — which is exactly where "new Campaigns" visibly became
 * "old Campaigns".
 *
 * No metric is removed. Delivered / failed / opted-out moved OUT of this list
 * because the frozen DELIVERY band directly above already reports them; showing
 * them twice on one screen was the duplication the band was meant to end.
 */

const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString()

function money(v: number | null): string {
  return v == null ? '—' : `$${v.toFixed(2)}`
}

export function CampaignOverviewMobile({ campaign }: { campaign: CampaignSummary }) {
  const readiness = computeCampaignReadiness(campaign)
  const cost = computeCampaignCostMetrics(campaign)
  const total = campaign.total_targets
  const pct = (n: number) => (total > 0 ? Math.max(0, Math.min(100, (n / total) * 100)) : 0)

  // Same discipline as the DELIVERY band: a rate needs a real denominator.
  const rated = campaign.sent_count >= 20

  const targets: Array<{ label: string; value: number; meter?: boolean }> = [
    { label: 'Total', value: total },
    { label: 'Ready', value: campaign.ready_targets, meter: true },
    { label: 'Planned', value: campaign.planned_targets ?? 0 },
    { label: 'Scheduled', value: campaign.scheduled_queue_rows ?? campaign.scheduled_targets },
    { label: 'Sent', value: campaign.sent_count },
  ]

  const rates: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }> = [
    {
      label: 'Delivery',
      value: rated ? `${campaign.delivery_rate.toFixed(1)}%` : '—',
      tone: rated ? (campaign.delivery_rate >= 90 ? 'good' : campaign.delivery_rate >= 75 ? 'warn' : 'bad') : undefined,
    },
    {
      label: 'Reply',
      value: rated ? `${campaign.reply_rate.toFixed(1)}%` : '—',
      tone: rated ? (campaign.reply_rate >= 12 ? 'good' : campaign.reply_rate >= 7 ? 'warn' : undefined) : undefined,
    },
    {
      label: 'Opt-out',
      value: rated ? `${campaign.opt_out_rate.toFixed(1)}%` : '—',
      tone: rated ? (campaign.opt_out_rate <= 3 ? 'good' : campaign.opt_out_rate <= 6 ? 'warn' : 'bad') : undefined,
    },
    { label: 'Leads', value: nf(campaign.positive_reply_count), tone: campaign.positive_reply_count > 0 ? 'good' : undefined },
  ]

  const schedule: Array<{ label: string; value: string }> = [
    { label: 'Next send', value: resolveNextSend(campaign).label },
    { label: 'Interval', value: fmtInterval(campaign.send_interval_seconds) },
    ...(campaign.send_window_start
      ? [{ label: 'Send window', value: `${campaign.send_window_start} – ${campaign.send_window_end ?? '—'}` }]
      : []),
    { label: 'Auto send', value: campaign.auto_send_enabled ? 'On' : 'Off' },
  ]

  // "Only when meaningful": a clean campaign with nothing to report says nothing.
  const readinessLine = readiness.blockers[0] ?? readiness.warnings[0] ?? null

  return (
    <div className="cov">
      {readinessLine && (
        <section className="cov__band">
          <div className="cov__key">READINESS</div>
          <p className={`cov__line${readiness.blockers.length ? ' is-blocked' : ' is-warn'}`}>{readinessLine}</p>
        </section>
      )}

      <section className="cov__band">
        <div className="cov__key">
          TARGETS
          <em>this campaign</em>
        </div>
        <div className="cov__rows">
          {targets.map((t) => (
            <div key={t.label} className={`cov__row${t.value === 0 ? ' is-nil' : ''}`}>
              <span className="cov__row-label">{t.label}</span>
              {t.meter && total > 0 && (
                <span className="cov__meter" aria-hidden="true">
                  <span className="cov__meter-fill" style={{ width: `${pct(t.value)}%` }} />
                </span>
              )}
              <span className="cov__row-value">{nf(t.value)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="cov__band">
        <div className="cov__key">COST &amp; SPEND</div>
        {cost.totalSpend == null ? (
          <>
            <p className="cov__line">No spend yet</p>
            <p className="cov__sub">Cost metrics appear after first send</p>
          </>
        ) : (
          <div className="cov__rows">
            <div className="cov__row">
              <span className="cov__row-label">Actual spend</span>
              <span className="cov__row-value">{money(cost.totalSpend)}</span>
            </div>
            <div className={`cov__row${cost.costPerReply == null ? ' is-nil' : ''}`}>
              <span className="cov__row-label">Cost / reply</span>
              <span className="cov__row-value">{money(cost.costPerReply)}</span>
            </div>
            <div className={`cov__row${cost.costPerLead == null ? ' is-nil' : ''}`}>
              <span className="cov__row-label">Cost / lead</span>
              <span className="cov__row-value">{money(cost.costPerLead)}</span>
            </div>
          </div>
        )}
      </section>

      <section className="cov__band">
        <div className="cov__key">
          PERFORMANCE
          {!rated && <em>rates need 20 sends</em>}
        </div>
        <div className="cov__rates">
          {rates.map((r) => (
            <div key={r.label} className={`cov__rate${r.value === '—' ? ' is-nil' : ''}`}>
              <span className={`cov__rate-value${r.tone ? ` is-${r.tone}` : ''}`}>{r.value}</span>
              <span className="cov__rate-label">{r.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="cov__band">
        <div className="cov__key">SCHEDULE</div>
        <div className="cov__rows">
          {schedule.map((sRow) => (
            <div key={sRow.label} className="cov__row">
              <span className="cov__row-label">{sRow.label}</span>
              <span className="cov__row-value is-text">{sRow.value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="cov__band is-last">
        <div className="cov__key">SUPPRESSION</div>
        <div className="cov__rows">
          {(campaign.blocked_reason_counts
            ? Object.entries(campaign.blocked_reason_counts).filter(([, v]) => Number(v) > 0)
            : []
          ).map(([reason, value]) => (
            <div key={reason} className="cov__row">
              <span className="cov__row-label">{reason.replace(/_/g, ' ')}</span>
              <span className="cov__row-value">{nf(Number(value))}</span>
            </div>
          ))}
          {(!campaign.blocked_reason_counts ||
            Object.values(campaign.blocked_reason_counts).every((v) => Number(v) === 0)) && (
            <div className="cov__row is-nil">
              <span className="cov__row-label">
                <Icon name="check" size={12} /> Nothing suppressed
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
