import { cls, fmt, fmtPct } from '../campaign-formatters'
import type { CampaignModel, CampaignSummary } from '../campaigns.types'

/**
 * Campaign Command readout — mobile.
 *
 * Replaces the four equal KPI boxes, which gave ACTIVE / READY / SENT TODAY /
 * REPLY RATE identical weight and told the operator nothing about what was
 * actually moving.
 *
 * Structure is deliberately asymmetric:
 *   - ONE dominant number: READY inventory. It is the figure that decides whether
 *     anything can happen at all, and it is the number this whole data-truth
 *     effort was about.
 *   - A single status LINE (not boxes) for live movement: running campaigns,
 *     today's sends, reply signal.
 *   - A next-action line, so "what happens next" is answered without opening a
 *     campaign.
 *
 * Everything shown is derived from data we actually have. No projections.
 */

const isLive = (c: CampaignSummary) => {
  const s = String(c.status ?? '').toLowerCase()
  return s === 'active' || s === 'activating' || s === 'live_limited'
}

export const CampaignCommandReadout = ({
  kpis,
  campaigns,
}: {
  kpis: CampaignModel['kpis']
  campaigns: CampaignSummary[]
}) => {
  const running = campaigns.filter(isLive).length
  const scheduled = campaigns.filter((c) => String(c.status ?? '').toLowerCase() === 'scheduled').length
  const paused = campaigns.filter((c) => String(c.status ?? '').toLowerCase() === 'paused').length

  // Next scheduled activity across the portfolio. Only future, only campaigns
  // that can actually act — a paused campaign's stale scheduled_for is not "next".
  const upcoming = campaigns
    .filter((c) => {
      const s = String(c.status ?? '').toLowerCase()
      return (s === 'scheduled' || isLive(c)) && c.next_send_at
    })
    .map((c) => ({ at: new Date(c.next_send_at as string).getTime(), name: c.campaign_name }))
    .filter((x) => Number.isFinite(x.at) && x.at > Date.now())
    .sort((a, b) => a.at - b.at)[0]

  const nextLabel = (() => {
    if (!upcoming) return null
    const mins = Math.round((upcoming.at - Date.now()) / 60000)
    if (mins < 60) return `${mins}m`
    if (mins < 1440) return `${Math.round(mins / 60)}h`
    return `${Math.round(mins / 1440)}d`
  })()

  // Live movement is only meaningful once something has actually sent.
  const hasMovement = kpis.sentToday > 0

  return (
    <div className="ccr">
      <div className="ccr__hero">
        <div className="ccr__hero-value">{fmt(kpis.readyTargets)}</div>
        <div className="ccr__hero-meta">
          <span className="ccr__hero-label">ready to send</span>
          <span className="ccr__hero-sub">{fmt(kpis.totalTargets)} targeted</span>
        </div>
      </div>

      {/* One status line, not a grid. Only states that exist are rendered. */}
      <div className="ccr__states">
        {running > 0 && (
          <span className="ccr__state is-running">
            <i className="ccr__pip" />
            {running} running
          </span>
        )}
        {scheduled > 0 && <span className="ccr__state is-scheduled">{scheduled} scheduled</span>}
        {paused > 0 && <span className="ccr__state is-paused">{paused} paused</span>}
        {/* Only the true empty case. Previously this rendered alongside "4 paused",
            producing the self-contradictory line "4 paused  Nothing sending". */}
        {running === 0 && scheduled === 0 && paused === 0 && (
          <span className="ccr__state is-idle">No active campaigns</span>
        )}
      </div>

      <div className="ccr__movement">
        {hasMovement ? (
          <>
            <span className="ccr__mv">
              <strong>{fmt(kpis.sentToday)}</strong> sent today
            </span>
            {kpis.deliveredToday > 0 && (
              <span className="ccr__mv">
                <strong>{fmtPct(kpis.replyRate)}</strong> reply
              </span>
            )}
            {kpis.positiveReplies > 0 && (
              <span className="ccr__mv is-good">
                <strong>{fmt(kpis.positiveReplies)}</strong> leads
              </span>
            )}
          </>
        ) : (
          <span className="ccr__mv is-quiet">No sends today</span>
        )}

        {nextLabel && (
          <span className="ccr__next" title={upcoming?.name}>
            next in {nextLabel}
          </span>
        )}
      </div>

      {/* Portfolio health only surfaces when it is actually a problem. Showing
          "0.0% opt-out" permanently is noise, not information. */}
      {(kpis.optOutRate > 3 || kpis.failureRate > 4) && (
        <div className="ccr__alerts">
          {kpis.optOutRate > 3 && (
            <span className={cls('ccr__alert', kpis.optOutRate > 6 ? 'is-crit' : 'is-warn')}>
              {fmtPct(kpis.optOutRate)} opt-out
            </span>
          )}
          {kpis.failureRate > 4 && (
            <span className={cls('ccr__alert', kpis.failureRate > 8 ? 'is-crit' : 'is-warn')}>
              {fmtPct(kpis.failureRate)} failing
            </span>
          )}
        </div>
      )}
    </div>
  )
}
