import type { ThreadSummary } from './email-command-api'
import { who } from './email-format'

/** Role-toned identity orb; breathes while LeadCommand is handling the conversation. */
const MONO_TONE: Record<string, string> = { seller: 'cobalt', title: 'violet', buyer: 'teal', lender: 'gold', unresolved: 'muted' }
export function Monogram({ t, size = 'sm' }: { t: ThreadSummary; size?: 'sm' | 'lg' }) {
  const name = who(t)
  const letters = name.includes('@') ? name[0] : name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('')
  return <span className={`em2-mono is-${MONO_TONE[t.category] || 'muted'} is-${size}${t.state === 'system_handling' ? ' is-live' : ''}`} aria-hidden>{letters.toUpperCase()}</span>
}


/** Liquid colour field behind the glass: slow, morphing blobs tinted by system state. */
export function LiquidField({ needs = false, live = false }: { needs?: boolean; live?: boolean }) {
  return (
    <span className={`em2-liquid${needs ? ' is-needs' : ''}${live ? ' is-live' : ''}`} aria-hidden>
      <i /><i /><i /><i />
    </span>
  )
}

