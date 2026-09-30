import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { summarizeTrail, type TrailStep } from '../message-automation-trail'

/**
 * Under an inbound message: what the automation read and decided, one step
 * per line (intent, sentiment, stage, price, next action…). Open on the latest
 * message; older ones fold to a single summary line.
 */
export function MessageAutomationTrail({ steps, defaultOpen }: { steps: TrailStep[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => { setOpen(defaultOpen) }, [defaultOpen])
  if (!steps.length) return null
  return (
    <div className={`nx-msg-trail${open ? ' is-open' : ''}`}>
      <button type="button" className="nx-msg-trail__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="nx-msg-trail__spark" aria-hidden />
        <span className="nx-msg-trail__title">Automation</span>
        {!open ? <span className="nx-msg-trail__sum">{summarizeTrail(steps)}</span> : null}
        <Icon name="chevron-down" size={12} />
      </button>
      {open ? (
        <ol className="nx-msg-trail__steps">
          {steps.map((s, i) => (
            <li key={s.key} className={`is-${s.tone}`} style={{ ['--i' as string]: i }}>
              <i aria-hidden />
              <span>{s.label}</span>
              <b>{s.value}</b>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
