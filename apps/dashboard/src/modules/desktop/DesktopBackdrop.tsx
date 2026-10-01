import { useState } from 'react'
import type { EnvironmentType } from '../../shared/color/appearance'
import { useEnvironmentShape } from './backdrop-settings'

/**
 * THE ENVIRONMENT — colour living beneath the glass.
 *
 * Fixed, full-bleed, inert and cheap: every layer is a soft gradient moved
 * by transform (no filters, no canvas), coloured by CSS variables the
 * Environment Studio publishes (--lc-env-*). Colour, intensity and the
 * composer never re-render this component — only the environment type and
 * whether it moves do.
 *
 *   liquid   slow living colour field          aurora  atmospheric curtains
 *   waves    soft directional energy           still   a stationary cinematic mesh
 *   custom   the operator's composition around a focal point
 *
 * Changing type: the current field refracts outward and dissolves while the
 * new one resolves underneath the glass (LC_MOTION.environment.swap) — no
 * flash, no hard swap. Motion Still / LeadCommand's Animations switch / the
 * OS reduce-motion request all hold the same colours still.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** One environment field. The Studio renders this same field in its live previews. */
export function EnvironmentField({ type }: { type: EnvironmentType }) {
  switch (type) {
    case 'waves':
      return (
        <div className="dsk-env is-waves">
          <i className="w1" /><i className="w2" /><i className="w3" /><i className="w4" />
        </div>
      )
    case 'aurora':
      return (
        <div className="dsk-env is-aurora">
          <i className="a1" /><i className="a2" /><i className="a3" /><i className="a4" /><i className="a5 is-wide" /><i className="a6" />
        </div>
      )
    case 'still':
      return (
        <div className="dsk-env is-still">
          <i className="s1" /><i className="s2" /><i className="s3" /><i className="s4" /><i className="s5 is-wide" />
        </div>
      )
    case 'custom':
      return (
        <div className="dsk-env is-custom">
          <i className="c1" /><i className="c2" /><i className="c3" /><i className="c4" /><i className="c5 is-wide" />
        </div>
      )
    case 'liquid':
    default:
      return (
        <div className="dsk-env is-liquid">
          <i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /><i className="l5 is-wide" /><i className="l6 is-wide" />
        </div>
      )
  }
}

export function DesktopBackdrop() {
  const { type, level, moving } = useEnvironmentShape()
  // Derived state: when the type changes, the previous field stays mounted
  // just long enough to dissolve (cleared by its own animationend).
  const [current, setCurrent] = useState(type)
  const [leaving, setLeaving] = useState<EnvironmentType | null>(null)
  const [generation, setGeneration] = useState(0)
  if (type !== current) {
    setLeaving(current)
    setCurrent(type)
    setGeneration((g) => g + 1)
  }

  return (
    <div className={cls('dsk-bd', !moving && 'is-held')} data-motion={level} aria-hidden>
      {leaving ? (
        <div
          key={`out-${generation}`}
          className="dsk-env-layer is-leaving"
          onAnimationEnd={(e) => { if (e.target === e.currentTarget) setLeaving(null) }}
        >
          <EnvironmentField type={leaving} />
        </div>
      ) : null}
      <div key={`in-${generation}`} className={cls('dsk-env-layer', generation > 0 && 'is-entering')}>
        <EnvironmentField type={current} />
      </div>
      <div className="dsk-bd__depth" />
      <div className="dsk-bd__grain" />
    </div>
  )
}
