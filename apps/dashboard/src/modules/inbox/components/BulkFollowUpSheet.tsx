import { useCallback, useEffect, useState } from 'react'
import { bulkFollowUp, type BulkFollowUpPlan, type FollowUpRecipient } from '../../../lib/api/backendClient'

type Props = {
  threadKeys: string[]
  onClose: () => void
  onScheduled: (scheduledThreadKeys: string[]) => void
}

// Human wording for the canonical rejection reasons. An operator should never
// have to read `missing_placeholder_values: agent_name`.
const REASON_LABEL: Record<string, string> = {
  blank_greeting_detected: 'Name missing — would send a blank greeting',
  unresolved_tokens_detected: 'Unresolved template fields',
  schedule_unresolvable: 'No eligible send window',
  no_fus2_templates_available: 'No approved templates available',
}

const describeReason = (r: FollowUpRecipient): string => {
  const raw = r.reason ?? ''
  if (REASON_LABEL[raw]) return REASON_LABEL[raw]
  if (raw.startsWith('seller_language_not_english')) {
    const lang = raw.split(':')[1]?.trim() ?? ''
    return lang ? `Seller prefers ${lang}` : 'Seller language not English'
  }
  if (raw.startsWith('missing_placeholder_values')) {
    const fields = raw.split(':')[1]?.trim() ?? ''
    const pretty = fields.split(',').map((f) => f.trim().replace(/_/g, ' ')).filter(Boolean).join(', ')
    // agent_name is only ever unresolved when the seller has no assigned agent.
    if (fields.includes('agent_name')) return 'No agent assigned to this seller'
    return `Missing ${pretty || 'required details'}`
  }
  return raw ? raw.replace(/_/g, ' ') : 'Needs review'
}

const PREVIEW_COUNT = 3

export function BulkFollowUpSheet({ threadKeys, onClose, onScheduled }: Props) {
  const [plan, setPlan] = useState<BulkFollowUpPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [showExcluded, setShowExcluded] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const res = await bulkFollowUp({ mode: 'preview', thread_keys: threadKeys })
    // BackendResult is a discriminated union: `data` only exists on the success
    // arm, so it has to be narrowed on `ok` before being read.
    if (!res.ok) {
      setError(res.message || res.error || 'Could not build follow-up preview')
      setPlan(null)
    } else if (!res.data?.ok) {
      setError(res.data?.error ?? 'Could not build follow-up preview')
      setPlan(null)
    } else {
      setPlan(res.data)
    }
    setLoading(false)
  }, [threadKeys])

  useEffect(() => { void load() }, [load])

  const schedule = async () => {
    if (!plan || plan.eligible_count === 0) return
    setBusy(true)
    const res = await bulkFollowUp({ mode: 'schedule', thread_keys: threadKeys })
    setBusy(false)
    // Scheduled means scheduled. A failure is surfaced, never swallowed into an
    // optimistic success.
    if (!res.ok) {
      setError(res.message || res.error || 'Scheduling was refused')
      return
    }
    if (!res.data?.ok) {
      setError(res.data?.error ?? 'Scheduling was refused')
      return
    }
    const done = (res.data.results ?? [])
      .filter((r): r is { thread_key: string; ok: boolean } => Boolean((r as { ok?: boolean })?.ok))
      .map((r) => r.thread_key)
    onScheduled(done)
  }

  const eligible = plan?.recipients.filter((r) => r.eligible) ?? []
  const excluded = plan?.recipients.filter((r) => !r.eligible) ?? []
  const shown = showAll ? eligible : eligible.slice(0, PREVIEW_COUNT)

  return (
    <div className="nx-bulk-sheet-backdrop" onClick={onClose}>
      <div className="nx-bulk-sheet nx-followup-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="nx-bulk-sheet__title">{plan?.label ?? 'Conversation Restart'}</div>

        {loading && <div className="nx-followup-sheet__status">Checking {threadKeys.length} leads…</div>}
        {error && <div className="nx-followup-sheet__error">{error}</div>}

        {plan && !loading && (
          <>
            <div className="nx-followup-counts">
              <span><strong>{plan.selected_count}</strong> selected</span>
              <span className="is-ok"><strong>{plan.eligible_count}</strong> eligible</span>
              {plan.needs_review_count > 0 && (
                <button type="button" className="is-warn" onClick={() => setShowExcluded((v) => !v)}>
                  <strong>{plan.needs_review_count}</strong> need review
                </button>
              )}
            </div>

            <div className="nx-followup-timing">
              <span className="nx-followup-timing__label">Timing</span>
              <span className="nx-followup-timing__value">Best local time · per seller</span>
            </div>

            {showExcluded && excluded.length > 0 && (
              <ul className="nx-followup-excluded">
                {excluded.map((r) => (
                  <li key={r.thread_key ?? Math.random()}>
                    <span className="nx-followup-excluded__who">{r.seller_name || r.thread_key}</span>
                    <span className="nx-followup-excluded__why">{describeReason(r)}</span>
                  </li>
                ))}
              </ul>
            )}

            <ul className="nx-followup-previews">
              {shown.map((r) => (
                <li key={r.thread_key ?? Math.random()} className="nx-followup-preview">
                  <div className="nx-followup-preview__who">
                    <span>{r.seller_name}</span>
                    {r.assigned_agent_name && (
                      <span className="nx-followup-preview__agent">{r.assigned_agent_name.split(' ')[0]}</span>
                    )}
                  </div>
                  <div className="nx-followup-preview__body">{r.message_body}</div>
                  <div className="nx-followup-preview__when">
                    {r.schedule?.effective_local_label} · {r.schedule?.local_send_date} seller local
                  </div>
                </li>
              ))}
            </ul>

            {eligible.length > PREVIEW_COUNT && (
              <button type="button" className="nx-followup-more" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `Show all ${eligible.length}`}
              </button>
            )}
          </>
        )}

        <div className="nx-bulk-sheet__actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="is-primary"
            disabled={busy || loading || !plan || plan.eligible_count === 0}
            onClick={() => void schedule()}
          >
            {busy ? 'Scheduling…' : `Schedule ${plan?.eligible_count ?? 0}`}
          </button>
        </div>
      </div>
    </div>
  )
}

export default BulkFollowUpSheet
