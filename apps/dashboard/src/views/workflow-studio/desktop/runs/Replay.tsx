import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../../../shared/icons'

const SPEEDS = [0.5, 1, 2] as const
const STEP_MS = 850

/**
 * REPLAY — visual playback of a run's RECORDED path, node by node. It never
 * re-executes anything: it only reveals the path the ledger already holds.
 * Reduced motion keeps stepping (state changes), just without transitions.
 */
export function useReplay(length: number) {
  const [index, setIndex] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const timer = useRef(0)
  useEffect(() => { setIndex(null); setPlaying(false) }, [length])
  useEffect(() => {
    window.clearTimeout(timer.current)
    if (!playing || index === null) return
    if (index >= length) { setPlaying(false); return }
    timer.current = window.setTimeout(() => setIndex((i) => (i === null ? 1 : Math.min(length, i + 1))), STEP_MS / speed)
    return () => window.clearTimeout(timer.current)
  }, [index, length, playing, speed])
  const play = useCallback(() => { setIndex((i) => (i === null || i >= length ? 1 : i)); setPlaying(true) }, [length])
  const pause = useCallback(() => setPlaying(false), [])
  const step = useCallback((d: number) => { setPlaying(false); setIndex((i) => Math.max(1, Math.min(length, (i ?? 0) + d))) }, [length])
  const stop = useCallback(() => { setPlaying(false); setIndex(null) }, [])
  return { index, playing, speed, setSpeed, play, pause, step, stop, active: index !== null }
}

export function ReplayBar({ replay, length, current }: { replay: ReturnType<typeof useReplay>; length: number; current: string | null }) {
  if (!length) return null
  return (
    <div className={`ws3-replay${replay.active ? ' is-on' : ''}`} role="group" aria-label="Replay the recorded path">
      <span className="ws3-replay__label">Replay</span>
      <button type="button" className="ws3-iconbtn" onClick={() => replay.step(-1)} disabled={!replay.active} aria-label="Step back"><Icon name="chevron-left" /></button>
      {replay.playing
        ? <button type="button" className="ws3-iconbtn is-on" onClick={replay.pause} aria-label="Pause"><Icon name="pause" /></button>
        : <button type="button" className="ws3-iconbtn" onClick={replay.play} aria-label="Play the recorded path"><Icon name="play" /></button>}
      <button type="button" className="ws3-iconbtn" onClick={() => replay.step(1)} aria-label="Step forward"><Icon name="chevron-right" /></button>
      <div className="ws3-seg" role="radiogroup" aria-label="Speed">
        {SPEEDS.map((s) => <button key={s} type="button" role="radio" aria-checked={replay.speed === s} className={replay.speed === s ? 'is-on' : ''} onClick={() => replay.setSpeed(s)}>{s}×</button>)}
      </div>
      <span className="ws3-replay__pos">{replay.active ? `${replay.index} / ${length}${current ? ` · ${current}` : ''}` : `${length} steps recorded`}</span>
      {replay.active ? <button type="button" className="ws3-textbtn" onClick={replay.stop}>Show all</button> : null}
    </div>
  )
}
