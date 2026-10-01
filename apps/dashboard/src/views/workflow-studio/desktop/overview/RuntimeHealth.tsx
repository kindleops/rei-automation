import { LCSkeleton } from '../../../../shared/lc'
import { ago } from '../lib/format'
import type { RuntimeBeat } from '../lib/types'

const word = (b: RuntimeBeat) => (b.state === 'stale' ? 'Degraded' : b.switched_off ? 'Off' : b.state === 'never' ? 'No heartbeat' : b.external ? 'Seen' : 'Current')
const tone = (b: RuntimeBeat) => (b.state === 'stale' && !b.switched_off ? 'crit' : b.switched_off || b.state === 'never' ? 'neutral' : b.external ? 'teal' : 'ok')

/**
 * RUNTIME HEALTH — each runtime's own heartbeat, read from system_control.
 * No health percentage: a beat is current, stale (DEGRADED), absent, or the
 * runtime is switched off on purpose. Providers have no schedule — they are
 * "last seen".
 */
export function RuntimeHealth({ beats, loading }: { beats: RuntimeBeat[] | null; loading: boolean }) {
  if (loading && !beats) return <LCSkeleton shape="rows" count={4} label="Reading heartbeats" />
  if (!beats?.length) return null
  const current = beats.filter((b) => !b.external && b.state === 'current' && !b.switched_off).length
  const off = beats.filter((b) => b.switched_off).length
  const degraded = beats.filter((b) => b.state === 'stale' && !b.switched_off).length
  return (
    <section className="ws4-health" aria-label="Runtime health">
      <header className="ws4-panelhead">
        <span className="ws4-panelhead__title">Runtimes</span>
        <span className="ws4-health__sum lc-num">{degraded ? <b className="is-crit">{degraded} degraded</b> : null}<span>{current} current</span>{off ? <span>{off} off</span> : null}</span>
      </header>
      <ul className="ws4-health__list">
        {beats.map((b) => (
          <li key={b.key} data-tone={tone(b)} title={`${b.heartbeat_key}${b.switch_key ? ` · switch ${b.switch_key}` : ''}`}>
            <i aria-hidden />
            <span className="ws4-health__name">{b.label}</span>
            <span className="ws4-health__cad">{b.cadence}</span>
            <span className="ws4-health__state">{word(b)}</span>
            <time className="lc-t-stamp" dateTime={b.at || undefined}>{b.at ? ago(b.at) : '—'}</time>
          </li>
        ))}
      </ul>
    </section>
  )
}
