import { memo } from 'react'
import { LCButton, cx } from '../../../../shared/lc'
import { APPROVAL_REFUSAL_COPY, TIER_LABELS } from '../../contracts/contracts'
import type { RunView, StreamItem } from '../../model/run-model'
import { controlRun, selectRun, type RunSnapshot } from '../../runtime/agent-store'
import { fmtClock, fmtDur, fmtUsd } from '../format'
import { Shimmer } from '../primitives'
import { nowWallOf, useTick } from '../hooks'

/**
 * THE RUN STREAM (arch §9.2) — operator turns, streamed answers, decision
 * lines, tool rows, plan / approval / artifact cards, ui intents. Shared by
 * the dock and the workspace canvas, so "Expand" never loses state.
 */
export function RunStream({ snap, wide }: { snap: RunSnapshot; wide?: boolean }) {
  const run = snap.run as RunView
  const live = snap.active
  useTick(1000, run.items.some((i) => i.kind === 'approval' && i.state === 'requested') && snap.record.frozenT === null)
  return (
    <div className={cx('agx-stream', wide && 'is-wide')} role="log" aria-label="Agent run" aria-live="off">
      {run.items.map((it) => <Item key={it.key} it={it} snap={snap} arrival={it.event_id > snap.arrivalFloor} />)}
      {live && !run.current && run.state === 'running' ? <p className="agx-stream__wait"><span className="agx-dots" aria-hidden="true"><i /><i /><i /></span>Waiting for the next event</p> : null}
    </div>
  )
}

const Item = memo(function Item({ it, snap, arrival }: { it: StreamItem; snap: RunSnapshot; arrival: boolean }) {
  const runId = snap.record.runId
  const cls = cx('agx-it', `is-${it.kind}`, arrival && 'is-arrival')
  switch (it.kind) {
    case 'context':
      return <div className={cls}><span className="agx-it__ctx">Context attached · {it.label}</span></div>
    case 'operator':
      return <div className={cls}><p className="agx-bubble">{it.text}</p></div>
    case 'assistant':
      return <div className={cls}><p className="agx-answer">{it.text}{!it.done ? <span className="agx-caret" aria-hidden="true" /> : null}</p></div>
    case 'decision':
      return <div className={cls}><span className="agx-tl__why">Why</span><p>{it.summary}</p></div>
    case 'tool':
      return (
        <div className={cx(cls, `is-${it.state}`)}>
          <span className={cx('agx-tool__dot', `is-${it.state}`)} aria-hidden="true" />
          <div className="agx-tool__main">
            <span className="agx-tool__label"><Shimmer active={it.state === 'running'}>{it.label}</Shimmer></span>
            <span className="agx-tool__meta">
              <span className="agx-tier" title={TIER_LABELS[it.tier]}>{it.tier} · {TIER_LABELS[it.tier]}</span>
              {it.state === 'running' ? <span>Running</span> : <span>{it.rows ?? 0} row{it.rows === 1 ? '' : 's'} · {fmtDur(it.duration_ms)}{it.cost_usd ? ` · ${fmtUsd(it.cost_usd)}` : ' · $0'}</span>}
            </span>
            {it.result ? <span className="agx-tool__result">{it.result}</span> : null}
          </div>
        </div>
      )
    case 'plan':
      return (
        <div className={cx(cls, `is-${it.state}`)}>
          <header className="agx-card__head"><b>Plan</b><span className="agx-muted">payload {it.hash}… · {it.steps.length} steps</span></header>
          <ol className="agx-plan">
            {it.steps.map((s, i) => <li key={i}><span>{s.label}</span><small><span className="agx-tier">{s.tier}</span>{s.estimate_usd !== null ? ` est. ${fmtUsd(s.estimate_usd)}` : ''}</small></li>)}
          </ol>
          {it.estimate ? <p className="agx-muted">Estimate {fmtUsd(it.estimate.low_usd)}–{fmtUsd(it.estimate.high_usd)} · {it.estimate.basis === 'worst_case' ? `worst case ${fmtUsd(it.estimate.worst_case_usd)} (no measured history)` : 'measured'} — an estimate, not a charge.</p> : null}
          {it.state === 'proposed' ? (
            <div className="agx-card__acts">
              <LCButton size="sm" variant="primary" onClick={() => controlRun(runId, 'approve_plan', { artifact_id: it.artifact_id })}>Approve plan</LCButton>
              <LCButton size="sm" variant="quiet" onClick={() => controlRun(runId, 'reject_plan', { artifact_id: it.artifact_id })}>Not now</LCButton>
            </div>
          ) : <p className={cx('agx-card__state', `is-${it.state}`)}>{it.state === 'approved' ? 'Approved — each consequential step still asks separately' : 'Declined'}</p>}
        </div>
      )
    case 'approval': {
      const a = it.approval
      // the server decides preconditions; the card shows its summary verbatim
      const blocked = Boolean(a.brake) || !a.identity_available
      const left = it.expires_ms ? Math.max(0, it.expires_ms - nowWallOf(snap)) : null
      return (
        <div className={cx(cls, `is-${it.state}`, blocked && 'is-braked')}>
          <header className="agx-card__head"><b>{a.title ?? a.tool}</b><span className="agx-tier is-t3">T3 · Needs your approval</span></header>
          {a.brake ? <p className="agx-brake">{a.brake}</p> : null}
          <ul className="agx-effects">{a.effects.map((e) => <li key={e.summary}>{e.summary}{!e.reversible && e.undo_note ? <small> · {e.undo_note}</small> : null}</li>)}</ul>
          <ul className="agx-pre">{a.precondition_summary.map((p) => <li key={p}>{p}</li>)}</ul>
          <p className="agx-muted">{a.target_scope_summary} · {a.provenance.label} · approves exactly this payload ({a.payload_hash_prefix}…) once{left !== null && it.state === 'requested' ? ` · expires in ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}` : ''}.</p>
          {!a.identity_available ? <p className="agx-identity">{APPROVAL_REFUSAL_COPY.IDENTITY_REQUIRED}</p> : null}
          {it.state === 'requested' ? (
            <div className="agx-card__acts">
              <LCButton size="sm" variant="primary" disabled={blocked} title={blocked ? 'Refused up-front: identity, a brake or a precondition fails' : undefined}>Approve 1</LCButton>
              <LCButton size="sm" variant="quiet" onClick={() => controlRun(runId, 'deny_approval', { approval_id: a.approval_id })}>Deny</LCButton>
            </div>
          ) : <p className={cx('agx-card__state', `is-${it.state}`)}>{it.state === 'denied' ? 'Denied — the agent sees “operator declined”' : it.state}</p>}
        </div>
      )
    }
    case 'artifact':
      return (
        <div className={cls}>
          <header className="agx-card__head"><b>{it.title}</b><span className="agx-muted">{it.artifact_kind} · v{it.version} · {it.status}</span></header>
          <p className="agx-muted">Draft artifact — sourced from the three reads above. Nothing is applied to a record.</p>
          <div className="agx-card__acts"><LCButton size="sm" variant="quiet" icon="maximize" onClick={() => selectRun(runId, { wsOpen: true })}>Open in workspace</LCButton></div>
        </div>
      )
    case 'intent':
      return <div className={cls}><span className="agx-it__ctx">{it.label} · {fmtClock(it.at)}</span></div>
    default:
      return null
  }
})
