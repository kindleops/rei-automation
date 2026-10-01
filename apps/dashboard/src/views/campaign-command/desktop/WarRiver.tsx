import { memo } from 'react'
import { Icon, type IconName } from '../../../shared/icons'
import { LCTooltip, cx } from '../../../shared/lc'
import { useRiseKey } from './war-room-hooks'
import { OWNER_LABEL, nf, type Gate, type GateKey, type GateState, type RiverKey, type RiverNode, type RiverPin } from './war-room-model'

/**
 * THE EXECUTION RIVER — one connected system, not eight KPI boxes.
 *
 * Sellers flow left to right over a thin rail: audience → eligible → planned
 * → in the queue (instantaneous buffer, drawn as a ring) → sent → delivered
 * → replied → opportunity. The rail is lit up to where execution stands;
 * past a held gate it turns to a dashed, quieter line, and the gate hangs
 * below the rail exactly where the flow stops, with its owner and the action
 * that clears it. When a real count rises, one restrained light passes along
 * the segment into it — once. Nothing moves to look alive.
 */

const PIN_ICON: Partial<Record<GateKey, IconName>> = {
  schedule: 'calendar', window: 'clock', template: 'file-text', sender: 'phone', capacity: 'stats', queue: 'layers', provider: 'send', eligibility: 'users', identity: 'shield', suppression: 'slash', delivery: 'send',
}

function Stage({ n, prev, rise, selected, past, onSelect }: { n: RiverNode; prev: RiverNode | null; rise: number; selected: boolean; past: boolean; onSelect: (k: RiverKey) => void }) {
  const basis = n.rate && prev ? `${n.rate} of ${prev.label.toLowerCase()}` : null
  return (
    <li className={cx('cc3-stage', selected && 'is-selected')} data-state={n.state} data-key={n.key} data-buffer={n.buffer ? '' : undefined} data-past={past ? '' : undefined}>
      <button type="button" className="cc3-stage__hit" onClick={() => onSelect(n.key)} aria-pressed={selected} title={basis ?? undefined}>
        <span className="cc3-stage__label">
          <span>{n.label}</span>
          {/* the conversion sits on the connector; this inline copy only shows when the river folds */}
          {n.rate ? <span className="cc3-stage__rate lc-num">{n.rate}</span> : null}
        </span>
        <span className="cc3-stage__value lc-num">{n.value === null ? <span className="cc3-dim">—</span> : nf(n.value)}</span>
        {basis ? <span className="lc-sr-only">, {basis}</span> : null}
        <span className={cx('cc3-stage__sub', n.subTone && `is-${n.subTone}`)}>{n.sub ?? ' '}</span>
      </button>
      <span className="cc3-stage__rail" aria-hidden="true">
        <span className="cc3-stage__line" data-gap={n.rate ? '' : undefined}>{rise ? <i key={rise} className="cc3-pulse" /> : null}</span>
        {n.rate ? <span className="cc3-stage__conv lc-num">{n.rate}</span> : null}
        <span className="cc3-stage__bead" />
      </span>
    </li>
  )
}

export const ExecutionRiver = memo(function ExecutionRiver({
  nodes, pin, selected, onSelect, onPin, pinAction,
}: {
  nodes: RiverNode[]
  pin: RiverPin | null
  selected: RiverKey | null
  onSelect: (k: RiverKey) => void
  onPin: (g: GateKey) => void
  pinAction?: { label: string; onClick: () => void } | null
}) {
  const valueOf = (k: RiverKey) => nodes.find((n) => n.key === k)?.value ?? null
  const rises: Partial<Record<RiverKey, number>> = {
    queued: useRiseKey(valueOf('queued')),
    sent: useRiseKey(valueOf('sent')),
    delivered: useRiseKey(valueOf('delivered')),
    replied: useRiseKey(valueOf('replied')),
    opportunity: useRiseKey(valueOf('opportunity')),
  }
  const pinAt = pin ? nodes.findIndex((n) => n.key === pin.after) : -1
  return (
    <div className="cc3-river" style={{ ['--cc3-pin-at' as string]: pinAt, ['--cc3-stages' as string]: nodes.length }}>
      <ol className="cc3-river__track" aria-label="Execution river: sellers through the machine">
        {nodes.map((n, i) => (
          <Stage key={n.key} n={n} prev={i > 0 ? nodes[i - 1] : null} rise={rises[n.key] ?? 0} selected={selected === n.key} past={Boolean(pin && pin.state === 'blocked' && i > pinAt)} onSelect={onSelect} />
        ))}
      </ol>
      {pin ? (
        <div className="cc3-gatepin" data-tone={pin.tone} data-state={pin.state}>
          <span className="cc3-gatepin__drop" aria-hidden="true" />
          <button type="button" className="cc3-gatepin__card" onClick={() => onPin(pin.gate)}>
            <span className="cc3-gatepin__glyph" aria-hidden="true"><Icon name={PIN_ICON[pin.gate] ?? 'alert'} size={13} /></span>
            <span className="cc3-gatepin__text">
              <span className="cc3-gatepin__title">{/gate$/i.test(pin.label) ? pin.label : `${pin.label} gate`} · {pin.state === 'blocked' ? 'Blocked' : 'Waiting'}</span>
              <span className="cc3-gatepin__detail">{pin.detail}</span>
            </span>
            <Icon name="chevron-right" size={13} className="cc3-gatepin__go" />
          </button>
          {pinAction ? <button type="button" className="cc3-gatepin__act" onClick={pinAction.onClick}>{pinAction.label}</button> : null}
        </div>
      ) : null}
    </div>
  )
})

/** the rail's eleven columns are narrow; the inspector and tooltip carry the full name */
const RAIL_LABEL: Partial<Record<GateKey, string>> = { window: 'Window' }

const GATE_MARK: Record<GateState, string> = { pass: '✓', hold: '◌', wait: '◷', warn: '!', block: '◆', idle: '·', unknown: '?' }
const GATE_TONE: Record<GateState, string> = { pass: 'ok', hold: 'attn', wait: 'neutral', warn: 'attn', block: 'crit', idle: 'neutral', unknown: 'neutral' }

/** All eleven gates in one quiet line; the one stopping execution is lit. */
export const GateRail = memo(function GateRail({ gates, stopping, selected, onSelect }: { gates: Gate[]; stopping: GateKey | null; selected: GateKey | null; onSelect: (g: GateKey) => void }) {
  return (
    <ol className="cc3-gates" aria-label="Execution gates">
      {gates.map((g) => (
        <li key={g.key}>
          <LCTooltip content={`${g.label}: ${g.detail}${g.owner ? ` · Owner: ${OWNER_LABEL[g.owner]}` : ''}`} side="top">
            <button
              type="button"
              className={cx('cc3-gate', stopping === g.key && 'is-stopping', selected === g.key && 'is-selected')}
              data-state={g.state}
              data-tone={GATE_TONE[g.state]}
              onClick={() => onSelect(g.key)}
            >
              <span className="cc3-gate__head">
                <span className="cc3-gate__mark" aria-hidden="true">{GATE_MARK[g.state]}</span>
                <span className="cc3-gate__label">{RAIL_LABEL[g.key] ?? g.label}</span>
              </span>
              <span className="cc3-gate__value">{g.value}</span>
            </button>
          </LCTooltip>
        </li>
      ))}
    </ol>
  )
})
