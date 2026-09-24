import { Icon } from '../../../shared/icons'
import { computeCampaignCostMetrics } from '../campaign-cost'
import { computeCampaignReadiness } from '../campaign-health'
import { resolveNextSend } from '../campaign-formatters'
import { describeBlocker, formatRatePct, RATE_MIN_SAMPLE } from '../campaign-operator-language'
import { replyRatePct, stopRatePct } from '../campaign-responses'
import type { CampaignSummary } from '../campaigns.types'
import { useCampaignResponses } from './useCampaignResponses'

/**
 * Campaign Detail — Overview, mobile.
 *
 * What this section is for: everything about the campaign that the hero above
 * it does NOT already say.
 *
 * It used to open with "READINESS · TEST MODE — NO MESSAGES WILL TRANSMIT" —
 * the third time the screen stated test mode, in orange capitals — then a
 * five-row table (Total / Ready / Planned / Scheduled / Sent) whose Sent
 * repeated the progress line, then delivery / reply / opt-out / leads, which
 * repeated the hero's outcomes. Now:
 *
 *   BEFORE IT CAN SEND   only when something blocks, in words, listed first so
 *                        "Review blockers" lands on it
 *   AUDIENCE             who is in it and where they are in the pipeline
 *   RESPONSE             rates the hero doesn't show, once there's a sample —
 *                        from the message log; reply_rate / opt_out_rate on the
 *                        campaign row are computed from target statuses that
 *                        never occur and read 0% for every campaign
 *   PACING               when and how fast
 *   SPEND                only once there is some
 */

const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString()
const money = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`)
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** The readiness strings are shared with desktop; this is how mobile says them. */
const READINESS_COPY: Array<{ match: RegExp; title: string; detail?: string } | { match: RegExp; skip: true }> = [
  // Already stated by the health card, in words, at the top of the screen.
  { match: /test mode/i, skip: true },
  { match: /no routable recipients|sender routing unavailable/i, title: 'No sender number covers these sellers', detail: 'Add a market with sender coverage, or wait for capacity.' },
  { match: /sending is disabled/i, title: 'Sending is turned off for this campaign' },
  { match: /partial template or routing/i, title: 'Some sellers may not be sendable yet', detail: 'A message or a sender number couldn’t be resolved for part of the audience.' },
  { match: /no frozen targets|run build targets/i, title: 'The audience hasn’t been built yet', detail: 'Build the audience to see who this campaign will reach.' },
  { match: /zero ready targets/i, title: 'Nobody in the audience is ready to message', detail: 'Everyone in the audience was excluded when it was built.' },
  { match: /approved template required/i, title: 'No approved message for this stage and language' },
  { match: /launch blocked/i, title: 'A system check is holding this campaign' },
]

function translate(raw: string): { title: string; detail?: string } | null {
  for (const rule of READINESS_COPY) {
    if (rule.match.test(raw)) return 'skip' in rule ? null : { title: rule.title, detail: rule.detail }
  }
  return { title: describeBlocker(raw, raw) }
}

export function CampaignOverviewMobile({ campaign }: { campaign: CampaignSummary }) {
  const readiness = computeCampaignReadiness(campaign)
  const cost = computeCampaignCostMetrics(campaign)
  const responses = useCampaignResponses(campaign.id)
  const messaged = responses.data?.sellers_messaged ?? 0
  const rated = messaged >= RATE_MIN_SAMPLE
  const stopPct = stopRatePct(responses.data)

  const blockers = readiness.blockers.map(translate).filter((b): b is { title: string; detail?: string } => b != null)
  const warnings = readiness.warnings.map(translate).filter((b): b is { title: string; detail?: string } => b != null)

  const total = Number(campaign.total_targets ?? 0)
  const ready = Number(campaign.ready_targets ?? 0)
  const planned = Number(campaign.planned_targets ?? 0)
  const scheduled = Number(campaign.scheduled_queue_rows ?? campaign.scheduled_targets ?? 0)
  const next = resolveNextSend(campaign).label
  const interval = Number(campaign.send_interval_seconds ?? 0)

  return (
    <div className="cov2">
      {blockers.length > 0 && (
        <section className="cov2-card is-blocked cov-blockers" aria-label="Before this can send">
          <h3 className="cov2-card__h">
            <Icon name="alert-circle" size={15} />
            Before this can send
          </h3>
          {blockers.map((b) => (
            <div key={b.title} className="cov2-item">
              <strong>{b.title}</strong>
              {b.detail ? <span>{b.detail}</span> : null}
            </div>
          ))}
        </section>
      )}

      {warnings.length > 0 && (
        <section className="cov2-card is-warn" aria-label="Worth knowing">
          <h3 className="cov2-card__h">Worth knowing</h3>
          {warnings.map((w) => (
            <div key={w.title} className="cov2-item">
              <strong>{w.title}</strong>
              {w.detail ? <span>{w.detail}</span> : null}
            </div>
          ))}
        </section>
      )}

      <section className="cov2-card" aria-label="Audience">
        <h3 className="cov2-card__h">Audience</h3>
        {total > 0 ? (
          <>
            <div className="cov2-big">
              <strong>{nf(ready)}</strong>
              <span>of {nf(total)} ready to message</span>
            </div>
            <div className="cov2-meter" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, (ready / total) * 100))}%` }} />
            </div>
            <div className="cov2-pairs">
              <div className={cls('cov2-pair', planned === 0 && 'is-nil')}>
                <strong>{nf(planned)}</strong>
                <span>Planned</span>
              </div>
              <div className={cls('cov2-pair', scheduled === 0 && 'is-nil')}>
                <strong>{nf(scheduled)}</strong>
                <span>Scheduled</span>
              </div>
            </div>
          </>
        ) : (
          <p className="cov2-note">No audience has been built for this campaign yet.</p>
        )}
      </section>

      <section className="cov2-card" aria-label="Response">
        <h3 className="cov2-card__h">Response</h3>
        {responses.loading && !responses.data ? (
          <p className="cov2-note">Reading replies…</p>
        ) : !responses.data ? (
          <p className="cov2-note">Replies couldn’t be read just now.</p>
        ) : rated ? (
          <div className="cov2-pairs">
            <div className="cov2-pair">
              <strong>{formatRatePct(replyRatePct(responses.data))}</strong>
              <span>Replied</span>
            </div>
            <div className={cls('cov2-pair', stopPct != null && stopPct > 5 && 'is-bad')}>
              <strong>{formatRatePct(stopPct)}</strong>
              <span>Asked to stop</span>
            </div>
          </div>
        ) : (
          <p className="cov2-note">
            Rates appear once {RATE_MIN_SAMPLE} sellers have been messaged — so far {nf(messaged)}.
          </p>
        )}
      </section>

      <section className="cov2-card" aria-label="Pacing">
        <h3 className="cov2-card__h">Pacing</h3>
        <div className="cov2-row">
          <span>Next message</span>
          <strong>{next}</strong>
        </div>
        {interval > 0 && (
          <div className="cov2-row">
            <span>Pace</span>
            <strong>One every {interval}s</strong>
          </div>
        )}
        {campaign.send_window_start && (
          <div className="cov2-row">
            <span>Texting hours</span>
            <strong>{campaign.send_window_start} – {campaign.send_window_end ?? '—'}</strong>
          </div>
        )}
        <div className="cov2-row">
          <span>Auto-send</span>
          <strong>{campaign.auto_send_enabled ? 'On' : 'Off'}</strong>
        </div>
      </section>

      {cost.totalSpend != null && (
        <section className="cov2-card" aria-label="Spend">
          <h3 className="cov2-card__h">Spend</h3>
          <div className="cov2-row">
            <span>Spent so far</span>
            <strong>{money(cost.totalSpend)}</strong>
          </div>
          {cost.costPerReply != null && (
            <div className="cov2-row">
              <span>Per reply</span>
              <strong>{money(cost.costPerReply)}</strong>
            </div>
          )}
          {cost.costPerLead != null && (
            <div className="cov2-row">
              <span>Per qualified lead</span>
              <strong>{money(cost.costPerLead)}</strong>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

export default CampaignOverviewMobile
