import { useId, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Icon } from '../../../shared/icons'
import { LC_DUR, lcEase, useLcReducedMotion } from '../../../shared/lc/motion'
import { cx } from './hooks'

/**
 * The Studio's small vocabulary: a section, a labelled slider that previews
 * while dragged and settles on release, a switch, and a disclosure that
 * reveals advanced controls.
 */

export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId()
  return (
    <section className={cx('es-sec', className)} aria-labelledby={id}>
      <header className="es-sec__head">
        <h3 id={id} className="es-sec__title">{title}</h3>
        {aside ? <div className="es-sec__aside">{aside}</div> : null}
      </header>
      {children}
    </section>
  )
}

export interface StudioSliderProps {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  /** words for the two ends ("Soft" … "Deep") — shown instead of a number */
  ends?: [string, string]
  /** readout beside the label (defaults to the zone word or the value) */
  format?: (v: number) => string
  /** the track's own colour story */
  track?: 'accent' | 'temperature' | 'luminosity' | 'neutral' | 'environment'
  onPreview: (v: number) => void
  onSettle: () => void
  disabled?: boolean
}

export function StudioSlider({ label, value: stored, min = 0, max = 100, step = 1, ends, format, track = 'neutral', onPreview, onSettle, disabled }: StudioSliderProps) {
  // the in-flight value lives here while dragging, so only this slider
  // re-renders per frame; the product repaints through the preview draft
  const [live, setLive] = useState<number | null>(null)
  const value = live ?? stored
  const settle = () => { if (live !== null) { setLive(null); onSettle() } }
  const pct = ((value - min) / (max - min)) * 100
  const readout = format ? format(value) : ends ? (pct < 34 ? ends[0] : pct > 66 ? ends[1] : 'Balanced') : `${Math.round(value)}`
  return (
    <label className={cx('es-slider', `is-${track}`, disabled && 'is-disabled')}>
      <span className="es-slider__head">
        <span className="es-slider__label">{label}</span>
        <em className="es-slider__value">{readout}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={readout}
        style={{ ['--es-pct' as string]: `${pct}%` }}
        onChange={(e) => { const v = Number(e.target.value); setLive(v); onPreview(v) }}
        onPointerUp={settle}
        onKeyUp={settle}
        onBlur={settle}
      />
      {ends ? (
        <span className="es-slider__ends" aria-hidden="true"><span>{ends[0]}</span><span>{ends[1]}</span></span>
      ) : null}
    </label>
  )
}

export function StudioSwitch({ on, label, onChange, hint }: { on: boolean; label: string; onChange: (next: boolean) => void; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={cx('es-switch', on && 'is-on')} onClick={() => onChange(!on)} title={hint}>
      <span className="es-switch__label">{label}</span>
      <span className="es-switch__track" aria-hidden="true"><i /></span>
    </button>
  )
}

export function Disclosure({ label, open, onToggle, children, badge }: { label: string; open: boolean; onToggle: () => void; children: ReactNode; badge?: ReactNode }) {
  const reduced = useLcReducedMotion()
  const id = useId()
  return (
    <div className={cx('es-disc', open && 'is-open')}>
      <button type="button" className="es-disc__toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span>{label}</span>
        {badge}
        <Icon name="chevron-down" size={13} strokeWidth={2} className="es-disc__chev" />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={id}
            key="body"
            className="es-disc__body"
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduced ? LC_DUR.fast : LC_DUR.surface, ease: lcEase('standard') }}
          >
            <div className="es-disc__inner">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
