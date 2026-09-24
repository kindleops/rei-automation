import { useCallback, useEffect, useMemo, useState } from 'react'
import { getCampaignActivityBackend, type CampaignActivityResponse } from '../../../lib/api/backendClient'
import { buildActivity, groupActivityByDay, type ActivityEntry } from '../campaign-activity'
import type { CampaignSummary } from '../campaigns.types'

/**
 * Campaign Detail — Activity, mobile.
 *
 * The shared log printed the backend's own words ("Blocked by
 * campaign_status_not_queueable:paused") in a list that was 99% the
 * scheduler's five-minute idle check. /activity keeps those checks from
 * crowding out real events; this reads each event as a sentence and folds runs
 * of the same one into a single line.
 */

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** For a folded run: when it began, since the time column shows the latest. */
function sinceOf(entry: ActivityEntry): string | null {
  if (entry.count === 1) return null
  const first = new Date(entry.firstAt)
  const sameDay = new Date(entry.at).toDateString() === first.toDateString()
  return sameDay
    ? `Since ${time(entry.firstAt)}`
    : `Since ${first.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(entry.firstAt)}`
}

export function CampaignActivityMobile({ campaign }: { campaign: CampaignSummary }) {
  const [data, setData] = useState<CampaignActivityResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    const res = await getCampaignActivityBackend(campaign.id)
    if (res.ok && Array.isArray(res.data?.events)) setData(res.data)
    else setFailed(true)
    setLoading(false)
  }, [campaign.id])

  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => groupActivityByDay(buildActivity(data?.events ?? [])), [data])

  if (loading && !data) {
    return (
      <div className="cact" aria-busy="true">
        <div className="cex-skel" />
      </div>
    )
  }

  if (failed && !data) {
    return (
      <div className="cact">
        <section className="cov2-card is-warn" role="status">
          <h3 className="cov2-card__h">Activity couldn’t be loaded</h3>
          <p className="cov2-note">Nothing about the campaign has changed.</p>
          <button type="button" className="cex-retry" onClick={() => void load()}>Try again</button>
        </section>
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="cact">
        <section className="cov2-card">
          <h3 className="cq-empty__title">No activity yet</h3>
        </section>
      </div>
    )
  }

  const ticks = data?.planning_ticks
  const hiddenTicks = ticks && ticks.total != null ? Math.max(0, ticks.total - ticks.shown) : 0

  return (
    <div className="cact">
      {groups.map((g) => (
        <section key={g.day} className="cov2-card cact-day" aria-label={g.day}>
          <h3 className="cact-day__h">{g.day}</h3>
          <ol className="cact-list">
            {g.entries.map((e) => (
              <li key={e.key} className={`cact-item is-${e.tone}`}>
                <span className="cact-item__dot" aria-hidden="true" />
                <div className="cact-item__main">
                  <div className="cact-item__top">
                    <span className="cact-item__title">
                      {e.title}
                      {e.count > 1 && <span className="cact-item__x">×{e.count.toLocaleString()}</span>}
                    </span>
                    <span className="cact-item__at">{time(e.at)}</span>
                  </div>
                  {e.detail && <p className="cact-item__detail">{e.detail}</p>}
                  {sinceOf(e) && <p className="cact-item__since">{sinceOf(e)}</p>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {hiddenTicks > 0 && (
        <p className="cexc-foot">
          {hiddenTicks.toLocaleString()} earlier scheduler checks aren’t listed.
        </p>
      )}
    </div>
  )
}

export default CampaignActivityMobile
