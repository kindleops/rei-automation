import { useMemo, useState } from 'react'
import { Popover } from '../../shared/ui'
import {
  ACCENT_PALETTE_IDS,
  applyThemeToDOM,
  loadSettings,
  resolveDataThemeAttr,
  updateSetting,
  type AccentPalette,
  type DensityMode,
  type NexusSettings,
  type NexusTheme,
} from '../../shared/settings'

/**
 * Appearance — theme, accent, density and motion, reachable from EVERY route.
 *
 * Fixes conflict register #3: the picker previously lived inside
 * `WorkspaceLauncher`, reachable only through `NexusTopBar`, which mounts only
 * on `/inbox` — so 14 of 15 routes could not change theme at all.
 *
 * R1.3: no colour values live here. Theme swatches carry `data-nexus-theme` and
 * therefore resolve the real per-theme `--lc-*` values through lc-tokens.css.
 * Accent swatches read their colour from the computed CSS custom property of a
 * probe element, so `nexus-theme.css` stays the single authority and the
 * TS↔CSS fork is not re-created here.
 */

const THEMES: Array<{ id: NexusTheme; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'red_ops', label: 'Red Ops' },
  { id: 'matrix', label: 'Matrix' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'executive', label: 'Executive' },
  { id: 'night_vision', label: 'Night Vision' },
  { id: 'monochrome', label: 'Monochrome' },
  { id: 'light', label: 'Light' },
]

const ACCENT_LABELS: Record<AccentPalette, string> = {
  cyan: 'Cyan',
  emerald: 'Emerald',
  amber: 'Amber',
  violet: 'Violet',
  rose: 'Rose',
  ice: 'Ice',
  blue: 'Blue',
  teal: 'Teal',
  lime: 'Lime',
  orange: 'Orange',
  pink: 'Pink',
  gold: 'Gold',
}

const DENSITIES: Array<{ id: DensityMode; label: string }> = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
]

/**
 * Read each accent's real colour out of the cascade rather than duplicating the
 * palette in TypeScript. `.nx-premium-inbox[data-nexus-accent="x"]` is a live
 * selector in nexus-theme.css, so a hidden probe carrying that class resolves
 * the exact value the theme would apply.
 */
const readAccentSwatches = (themeAttr: string): Record<string, string> => {
  if (typeof document === 'undefined') return {}
  const probe = document.createElement('div')
  probe.className = 'nx-premium-inbox'
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden;'
  probe.setAttribute('data-nexus-theme', themeAttr)
  document.body.appendChild(probe)

  const out: Record<string, string> = {}
  for (const id of ACCENT_PALETTE_IDS) {
    probe.setAttribute('data-nexus-accent', id)
    const value = getComputedStyle(probe).getPropertyValue('--nx-accent').trim()
    if (value) out[id] = value
  }
  probe.remove()
  return out
}

export interface AppearanceMenuProps {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onChange?: () => void
}

export const AppearanceMenu = ({ open, anchorRef, onClose, onChange }: AppearanceMenuProps) => {
  const settings = loadSettings()
  const [, force] = useState(0)
  const activeTheme = settings.nexusTheme
  const activeAccent = settings.accentPalette
  const activeDensity = settings.densityMode
  const motionOn = settings.animationsEnabled

  const themeAttr = useMemo(() => resolveDataThemeAttr(activeTheme), [activeTheme])

  // Resolved during render (not in an effect) so the swatches are correct on
  // first paint — an effect leaves a frame of unpainted dots.
  const accentSwatches = useMemo(
    () => (open ? readAccentSwatches(themeAttr) : {}),
    [open, themeAttr],
  )

  const apply = <K extends keyof NexusSettings>(key: K, value: NexusSettings[K]) => {
    updateSetting(key, value)
    applyThemeToDOM()
    force((n) => n + 1)
    onChange?.()
  }

  return (
    <Popover
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      label="Appearance"
      placement="bottom-end"
      width={296}
      className="lc-appearance"
    >
      <div className="lc-appearance__section">
        <div className="lc-menu__label" id="lc-appearance-theme">
          Theme
        </div>
        <div className="lc-appearance__grid" role="group" aria-labelledby="lc-appearance-theme">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`lc-appearance__theme${activeTheme === theme.id ? ' is-active' : ''}`}
              aria-pressed={activeTheme === theme.id}
              onClick={() => apply('nexusTheme', theme.id)}
            >
              <span className="lc-appearance__swatch" data-nexus-theme={theme.id} aria-hidden>
                <i />
              </span>
              <span className="lc-appearance__theme-label">{theme.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="lc-appearance__section">
        <div className="lc-menu__label" id="lc-appearance-accent">
          Accent
        </div>
        <div className="lc-appearance__accents" role="group" aria-labelledby="lc-appearance-accent">
          {ACCENT_PALETTE_IDS.map((accent) => (
            <button
              key={accent}
              type="button"
              title={ACCENT_LABELS[accent]}
              aria-label={ACCENT_LABELS[accent]}
              aria-pressed={activeAccent === accent}
              className={`lc-appearance__accent${activeAccent === accent ? ' is-active' : ''}`}
              onClick={() => apply('accentPalette', accent)}
            >
              <span
                className="lc-appearance__accent-dot"
                style={{ background: accentSwatches[accent] || 'currentColor' }}
                aria-hidden
              />
            </button>
          ))}
        </div>
      </div>

      <div className="lc-appearance__section">
        <div className="lc-menu__label" id="lc-appearance-density">
          Density
        </div>
        <div className="lc-appearance__row" role="group" aria-labelledby="lc-appearance-density">
          {DENSITIES.map((density) => (
            <button
              key={density.id}
              type="button"
              aria-pressed={activeDensity === density.id}
              className={`lc-appearance__toggle${activeDensity === density.id ? ' is-active' : ''}`}
              onClick={() => apply('densityMode', density.id)}
            >
              {density.label}
            </button>
          ))}
        </div>
      </div>

      <div className="lc-appearance__section">
        <div className="lc-menu__label" id="lc-appearance-motion">
          Motion
        </div>
        <div className="lc-appearance__row" role="group" aria-labelledby="lc-appearance-motion">
          <button
            type="button"
            aria-pressed={motionOn}
            className={`lc-appearance__toggle${motionOn ? ' is-active' : ''}`}
            onClick={() => apply('animationsEnabled', true)}
          >
            Full
          </button>
          <button
            type="button"
            aria-pressed={!motionOn}
            className={`lc-appearance__toggle${!motionOn ? ' is-active' : ''}`}
            onClick={() => apply('animationsEnabled', false)}
          >
            Reduced
          </button>
        </div>
      </div>
    </Popover>
  )
}
