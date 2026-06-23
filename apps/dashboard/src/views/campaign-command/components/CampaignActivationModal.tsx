import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../../shared/icons'
import { activateCampaignWithReview } from '../campaigns.adapter'
import { computeCampaignReadiness } from '../campaign-health'
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

const ACTIVATION_TIMEOUT_MS = 120_000

interface CampaignActivationModalProps {
  campaign: CampaignSummary
  onClose: () => void
  onSuccess: (result: {
    inserted: number
    skipped: number
    blockers: string[]
    idempotent?: boolean
  }) => void
}

const PROGRESS_STEPS: Array<{ id: ActivationStep; label: string }> = [
  { id: 'validating_recipients', label: 'Validating recipients' },
  { id: 'resolving_templates', label: 'Resolving templates' },
  { id: 'resolving_senders', label: 'Resolving sender routes' },
  { id: 'applying_compliance', label: 'Applying compliance guards' },
  { id: 'hydrating_queue', label: 'Hydrating Queue' },
  { id: 'activating_campaign', label: 'Activating campaign' },
  { id: 'complete', label: 'Complete' },
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
  const idempotencyKeyRef = useRef(`activate-${campaign.id}-${Date.now()}`)
  const abortRef = useRef<AbortController | null>(null)
  const busy = pending

  const readiness = useMemo(() => computeCampaignReadiness(campaign), [campaign])

  const runActivation = useCallback(async () => {
    if (pending) return
    setError(null)
    setBlockers([])
    setPending(true)
    setStep('validating_recipients')
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    const timeout = window.setTimeout(() => abortRef.current?.abort(), ACTIVATION_TIMEOUT_MS)

    try {
      const result = await activateCampaignWithReview(campaign.id, {
        activation_idempotency_key: idempotencyKeyRef.current,
        confirm_live: true,
        no_send: true,
        batch_max: Math.min(campaign.ready_targets || 5, 5),
      })

      if (!result.ok) {
        const msgs = result.blockers?.length
          ? result.blockers
          : [result.message || result.error || 'Activation blocked']
        setBlockers(msgs)
        setError(msgs.join(' · '))
        setStep('failed')
        return
      }

      setStep('complete')
      onSuccess({
        inserted: result.inserted ?? 0,
        skipped: result.skipped ?? 0,
        blockers: result.blockers ?? [],
        idempotent: result.idempotent,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isAbort = err instanceof Error && err.name === 'AbortError'
      setError(isAbort ? 'Activation timed out — check campaign run status and retry.' : msg)
      setStep('failed')
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

  const reviewBlockers = [...readiness.blockers, ...blockers]
  const canConfirm = readiness.level !== 'blocked' && campaign.ready_targets > 0 && campaign.launch_readiness !== 'blocked'

  const modal = (
    <div className="ccm-glass-overlay" onClick={onClose}>
      <div className="ccm-glass-modal ccm-activation-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ccm-glass-modal__header">
          <div className="ccm-glass-modal__icon">
            <Icon name="zap" size={18} />
          </div>
          <div>
            <h3>Activation Review</h3>
            <p>{campaign.campaign_name}</p>
          </div>
          <button type="button" className="ccm-glass-modal__close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>

        {step === 'review' && (
          <>
            <div className="ccm-activation-grid">
              <div className="ccm-activation-stat">
                <span>Ready targets</span>
                <strong>{campaign.ready_targets.toLocaleString()}</strong>
              </div>
              <div className="ccm-activation-stat">
                <span>Initial batch</span>
                <strong>{Math.min(campaign.ready_targets || 0, 500).toLocaleString()}</strong>
              </div>
              <div className="ccm-activation-stat">
                <span>Total snapshot</span>
                <strong>{campaign.total_targets.toLocaleString()}</strong>
              </div>
              <div className="ccm-activation-stat">
                <span>Compliance</span>
                <strong className={readiness.level === 'blocked' ? 'is-bad' : 'is-good'}>
                  {readiness.level === 'blocked' ? 'Blocked' : 'Clear'}
                </strong>
              </div>
              <div className="ccm-activation-stat">
                <span>Pacing</span>
                <strong>{campaign.send_interval_seconds}s spacing</strong>
              </div>
              <div className="ccm-activation-stat">
                <span>First execution</span>
                <strong>{campaign.next_send_at ? new Date(campaign.next_send_at).toLocaleString() : 'On activation'}</strong>
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
                <div className="ccm-activation-blockers__title">Blockers</div>
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

        {step === 'complete' && (
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
            {step === 'complete' && (
              <div className="ccm-activation-success">
                <Icon name="check" size={20} />
                Campaign activated successfully
              </div>
            )}
          </div>
        )}

        {step === 'failed' && error && (
          <div className="ccm-activation-error">
            <Icon name="alert" size={16} />
            <div>
              <strong>Activation failed</strong>
              <p>{error}</p>
            </div>
          </div>
        )}

        <div className="ccm-glass-modal__footer">
          {step === 'review' && (
            <>
              <button type="button" className="ccc-btn" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="ccc-btn is-primary"
                disabled={!canConfirm}
                onClick={() => void runActivation()}
              >
                Confirm Activation
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
                Back to Review
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