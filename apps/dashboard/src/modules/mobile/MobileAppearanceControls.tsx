import { useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import {
  ACCENT_PALETTE_IDS,
  ACCENT_PALETTES,
  LIGHT_ACCENT_PALETTES,
  applyThemeToDOM,
  loadSettings,
  subscribeSettings,
  updateSetting,
  type AccentPalette,
} from '../../shared/settings'
import { NEXUS_GLOBAL_THEME_OPTIONS } from '../../domain/theme/nexusThemes'
import type { NexusGlobalThemeId } from '../../domain/theme/nexusThemes'

/**
 * THE MOBILE APPEARANCE SYSTEM — one implementation, mounted inside the one launcher.
 *
 * Appearance used to exist twice on a phone and unequally. The inbox family reached it
 * through WorkspaceLauncher's "Appearance" tab, which offered FOUR of the eleven themes;
 * every other route had no accent control at all and only the four-theme list buried in
 * the settings sheet. So the same operator got a different appearance system depending
 * on which application they happened to be standing in.
 *
 * §0 is explicit that this feature is not the problem and must not be simplified away,
 * so this component is the opposite of a reduction: the COMPLETE theme set and the
 * COMPLETE accent palette, composed for a thumb rather than for a desktop menu.
 *
 * It owns its own state rather than taking props. The write path is two calls
 * (`updateSetting` + `applyThemeToDOM`) against a store that already broadcasts, which
 * is why the inbox's copy of this wiring and this one cannot drift: both read the same
 * subscription. That also means appearance works identically on routes whose host has
 * no theme props to pass — which was the actual reason the feature was inbox-only.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

export const MobileAppearanceControls = () => {
  const [settings, setSettings] = useState(() => loadSettings())

  useEffect(() => subscribeSettings(() => setSettings(loadSettings())), [])

  const themeId = settings.nexusTheme as NexusGlobalThemeId
  const accentId = settings.accentPalette
  const isLight = settings.nexusTheme === 'light'
  // The accent swatch must show the colour the operator will actually get. Light mode
  // runs a separate palette table, so reading the dark one would paint a preview the
  // theme then contradicts.
  const palette = isLight ? LIGHT_ACCENT_PALETTES : ACCENT_PALETTES

  const selectTheme = (next: NexusGlobalThemeId) => {
    updateSetting('nexusTheme', next)
    applyThemeToDOM()
  }

  const selectAccent = (next: AccentPalette) => {
    updateSetting('accentPalette', next)
    applyThemeToDOM()
  }

  return (
    <section className="nx-app-launcher__group nx-mobile-appearance">
      <h4>Appearance</h4>

      <div className="nx-mobile-appearance__themes" role="radiogroup" aria-label="Theme">
        {NEXUS_GLOBAL_THEME_OPTIONS.map((theme) => {
          const active = themeId === theme.id
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={cls('nx-mobile-appearance__theme', active && 'is-active')}
              onClick={() => selectTheme(theme.id)}
            >
              <span
                className="nx-mobile-appearance__swatch"
                style={{ background: theme.accent }}
                aria-hidden
              />
              <span className="nx-mobile-appearance__theme-label">{theme.label}</span>
              {active ? (
                <span className="nx-mobile-appearance__check" aria-hidden>
                  <Icon name="check" size={11} strokeWidth={2.4} />
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="nx-mobile-appearance__accents" role="radiogroup" aria-label="Accent colour">
        {ACCENT_PALETTE_IDS.map((accent) => {
          const active = accentId === accent
          return (
            <button
              key={accent}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${accent} accent`}
              className={cls('nx-mobile-appearance__accent', active && 'is-active')}
              onClick={() => selectAccent(accent)}
            >
              {/* The visible dot stays 18px; the 44px target comes from the button's
                  own padding, so the row reads as jewellery and taps like a control. */}
              <i style={{ background: palette[accent].primary }} aria-hidden />
            </button>
          )
        })}
      </div>
    </section>
  )
}
