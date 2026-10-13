import { useCallback, useEffect, useState } from 'react'
import { LCButton } from '../../../shared/lc'
import { decideApproval, DECIDE_CODE_LABEL, getApproval, listApprovals, type CapabilityApproval } from './approvals-transport'
import './approvals.css'

const CAPABILITY_LABEL: Record<string, string> = {
  'inbox.prepare_reply': 'Template reply',
  'campaigns.prepare_launch_approval': 'Campaign launch',
  'pipeline.propose_stage_change': 'Stage change',
}

type Load = { status: 'loading' } | { status: 'ready'; items: CapabilityApproval[] } | { status: 'unavailable'; reason: string }

/**
 * Pending capability approvals (Intelligence 2.0 B). The agent only PREPARES
 * these; a human decides here. Approving sends the exact payload hash that was
 * shown — the server refuses if anything changed — and the result shown is the
 * server's recorded outcome (e.g. the real send-now / provider result).
 */
export function ApprovalsList() {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [open, setOpen] = useState<CapabilityApproval | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Record<string, string>>({})

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const r = await listApprovals('pending', signal)
    if (signal?.aborted) return
    setLoad(r.ok ? { status: 'ready', items: r.data } : { status: 'unavailable', reason: r.status === 404 ? 'Approvals are not enabled on this server.' : r.message })
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    void refresh(ac.signal)
    return () => ac.abort()
  }, [refresh])

  const expand = async (a: CapabilityApproval) => {
    if (open?.approval_id === a.approval_id) { setOpen(null); return }
    const r = await getApproval(a.approval_id)
    setOpen(r.ok ? r.data : a)
  }

  const act = async (a: CapabilityApproval, decision: 'approve' | 'deny') => {
    setBusy(a.approval_id)
    const r = await decideApproval(a, decision)
    setBusy(null)
    const msg = !r.ok ? r.message
      : r.data.code ? (DECIDE_CODE_LABEL[r.data.code] ?? r.data.code)
      : decision === 'deny' ? 'Denied.'
      : r.data.ok ? 'Approved and executed.' : `Approved; the service refused: ${String(r.data.execution_result?.code ?? r.data.state ?? 'unknown')}`
    setNote((n) => ({ ...n, [a.approval_id]: msg }))
    setOpen(null)
    void refresh()
  }

  if (load.status === 'loading') return <section className="agx-apr" aria-label="Approvals"><h5>Approvals</h5><p className="agx-muted">Loading…</p></section>
  if (load.status === 'unavailable') return <section className="agx-apr" aria-label="Approvals"><h5>Approvals</h5><p className="agx-muted">{load.reason}</p></section>
  return (
    <section className="agx-apr" aria-label="Approvals">
      <h5>Approvals <small>{load.items.length ? `${load.items.length} pending` : 'none pending'}</small></h5>
      {Object.entries(note).map(([id, m]) => <p key={id} className="agx-apr__note" role="status">{m}</p>)}
      <ul className="agx-apr__list">
        {load.items.map((a) => (
          <li key={a.approval_id} className="agx-apr__item">
            <button type="button" className="agx-apr__head" onClick={() => void expand(a)} aria-expanded={open?.approval_id === a.approval_id}>
              <span className="agx-apr__k">{CAPABILITY_LABEL[a.capability_id] ?? a.capability_id}{a.provenance === 'untrusted_content' ? ' · from message content' : ''}</span>
              <b>{a.summary[0] ?? a.capability_id}</b>
              <small>Expires {new Date(a.expires_at).toLocaleTimeString()}</small>
            </button>
            {open?.approval_id === a.approval_id ? (
              <div className="agx-apr__body">
                <ul>{open.summary.slice(1).map((s, i) => <li key={i}>{s}</li>)}</ul>
                {open.preview?.message_text ? (
                  <blockquote className="agx-apr__msg">{open.preview.message_text}<small>{open.preview.matches_approved === false ? 'Differs from what was prepared — approving will be refused.' : `To ${open.preview.recipient_mask ?? 'recipient'} from ${open.preview.sender_mask ?? 'sender'}`}</small></blockquote>
                ) : open.preview?.unavailable ? <p className="agx-muted">Preview unavailable ({open.preview.unavailable}).</p> : null}
                <p className="agx-muted">State check {open.snapshot_hash_prefix} · payload {open.payload_hash.slice(0, 12)}</p>
                <div className="agx-apr__actions">
                  <LCButton size="sm" variant="primary" disabled={busy === a.approval_id} onClick={() => void act(open, 'approve')}>Approve</LCButton>
                  <LCButton size="sm" variant="secondary" disabled={busy === a.approval_id} onClick={() => void act(open, 'deny')}>Deny</LCButton>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
