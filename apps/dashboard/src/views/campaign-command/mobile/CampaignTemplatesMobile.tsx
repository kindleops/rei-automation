import { useCallback, useEffect, useState } from 'react'
import { getCampaignCommandSummary, type CampaignCommandSummaryResponse } from '../../../lib/api/backendClient'
import type { CampaignSummary } from '../campaigns.types'

/**
 * Campaign Detail — Templates, mobile.
 *
 * The shared tab showed a table headed DLV% / REPLY% / OPT-OUT% whose numbers
 * were not delivery or reply rates at all: the adapter mapped each language's
 * template COVERAGE into "delivery_rate", so "English 100.0% DLV" meant "every
 * English-speaking seller has a template assigned", and every reply and opt-out
 * column was a hard-coded zero.
 *
 * What the data actually answers is useful on its own: does every seller in
 * this audience have an approved message in their language? That is what this
 * shows, per language, from the command summary's language coverage.
 */

type Coverage = CampaignCommandSummaryResponse['language_coverage'][number]

const nf = (n: number) => n.toLocaleString()
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function stateOf(row: Coverage): { text: string; tone: 'ok' | 'attention' | 'none' } {
  if (row.targets > 0 && row.assigned >= row.targets) return { text: 'All covered', tone: 'ok' }
  if (row.assigned <= 0) return { text: 'No approved message', tone: 'none' }
  return { text: `${nf(row.assigned)} of ${nf(row.targets)} covered`, tone: 'attention' }
}

export function CampaignTemplatesMobile({ campaign }: { campaign: CampaignSummary }) {
  const [rows, setRows] = useState<Coverage[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    const res = await getCampaignCommandSummary(campaign.id)
    if (res.ok && res.data?.ok && Array.isArray(res.data.language_coverage)) setRows(res.data.language_coverage)
    else setFailed(true)
    setLoading(false)
  }, [campaign.id])

  useEffect(() => { void load() }, [load])

  if (loading && !rows) {
    return <div className="ctp" aria-busy="true"><div className="cex-skel" /></div>
  }

  if (failed || !rows) {
    return (
      <div className="ctp">
        <section className="cov2-card is-warn" role="status">
          <h3 className="cov2-card__h">Message coverage couldn’t be loaded</h3>
          <p className="cov2-note">Nothing about the campaign has changed.</p>
          <button type="button" className="cex-retry" onClick={() => void load()}>Try again</button>
        </section>
      </div>
    )
  }

  const counted = rows.reduce((n, r) => n + r.targets, 0)
  const covered = rows.reduce((n, r) => n + Math.min(r.assigned, r.targets), 0)
  const total = Number(campaign.total_targets ?? 0)

  if (counted === 0) {
    return (
      <div className="ctp">
        <section className="cov2-card">
          <h3 className="cq-empty__title">No audience yet</h3>
          <p className="cov2-note">Message coverage appears once the audience is built.</p>
        </section>
      </div>
    )
  }

  const uncovered = rows.filter((r) => r.assigned < r.targets)
  const pct = Math.max(0, Math.min(100, (covered / counted) * 100))

  return (
    <div className="ctp">
      <section className="cov2-card" aria-label="Message coverage">
        <h3 className="cov2-card__h">Message coverage</h3>
        <div className="cov2-big">
          <strong>{nf(covered)}</strong>
          <span>of {nf(counted)} sellers have an approved message in their language</span>
        </div>
        <div className="cov2-meter" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
        {uncovered.length === 0 ? (
          <p className="cov2-note">Every language in this audience is covered.</p>
        ) : (
          <p className="cov2-note">
            {nf(counted - covered)} {counted - covered === 1 ? 'seller speaks a language' : 'sellers speak languages'} without full coverage.
          </p>
        )}
      </section>

      <section className="cov2-card" aria-label="By language">
        <h3 className="cov2-card__h">By language</h3>
        <ul className="ctp-list">
          {rows.map((r) => {
            const state = stateOf(r)
            return (
              <li key={r.language} className={cls('ctp-row', `is-${state.tone}`)}>
                <span className="ctp-row__lang">{r.label || r.language}</span>
                <span className="ctp-row__n">{nf(r.targets)} {r.targets === 1 ? 'seller' : 'sellers'}</span>
                <span className="ctp-row__state">{state.text}</span>
              </li>
            )
          })}
        </ul>
      </section>

      {total > counted && (
        <p className="cexc-foot">Counted from {nf(counted)} of {nf(total)} sellers.</p>
      )}
    </div>
  )
}

export default CampaignTemplatesMobile
