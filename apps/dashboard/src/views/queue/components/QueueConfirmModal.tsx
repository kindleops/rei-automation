import { useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { BulkActionPreview } from '../queue-ui-helpers'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const ACTION_LABELS: Record<string, string> = {
  'retry-all-failed': 'Retry All Failed',
  'run-queue-now': 'Run Queue',
  'pause-queue': 'Pause Queue',
  'resume-queue': 'Resume Queue',
  'cancel-queued': 'Cancel Queued Jobs',
  'bulk-suppress': 'Bulk Suppress Contacts',
}

interface QueueConfirmModalProps {
  preview: BulkActionPreview | null
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function QueueConfirmModal({ preview, busy, onConfirm, onCancel }: QueueConfirmModalProps) {
  const [phrase, setPhrase] = useState('')
  if (!preview) return null

  const label = ACTION_LABELS[preview.action] ?? preview.action
  const phraseOk = !preview.requiresPhrase || phrase.trim().toUpperCase() === 'CONFIRM'

  return (
    <div className="occ-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="occ-confirm-title">
      <div className="occ-confirm-modal">
        <div className="occ-confirm-modal__atmo" aria-hidden="true" />
        <header className="occ-confirm-modal__head">
          <Icon name="shield" size={16} />
          <div>
            <h2 id="occ-confirm-title" className="occ-confirm-modal__title">Confirm {label}</h2>
            <p className="occ-confirm-modal__sub">Review eligibility before executing this operational action.</p>
          </div>
        </header>

        <div className="occ-confirm-modal__grid">
          <div className="occ-confirm-stat">
            <span className="occ-confirm-stat__val">{preview.affected.toLocaleString()}</span>
            <span className="occ-confirm-stat__lbl">Affected rows</span>
          </div>
          <div className="occ-confirm-stat is-green">
            <span className="occ-confirm-stat__val">{preview.eligible.toLocaleString()}</span>
            <span className="occ-confirm-stat__lbl">Eligible</span>
          </div>
          <div className="occ-confirm-stat is-amber">
            <span className="occ-confirm-stat__val">{preview.excluded.toLocaleString()}</span>
            <span className="occ-confirm-stat__lbl">Excluded</span>
          </div>
          {preview.retryable > 0 || preview.nonRetryable > 0 ? (
            <>
              <div className="occ-confirm-stat">
                <span className="occ-confirm-stat__val">{preview.retryable.toLocaleString()}</span>
                <span className="occ-confirm-stat__lbl">Retryable</span>
              </div>
              <div className="occ-confirm-stat is-red">
                <span className="occ-confirm-stat__val">{preview.nonRetryable.toLocaleString()}</span>
                <span className="occ-confirm-stat__lbl">Non-retryable</span>
              </div>
            </>
          ) : null}
        </div>

        {preview.markets.length > 0 && (
          <div className="occ-confirm-modal__scope">
            <span className="occ-confirm-modal__scope-label">Markets</span>
            <div className="occ-confirm-modal__chips">
              {preview.markets.slice(0, 6).map(m => <span key={m} className="occ-chip">{m}</span>)}
              {preview.markets.length > 6 && <span className="occ-chip is-muted">+{preview.markets.length - 6}</span>}
            </div>
          </div>
        )}

        {preview.senders.length > 0 && (
          <div className="occ-confirm-modal__scope">
            <span className="occ-confirm-modal__scope-label">Senders</span>
            <div className="occ-confirm-modal__chips">
              {preview.senders.slice(0, 5).map(s => <span key={s} className="occ-chip occ-mono">…{s.slice(-4)}</span>)}
              {preview.senders.length > 5 && <span className="occ-chip is-muted">+{preview.senders.length - 5}</span>}
            </div>
          </div>
        )}

        {preview.action === 'retry-all-failed' && (
          <p className="occ-confirm-modal__note is-warn">
            Blacklist 21610, opt-out, suppressed, and non-retryable provider failures are excluded automatically.
          </p>
        )}

        {preview.irreversible && (
          <p className="occ-confirm-modal__note is-danger">This action has irreversible compliance effects.</p>
        )}

        {preview.requiresPhrase && (
          <label className="occ-confirm-modal__phrase">
            <span>Type CONFIRM to proceed</span>
            <input
              type="text"
              className="occ-search"
              value={phrase}
              onChange={e => setPhrase(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}

        <footer className="occ-confirm-modal__actions">
          <button type="button" className="occ-action-btn is-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={cls('occ-action-btn', preview.irreversible ? 'is-danger' : 'is-primary', busy && 'is-busy')}
            disabled={busy || !phraseOk || preview.eligible === 0}
            onClick={onConfirm}
          >
            <Icon name={busy ? 'refresh-cw' : 'zap'} size={12} />
            {busy ? ' Executing…' : ` Execute ${label}`}
          </button>
        </footer>
      </div>
    </div>
  )
}