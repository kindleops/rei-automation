import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import {
  commitBuyerOutreach,
  describeBlockedReason,
  describeOutreachStatus,
  loadBuyerOutreachTargets,
  preflightBuyerOutreach,
  type BuyerOutreachSelection,
  type BuyerOutreachTarget,
  type BuyerOutreachVerdict,
} from '../buyer-outreach-client'

/**
 * THE OUTREACH SHEET (§7, §8, §9).
 *
 * Three states, and the operator is never shown a Send button whose outcome the
 * system cannot back:
 *
 *   PREFLIGHT  — the server's real eligibility verdict for this exact
 *                selection. Blocked buyers are listed WITH REASONS rather than
 *                disappearing from a count.
 *   SENDING    — the commit is in flight.
 *   RESULT     — the state read back from `buyer_outreach_targets`, not an
 *                optimistic echo of what was requested. If the queue blocked a
 *                row after submission, this is where the operator sees it.
 *
 * Send is disabled when nothing is eligible. That is not a UI nicety: with
 * buyer contact enrichment at `not_started` across the whole buyer universe,
 * "0 eligible" is currently the truthful and expected verdict, and a button
 * that appeared to work would be reporting outreach that cannot happen.
 */

interface Props {
  propertyId: string
  address: string
  selection: BuyerOutreachSelection[]
  onClose: () => void
  onCommitted?: () => void
}

type Phase = 'preflight' | 'sending' | 'result'

export function BuyerOutreachSheet({ propertyId, address, selection, onClose, onCommitted }: Props) {
  const [phase, setPhase] = useState<Phase>('preflight')
  const [verdict, setVerdict] = useState<BuyerOutreachVerdict | null>(null)
  const [targets, setTargets] = useState<BuyerOutreachTarget[] | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const runPreflight = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setVerdict(await preflightBuyerOutreach(propertyId, selection))
    } catch (e) {
      // A failed preflight is a failure. It must not read as "nothing blocked".
      setError(e instanceof Error ? e.message : 'Preflight failed')
      setVerdict(null)
    } finally {
      setLoading(false)
    }
  }, [propertyId, selection])

  useEffect(() => { void runPreflight() }, [runPreflight])

  const send = async () => {
    setPhase('sending')
    setError(null)
    try {
      const committed = await commitBuyerOutreach(propertyId, selection, message.trim())
      setVerdict(committed)
      // §9 — what the system now holds, re-read rather than assumed.
      try {
        setTargets(await loadBuyerOutreachTargets(propertyId))
      } catch {
        setTargets(null)
      }
      setPhase('result')
      onCommitted?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Outreach failed')
      setPhase('preflight')
    }
  }

  const eligible = verdict?.eligible ?? 0
  const blocked = verdict?.blocked ?? []
  const sending = phase === 'sending'
  const canSend = phase === 'preflight' && !loading && eligible > 0 && message.trim().length > 0

  return (
    <div className="bmm-sheet-root" role="presentation">
      <button type="button" className="bmm-sheet__backdrop" aria-label="Close outreach" onClick={onClose} />
      <div className="bmm-sheet bmm-outreach" role="dialog" aria-label="Buyer outreach">
        <header className="bmm-sheet__head">
          <div>
            <strong>Buyer outreach</strong>
            <span className="bmm-sheet__sub">{selection.length} selected · {address}</span>
          </div>
          <button type="button" className="bmm-sheet__close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="bmm-sheet__body">
          {error ? (
            <div className="bmm__state is-error" role="alert">
              <Icon name="alert" size={16} />
              <strong>{phase === 'result' ? 'Outreach failed' : 'Preflight failed'}</strong>
              <p>{error}</p>
              <button type="button" className="bmm__retry" onClick={() => void runPreflight()}>Try again</button>
            </div>
          ) : null}

          {loading ? <p className="bmm__muted">Checking eligibility…</p> : null}

          {!loading && verdict && phase !== 'result' ? (
            <section className="bmm-outreach__verdict">
              <h4>Eligibility</h4>
              <p className="bmm-outreach__counts">
                <strong>{verdict.selected}</strong> selected ·{' '}
                <strong className={eligible > 0 ? 'is-ok' : 'is-zero'}>{eligible}</strong> can be contacted ·{' '}
                <strong>{blocked.length}</strong> blocked
              </p>
              {eligible === 0 ? (
                <p className="bmm__muted">
                  Nothing can be sent for this selection. Every blocked reason is listed below — no message will
                  be queued.
                </p>
              ) : null}
              {blocked.length > 0 ? (
                <ul className="bmm-outreach__blocked">
                  {blocked.map((b) => (
                    <li key={`${b.buyer_key}:${b.blocked_reason}`}>
                      <span>{b.buyer_name || b.buyer_key}</span>
                      <em>{describeBlockedReason(b.blocked_reason)}</em>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {!loading && phase !== 'result' ? (
            <section>
              <h4>Message</h4>
              <textarea
                className="bmm-outreach__message"
                value={message}
                rows={4}
                placeholder="What are you sending these buyers?"
                aria-label="Outreach message"
                onChange={(e) => setMessage(e.target.value)}
              />
              <p className="bmm__muted">
                Sends through the canonical queue — contact window, suppression, sender eligibility and daily caps
                all still apply after you submit.
              </p>
            </section>
          ) : null}

          {phase === 'result' ? (
            <section>
              <h4>What the system recorded</h4>
              <p className="bmm-outreach__counts">
                <strong>{verdict?.eligible ?? 0}</strong> queued ·{' '}
                <strong>{verdict?.blocked.length ?? 0}</strong> blocked
              </p>
              {targets === null ? (
                <p className="bmm__muted">
                  Queued, but the outreach state could not be re-read just now — reopen this property to confirm.
                </p>
              ) : (
                <ul className="bmm-outreach__targets">
                  {targets.slice(0, 25).map((t) => (
                    <li key={t.id}>
                      <span>{t.buyer_name || t.buyer_key}</span>
                      <em>{describeOutreachStatus(t)}</em>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>

        <footer className="bmm-sheet__actions">
          {phase === 'result' ? (
            <button type="button" className="bmm-act is-select" onClick={onClose}>Done</button>
          ) : (
            <button
              type="button"
              className="bmm-act is-select"
              disabled={!canSend || sending}
              onClick={() => void send()}
            >
              {sending
                ? 'Queueing…'
                : eligible > 0
                  ? `Queue outreach to ${eligible}`
                  : 'Nothing eligible to send'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
