import { memo, useState } from 'react'
import { pushRoutePath } from '../../../app/router'
import { LCButton, LCLink, LCSkeleton, cx } from '../../../shared/lc'
import type { CockpitRead } from './cockpit-api'
import { feederSkipWords } from './cockpit-model'
import type { Batch, CampaignIntel, WarSystem } from './war-room-api'
import { workflowPath } from './war-room-links'
import {
  GATE_LABEL, OWNER_LABEL, clock, dayClock, nf, plural, relative, systemPosture, zoneFamily,
  type CapLine, type Gate, type GateKey, type Pace, type WarInput,
} from './war-room-model'
import { facts } from './war-room-model'
import { Plane, SenderRail } from './WarPlanes'

const STATE_WORD: Record<Gate['state'], string> = { pass: 'Clear', hold: 'Holding some', wait: 'Waiting', warn: 'Watch', block: 'Blocked', idle: 'Not started', unknown: 'Unknown' }

export function BatchCard({ b, tz, now, onOpen }: { b: Batch; tz: string | null; now: number; onOpen?: () => void }) {
  const o = b.outcome
  const blocked = Object.entries(b.blocked_counts || {}).filter(([, n]) => Number(n) > 0).sort((a, z) => z[1] - a[1])
  return (
    <article className="cc3-batch">
      <header className="cc3-batch__head">
        <span className="cc3-batch__n">Batch {nf(b.n)}</span>
        <time className="lc-num">{dayClock(b.started_at, tz, now) ?? '—'}</time>
        {b.duration_ms !== null ? <span className="cc3-batch__dur lc-num">{(b.duration_ms / 1000).toFixed(1)}s</span> : null}
        {onOpen ? <LCLink icon="chevron-right" onClick={onOpen}>Inspect</LCLink> : null}
      </header>
      <dl className="cc3-batch__flow">
        <div><dt>Ready</dt><dd className="lc-num">{nf(b.ready)}</dd></div>
        <div><dt>Queued</dt><dd className="lc-num">{nf(b.created)}</dd></div>
        <div><dt>Left us</dt><dd className="lc-num">{nf(o.left_us)}</dd></div>
        <div data-tone="ok"><dt>Delivered</dt><dd className="lc-num">{nf(o.delivered)}</dd></div>
        <div data-tone={o.filtered ? 'attn' : undefined}><dt>Filtered</dt><dd className="lc-num">{nf(o.filtered)}</dd></div>
        <div data-tone={o.failed ? 'crit' : undefined}><dt>Not delivered</dt><dd className="lc-num">{nf(o.failed)}</dd></div>
        <div data-tone="flow"><dt>Replies</dt><dd className="lc-num">{nf(o.replied)}</dd></div>
      </dl>
      {blocked.length ? <p className="cc3-batch__held">Not placed: {blocked.slice(0, 3).map(([code, n]) => `${feederSkipWords(code)} (${nf(n)})`).join(' · ')}</p> : null}
    </article>
  )
}

export const ExecutionMode = memo(function ExecutionMode({
  input, gates, stopping, caps, pace, now, onGate, onSender, onBatch,
}: {
  input: WarInput
  gates: Gate[]
  stopping: GateKey | null
  caps: CapLine[]
  pace: Pace
  now: number
  onGate: (g: GateKey) => void
  onSender: (phone: string) => void
  onBatch: (b: Batch) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const core: CockpitRead | null = input.core ?? null
  const intel: CampaignIntel | null = input.intel ?? null
  const system: WarSystem | null = input.system ?? null
  const f = facts(input)
  const tz = f.tz
  const feeder = f.feeder
  const latest = intel?.batches?.list[0] ?? null
  const fleet = intel?.fleet ?? null
  const shown = fleet ? (showAll ? fleet.numbers : fleet.numbers.filter((s) => s.in_campaign_market || s.campaign.carrying)) : []
  const posture = systemPosture(system, Math.min(now, Date.parse(core?.at ?? '') || now))
  const zones = intel?.audience?.zones ? Object.entries(intel.audience.zones).filter(([z]) => z !== 'unknown').sort((a, b) => b[1] - a[1]) : []
  return (
    <div className="cc3-exec">
      <Plane title="Gates" meta={stopping ? `Stopped at ${GATE_LABEL[stopping].toLowerCase()}` : 'Nothing is stopping execution'} className="cc3-exec__gates" id="cc3-xg">
        <table className="cc3-table">
          <thead><tr><th>Gate</th><th>State</th><th>Now</th><th>Why</th><th>Owner</th></tr></thead>
          <tbody>
            {gates.map((g) => (
              <tr key={g.key} className={cx(stopping === g.key && 'is-stopping')} data-state={g.state} onClick={() => onGate(g.key)}>
                <th scope="row"><button type="button" className="cc3-table__open" onClick={(e) => { e.stopPropagation(); onGate(g.key) }}>{g.label}</button></th>
                <td><span className="cc3-chip" data-state={g.state}>{STATE_WORD[g.state]}</span></td>
                <td className="lc-num">{g.value}</td>
                <td className="cc3-table__why">{g.detail}</td>
                <td>{g.owner ? OWNER_LABEL[g.owner] : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Plane>

      <div className="cc3-exec__grid">
        <Plane title="Campaign feeder" meta="Rolling execution — the campaign owns its whole cohort" className="cc3-exec__feeder" id="cc3-xf">
          <dl className="cc3-facts is-wide">
            <div><dt>Buffer target</dt><dd className="lc-num">{nf(intel?.feeder.buffer_target ?? core?.feed?.buffer_target ?? 150)} rows kept ahead</dd></div>
            <div><dt>In the queue now</dt><dd className="lc-num">{f.queueLive === null ? '—' : nf(f.queueLive)}{f.due ? ` · ${nf(f.due)} due` : ''}{f.overdue ? ` · ${nf(f.overdue)} overdue` : ''}</dd></div>
            <div><dt>Refill size</dt><dd className="lc-num">up to {nf(intel?.feeder.chunk ?? core?.feed?.chunk ?? 100)} per pass</dd></div>
            <div><dt>Remaining cohort</dt><dd className="lc-num">{f.ready === null ? '—' : plural(f.ready, 'ready seller')}</dd></div>
            <div><dt>Next pass room</dt><dd className="lc-num">{core?.feed ? `${nf(core.feed.limit)} · ${core.feed.bound?.replace(/_/g, ' ')}` : '—'}</dd></div>
            <div><dt>Last refill</dt><dd>{feeder?.last_refill_at ? `${dayClock(feeder.last_refill_at, tz, now)} · ${relative(feeder.last_refill_at, now)}` : 'none yet'}</dd></div>
            <div><dt>Last pass</dt><dd>{feeder?.at ? `${relative(feeder.at, now)} · ${feeder.inserted ? `placed ${nf(feeder.inserted)}` : 'placed none'}` : 'never fed'}</dd></div>
            <div><dt>Last reason</dt><dd>{feeder?.reason ? feederSkipWords(feeder.reason) : '—'}</dd></div>
          </dl>
          {feeder && Object.keys(feeder.skipped_counts_by_reason || {}).length ? (
            <ul className="cc3-reasons is-plain">
              {Object.entries(feeder.skipped_counts_by_reason).sort((a, b) => b[1] - a[1]).map(([code, n]) => (
                <li key={code}><span className="cc3-reasons__label">{feederSkipWords(code)}</span><b className="lc-num">{nf(n)}</b></li>
              ))}
            </ul>
          ) : null}
          {intel?.batches ? <p className="cc3-foot">{plural(intel.batches.placed_passes, 'pass', 'passes')} placed rows · {intel.batches.empty_passes === null ? '—' : nf(intel.batches.empty_passes)} found nothing to place (every 5 min while live)</p> : null}
        </Plane>

        <Plane title="Current batch" meta={latest ? `${plural(intel?.batches?.placed_passes ?? 0, 'batch', 'batches')} so far` : null} action={<LCButton size="sm" variant="quiet" icon="layers" onClick={() => pushRoutePath(workflowPath(latest?.run_id))}>Open in Workflow Studio</LCButton>} className="cc3-exec__batch" id="cc3-xb">
          {latest ? <BatchCard b={latest} tz={tz} now={now} onOpen={() => onBatch(latest)} /> : intel ? <p className="cc3-muted">No feeder pass has placed rows for this campaign.</p> : <LCSkeleton shape="lines" count={4} />}
          <p className="cc3-foot">Workflow Studio observes campaign execution as the system workflow “Campaign Execution”; each feeder pass is a run.</p>
        </Plane>
      </div>

      <Plane
        title="Sender assignment"
        meta={fleet ? `${plural(fleet.numbers.filter((s) => s.eligible).length, 'eligible number')} fleet-wide · system limit ${nf(fleet.system_cap)} / sender / day${fleet.campaign_cap ? ` · campaign cap ${nf(fleet.campaign_cap)}` : ''}` : null}
        action={fleet ? <LCLink onClick={() => setShowAll((v) => !v)}>{showAll ? 'Campaign markets only' : `All ${nf(fleet.numbers.length)} numbers`}</LCLink> : null}
        className="cc3-exec__fleet"
        id="cc3-xs"
      >
        {intel?.routing ? (
          <ul className="cc3-routes">
            {intel.routing.map((r) => (
              <li key={r.market} data-blocked={r.ready > 0 && r.eligible === 0 ? '' : undefined}>
                <b>{r.market}</b>
                <span className="lc-num">{plural(r.targets, 'target')} · {nf(r.ready)} ready</span>
                <span className="lc-num">{r.eligible ? `${plural(r.eligible, 'eligible sender')} · ${nf(r.remaining_today)} room today` : `No eligible sender${Object.keys(r.by_state).length ? ` — ${Object.entries(r.by_state).map(([s, n]) => `${n} ${s.replace(/_/g, ' ')}`).join(', ')}` : ' — no local number'}`}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="cc3-foot">Routing: a first text goes from an eligible number in the seller’s own market, least-used today first. Blocked, cooling and paused numbers never win because their usage is zero.</p>
        <div className="cc3-senders is-grid">
          {!fleet ? <LCSkeleton shape="rows" count={4} /> : shown.map((s) => <SenderRail key={s.phone} s={s} onOpen={() => onSender(s.phone)} />)}
        </div>
      </Plane>

      <div className="cc3-exec__grid">
        <Plane title="Contact window & time" className="cc3-exec__time" id="cc3-xt">
          <dl className="cc3-facts is-wide">
            <div><dt>Campaign zone</dt><dd>{tz ? `${zoneFamily(tz)} · ${tz}` : 'Not set'}</dd></div>
            <div><dt>Window</dt><dd className="lc-num">{f.window?.window ?? '—'} {f.window?.source === 'operator' ? '(operator default)' : ''}</dd></div>
            <div><dt>Now</dt><dd>{f.window?.open === null || f.window?.open === undefined ? 'Unknown' : f.window.open ? `Open until ${clock(f.window.closes_at, f.window.timezone ?? tz)}` : `Closed · opens ${dayClock(f.window.next_open_at, f.window.timezone ?? tz, now)}`}</dd></div>
            <div><dt>Sellers’ zones</dt><dd>{zones.length ? zones.map(([z, n]) => `${zoneFamily(z)} ${nf(n)}`).join(' · ') : '—'}</dd></div>
            <div><dt>Scheduled start</dt><dd>{core?.lifecycle.scheduled_for ? dayClock(core.lifecycle.scheduled_for, tz, now) : '—'}</dd></div>
            <div><dt>Activated</dt><dd>{core?.lifecycle.activated_at ? dayClock(core.lifecycle.activated_at, tz, now) : '—'}</dd></div>
            <div><dt>Cadence</dt><dd className="lc-num">{core?.caps.send_interval_seconds ? `1 text / ${core.caps.send_interval_seconds}s inside the window` : 'Default spacing'}</dd></div>
            <div><dt>Multi-day</dt><dd className="lc-num">{pace.dayIndex ? `Day ${nf(pace.dayIndex)}` : '—'}{pace.daily ? ` · ${nf(pace.daily)}/day (${pace.basis})` : ''}{pace.days ? ` · ≈ ${pace.days} day${pace.days === 1 ? '' : 's'} to place the rest (estimate)` : pace.remaining === 0 ? ' · nothing left to place' : ''}</dd></div>
          </dl>
          <p className="cc3-foot">The campaign continues across days on its own; no reactivation is needed.</p>
        </Plane>

        <Plane title="Caps — named by what they bound" className="cc3-exec__caps" id="cc3-xc">
          <ul className="cc3-caps">
            {caps.map((c) => (
              <li key={c.key} data-limiting={c.limiting ? '' : undefined}>
                <span className="cc3-caps__label">{c.label}<em data-scope={c.scope}>{c.scope}</em></span>
                <b className="lc-num">{c.value}</b>
                <span className="cc3-caps__meaning">{c.meaning}</span>
              </li>
            ))}
          </ul>
        </Plane>
      </div>

      <Plane title="Runtime" meta={posture.ok ? 'Healthy' : posture.label} tone={posture.ok ? undefined : 'crit'} className="cc3-exec__runtime" id="cc3-xr">
        <dl className="cc3-facts is-wide">
          <div><dt>Queue processor</dt><dd>{system ? `${system.processor.mode ?? '—'} · execution ${system.processor.execution_mode ?? '—'} · heartbeat ${relative(system.processor.heartbeat_at, now) ?? 'none'}` : '—'}</dd></div>
          <div><dt>Last claim</dt><dd>{system?.processor.last_claimed_at ? `${dayClock(system.processor.last_claimed_at, tz, now)} · ${relative(system.processor.last_claimed_at, now)}` : '—'}</dd></div>
          <div><dt>Campaign feeder</dt><dd>{system ? `heartbeat ${relative(system.feeder.heartbeat_at, now) ?? 'none'} · every ${system.feeder.cadence_minutes} min` : '—'}</dd></div>
          <div><dt>Outbound SMS</dt><dd>{system?.processor.outbound_sms === null || system?.processor.outbound_sms === undefined ? '—' : system.processor.outbound_sms ? 'On' : 'Off'}{system?.processor.emergency_stop_at ? ' · EMERGENCY STOP' : ''}</dd></div>
          <div><dt>Operator blocklists</dt><dd className="lc-num">{system ? `${plural(system.blocked_sender_count, 'number')} · ${plural(system.blocked_template_count, 'template')}` : '—'}</dd></div>
          <div><dt>Cloudflare schedule</dt><dd>Activate-due and the feeder run every 5 min; the queue runner every minute.</dd></div>
        </dl>
        {!posture.ok && posture.detail ? <p className="cc3-alert" data-tone="crit">{posture.detail}</p> : null}
      </Plane>
    </div>
  )
})
