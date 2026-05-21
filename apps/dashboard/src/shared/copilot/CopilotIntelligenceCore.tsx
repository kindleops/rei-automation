/**
 * CopilotPresence — Living AI presence anchored to the assistant header.
 *
 * Compact inline orb with state-driven CSS animations.
 * Greeting + context line sit beside the orb, not below it.
 */

import type { CSSProperties } from 'react'
import type { CopilotState } from './copilot-state'

interface CopilotPresenceProps {
  state: CopilotState
  amplitude: number
  greeting?: string
  contextLine?: string
  compact?: boolean
}

const COLOR: Partial<Record<CopilotState, string>> = {
  idle: '56,208,240',
  greeting: '56,208,240',
  listening: '46,232,192',
  transcribing: '46,232,192',
  speaking: '124,108,255',
  understanding: '140,110,255',
  searching: '140,110,255',
  analyzing: '140,110,255',
  planning: '140,110,255',
  drafting: '140,110,255',
  executing: '216,149,48',
  confirming: '216,149,48',
  completed: '44,184,122',
  error: '224,64,80',
}

function animClass(s: CopilotState): string {
  switch (s) {
    case 'listening': case 'transcribing': return 'is-listen'
    case 'speaking': return 'is-speak'
    case 'understanding': case 'searching': case 'analyzing': case 'planning': case 'drafting': return 'is-think'
    case 'executing': return 'is-exec'
    case 'completed': return 'is-bloom'
    case 'confirming': return 'is-confirm'
    case 'error': return 'is-error'
    default: return 'is-idle'
  }
}

export function CopilotPresence({ state, amplitude, greeting, contextLine, compact }: CopilotPresenceProps) {
  const rgb = COLOR[state] ?? '56,208,240'
  const anim = animClass(state)
  const isVoice = state === 'listening' || state === 'transcribing' || state === 'speaking'

  const style = {
    '--co-rgb': rgb,
    '--co-amp': amplitude,
  } as CSSProperties

  const coAnim = (() => {
    switch (state) {
      case 'listening': case 'transcribing': return 'co-anim--listen'
      case 'speaking': return 'co-anim--speak'
      case 'understanding': case 'searching': case 'analyzing': case 'planning': case 'drafting': return 'co-anim--think'
      case 'executing': return 'co-anim--exec'
      case 'completed': return 'co-anim--bloom'
      case 'confirming': return 'co-anim--confirm'
      case 'error': return 'co-anim--error'
      default: return 'co-anim--idle'
    }
  })()

  return (
    <div className={`co-presence ${coAnim} ${compact ? 'co-presence--compact' : ''}`} style={style}>
      <div className={`co-presence__orb ${anim}`}>
        <div className="co-presence__glow" />
        <div className="co-presence__ring" />
        <div className="co-presence__core" />
        {isVoice && (
          <div className="co-presence__wave">
            {Array.from({ length: 5 }).map((_, i) => (
              <span key={i} className="co-presence__bar" style={{ animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        )}
      </div>
      {(greeting || contextLine) && (
        <div className="co-presence__copy">
          {greeting && <p className="co-presence__greeting">{greeting}</p>}
          {contextLine && <p className="co-presence__context">{contextLine}</p>}
        </div>
      )}
    </div>
  )
}

export { CopilotPresence as CopilotIntelligenceCore }
