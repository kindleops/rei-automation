import { useState } from 'react'
import { ACTION_PERMISSION_META, MODEL_OPTIONS } from './copilot-state'
import type { ActionPermission, ModelOption } from './copilot-state'
import { loadSettings, updateSetting } from '../settings'

interface ModelPickerProps {
  model: string
  permission: ActionPermission
  onModelChange: (id: string) => void
  onPermissionChange: (permission: ActionPermission) => void
}

const REASONING_DEPTHS = [
  { id: 'minimal', label: 'Minimal', desc: 'Fastest route to action' },
  { id: 'standard', label: 'Standard', desc: 'Balanced reasoning and pace' },
  { id: 'deep', label: 'Deep', desc: 'Longer analysis, stronger synthesis' },
] as const

const INITIATIVE_LEVELS = [
  { id: 'on-demand', label: 'On Demand', desc: 'Only reacts to explicit prompts' },
  { id: 'balanced', label: 'Balanced', desc: 'Suggests actions at useful moments' },
  { id: 'proactive', label: 'Proactive', desc: 'Continuously surfaces next steps' },
] as const

const MODE_OPTIONS = [
  { id: 'orb', label: 'Orb', desc: 'Ambient floating intelligence' },
  { id: 'sidecar', label: 'Sidecar', desc: 'Persistent right-edge rail' },
  { id: 'console', label: 'Command Deck', desc: 'Wide tactical planning surface' },
] as const

const ORB_PLACEMENTS = [
  { id: 'dock', label: 'Dock', desc: 'Bottom-right floating anchor' },
  { id: 'corner', label: 'Corner', desc: 'Upper-right tactical badge' },
] as const

export function ModelPicker({ model, permission, onModelChange, onPermissionChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<'model' | 'permission' | 'behavior' | 'presence'>('model')

  const settings = loadSettings()
  const currentModel = MODEL_OPTIONS.find((item) => item.id === model) ?? MODEL_OPTIONS[1]
  const currentPermission = ACTION_PERMISSION_META[permission]
  const reasoning = settings.copilotReasoningDepth ?? 'standard'
  const initiative = settings.copilotInitiative ?? 'balanced'

  return (
    <div className={`nx-model-picker ${open ? 'is-open' : ''}`}>
      <button type="button" className="nx-model-picker__trigger" onClick={() => setOpen((current) => !current)}>
        <span className="nx-model-picker__model-label">{currentModel.label}</span>
        <span className="nx-model-picker__divider">·</span>
        <span className="nx-model-picker__perm-label">{currentPermission.label}</span>
        <span className="nx-model-picker__chevron">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="nx-model-picker__panel">
          <div className="nx-model-picker__tabs">
            {(['model', 'permission', 'behavior', 'presence'] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={`nx-model-picker__tab ${section === item ? 'is-active' : ''}`}
                onClick={() => setSection(item)}
              >
                {item === 'model' ? 'Model' : item === 'permission' ? 'Permissions' : item === 'behavior' ? 'Behavior' : 'Presence'}
              </button>
            ))}
          </div>

          {section === 'model' && (
            <div className="nx-model-picker__section">
              <span className="nx-model-picker__section-label">Intelligence Model</span>
              <div className="nx-model-picker__options">
                {MODEL_OPTIONS.map((item: ModelOption) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`nx-model-picker__option ${item.id === model ? 'is-active' : ''}`}
                    onClick={() => onModelChange(item.id)}
                  >
                    <span className="nx-model-picker__opt-label">{item.label}</span>
                    <span className="nx-model-picker__opt-desc">{item.description}</span>
                    <span className={`nx-model-picker__speed nx-model-picker__speed--${item.speed}`}>{item.speed}</span>
                  </button>
                ))}
              </div>

              <span className="nx-model-picker__section-label">Reasoning Depth</span>
              <div className="nx-model-picker__options">
                {REASONING_DEPTHS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`nx-model-picker__option ${item.id === reasoning ? 'is-active' : ''}`}
                    onClick={() => updateSetting('copilotReasoningDepth', item.id)}
                  >
                    <span className="nx-model-picker__opt-label">{item.label}</span>
                    <span className="nx-model-picker__opt-desc">{item.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {section === 'permission' && (
            <div className="nx-model-picker__section">
              <span className="nx-model-picker__section-label">Action Permission</span>
              <div className="nx-model-picker__options">
                {(Object.entries(ACTION_PERMISSION_META) as [ActionPermission, typeof currentPermission][]).map(([key, meta]) => (
                  <button
                    key={key}
                    type="button"
                    className={`nx-model-picker__option ${key === permission ? 'is-active' : ''}`}
                    onClick={() => onPermissionChange(key)}
                  >
                    <span className="nx-model-picker__opt-label">{meta.label}</span>
                    <span className="nx-model-picker__opt-desc">{meta.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {section === 'behavior' && (
            <div className="nx-model-picker__section">
              <span className="nx-model-picker__section-label">Initiative Level</span>
              <div className="nx-model-picker__options">
                {INITIATIVE_LEVELS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`nx-model-picker__option ${item.id === initiative ? 'is-active' : ''}`}
                    onClick={() => updateSetting('copilotInitiative', item.id)}
                  >
                    <span className="nx-model-picker__opt-label">{item.label}</span>
                    <span className="nx-model-picker__opt-desc">{item.desc}</span>
                  </button>
                ))}
              </div>

              <div className="nx-model-picker__toggle-row">
                <span className="nx-model-picker__toggle-label">Voice Mode Primed by Default</span>
                <button
                  type="button"
                  className={`nx-model-picker__toggle ${settings.voiceModeDefault ? 'is-active' : ''}`}
                  onClick={() => updateSetting('voiceModeDefault', !settings.voiceModeDefault)}
                >
                  {settings.voiceModeDefault ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>
          )}

          {section === 'presence' && (
            <div className="nx-model-picker__section">
              <span className="nx-model-picker__section-label">Default Presentation</span>
              <div className="nx-model-picker__options">
                {MODE_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`nx-model-picker__option ${item.id === settings.copilotMode ? 'is-active' : ''}`}
                    onClick={() => updateSetting('copilotMode', item.id)}
                  >
                    <span className="nx-model-picker__opt-label">{item.label}</span>
                    <span className="nx-model-picker__opt-desc">{item.desc}</span>
                  </button>
                ))}
              </div>

              <div className="nx-model-picker__toggle-row">
                <span className="nx-model-picker__toggle-label">Keep Orb Visible While Open</span>
                <button
                  type="button"
                  className={`nx-model-picker__toggle ${settings.copilotOrbAlwaysVisible ? 'is-active' : ''}`}
                  onClick={() => updateSetting('copilotOrbAlwaysVisible', !settings.copilotOrbAlwaysVisible)}
                >
                  {settings.copilotOrbAlwaysVisible ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="nx-model-picker__toggle-row">
                <span className="nx-model-picker__toggle-label">Pin Trace</span>
                <button
                  type="button"
                  className={`nx-model-picker__toggle ${settings.copilotMissionTracePinned ? 'is-active' : ''}`}
                  onClick={() => updateSetting('copilotMissionTracePinned', !settings.copilotMissionTracePinned)}
                >
                  {settings.copilotMissionTracePinned ? 'ON' : 'OFF'}
                </button>
              </div>

              <span className="nx-model-picker__section-label">Orb Placement</span>
              <div className="nx-model-picker__options">
                {ORB_PLACEMENTS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`nx-model-picker__option ${item.id === settings.orbPlacement ? 'is-active' : ''}`}
                    onClick={() => updateSetting('orbPlacement', item.id)}
                  >
                    <span className="nx-model-picker__opt-label">{item.label}</span>
                    <span className="nx-model-picker__opt-desc">{item.desc}</span>
                  </button>
                ))}
              </div>

              <div className="nx-model-picker__toggle-row">
                <span className="nx-model-picker__toggle-label">Auto-open on Room Change</span>
                <button
                  type="button"
                  className={`nx-model-picker__toggle ${settings.copilotAutoOpen ? 'is-active' : ''}`}
                  onClick={() => updateSetting('copilotAutoOpen', !settings.copilotAutoOpen)}
                >
                  {settings.copilotAutoOpen ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}