import { LCIconButton, LCSegmented, LCTooltip } from '../../../../shared/lc'
import { Icon } from '../../../../shared/icons'
import { clockMs } from '../lib/format'
import type { TimingQuality } from '../lib/types'
import { SPEEDS, type Replay, type ReplayStep, type Speed } from '../runs/replay'
import { sound } from '../../../../shared/sound'

const QUALITY_WORD: Record<TimingQuality, string> = { measured: 'Real step times', recorder: 'Causal order · recorder timing', inferred: 'Order inferred from the final status', single: 'One recorded instant · order only' }

/**
 * REPLAY BAR — scrub the recorded path. The stamp under the playhead is the
 * timestamp the ledger holds for that step; the quality chip says how far
 * those times can be trusted.
 */
export function ReplayBar({ replay, steps, quality, note, labelOf }: { replay: Replay; steps: ReplayStep[]; quality: TimingQuality; note?: string; labelOf: (key: string) => string }) {
  if (!steps.length) return null
  const at = replay.index && replay.index > 0 ? steps[replay.index - 1] : null
  return (
    <div className={`ws4-replay${replay.active ? ' is-on' : ''}`} role="group" aria-label="Replay the recorded path" data-no-pan>
      <span className="ws4-replay__label">Replay</span>
      <LCIconButton icon="chevron-left" label="Step back" size="sm" disabled={!replay.active || (replay.index ?? 0) <= 1} onClick={() => replay.step(-1)} />
      {replay.playing
        ? <LCIconButton icon="pause" label="Pause" size="sm" selected onClick={replay.pause} />
        : <LCIconButton icon="play" label={replay.active ? 'Play from here' : 'Play the recorded path'} size="sm" onClick={() => { sound.ui.tap(); replay.play() }} />}
      <LCIconButton icon="chevron-right" label="Step forward" size="sm" disabled={(replay.index ?? 0) >= steps.length} onClick={() => replay.step(1)} />
      <LCSegmented size="sm" label="Replay speed" value={String(replay.speed) as `${Speed}`} onChange={(v) => replay.setSpeed(Number(v) as Speed)} options={SPEEDS.map((s) => ({ value: String(s) as `${Speed}`, label: `${s}×` }))} />
      <div className="ws4-scrub">
        <input
          type="range"
          min={0}
          max={steps.length}
          step={1}
          value={replay.index ?? steps.length}
          onChange={(e) => replay.seek(Number(e.target.value))}
          aria-label="Scrub the recorded steps"
          aria-valuetext={at ? `${labelOf(at.node)} at ${clockMs(at.at)}` : 'whole path'}
          style={{ ['--p' as string]: `${((replay.index ?? steps.length) / steps.length) * 100}%` }}
        />
        <span className="ws4-scrub__ticks" aria-hidden>{steps.map((s, i) => <i key={i} data-status={s.status} style={{ left: `${((i + 1) / steps.length) * 100}%` }} />)}</span>
      </div>
      <span className="ws4-replay__pos">
        {at ? <><b className="lc-num">{clockMs(at.at)}</b><span>{labelOf(at.node)}{at.label ? ` · ${at.label}` : ''}</span><em className="lc-num">{replay.index}/{steps.length}</em></> : <><b className="lc-num">{steps.length} steps</b><span>{clockMs(steps[0].at)} → {clockMs(steps[steps.length - 1].at)}</span></>}
      </span>
      <LCTooltip content={note || QUALITY_WORD[quality]}>
        <span className="ws4-replay__q" data-q={quality}><Icon name="clock" size={11} />{QUALITY_WORD[quality]}</span>
      </LCTooltip>
      {replay.active ? <button type="button" className="lc-link" onClick={replay.stop}>Show all</button> : null}
    </div>
  )
}
