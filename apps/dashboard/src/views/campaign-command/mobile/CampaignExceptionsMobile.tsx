import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { fetchCampaignFailures, type CampaignFailuresResult } from '../campaigns.adapter'
import {
  formatExceptionDate,
  summarizeExceptions,
  type ExceptionEntry,
} from '../campaign-exceptions'
import type { CampaignSummary } from '../campaigns.types'

/**
 * Campaign Detail — Exceptions, mobile.
 *
 * The shared desktop tab rendered here before: a shimmer too faint to see on a
 * phone, then — nine seconds later — "internal_execution_error ×499" for a
 * campaign whose 612 exceptions were 595 expiries, 16 carrier refusals and one
 * unconfirmed send. The backend now counts every row; this says what each kind
 * means and whether anyone has to act on it, most actionable first.
 *
 * Nothing here is estimated. A total that stopped at the backend's scan limit
 * carries a "+"; a count read from the fallback sample says so.
 */

const nf = (n: number) => n.toLocaleString()
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function ExceptionRow({ entry }: { entry: ExceptionEntry }) {
  const when = formatExceptionDate(entry.latestAt)
  return (
    <li className={cls('cexc-row', `is-${entry.copy.tone}`)}>
      <span className="cexc-row__dot" aria-hidden="true" />
      <div className="cexc-row__main">
        <div className="cexc-row__top">
          <strong className="cexc-row__title">{entry.copy.title}</strong>
          <span className="cexc-row__n">{nf(entry.count)}</span>
        </div>
        {entry.copy.tone === 'attention' && <span className="cexc-row__tag">Worth a look</span>}
        {entry.copy.body && <p className="cexc-row__body">{entry.copy.body}</p>}
        {entry.quotes.map((q) => (
          <p key={q} className="cexc-row__quote">
            <span>Carrier said</span>
            “{q}”
          </p>
        ))}
        {when && <span className="cexc-row__when">Last on {when}</span>}
      </div>
    </li>
  )
}

function Verdict({ entries }: { entries: ExceptionEntry[] }) {
  const attention = entries.filter((e) => e.copy.tone === 'attention').length
  return (
    <p className={cls('cexc-verdict', attention > 0 ? 'is-attention' : 'is-calm')}>
      <Icon name={attention > 0 ? 'alert-circle' : 'check'} size={14} />
      {attention > 0 ? `${attention} worth a look` : 'Nothing here needs action'}
    </p>
  )
}

/** Share of each kind, for a one-glance read. Only drawn when there's a mix. */
function Composition({ entries, total }: { entries: ExceptionEntry[]; total: number }) {
  if (entries.length < 2 || total <= 0) return null
  return (
    <div className="cexc-bar" aria-hidden="true">
      {entries.map((e) => (
        <span key={e.key} className={`is-${e.copy.tone}`} style={{ flexGrow: e.count }} />
      ))}
    </div>
  )
}

export function CampaignExceptionsMobile({ campaign }: { campaign: CampaignSummary }) {
  const [result, setResult] = useState<CampaignFailuresResult | null>(null)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchCampaignFailures(campaign.id)
      if (mounted.current) setResult(data)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [campaign.id])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load])

  if (loading && !result) {
    return (
      <div className="cexc" aria-busy="true" aria-label="Loading exceptions">
        <div className="cex-skel" />
        <div className="cex-skel is-short" />
      </div>
    )
  }

  // `none` means neither the API nor its fallback answered — not "no exceptions".
  if (!result || result.source === 'none') {
    return (
      <div className="cexc">
        <section className="cov2-card is-warn" role="status">
          <h3 className="cov2-card__h">Exceptions couldn’t be loaded</h3>
          <p className="cov2-note">Nothing about the campaign has changed. Try again in a moment.</p>
          <button type="button" className="cex-retry" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Try again'}
          </button>
        </section>
      </div>
    )
  }

  const s = summarizeExceptions(result)

  if (s.sendingTotal === 0 && s.audienceTotal === 0) {
    return (
      <div className="cexc">
        <section className="cov2-card cexc-clear">
          <span className="cexc-clear__icon" aria-hidden="true"><Icon name="check" size={18} /></span>
          <h3 className="cexc-clear__title">No exceptions</h3>
          <p className="cov2-note">No message in this campaign has expired, failed or been refused.</p>
        </section>
      </div>
    )
  }

  const sampled = result.source === 'deal_context_sample'

  return (
    <div className="cexc">
      {s.sendingTotal > 0 && (
        <section className="cov2-card cexc-card" aria-label="While sending">
          <div className="cov2-big cexc-big">
            <strong>{nf(s.sendingTotal)}{s.sendingIsFloor ? '+' : ''}</strong>
            <span>{s.sendingTotal === 1 ? 'message' : 'messages'} didn’t go as planned</span>
          </div>
          <Composition entries={s.sending} total={s.sendingTotal} />
          <Verdict entries={s.sending} />
          <ul className="cexc-list">
            {s.sending.map((e) => <ExceptionRow key={e.key} entry={e} />)}
          </ul>
        </section>
      )}

      {s.audienceTotal > 0 && (
        <section className="cov2-card cexc-card" aria-label="When the audience was built">
          <div className="cov2-big cexc-big">
            <strong>{nf(s.audienceTotal)}{s.audienceIsFloor ? '+' : ''}</strong>
            <span>{s.audienceTotal === 1 ? 'seller was' : 'sellers were'} left out of the audience</span>
          </div>
          <Verdict entries={s.audience} />
          <ul className="cexc-list">
            {s.audience.map((e) => <ExceptionRow key={e.key} entry={e} />)}
          </ul>
        </section>
      )}

      {(sampled || s.sendingIsFloor || s.audienceIsFloor) && (
        <p className="cexc-foot">
          {sampled
            ? 'Counted from the most recent messages only — the full count wasn’t available.'
            : 'Counting stopped at the limit, so the real number is higher.'}
        </p>
      )}
    </div>
  )
}

export default CampaignExceptionsMobile
