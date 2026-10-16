import { useState } from 'react'
import { cx } from '../../../shared/lc'
import type { CapabilityApproval } from '../api/ic-client'
import { approvalDiff, CAPABILITY_LABEL } from '../model/act-model'
import { decide, inspect, type ActEntry } from '../store/ic-store'
import { IcGlyph, PlaneNotice, Spec, clock } from './primitives'

/** Diff-style proposed change: the exact before → after the server recorded, then Approve / Reject. */
export function DiffCard({ approval, actId = null, note = null, busy = false, compact = false }: { approval: CapabilityApproval; actId?: string | null; note?: string | null; busy?: boolean; compact?: boolean }) {
  const [deciding, setDeciding] = useState<'approve' | 'deny' | null>(null)
  const [local, setLocal] = useState<string | null>(null)
  const rows = approvalDiff(approval)
  const pending = approval.state === 'pending'
  const go = async (d: 'approve' | 'deny') => { setDeciding(d); const m = await decide(approval, d, actId); setLocal(m); setDeciding(null) }
  const expired = Date.parse(approval.expires_at) < Date.now()
  return (
    <section className={cx('ic-diff', `is-${approval.state}`, compact && 'is-compact')} aria-label="Proposed change">
      <header className="ic-diff__h">
        <span className="ic-diff__ic"><IcGlyph name="diff" size={12} /></span>
        <b>{CAPABILITY_LABEL[approval.capability_id] ?? approval.capability_id}</b>
        <span className={cx('ic-state', `is-${approval.state}`)}>{approval.state.replace(/_/g, ' ')}</span>
        <Spec className="ic-diff__meta" items={[approval.provenance === 'untrusted_content' ? 'from message content' : approval.provenance, `expires ${clock(approval.expires_at)}`, <code key="h">#{approval.payload_hash.slice(0, 10)}</code>]} />
      </header>
      {approval.summary[0] ? <p className="ic-diff__sum">{approval.summary[0]}</p> : null}
      <div className="ic-diff__rows" role="table" aria-label="Before and after">
        {rows.map((r, i) => (
          <div key={`${r.field}:${i}`} className={cx('ic-diff__row', `is-${r.kind}`)} role="row">
            <span className="ic-diff__f" role="cell">{r.field}</span>
            {r.kind === 'change' ? (
              <>
                <span className="ic-diff__b" role="cell"><i aria-hidden="true">−</i>{r.before ?? '∅'}</span>
                <span className="ic-diff__a" role="cell"><i aria-hidden="true">+</i>{r.after ?? '∅'}</span>
              </>
            ) : <span className={cx('ic-diff__a', r.kind === 'context' && 'is-ctx')} role="cell">{r.kind === 'add' ? <i aria-hidden="true">+</i> : null}{r.after}</span>}
          </div>
        ))}
      </div>
      {!compact && approval.summary.length > 1 ? <ul className="ic-diff__notes">{approval.summary.slice(1).map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
      {approval.preview?.matches_approved === false ? <p className="ic-diff__warn">The text rendered now differs from what was prepared — approving will be refused.</p> : null}
      {approval.preview?.unavailable ? <p className="ic-diff__warn">Preview unavailable ({approval.preview.unavailable}).</p> : null}
      {approval.execution_result ? <pre className="ic-diff__result">{JSON.stringify(approval.execution_result, null, 2)}</pre> : null}
      {local || note ? <p className="ic-diff__note" role="status">{local ?? note}</p> : null}
      <footer className="ic-diff__f2">
        <Spec items={[`state check ${approval.snapshot_hash_prefix}`, `v${approval.capability_version}`]} />
        {pending ? (
          <span className="ic-diff__acts">
            <button type="button" className="ic-btn is-ghost" disabled={busy || deciding !== null} onClick={() => void go('deny')}>{deciding === 'deny' ? 'Rejecting…' : 'Reject'}</button>
            <button type="button" className="ic-btn is-accept" disabled={busy || deciding !== null || expired} onClick={() => void go('approve')}>{deciding === 'approve' ? 'Approving…' : expired ? 'Expired' : 'Approve'}</button>
          </span>
        ) : null}
      </footer>
    </section>
  )
}

const PHASE_COPY: Record<ActEntry['phase'], string> = { invoking: 'Preparing on the server', pending: 'Awaiting your approval', deciding: 'Deciding', executed: 'Executed', denied: 'Rejected', refused: 'Refused', failed: 'Not prepared', done: 'Done' }

export function ActEntryView({ entry }: { entry: ActEntry }) {
  return (
    <article className="ic-turn ic-act" aria-label="Act">
      <header className="ic-turn__q">
        <span className="ic-mode-tag is-act">Act</span>
        <p>{entry.title}</p>
        {entry.reason ? <span className="ic-turn__chips"><span className="ic-chip is-static">reason · {entry.reason}</span></span> : null}
      </header>
      <div className={cx('ic-turn__status', entry.phase === 'invoking' || entry.phase === 'deciding' ? 'is-running' : null, entry.phase === 'failed' || entry.phase === 'refused' ? 'is-bad' : null, entry.phase === 'executed' && 'is-done')} role="status">
        <span className="ic-turn__pulse" aria-hidden="true" />
        <b>{PHASE_COPY[entry.phase]}</b>
        <Spec items={[<code key="c">{entry.capability_id}</code>, entry.outcome?.status ?? null, entry.outcome?.approval_id ? <code key="a">{entry.outcome.approval_id}</code> : null]} />
        <span className="ic-turn__acts"><button type="button" className="ic-btn is-quiet" onClick={() => inspect({ kind: 'act', id: entry.id })}>Inspect</button></span>
      </div>
      {entry.failure ? <PlaneNotice failure={entry.failure} compact /> : null}
      {entry.approval ? <DiffCard approval={entry.approval} actId={entry.id} note={entry.note} busy={entry.phase === 'deciding'} /> : entry.note ? <p className="ic-turn__note">{entry.note}</p> : null}
      {entry.phase === 'done' && entry.outcome?.result ? <pre className="ic-diff__result">{JSON.stringify(entry.outcome.result, null, 2)}</pre> : null}
    </article>
  )
}
