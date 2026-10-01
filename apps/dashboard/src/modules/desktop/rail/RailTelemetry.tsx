import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useLcReducedMotion } from '../../../shared/lc'
import { compactCount, type Resting, type ShownTransient } from './rail-model'

/**
 * The row's micro-display: a fixed-width optical readout at the right edge of
 * every row. At rest it is the app's one stable number; for a moment it is
 * what the machine is doing; then the number again. Width never changes.
 */

function Glyph({ t }: { t: ShownTransient }) {
  switch (t.transient) {
    case 'typing':
      return <span className="crt-typing" aria-hidden="true"><i /><i /><i /></span>
    case 'processing':
      return (
        <svg className="crt-orbit" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" className="crt-orbit__track" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" className="crt-orbit__arc" />
        </svg>
      )
    case 'success':
    case 'complete':
      return (
        <span className="crt-text">
          <svg className="crt-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.6 4.8" /></svg>
          {t.display ? <b>{t.display}</b> : null}
        </span>
      )
    case 'failure':
      return <svg className="crt-cross" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5" /><path d="M11.5 4.5 4.5 11.5" /></svg>
    case 'retry':
      return <svg className="crt-retry" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.6 6.2A5 5 0 1 0 13 9.6" /><path d="M12.9 3.2v3.3H9.6" /></svg>
    case 'attention':
      return <span className="crt-attn" aria-hidden="true">!</span>
    case 'trace':
      return (
        <svg className="crt-trace" viewBox="0 0 30 12" aria-hidden="true">
          <path d="M4 6h22" className="crt-trace__line" />
          <rect x="1.2" y="3.2" width="5.6" height="5.6" rx="1" transform="rotate(45 4 6)" />
          <rect x="23.2" y="3.2" width="5.6" height="5.6" rx="1" transform="rotate(45 26 6)" />
        </svg>
      )
    case 'stage': {
      const m = /^S(\d+)→S(\d+)$/.exec(t.display || '')
      if (m) return <span className="crt-stage"><span>S{m[1]}</span><i aria-hidden="true">→</i><span>S{m[2]}</span></span>
      return <span className="crt-text"><b>{t.display}</b></span>
    }
    case 'start':
      return <svg className="crt-start" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4v8l6.5-4z" /></svg>
    case 'refill':
      return <span className="crt-text crt-refill"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.6 6.2A5 5 0 1 0 13 9.6" /><path d="M12.9 3.2v3.3H9.6" /></svg>{t.display ? <b>{t.display}</b> : null}</span>
    case 'add':
    case 'milestone':
    default:
      return <span className="crt-text"><b>{t.display || ''}</b></span>
  }
}

export function RailTelemetry({ resting, transient, expanded }: { resting: Resting | null; transient: ShownTransient | null; expanded: boolean }) {
  const reduced = useLcReducedMotion()
  const value = resting ? resting.value : null
  const [prev, setPrev] = useState<number | null>(value)
  const [dir, setDir] = useState(1)
  if (prev !== value) { setPrev(value); setDir(value !== null && prev !== null && value < prev ? -1 : 1) }
  const show = transient ? 'transient' : value !== null && value > 0 ? 'count' : 'none'
  const roll = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } : {
    initial: { opacity: 0, y: dir * 7, filter: 'blur(2px)' },
    animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
    exit: { opacity: 0, y: dir * -6, filter: 'blur(2px)' },
  }
  return (
    <span className={`crt${transient ? ` is-${transient.transient}` : ''}`} data-tone={transient ? transient.tone : resting?.tone !== 'default' ? resting?.tone : undefined} aria-hidden="true">
      <AnimatePresence initial={false}>
        {show === 'transient' && transient ? (
          <motion.span key={`t:${transient.key}`} className="crt__face" {...(reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } : { initial: { opacity: 0, scale: 0.85 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.9 } })} transition={{ duration: 0.18 }}>
            <Glyph t={transient} />
          </motion.span>
        ) : show === 'count' && value !== null ? (
          <motion.span key={`c:${value}`} className="crt__face crt__count" {...roll} transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}>
            {compactCount(value)}
            {expanded && resting?.attention ? <em className="crt__attn" title={`${resting.attention} need attention`}>{compactCount(resting.attention)}</em> : null}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  )
}
