import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { activateCampaignWithReview, fetchCampaignDetail } from '../campaigns.adapter'
import { computeCampaignReadiness } from '../campaign-health'
import { mergeCampaignDetail } from '../campaign-detail-merge'
import type { CampaignSummary } from '../campaigns.types'

type ActivationStep =
  | 'review'
  | 'validating_recipients'
  | 'resolving_templates'
  | 'resolving_senders'
  | 'applying_compliance'
  | 'hydrating_queue'
  | 'activating_campaign'
  | 'complete'
  | 'failed'

type ActivationMode = 'live' | 'test'

const ACTIVATION_TIMEOUT_MS = 120_000

interface CampaignActivationModalProps {
  campaign: CampaignSummary
  onClose: () => void
  onSuccess: (result: {
    inserted: number
    skipped: number
    blockers: string[]
    idempotent?: boolean
    activationMode: ActivationMode
    proofHydration: boolean
  }) => void
}

/**
 * Operator language throughout (2026-09-24). This read as an engineering
 * console — "hydrates proof rows (`no_send`)", "Hydrating Queue", "global brakes"
 * — and asked for the live launch in a native window.confirm. The steps, gates,
 * payload and idempotency key are unchanged; the live launch now confirms
 * inside the sheet, stating how many sellers it prepares messages for.
 */
const PROGRESS_STEPS: Array<{ id: ActivationStep; label: string }> = [
  { id: 'validating_recipients', label: 'Checking sellers' },
  { id: 'resolving_templates', label: 'Choosing messages' },
  { id: 'resolving_senders', label: 'Assigning sender numbers' },
  { id: 'applying_compliance', label: 'Applying compliance checks' },
  { id: 'hydrating_queue', label: 'Preparing messages' },
  { id: 'activating_campaign', label: 'Starting the campaign' },
  { id: 'complete', label: 'Done' },
]

function stepIndex(step: ActivationStep): number {
  const idx = PROGRESS_STEPS.findIndex((s) => s.id === step)
  return idx >= 0 ? idx : -1
}

export const CampaignActivationModal = ({
  campaign,
  onClose,
  onSuccess,
}: CampaignActivationModalProps) => {
  const [step, setStep] = useState<ActivationStep>('review')
  const [error, setError] = useState<string | null>(null)
  const [blockers, setBlockers] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [completionMode, setCompletionMode] = useState<ActivationMode | null>(null)
  const [confirmingLive, setConfirmingLive] = useState(false)
  const idempotencyKeyRef = useRef(`activate-${campaign.id}-${Date.now()}`)
  const abortRef = useRef<AbortController | null>(null)
  const busy = pending

  /**
   * CHECK AGAINST THE CAMPAIGN AS IT IS NOW.
   *
   * The campaign handed in may be the list row, taken before the detail had
   * loaded — without launch_blockers. Opened that way, this sheet computed
   * "Launch checks: Passing" and enabled Launch live on a campaign whose real
   * checks were blocked (the backend still refused; the sheet shouldn't have
   * claimed otherwise). It reads the campaign fresh on open, says "Checking…"
   * until it has, and keeps a live launch off until the checks are read.
   */
  const [fresh, setFresh] = useState<CampaignSummary | null>(null)
  const [checkFailed, setCheckFailed] = useState(false)
  useEffect(() => {
    let alive = true
    fetchCampaignDetail(campaign.id)
      .then((detail) => {
        if (!alive) return
        if (detail) setFresh(mergeCampaignDetail(campaign, detail))
        else setCheckFailed(true)
      })
      .catch(() => { if (alive) setCheckFailed(true) })
    return () => { alive = false }
    // Once per open: a refreshed parent row must not restart the check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id])
  const current = fresh ?? campaign
  const checking = !fresh && !checkFailed
  const readiness = useMemo(() => computeCampaignReadiness(current), [current])

  const runActivation = useCallback(async (activationMode: ActivationMode) => {
    if (pending) return
    const isTest = activationMode === 'test'
    // A live launch is only reachable through the in-sheet confirmation step
    // (confirmingLive), which states its scope before this runs.
    setConfirmingLive(false)
    setError(null)
    setBlockers([])
    setPending(true)
    setCompletionMode(activationMode)
    setStep('validating_recipients')
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    const timeout = window.setTimeout(() => abortRef.current?.abort(), ACTIVATION_TIMEOUT_MS)

    try {
      const result = await activateCampaignWithReview(campaign.id, {
        activation_idempotency_key: idempotencyKeyRef.current,
        confirm_live: true,
        no_send: isTest,
        explicit_operator_action: true,
        batch_max: Math.min(campaign.ready_targets || 5, 5),
      })

      if (!result.ok) {
        const msgs = result.blockers?.length
          ? result.blockers
          : [result.message || result.error || 'Activation blocked']
        setBlockers(msgs)
        setError(msgs.join(' · '))
        setStep('failed')
        setCompletionMode(null)
        return
      }

      setStep('complete')
      onSuccess({
        inserted: result.inserted ?? 0,
        skipped: result.skipped ?? 0,
        blockers: result.blockers ?? [],
        idempotent: result.idempotent,
        activationMode,
        proofHydration: Boolean(result.proof_hydration ?? isTest),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isAbort = err instanceof Error && err.name === 'AbortError'
      setError(isAbort ? 'This took too long to confirm. Check the campaign’s status before trying again.' : msg)
      setStep('failed')
      setCompletionMode(null)
    } finally {
      window.clearTimeout(timeout)
      setPending(false)
    }
  }, [campaign.id, campaign.ready_targets, onSuccess, pending])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const reviewBlockers = fresh ? [...readiness.blockers, ...blockers] : blockers
  const canTestActivate = current.ready_targets > 0
  const canLiveActivate = Boolean(fresh)
    && readiness.level !== 'blocked' && current.ready_targets > 0 && current.launch_readiness !== 'blocked'

  const completionCopy = completionMode === 'test'
    ? 'Test launch done — messages were prepared, and none will be sent.'
    : completionMode === 'live'
      ? 'Launched — messages are prepared and go out on schedule while sending is on.'
      : null
  const firstBatch = Math.min(current.ready_targets || 0, 5)

  const modal = (
    <div className="ccm-glass-overlay" onClick={onClose}>
      <div className="ccm-glass-modal ccm-activation-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ccm-glass-modal__header">
          <div className="ccm-glass-modal__icon">
            <Icon name="zap" size={18} />
          </div>
          <div>
            <h3>{confirmingLive ? 'Launch live?' : 'Launch campaign'}</h3>
            <p>{campaign.campaign_name}</p>
          </div>
          <button type="button" className="ccm-glass-modal__close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>

        {step === 'review' && confirmingLive && (
          <div className="ccm-schedule-body">
            <div className="ccm-schedule-hint">
              Real messages are prepared for the first {firstBatch.toLocaleString()} of {campaign.ready_targets.toLocaleString()} ready
              {campaign.ready_targets === 1 ? ' seller' : ' sellers'}. They go out only while system-wide sending is on,
              inside texting hours, and after every suppression and sender check.
            </div>
          </div>
        )}

        {step === 'review' && !confirmingLive && (
          <>
            <div className="ccm-activation-grid">
              <div className="ccm-activation-stat">
                <span>Sellers ready</span>
                <strong>{current.ready_targets.toLocaleString()}</strong>
              </div>
              <div className="ccm-activation-stat">
                <span>First batch</span>
                <strong>{firstBatch.toLocaleString()}</strong>
              </div>
              <div className="ccm-activation-stat">
                <span>Audience</span>
                <strong>{current.total_targets.toLocaleString()}</strong>
              </div>
              <div className="ccm-activation-stat">
                <span>Launch checks</span>
                {checking ? (
                  <strong>Checking…</strong>
                ) : !fresh ? (
                  <strong className="is-bad">Couldn’t check</strong>
                ) : (
                  <strong className={readiness.level === 'blocked' || current.launch_readiness === 'blocked' ? 'is-bad' : 'is-good'}>
                    {readiness.level === 'blocked' || current.launch_readiness === 'blocked' ? 'Blocked' : 'Passing'}
                  </strong>
                )}
              </div>
              <div className="ccm-activation-stat">
                <span>Pace</span>
                <strong>One every {campaign.send_interval_seconds}s</strong>
              </div>
              <div className="ccm-activation-stat">
                <span>First message</span>
                <strong>{campaign.next_send_at ? new Date(campaign.next_send_at).toLocaleString() : 'When it starts'}</strong>
              </div>
            </div>

            <div className="ccm-activation-warnings">
              <div className="ccm-activation-warn-item">
                <Icon name="alert-circle" size={12} />
                A test launch prepares messages that are never sent, to check everything end to end.
              </div>
              <div className="ccm-activation-warn-item">
                <Icon name="zap" size={12} />
                A live launch prepares real messages. They send only while system-wide sending is on.
              </div>
            </div>

            {readiness.warnings.length > 0 && (
              <div className="ccm-activation-warnings">
                {readiness.warnings.map((w) => (
                  <div key={w} className="ccm-activation-warn-item">
                    <Icon name="alert-circle" size={12} />
                    {w}
                  </div>
                ))}
              </div>
            )}

            {reviewBlockers.length > 0 && (
              <div className="ccm-activation-blockers">
                <div className="ccm-activation-blockers__title">Before this can launch live</div>
                {reviewBlockers.map((b) => (
                  <div key={b} className="ccm-activation-blocker-item">{b}</div>
                ))}
              </div>
            )}
          </>
        )}

        {step !== 'review' && step !== 'failed' && step !== 'complete' && pending && (
          <div className="ccm-activation-progress">
            <ul className="ccm-activation-steps">
              {PROGRESS_STEPS.map((s) => {
                const current = stepIndex(step)
                const idx = stepIndex(s.id)
                const state = idx < current ? 'is-done' : idx === current ? 'is-active' : ''
                return (
                  <li key={s.id} className={state}>
                    <span className="ccm-activation-step-dot" />
                    {s.label}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {step === 'complete' && completionCopy && (
          <div className="ccm-activation-progress">
            <ul className="ccm-activation-steps">
              {PROGRESS_STEPS.map((s) => {
                const current = stepIndex(step)
                const idx = stepIndex(s.id)
                const state = idx < current ? 'is-done' : idx === current ? 'is-active' : ''
                return (
                  <li key={s.id} className={state}>
                    <span className="ccm-activation-step-dot" />
                    {s.label}
                  </li>
                )
              })}
            </ul>
            <div className={`ccm-activation-success${completionMode === 'test' ? ' is-warn' : ''}`}>
              <Icon name={completionMode === 'test' ? 'alert-circle' : 'check'} size={20} />
              {completionCopy}
            </div>
          </div>
        )}

        {step === 'failed' && error && (
          <div className="ccm-activation-error">
            <Icon name="alert" size={16} />
            <div>
              <strong>Launch didn’t complete</strong>
              <p>{error}</p>
            </div>
          </div>
        )}

        <div className="ccm-glass-modal__footer">
          {step === 'review' && confirmingLive && (
            <>
              <button type="button" className="ccc-btn" onClick={() => setConfirmingLive(false)} disabled={busy}>Back</button>
              <button
                type="button"
                className="ccc-btn is-primary"
                disabled={!canLiveActivate || busy}
                onClick={() => void runActivation('live')}
              >
                Launch live
              </button>
            </>
          )}
          {step === 'review' && !confirmingLive && (
            <>
              <button type="button" className="ccc-btn" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="ccc-btn is-warn"
                disabled={!canTestActivate || busy}
                onClick={() => void runActivation('test')}
              >
                Test launch
              </button>
              <button
                type="button"
                className="ccc-btn is-primary"
                disabled={!canLiveActivate || busy}
                onClick={() => setConfirmingLive(true)}
              >
                Launch live…
              </button>
            </>
          )}
          {step === 'complete' && (
            <button type="button" className="ccc-btn is-primary" onClick={onClose}>Done</button>
          )}
          {step === 'failed' && (
            <>
              <button type="button" className="ccc-btn" onClick={onClose}>Close</button>
              <button type="button" className="ccc-btn is-primary" onClick={() => { setStep('review'); setError(null) }}>
                Back
              </button>
            </>
          )}
          {busy && step !== 'review' && step !== 'complete' && step !== 'failed' && (
            <button type="button" className="ccc-btn" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}