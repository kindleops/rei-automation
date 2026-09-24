import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { getCampaignProgress, type CampaignRuntimeSummary } from '../../../lib/api/backendClient'
import type { CampaignSummary } from '../campaigns.types'

/**
 * Campaign Detail — Execution, mobile.
 *
 * The shared desktop Control Center rendered here before, and on a phone it
 * contradicted the screen it sat in:
 *
 *   - its own delivery counters, from the runtime endpoint (Miami: sent 151),
 *     directly below a hero reading "354 of 802 sent" from the campaign list
 *     (the send queue holds 367)
 *   - "EXECUTION — LIVE" above "State: Test Mode"
 *   - "Next scheduled Jun 30" — three months in the past, presented as next
 *   - its own Pause / Resume / Archive buttons, duplicating the dock and, for
 *     Resume, skipping the confirmation the dock asks for
 *   - "Queue hydration", "Live send rows", and a raw JSON hydration cursor
 *
 * What execution uniquely knows is WHEN things happened and whether the engine
 * is moving. That is what this shows. Outcome counts belong to the hero, from
 * one source; actions belong to the dock, behind one confirmation.
 *
 * Two more that read wrong (2026-09-24):
 *   - "557 messages prepared for sending" was hydrated_rows, which counts
 *     expired and failed rows too; Miami had nothing waiting. What's waiting
 *     is the Queue section's job, counted there from send_queue itself — a
 *     second, differently-scoped count here would only disagree with it.
 *   - "Sending: Enabled" directly under "Test — nothing reaches sellers". The
 *     send switch is a live-mode fact, and status already says paused or live.
 */

const POLL_MS = 20_000
const LIVE = new Set(['active', 'activating', 'live_limited'])
const nf = (n: number | null | undefined) => (Number(n) || 0).toLocaleString()
const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function when(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function ago(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 1440) return `${Math.round(m / 60)} hr ago`
  return `${Math.round(m / 1440)} days ago`
}

/** A failure reason reaches the operator as a sentence, never a code. */
function humanReason(raw: string | null | undefined): string | null {
  const t = String(raw ?? '').trim()
  if (!t) return null
  if (/^[a-z0-9_:.-]+$/i.test(t)) return t.replace(/[_:.-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  return t
}

export function CampaignExecutionMobile({ campaign }: { campaign: CampaignSummary }) {
  const [summary, setSummary] = useState<CampaignRuntimeSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [showTech, setShowTech] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)

  const load = useCallback(async (recompute: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    if (recompute) setRechecking(true)
    try {
      const res = await getCampaignProgress(campaign.id, { recompute })
      if (!mounted.current) return
      if (res.ok && res.data?.summary) { setSummary(res.data.summary); setError(false) }
      else setError(true)
    } catch {
      if (mounted.current) setError(true)
    } finally {
      inFlight.current = false
      if (mounted.current) { setLoading(false); setRechecking(false) }
    }
  }, [campaign.id])

  useEffect(() => {
    mounted.current = true
    setLoading(true)
    void load(false)
    return () => { mounted.current = false }
  }, [load])

  const isLive = LIVE.has(String(campaign.status ?? '').toLowerCase())

  // Poll only while live and visible — a paused campaign's timeline doesn't move.
  useEffect(() => {
    if (!isLive) return undefined
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false)
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [isLive, load])

  const proof = campaign.execution_proof ?? null
  const inTest = campaign.operator_state === 'test_mode'
  const nextAt = proof?.next_scheduled_proof_row ?? null
  // "Next" must be in the future. A past timestamp here is a stale plan row,
  // and a paused campaign has no next message.
  const nextIsFuture = nextAt ? new Date(nextAt).getTime() > Date.now() : false
  // The engine only checks in on a campaign it's running; on a paused one the
  // age of the last check-in says nothing about health.
  const heartbeat = ago(summary?.execution_heartbeat_at)

  const intervalSec = Number(campaign.send_interval_seconds) || 0
  const targetPerHour = intervalSec > 0 ? Math.round(3600 / intervalSec) : null
  const hydrating = Boolean(summary?.hydration_active)
  const hydrationPct = Math.max(0, Math.min(100, Number(summary?.hydration_progress_pct ?? 0)))

  // In the order it happened.
  const timeline: Array<{ key: string; label: string; at: string; tone?: 'bad' }> = [
    { key: 'scheduled', label: 'Scheduled for', at: summary?.scheduled_for ?? '' },
    { key: 'activated', label: 'Started', at: summary?.activated_at ?? '' },
    { key: 'paused', label: 'Paused', at: summary?.paused_at ?? '' },
    { key: 'completed', label: 'Completed', at: summary?.completed_at ?? '' },
    { key: 'failed', label: 'Stopped with a problem', at: summary?.failed_at ?? '', tone: 'bad' as const },
  ]
    .filter((t) => when(t.at))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  if (loading && !summary) {
    return (
      <div className="cex" aria-busy="true">
        <div className="cex-skel" />
        <div className="cex-skel is-short" />
      </div>
    )
  }

  return (
    <div className="cex">
      {error && !summary && (
        <section className="cov2-card is-warn" role="status">
          <h3 className="cov2-card__h">Execution details are unavailable</h3>
          <p className="cov2-note">The campaign itself is unaffected. Try again in a moment.</p>
          <button type="button" className="cex-retry" onClick={() => void load(false)}>Try again</button>
        </section>
      )}

      <section className="cov2-card" aria-label="Sending">
        <h3 className="cov2-card__h cex-head">
          Sending
          <button
            type="button"
            className="cex-recheck"
            onClick={() => void load(true)}
            disabled={rechecking}
            aria-label="Recheck execution status"
          >
            <Icon name="refresh-cw" size={13} />
            {rechecking ? 'Checking…' : 'Recheck'}
          </button>
        </h3>
        <div className="cov2-row">
          <span>Mode</span>
          <strong className={cls(inTest && 'cex-test')}>{inTest ? 'Test — nothing reaches sellers' : 'Live'}</strong>
        </div>
        {nextIsFuture && (
          <div className="cov2-row">
            <span>Next message</span>
            <strong>{when(nextAt)}</strong>
          </div>
        )}
        {heartbeat && isLive && (
          <div className="cov2-row">
            <span>Engine checked in</span>
            <strong>{heartbeat}</strong>
          </div>
        )}
      </section>

      {targetPerHour != null && (
        <section className="cov2-card" aria-label="Pace">
          <h3 className="cov2-card__h">Pace</h3>
          <div className="cov2-row">
            <span>Target</span>
            <strong>{nf(targetPerHour)} an hour</strong>
          </div>
          <div className="cov2-row">
            <span>Spacing</span>
            <strong>One every {intervalSec}s</strong>
          </div>
          {!isLive && (
            <p className="cov2-note cex-note">Pace resumes when the campaign is sending again.</p>
          )}
        </section>
      )}

      {hydrating && (
        <section className="cov2-card" aria-label="Preparing messages">
          <h3 className="cov2-card__h">Preparing messages</h3>
          <div className="cov2-meter" aria-hidden="true">
            <span style={{ width: `${hydrationPct}%` }} />
          </div>
          <p className="cov2-note">{Math.round(hydrationPct)}% done</p>
        </section>
      )}

      {timeline.length > 0 && (
        <section className="cov2-card" aria-label="History">
          <h3 className="cov2-card__h">History</h3>
          <ol className="cex-timeline">
            {timeline.map((t) => (
              <li key={t.key} className={cls('cex-event', t.tone === 'bad' && 'is-bad')}>
                <span className="cex-event__dot" aria-hidden="true" />
                <span className="cex-event__label">{t.label}</span>
                <span className="cex-event__at">{when(t.at)}</span>
              </li>
            ))}
          </ol>
          {summary?.failure_reason && (
            <p className="cov2-note cex-fail">{humanReason(summary.failure_reason)}</p>
          )}
        </section>
      )}

      <section className="cov2-card cex-tech" aria-label="Technical details">
        <button
          type="button"
          className="cex-tech__toggle"
          aria-expanded={showTech}
          onClick={() => setShowTech((v) => !v)}
        >
          Technical details
          <Icon name={showTech ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
        {showTech && (
          <div className="cex-tech__body">
            {proof && (
              <>
                <div className="cov2-row"><span>Live send rows</span><strong>{nf(proof.live_send_rows)}</strong></div>
                <div className="cov2-row"><span>Test rows</span><strong>{nf(proof.proof_no_send_rows)}</strong></div>
                <div className="cov2-row"><span>SMS-capable sellers</span><strong>{nf(proof.sms_eligible)}</strong></div>
                <div className="cov2-row"><span>With a sender number</span><strong>{nf(proof.routing_allowed)}</strong></div>
              </>
            )}
            <div className="cov2-row"><span>Launch attempts</span><strong>{nf(summary?.activation_attempt_count)}</strong></div>
            {ago(summary?.progress_synced_at) && (
              <div className="cov2-row"><span>Numbers last synced</span><strong>{ago(summary?.progress_synced_at)}</strong></div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

export default CampaignExecutionMobile
