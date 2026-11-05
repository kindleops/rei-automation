import { useEffect, useMemo } from 'react'
import { runFailureOf } from '../../agent/ask/ask-model'
import { useAsk } from '../../agent/ask/ask-store'
import { useRuns } from '../../agent/runtime/agent-store'
import { useRail } from '../../desktop/rail/rail-store'
import { derivePresence, type Presence } from '../model/presence'
import { pendingCount, refreshApprovals, useIc } from '../store/ic-store'

const ACTIVE_LIVE = new Set(['starting', 'connecting', 'streaming', 'reconnecting'])
const APPROVALS_EVERY_MS = 60_000

/** The shell's intelligence presence, from real telemetry, real runs and the approvals list. */
export function usePresence(): Presence {
  const rail = useRail()
  const a = useAsk()
  const runs = useRuns()
  const ic = useIc()
  useEffect(() => startApprovalsPoll(), [])
  usable = !(ic.approvals.phase === 'failed' && ic.approvals.failure?.state === 'not_enabled')
  return useMemo(() => {
    const asking = a.threads.reduce((n, t) => n + t.turns.filter((u) => u.phase === 'running' || u.phase === 'sending').length, 0)
    const scans = runs.filter((r) => r.mode === 'live' && r.live && ACTIVE_LIVE.has(r.live.status)).length
    const last = a.threads.flatMap((t) => t.turns).filter((u) => u.run && u.phase === 'done').sort((x, y) => y.sentAt - x.sentAt)[0]
    const f = last?.run ? runFailureOf(last.run) : null
    return derivePresence({
      now: Date.now(),
      telemetry: rail.telemetry,
      telemetryError: rail.error,
      activeRuns: asking + scans,
      pendingApprovals: pendingCount(ic),
      lastRunProblem: f && (f.kind === 'provider' || f.kind === 'configuration') ? `Last run: ${f.title}` : null,
    })
  }, [rail.telemetry, rail.error, a.threads, runs, ic])
}

// a 404 actions plane is not polled again every minute (it is re-read when Approvals opens)
let usable = true
let refs = 0
let timer = 0
/** One shared approvals poll for every presence reader (ref-counted). */
function startApprovalsPoll(): () => void {
  refs += 1
  if (refs === 1) {
    void refreshApprovals()
    timer = window.setInterval(() => { if (document.visibilityState === 'visible' && usable) void refreshApprovals() }, APPROVALS_EVERY_MS)
  }
  return () => { refs -= 1; if (refs === 0) window.clearInterval(timer) }
}
