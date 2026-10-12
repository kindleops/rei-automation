import { useState } from 'react'
import { LCButton, LCPopover, cx } from '../../shared/lc'
import { batchCounters, progressOf } from './model/research-model'
import { isActiveStatus, needsOperator, taskStatus, TASK_STATUS_LABEL } from './model/run-status'
import { selectRun, setUi, snapshotOf, useRuns, type RunSnapshot } from './runtime/agent-store'
import { fmtUsd } from './ui/format'
import { runningTurn, useAsk } from './ask/ask-store'
import { AgentOrb, ProgressBar, ProvenanceBadge, Shimmer } from './ui/primitives'
import './ui/agent.css'
import './ui/agent-s3.css'

/**
 * THE SHELL RESEARCH INDICATOR (DR §1H, arch §9.1 #3) — a compact chip in the
 * Command Deck beside Live activity. Runs survive navigation and reload, so
 * this is how the operator keeps exploring while research continues. It
 * names live vs simulated work separately and never sums them.
 */
export default function AgentIndicator() {
  const runs = useRuns()
  const asking = Boolean(runningTurn(useAsk()))
  const [open, setOpen] = useState(false)
  const snaps = runs.map((r) => snapshotOf(r.runId)).filter((s): s is RunSnapshot => Boolean(s))
  const active = snaps.filter((s) => s.research && isActiveStatus(taskStatus(s).status))
  const waiting = snaps.filter((s) => needsOperator(taskStatus(s).status))
  const liveActive = active.filter((s) => s.mode === 'live')
  const simActive = active.filter((s) => s.mode === 'fixture')
  let done = 0; let planned = 0; let gold = 0
  for (const s of active) { const p = progressOf(s.research!); done += p.done; planned += p.planned; gold += batchCounters(s.research!).discoveries }
  const usd = simActive.reduce((n, s) => n + s.research!.accrued_usd, 0)
  const running = asking || active.some((s) => s.research!.running_count > 0)
  const text = asking && !active.length ? 'Agent · researching' : active.length
    ? `Research · ${active.length} job${active.length === 1 ? '' : 's'} · ${done}/${planned}${simActive.length && !liveActive.length ? ` · ${fmtUsd(usd)}` : ''}`
    : waiting.length ? `Agent · ${waiting.length} waiting on you` : 'Agent'
  const tag = liveActive.length && simActive.length ? 'mixed' : liveActive.length ? 'live' : simActive.length ? 'sim' : null
  return (
    <LCPopover open={open} onOpenChange={setOpen} side="bottom" align="end" width={440} label="Agent runs"
      trigger={
        <button type="button" className={cx('agx-ind', running && 'is-running', waiting.length > 0 && 'is-waiting')} aria-label={`${text}${tag === 'sim' ? ' (simulated)' : tag === 'live' ? ' (live, read-only)' : ''}`}>
          <AgentOrb live={running} size={16} />
          <span className="agx-ind__t">{text}</span>
          <span className="agx-ind__s" aria-hidden="true">{active.length ? `${done}/${planned}` : waiting.length ? `${waiting.length} waiting` : 'Agent'}</span>
          {gold ? <span className="agx-ind__gold" title="High-priority discoveries">{gold}</span> : null}
          {tag === 'live' || tag === 'mixed' ? <span className="agx-ind__live">LIVE</span> : null}
          {tag === 'sim' || tag === 'mixed' ? <span className="agx-ind__sim">SIM</span> : null}
        </button>
      }>
      <div className="agx agx-indpanel">
        <header><b>Agent runs</b><span className="agx-muted">{active.length} active · {waiting.length} waiting</span></header>
        {snaps.length ? snaps.slice(0, 6).map((s) => {
          const r = s.research
          const p = r ? progressOf(r) : null
          const st = taskStatus(s)
          return (
            <button key={s.record.runId} type="button" className="agx-indpanel__row" onClick={() => { selectRun(s.record.runId, { wsOpen: true }); setOpen(false) }}>
              <span className="agx-indpanel__t"><b>{s.title}</b><ProvenanceBadge mode={s.mode} compact /><small>{TASK_STATUS_LABEL[st.status]}{st.detail && !isActiveStatus(st.status) ? ` · ${st.detail}` : ''}</small></span>
              {p && p.planned ? <ProgressBar fraction={p.fraction} label="Progress" /> : null}
              {r && st.status === 'running' && r.current ? <span className="agx-indpanel__now"><Shimmer active>{r.current.label}</Shimmer></span> : null}
            </button>
          )
        }) : <p className="agx-muted">No runs yet.</p>}
        <footer>
          <LCButton size="sm" variant="secondary" onClick={() => { setUi({ wsOpen: true }); setOpen(false) }}>Open workspace</LCButton>
          <LCButton size="sm" variant="quiet" onClick={() => { setUi({ dock: 'open', wsOpen: false }); setOpen(false) }}>Open dock</LCButton>
        </footer>
      </div>
    </LCPopover>
  )
}
