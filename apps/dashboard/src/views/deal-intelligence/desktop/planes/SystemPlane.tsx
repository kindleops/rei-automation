import { LCButton, LCRail, LCStatus } from '../../../../shared/lc'
import { ago, dateTime, humanize, until } from '../di-format'
import type { DiLinks } from '../di-links'
import { STAGE_ORDER, STAGE_SHORT } from '../di-model'
import type { DiDecision } from '../di-types'
import { Plane } from '../di-ui'

const LANE_TONE: Record<string, 'exec' | 'ok' | 'attn' | 'crit' | 'neutral'> = {
  system: 'exec', seller: 'neutral', operator: 'attn', blocked: 'crit', external: 'exec', dormant: 'neutral', complete: 'ok', closed_out: 'neutral',
}

/**
 * SYSTEM HANDLING — who has the move (the Pipeline's own lane), what the
 * negotiation will do next, the latest seller-automation run and where the
 * deal sits in S1–S10. Rendered, never decided here.
 */
export function SystemPlane({ d, links, now, compact }: { d: DiDecision; links: DiLinks | null; now: number; compact?: boolean }) {
  const a = d.automation
  const lane = a?.lane ?? null
  const neg = a?.negotiation ?? null
  const exec = a?.execution ?? null
  const th = a?.thread ?? null
  const stage = d.pipeline?.stage ?? null
  const idx = stage ? STAGE_ORDER.indexOf(stage) : -1
  if (!a && !d.pipeline) {
    return (
      <Plane id="system" eyebrow="System handling" title="No deal in the pipeline">
        <p className="dr-none">This property has no acquisition opportunity, so no seller workflow is running for it.</p>
      </Plane>
    )
  }
  const due = neg?.nextActionDueAt ?? th?.nextActionAt ?? null
  return (
    <Plane
      id="system"
      eyebrow="System handling"
      title={lane ? lane.label : neg?.nextMoveLabel ?? 'No lane recorded'}
      under={lane ? (LANE_TONE[lane.key] === 'crit' ? 'crit' : LANE_TONE[lane.key] === 'attn' ? 'attn' : 'exec') : 'exec'}
      aside={lane ? <LCStatus label={humanize(lane.key) ?? lane.key} tone={LANE_TONE[lane.key] ?? 'neutral'} quiet={lane.key === 'seller' || lane.key === 'system'} /> : null}
    >
      {lane?.detail ? <p className="dr-system__detail">{lane.detail}{lane.since ? <span> · since {ago(lane.since, now)}</span> : null}</p> : null}
      <dl className="dr-kv">
        {neg?.nextMoveLabel ? <div><dt>Negotiation next</dt><dd>{neg.nextMoveLabel}{due ? <em> · {until(due, now)}</em> : null}</dd></div> : null}
        {neg?.lastAction ? <div><dt>Last action</dt><dd>{neg.lastAction}</dd></div> : null}
        {exec ? <div><dt>Latest automation run</dt><dd>{humanize(exec.status) ?? '—'}{exec.reasonLabel ? ` — ${exec.reasonLabel}` : ''}<em> · {[humanize(exec.stage), humanize(exec.mode), exec.at ? ago(exec.at, now) : null].filter(Boolean).join(' · ')}</em></dd></div> : null}
        {neg?.humanReviewReason ? <div><dt>Review reason</dt><dd>{neg.humanReviewReason}</dd></div> : null}
        {th && (th.pendingQueue || th.failedQueue || th.blockedQueue) ? <div><dt>Queue</dt><dd>{th.pendingQueue} pending · {th.failedQueue} failed · {th.blockedQueue} blocked</dd></div> : null}
        {th?.nextScheduledFor ? <div><dt>Next scheduled</dt><dd>{dateTime(th.nextScheduledFor)}</dd></div> : null}
        {neg?.contractReadiness ? <div><dt>Contract readiness</dt><dd>{neg.contractReadiness}{neg.unresolvedContractFields.length ? <em> · {neg.unresolvedContractFields.length} facts open</em> : null}</dd></div> : null}
        {a?.stall ? <div><dt>Stall</dt><dd className="is-attn">{a.stall.label}</dd></div> : null}
      </dl>
      {idx >= 0 && !compact ? (
        <LCRail
          label="Acquisition stage"
          compact
          steps={STAGE_ORDER.map((s, i) => ({ id: s, label: `S${i + 1}`, sub: i === idx ? STAGE_SHORT[s] : undefined, state: i < idx ? 'done' : i === idx ? 'active' : 'idle' }))}
          className="dr-stagerail"
        />
      ) : null}
      <div className="dr-system__actions">
        {links?.pipeline ? <LCButton size="sm" variant="quiet" icon="layers" onClick={links.pipeline}>Open in Pipeline</LCButton> : null}
        {links ? <LCButton size="sm" variant="quiet" icon="zap" onClick={links.workflow}>Open Workflow</LCButton> : null}
      </div>
    </Plane>
  )
}
