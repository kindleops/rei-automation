import { pushRoutePath } from '../../../app/router'
import { Icon } from '../../../shared/icons'
import { formatRatePct, RATE_MIN_SAMPLE } from '../campaign-operator-language'
import { describeIntent, intentRows, replyRatePct } from '../campaign-responses'
import type { CampaignSummary } from '../campaigns.types'
import { formatPhone } from './mobile-format'
import { useCampaignResponses } from './useCampaignResponses'

/**
 * Campaign Detail — Replies, mobile.
 *
 * This said "No replies yet — they appear once sending begins" on a campaign
 * that had sent 354 messages and heard back from 41 sellers. Its count read
 * `reply_count`, which is counted from target statuses no target ever holds;
 * its list came from a deal-context query that found none of those 41; and it
 * offered Positive / Negative / Opt out / Question filters that could never
 * match anything.
 *
 * Now it reads /responses — inbound messages from each seller to the number
 * that messaged them, after it did — the same answer the hero and Overview
 * show. What each seller said is grouped by the classifier's reading of their
 * latest reply, and every reply opens its conversation.
 */

const nf = (n: number) => n.toLocaleString()
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function ago(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 1440) return `${Math.round(m / 60)} hr ago`
  const d = Math.round(m / 1440)
  if (d < 7) return `${d} ${d === 1 ? 'day' : 'days'} ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function CampaignRepliesMobile({ campaign }: { campaign: CampaignSummary }) {
  const { data, loading, failed, reload } = useCampaignResponses(campaign.id)

  if (loading && !data) {
    return (
      <div className="crp" aria-busy="true">
        <div className="cex-skel is-short" />
        <div className="cq-card">{[0, 1, 2].map((i) => <div key={i} className="cq-skel is-tall" />)}</div>
      </div>
    )
  }

  if (failed || !data) {
    return (
      <div className="crp">
        <section className="cov2-card is-warn" role="status">
          <h3 className="cov2-card__h">Replies couldn’t be loaded</h3>
          <p className="cov2-note">Nothing about the campaign has changed.</p>
          <button type="button" className="cex-retry" onClick={() => void reload()}>Try again</button>
        </section>
      </div>
    )
  }

  const rows = intentRows(data.intents)
  const rate = replyRatePct(data)
  const floor = data.truncated ? '+' : ''

  return (
    <div className="crp">
      <section className="cov2-card" aria-label="Replies">
        <div className="cov2-big">
          <strong>{nf(data.sellers_replied)}{floor}</strong>
          <span>
            of {nf(data.sellers_messaged)} {data.sellers_messaged === 1 ? 'seller' : 'sellers'} replied
          </span>
        </div>
        {data.sellers_replied > 0 ? (
          <p className="cov2-note crp-note">
            {data.sellers_messaged >= RATE_MIN_SAMPLE && rate != null ? `${formatRatePct(rate)} response · ` : ''}
            {nf(data.reply_messages)}{floor} {data.reply_messages === 1 ? 'message' : 'messages'}
            {data.latest_reply_at ? ` · latest ${ago(data.latest_reply_at)}` : ''}
          </p>
        ) : (
          <p className="cov2-note crp-note">
            {data.sellers_messaged > 0
              ? 'Nobody has texted back yet.'
              : 'Replies show up here once messages go out.'}
          </p>
        )}
      </section>

      {rows.length > 0 && (
        <section className="cov2-card" aria-label="What they said">
          <h3 className="cov2-card__h">What they said</h3>
          <p className="crp-sub">Each seller once, by their latest reply.</p>
          <ul className="crp-intents">
            {rows.map((r) => (
              <li key={r.label} className={cls('crp-intent', `is-${r.tone}`)}>
                <span className="crp-intent__dot" aria-hidden="true" />
                <span className="crp-intent__label">{r.label}</span>
                <span className="crp-intent__n">{nf(r.count)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.latest.length > 0 && (
        <section className="cov2-card crp-card" aria-label="Latest replies">
          <h3 className="cov2-card__h">Latest replies</h3>
          <ul className="crp-list">
            {data.latest.map((r) => {
              const intent = describeIntent(r.intent)
              const Row = r.thread_key ? 'button' : 'div'
              return (
                <li key={`${r.seller_phone}-${r.at}`}>
                  <Row
                    {...(r.thread_key
                      ? { type: 'button' as const, onClick: () => pushRoutePath(`/inbox?thread=${encodeURIComponent(r.thread_key!)}`) }
                      : {})}
                    className={cls('crp-row', r.thread_key && 'is-link')}
                  >
                    <span className="crp-row__top">
                      <span className="crp-row__who">{r.seller_name || formatPhone(r.seller_phone) || 'Seller'}</span>
                      <span className="crp-row__at">{ago(r.at)}</span>
                    </span>
                    {r.message && <span className="crp-row__msg">{r.message}</span>}
                    <span className="crp-row__bottom">
                      <span className={cls('cq-pill', intent.tone === 'good' && 'is-ok', intent.tone === 'bad' && 'is-bad')}>
                        {intent.label}
                      </span>
                      <span className="crp-row__sub">{r.seller_name ? formatPhone(r.seller_phone) : ' '}</span>
                      {r.thread_key && <Icon name="chevron-right" size={14} />}
                    </span>
                  </Row>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

export default CampaignRepliesMobile
