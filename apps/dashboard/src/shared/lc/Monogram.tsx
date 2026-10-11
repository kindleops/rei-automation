import { Icon } from '../icons'
import { cx } from './cx'
import { monogramFace } from './monogram-model'
import './lc-monogram.css'

export interface LCMonogramProps {
  /** the seller's display name (a phone number or nothing → the fallback glyph) */
  name?: string | null
  /** stable identity for the colour (thread key); falls back to the name */
  seed?: string | null
  /** px; the tile scales its type from this */
  size?: number
  className?: string
  /** decorative next to a visible name (default) — set false to announce the name */
  decorative?: boolean
}

/**
 * LCMonogram — a seller's initials on their own colour, in a soft glass
 * gradient (Apple-Intelligence style contact tile). Unknown name → a person
 * glyph on the same colour, so a seller is recognisable before they are named.
 */
export function LCMonogram({ name, seed, size = 32, className, decorative = true }: LCMonogramProps) {
  const face = monogramFace({ name, seed })
  return (
    <span
      className={cx('lc-mono', !face.initials && 'is-glyph', className)}
      style={{ ['--lc-mono-c' as string]: face.color, ['--lc-mono-s' as string]: `${size}px` }}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': face.label })}
      data-initials={face.initials ?? undefined}
    >
      {face.initials ? <span className="lc-mono__txt">{face.initials}</span> : <Icon name="user" size={Math.round(size * 0.5)} />}
    </span>
  )
}
