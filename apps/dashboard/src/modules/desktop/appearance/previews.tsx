import { memo, useMemo, type CSSProperties, type ReactNode } from 'react'
import type { AppearanceSnapshot, EnvironmentType, MaterialState } from '../../../shared/color/appearance'
import type { GlassFamily } from '../../../shared/color/derive'
import type { AppearanceComputed } from '../../../shared/color/tokens'
import { EnvironmentField } from '../DesktopBackdrop'
import { cx } from './hooks'
import { materialPreview, materialStyle, thumbStyle } from './preview-model'

/**
 * Live previews, painted by the same environment field as the desktop and
 * coloured by the same tokens. At rest they are still; hovering a tile lets
 * it move a little (when motion is allowed) — the app itself never repaints
 * on hover. Selection is what changes the environment.
 */

export function EnvironmentStage({ type, style, scheme, className, children, moving = false }: {
  type: EnvironmentType
  style?: CSSProperties
  scheme?: 'dark' | 'light'
  className?: string
  children?: ReactNode
  moving?: boolean
}) {
  return (
    <span className={cx('lc-env-stage', moving && 'is-moving', className)} style={style} data-scheme={scheme}>
      <EnvironmentField type={type} />
      <span className="dsk-bd__depth" />
      {children}
    </span>
  )
}

/** The type picker's tile: this type, the operator's live palette. */
export const EnvironmentTile = memo(function EnvironmentTile({ type, label, active, onSelect, moving }: {
  type: EnvironmentType
  label: string
  active: boolean
  onSelect: () => void
  moving: boolean
}) {
  return (
    <button type="button" role="radio" aria-checked={active} className={cx('es-envtile', active && 'is-active', moving && 'can-move')} onClick={onSelect}>
      <EnvironmentStage type={type} className="es-envtile__stage" />
      <span className="es-envtile__label">{label}</span>
    </button>
  )
})

/** A saved environment's thumbnail, rendered from its own tokens. */
export const EnvironmentThumb = memo(function EnvironmentThumb({ snapshot, className }: { snapshot: AppearanceSnapshot; className?: string }) {
  // keyed by content, not identity: a re-created snapshot with the same look reuses the tokens
  const key = JSON.stringify(snapshot)
  const t = useMemo(() => thumbStyle(JSON.parse(key) as AppearanceSnapshot), [key])
  return (
    <EnvironmentStage type={snapshot.environment.type} style={t.style} scheme={t.scheme} className={cx('es-thumb', className)}>
      <span className="es-thumb__plate" aria-hidden="true">
        <i className="es-thumb__line" />
        <i className="es-thumb__line is-short" />
        <i className="es-thumb__chip" />
      </span>
    </EnvironmentStage>
  )
})

/** One glass family over the live environment: the pane refracts what is behind it. */
export const GlassTile = memo(function GlassTile({ family, label, active, computed, current, type, onSelect }: {
  family: GlassFamily
  label: string
  active: boolean
  computed: AppearanceComputed
  current: MaterialState
  type: EnvironmentType
  onSelect: () => void
}) {
  const style = materialStyle(computed, materialPreview(computed, family, current))
  return (
    <button type="button" role="radio" aria-checked={active} className={cx('es-glass', `is-${family}`, active && 'is-active')} onClick={onSelect} style={style}>
      <span className="es-glass__stage">
        <EnvironmentStage type={type} className="es-glass__env" />
        <EnvironmentStage type={type} className="es-glass__refract" />
        <span className="es-glass__pane" aria-hidden="true"><i /><i className="is-short" /></span>
      </span>
      <span className="es-glass__label">{label}</span>
    </button>
  )
})

/**
 * The tiny proof of the current look: type, a primary action, a chart line,
 * a selected state and a focus ring — enough to judge contrast at a glance.
 * Painted only from the live Experience Tokens.
 */
export function LiveSample({ type }: { type: EnvironmentType }) {
  return (
    <EnvironmentStage type={type} className="es-sample">
      <span className="es-sample__plate" aria-hidden="true">
        <span className="es-sample__type">Aa</span>
        <span className="es-sample__chip">Selected</span>
        <svg className="es-sample__spark" viewBox="0 0 64 22" aria-hidden="true">
          <path d="M1 17 L10 13 L18 15 L27 8 L36 11 L45 5 L54 8 L63 3" />
        </svg>
        <span className="es-sample__btn">Run</span>
      </span>
    </EnvironmentStage>
  )
}
