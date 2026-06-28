import { useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import {
  applyThemeToDOM,
  loadSettings,
  subscribeSettings,
  updateSetting,
  type NexusTheme,
} from '../../shared/settings'

const THEME_OPTIONS: Array<{ id: NexusTheme; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'midnight-glass', label: 'Midnight' },
  { id: 'tactical-blue', label: 'Tactical' },
  { id: 'operator-black', label: 'Operator' },
]

interface MobileSettingsSheetProps {
  open: boolean
  onClose: () => void
}

export const MobileSettingsSheet = ({ open, onClose }: MobileSettingsSheetProps) => {
  const [theme, setTheme] = useState<NexusTheme>(() => loadSettings().nexusTheme)

  useEffect(() => {
    return subscribeSettings(() => setTheme(loadSettings().nexusTheme))
  }, [])

  if (!open) return null

  return (
    <>
      <button type="button" className="nx-mobile-sheet-backdrop" aria-label="Close settings" onClick={onClose} />
      <aside className="nx-mobile-settings-sheet" role="dialog" aria-label="Settings">
        <header className="nx-mobile-more-sheet__header">
          <strong>Settings</strong>
          <button type="button" className="nx-mobile-more-sheet__close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="nx-mobile-settings-sheet__body">
          <p className="nx-mobile-settings-sheet__label">Theme</p>
          <div className="nx-mobile-settings-sheet__themes">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`nx-mobile-settings-sheet__theme${theme === option.id ? ' is-active' : ''}`}
                onClick={() => {
                  updateSetting('nexusTheme', option.id)
                  applyThemeToDOM()
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </aside>
    </>
  )
}