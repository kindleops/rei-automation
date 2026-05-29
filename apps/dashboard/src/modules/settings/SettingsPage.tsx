import { useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import {
  loadSettings,
  updateSetting,
  subscribeSettings,
  resetSettings,
  applyThemeToDOM,
  THEME_PRESETS,
  ACCENT_PALETTES,
  type NexusSettings,
  type MapTheme,
  type HeatPalette,
  type PulsePalette,
  type SoundProfile,
  type DensityMode,
  type NexusTheme,
  type AccentPalette,
  type GreetingStyle,
  type CopilotInitiative,
  type CopilotVerbosity,
} from '../../shared/settings'
import { previewSound, playSound, type SoundEvent } from '../../shared/sounds'

const classes = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const MAP_THEMES: { value: MapTheme; label: string }[] = [
  { value: 'dark-matter', label: 'Dark Matter' },
  { value: 'dark-matter-nolabels', label: 'Dark (No Labels)' },
  { value: 'voyager-nolabels', label: 'Voyager' },
  { value: 'positron-nolabels', label: 'Positron' },
]

const HEAT_PALETTES: { value: HeatPalette; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'infrared', label: 'Infrared' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'arctic', label: 'Arctic' },
]

const PULSE_PALETTES: { value: PulsePalette; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'neon', label: 'Neon' },
  { value: 'muted', label: 'Muted' },
  { value: 'monochrome', label: 'Monochrome' },
]

const SOUND_PROFILES: { value: SoundProfile; label: string }[] = [
  { value: 'tactical', label: 'Tactical' },
  { value: 'ambient', label: 'Ambient' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'silent', label: 'Silent' },
]

const DENSITY_MODES: { value: DensityMode; label: string }[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
  { value: 'spacious', label: 'Spacious' },
]

const SOUND_EVENTS: { key: keyof NexusSettings; label: string; event: SoundEvent }[] = [
  { key: 'soundInboundReply', label: 'Inbound Reply', event: 'inbound-reply' },
  { key: 'soundHotLeadEscalation', label: 'Hot Lead Escalation', event: 'hot-lead-escalation' },
  { key: 'soundAlertTriggered', label: 'Alert Triggered', event: 'alert-triggered' },
  { key: 'soundTitleClear', label: 'Title Clear', event: 'title-clear' },
  { key: 'soundClosingScheduled', label: 'Closing Scheduled', event: 'closing-scheduled' },
  { key: 'soundBuyerMatch', label: 'Buyer Match', event: 'buyer-match' },
  { key: 'soundAiResponse', label: 'AI Response', event: 'ai-response' },
  { key: 'soundAutopilotAction', label: 'Autopilot Action', event: 'autopilot-action' },
  { key: 'soundNotification', label: 'Notification', event: 'notification' },
  { key: 'soundQueueIssue', label: 'Queue Issue', event: 'queue-issue' },
  { key: 'soundContractMilestone', label: 'Contract Milestone', event: 'contract-milestone' },
]

const LAYER_TOGGLES: { key: keyof NexusSettings; label: string }[] = [
  { key: 'layerLeadTemp', label: 'Lead Temperature' },
  { key: 'layerMarketPressure', label: 'Market Pressure' },
  { key: 'layerBuyerDemand', label: 'Buyer Demand' },
  { key: 'layerAlerts', label: 'Alerts' },
  { key: 'layerTitle', label: 'Title & Closing' },
  { key: 'layerContracts', label: 'Contracts' },
]

const NEXUS_GLOBAL_THEME_IDS: NexusTheme[] = ['light', 'dark', 'satellite', 'terrain', 'red_ops', 'matrix', 'blueprint', 'executive', 'night_vision', 'monochrome']
const NEXUS_THEMES: { value: NexusTheme; label: string }[] = NEXUS_GLOBAL_THEME_IDS.map(id => ({ value: id, label: THEME_PRESETS[id].label }))
const ACCENT_OPTIONS: { value: AccentPalette; label: string; color: string }[] = (Object.entries(ACCENT_PALETTES) as [AccentPalette, { primary: string; glow: string }][]).map(([k, v]) => ({ value: k, label: k.charAt(0).toUpperCase() + k.slice(1), color: v.primary }))
const GREETING_STYLES: { value: GreetingStyle; label: string }[] = [
  { value: 'formal', label: 'Formal' }, { value: 'casual', label: 'Casual' }, { value: 'minimal', label: 'Minimal' }, { value: 'cinematic', label: 'Cinematic' },
]
const COPILOT_INITIATIVE: { value: CopilotInitiative; label: string }[] = [
  { value: 'proactive', label: 'Proactive' }, { value: 'balanced', label: 'Balanced' }, { value: 'on-demand', label: 'On-Demand' },
]
const COPILOT_VERBOSITY: { value: CopilotVerbosity; label: string }[] = [
  { value: 'concise', label: 'Concise' }, { value: 'detailed', label: 'Detailed' },
]
const COPILOT_MODES = [
  { value: 'orb', label: 'Orb' },
  { value: 'sidecar', label: 'Sidecar' },
  { value: 'console', label: 'Command Deck' },
] as const
const ORB_PLACEMENTS = [
  { value: 'dock', label: 'Dock' },
  { value: 'corner', label: 'Corner' },
] as const

export const SettingsPage = () => {
  const [s, setS] = useState(loadSettings)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])

  useEffect(() => subscribeSettings(() => setS(loadSettings())), [])

  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const synth = window.speechSynthesis
    const load = () => {
      try {
        const v = synth.getVoices() || []
        setVoices(v)
      } catch {
        setVoices([])
      }
    }
    load()
    // Some browsers populate voices lazily — try again shortly and listen for the voiceschanged event
    const timerId = window.setTimeout(load, 250)
    synth.addEventListener('voiceschanged', load)
    return () => {
      try { synth.removeEventListener('voiceschanged', load) } catch (_) { /* noop */ }
      window.clearTimeout(timerId)
    }
  }, [])

  const toggle = (key: keyof NexusSettings) => {
    updateSetting(key, !s[key] as any)
  }

  const setSelect = <K extends keyof NexusSettings>(key: K, value: NexusSettings[K]) => {
    updateSetting(key, value)
  }

  const setRange = (key: keyof NexusSettings, value: number) => {
    updateSetting(key, value as any)
  }

  const setTheme = (theme: NexusTheme) => {
    updateSetting('nexusTheme', theme)
    applyThemeToDOM()
    playSound('theme-switch')
  }

  const setAccent = (accent: AccentPalette) => {
    updateSetting('accentPalette', accent)
    applyThemeToDOM()
  }

  return (
    <div className="nx-settings">
      <header className="nx-surface-header">
        <div className="nx-surface-header__title">
          <Icon className="nx-surface-icon" name="settings" />
          <h1>Settings</h1>
        </div>
        <div className="nx-surface-header__stats">
          <button className="nx-action-button nx-action-button--muted" type="button" onClick={resetSettings}>
            Reset to Defaults
          </button>
        </div>
      </header>

      <div className="nx-settings__body">
        {/* ── Operator Personalization ─────────────────────────── */}
        <section className="nx-settings__group">
          <h2><Icon name="users" className="nx-settings__group-icon" /> Operator</h2>
          <div className="nx-settings__list">
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Operator Name</strong><p>Your name for greetings</p></div>
              <div className="nx-setting-row__control">
                <input type="text" className="nx-text-input" placeholder="Operator" value={s.operatorName} onChange={e => updateSetting('operatorName', e.target.value)} />
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Operator Title</strong><p>Your role label</p></div>
              <div className="nx-setting-row__control">
                <input type="text" className="nx-text-input" placeholder="Operator" value={s.operatorTitle} onChange={e => updateSetting('operatorTitle', e.target.value)} />
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Assistant Name</strong><p>AI copilot display name</p></div>
              <div className="nx-setting-row__control">
                <input type="text" className="nx-text-input" placeholder="NEXUS" value={s.assistantName} onChange={e => updateSetting('assistantName', e.target.value)} />
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Greeting Style</strong><p>Copilot greeting tone</p></div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {GREETING_STYLES.map(g => (
                    <button key={g.value} type="button" className={classes('nx-segmented__btn', s.greetingStyle === g.value && 'is-active')} onClick={() => setSelect('greetingStyle', g.value)}>{g.label}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Theme ────────────────────────────────────────────── */}
        <section className="nx-settings__group">
          <h2><Icon name="palette" className="nx-settings__group-icon" /> Theme</h2>
          <div className="nx-settings__list">
            <div className="nx-setting-row nx-setting-row--stack">
              <div className="nx-setting-row__info"><strong>NEXUS Theme</strong><p>Command center color scheme</p></div>
              <div className="nx-theme-grid">
                {NEXUS_THEMES.map(t => {
                  const tokens = THEME_PRESETS[t.value]
                  return (
                    <button key={t.value} type="button" className={classes('nx-theme-swatch', s.nexusTheme === t.value && 'is-active')} onClick={() => setTheme(t.value)}>
                      <div className="nx-theme-swatch__preview" style={{ background: tokens.bg }}>
                        <div className="nx-theme-swatch__accent" style={{ background: tokens.accent }} />
                      </div>
                      <span className="nx-theme-swatch__label">{t.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="nx-setting-row nx-setting-row--stack">
              <div className="nx-setting-row__info"><strong>Accent Palette</strong><p>Primary accent color</p></div>
              <div className="nx-accent-row">
                {ACCENT_OPTIONS.map(a => (
                  <button key={a.value} type="button" className={classes('nx-accent-chip', s.accentPalette === a.value && 'is-active')} onClick={() => setAccent(a.value)} title={a.label}>
                    <span className="nx-accent-chip__dot" style={{ background: a.color }} />
                    <span className="nx-accent-chip__label">{a.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── AI Copilot Config ────────────────────────────────── */}
        <section className="nx-settings__group">
          <h2><Icon name="spark" className="nx-settings__group-icon" /> AI Copilot</h2>
          <div className="nx-settings__list">
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Copilot Enabled</strong><p>AI intelligence companion</p></div>
              <button type="button" className={classes('nx-toggle', s.copilotEnabled && 'is-on')} onClick={() => toggle('copilotEnabled')} role="switch" aria-checked={s.copilotEnabled}><span className="nx-toggle__thumb" /></button>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Presentation Mode</strong><p>Choose Orb, Sidecar, or the full Command Deck</p></div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {COPILOT_MODES.map(mode => (
                    <button key={mode.value} type="button" className={classes('nx-segmented__btn', s.copilotMode === mode.value && 'is-active')} onClick={() => setSelect('copilotMode', mode.value)}>{mode.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Initiative Level</strong><p>How proactively the copilot surfaces insights</p></div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {COPILOT_INITIATIVE.map(ci => (
                    <button key={ci.value} type="button" className={classes('nx-segmented__btn', s.copilotInitiative === ci.value && 'is-active')} onClick={() => setSelect('copilotInitiative', ci.value)}>{ci.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Verbosity</strong><p>Response detail level</p></div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {COPILOT_VERBOSITY.map(cv => (
                    <button key={cv.value} type="button" className={classes('nx-segmented__btn', s.copilotVerbosity === cv.value && 'is-active')} onClick={() => setSelect('copilotVerbosity', cv.value)}>{cv.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Auto-Open</strong><p>Open copilot on surface change</p></div>
              <button type="button" className={classes('nx-toggle', s.copilotAutoOpen && 'is-on')} onClick={() => toggle('copilotAutoOpen')} role="switch" aria-checked={s.copilotAutoOpen}><span className="nx-toggle__thumb" /></button>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Voice Mode Default</strong><p>Prime voice capture when the deck opens</p></div>
              <button type="button" className={classes('nx-toggle', s.voiceModeDefault && 'is-on')} onClick={() => toggle('voiceModeDefault')} role="switch" aria-checked={s.voiceModeDefault}><span className="nx-toggle__thumb" /></button>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Autonomous Mode</strong><p>Allow Copilot to execute actions automatically without explicit approval for typed or spoken commands</p></div>
              <button type="button" className={classes('nx-toggle', s.copilotAutonomous && 'is-on')} onClick={() => toggle('copilotAutonomous')} role="switch" aria-checked={s.copilotAutonomous}><span className="nx-toggle__thumb" /></button>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Voice Output</strong><p>When clicking away from the sidecar: talk or display animated text</p></div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  <button type="button" className={classes('nx-segmented__btn', s.copilotVoiceMode === 'full' && 'is-active')} onClick={() => setSelect('copilotVoiceMode', 'full')}>Full Voice</button>
                  <button type="button" className={classes('nx-segmented__btn', s.copilotVoiceMode === 'text' && 'is-active')} onClick={() => setSelect('copilotVoiceMode', 'text')}>Animated Text</button>
                  <button type="button" className={classes('nx-segmented__btn', s.copilotVoiceMode === 'off' && 'is-active')} onClick={() => setSelect('copilotVoiceMode', 'off')}>Off</button>
                </div>
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>TTS Voice Controls</strong><p>Adjust volume, rate, and pitch for full voice output</p></div>
              <div className="nx-setting-row__control">
                <div className="nx-tts-controls">
                  <label className="nx-tts-label">Volume {s.ttsVolume}</label>
                  <input type="range" className="nx-range" min={0} max={1} step={0.05} value={s.ttsVolume} onChange={e => setRange('ttsVolume', parseFloat(e.target.value))} />
                  <label className="nx-tts-label">Rate {s.ttsRate}</label>
                  <input type="range" className="nx-range" min={0.5} max={2} step={0.1} value={s.ttsRate} onChange={e => setRange('ttsRate', parseFloat(e.target.value))} />
                  <label className="nx-tts-label">Pitch {s.ttsPitch}</label>
                  <input type="range" className="nx-range" min={0.5} max={2} step={0.1} value={s.ttsPitch} onChange={e => setRange('ttsPitch', parseFloat(e.target.value))} />
                  <label className="nx-tts-label" style={{ marginTop: 8 }}>Voice</label>
                  <select className="nx-select" value={s.ttsVoice ?? ''} onChange={e => setSelect('ttsVoice', e.target.value)}>
                    <option value="">Default</option>
                    {voices.map((v) => (
                      <option key={v.voiceURI || v.name} value={v.voiceURI || v.name}>{`${v.name} ${v.lang ? `(${v.lang})` : ''}`}</option>
                    ))}
                  </select>
                  <label className="nx-tts-label" style={{ marginTop: 8 }}>Persona</label>
                  <select className="nx-select" value={s.ttsPersona ?? 'neutral'} onChange={e => setSelect('ttsPersona', e.target.value as any)}>
                    <option value="neutral">Neutral</option>
                    <option value="warm">Warm</option>
                    <option value="energetic">Energetic</option>
                    <option value="calm">Calm</option>
                    <option value="robotic">Robotic</option>
                    <option value="friendly">Friendly</option>
                    <option value="authoritative">Authoritative</option>
                    <option value="narrator">Narrator</option>
                  </select>
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="nx-inline-button" onClick={() => {
                      if (!('speechSynthesis' in window)) return
                      try {
                        window.speechSynthesis.cancel()
                        const u = new SpeechSynthesisUtterance('This is a voice preview.')
                        // apply persona modifiers for a closer preview
                        const persona = s.ttsPersona ?? 'neutral'
                        const PERSONA: Record<string, { rate: number; pitch: number; vol: number }> = {
                          neutral: { rate: 1, pitch: 1, vol: 1 },
                          warm: { rate: 0.95, pitch: 0.92, vol: 0.98 },
                          energetic: { rate: 1.12, pitch: 1.06, vol: 1 },
                          calm: { rate: 0.88, pitch: 0.86, vol: 0.95 },
                          robotic: { rate: 1.0, pitch: 0.56, vol: 1 },
                          friendly: { rate: 1.02, pitch: 1.05, vol: 1 },
                          authoritative: { rate: 0.95, pitch: 0.9, vol: 1.05 },
                          narrator: { rate: 0.92, pitch: 0.88, vol: 1 },
                        }
                        const p = PERSONA[persona] ?? PERSONA.neutral
                        u.volume = (s.ttsVolume ?? 1) * p.vol
                        u.rate = (s.ttsRate ?? 1) * p.rate
                        u.pitch = (s.ttsPitch ?? 1) * p.pitch
                        if (s.ttsVoice) {
                          try {
                            const found = window.speechSynthesis.getVoices().find(v => (v.voiceURI || v.name) === s.ttsVoice)
                            if (found) u.voice = found
                          } catch (_) {
                            // ignore voice selection errors
                          }
                        }
                        window.speechSynthesis.speak(u)
                      } catch (_) {
                        // ignore
                      }
                    }}>Preview</button>
                  </div>
                </div>
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Copilot Sound</strong><p>Audio cues for AI events</p></div>
              <button type="button" className={classes('nx-toggle', s.copilotSoundEnabled && 'is-on')} onClick={() => toggle('copilotSoundEnabled')} role="switch" aria-checked={s.copilotSoundEnabled}><span className="nx-toggle__thumb" /></button>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Orb Always Visible</strong><p>Keep the ambient orb present even while panels are open</p></div>
              <button type="button" className={classes('nx-toggle', s.copilotOrbAlwaysVisible && 'is-on')} onClick={() => toggle('copilotOrbAlwaysVisible')} role="switch" aria-checked={s.copilotOrbAlwaysVisible}><span className="nx-toggle__thumb" /></button>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Orb Intensity</strong><p>Ambient orb strength ({s.copilotOrbIntensity?.toFixed(2) ?? '1.00'})</p></div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={0.2} max={2.0} step={0.05} value={s.copilotOrbIntensity ?? 1} onChange={e => setRange('copilotOrbIntensity', parseFloat(e.target.value))} />
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Orb Speed</strong><p>Background orb animation speed ({s.copilotOrbSpeed?.toFixed(2) ?? '1.00'})</p></div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={0.5} max={2.0} step={0.05} value={s.copilotOrbSpeed ?? 1} onChange={e => setRange('copilotOrbSpeed', parseFloat(e.target.value))} />
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Trace Pinned</strong><p>Keep the trace feed expanded in the command deck</p></div>
              <button type="button" className={classes('nx-toggle', s.copilotMissionTracePinned && 'is-on')} onClick={() => toggle('copilotMissionTracePinned')} role="switch" aria-checked={s.copilotMissionTracePinned}><span className="nx-toggle__thumb" /></button>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Orb Placement</strong><p>Choose where the floating orb idles on screen</p></div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {ORB_PLACEMENTS.map(option => (
                    <button key={option.value} type="button" className={classes('nx-segmented__btn', s.orbPlacement === option.value && 'is-active')} onClick={() => setSelect('orbPlacement', option.value)}>{option.label}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Map ──────────────────────────────────────────────── */}
        <section className="nx-settings__group">
          <h2><Icon name="map" className="nx-settings__group-icon" /> Map</h2>
          <div className="nx-settings__list">
            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Map Theme</strong>
                <p>Base map tile style</p>
              </div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {MAP_THEMES.map(t => (
                    <button key={t.value} type="button" className={classes('nx-segmented__btn', s.mapTheme === t.value && 'is-active')} onClick={() => setSelect('mapTheme', t.value)}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Heat Palette</strong>
                <p>Color scheme for heatmap layer</p>
              </div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {HEAT_PALETTES.map(p => (
                    <button key={p.value} type="button" className={classes('nx-segmented__btn', s.heatPalette === p.value && 'is-active')} onClick={() => setSelect('heatPalette', p.value)}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Heat Intensity</strong>
                <p>Heatmap layer brightness ({s.heatIntensity.toFixed(1)})</p>
              </div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={0.2} max={2.0} step={0.1} value={s.heatIntensity} onChange={e => setRange('heatIntensity', parseFloat(e.target.value))} />
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Pulse Palette</strong>
                <p>Event pulse ring color scheme</p>
              </div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {PULSE_PALETTES.map(p => (
                    <button key={p.value} type="button" className={classes('nx-segmented__btn', s.pulsePalette === p.value && 'is-active')} onClick={() => setSelect('pulsePalette', p.value)}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Pulse Density</strong>
                <p>Event pulse frequency ({(s.pulseDensity * 100).toFixed(0)}%)</p>
              </div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={0.1} max={1.0} step={0.1} value={s.pulseDensity} onChange={e => setRange('pulseDensity', parseFloat(e.target.value))} />
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Default Zoom</strong>
                <p>Initial map zoom level ({s.defaultZoom})</p>
              </div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={3} max={12} step={1} value={s.defaultZoom} onChange={e => setRange('defaultZoom', parseInt(e.target.value))} />
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Show Labels</strong><p>Map text labels</p></div>
              <button type="button" className={classes('nx-toggle', s.showLabels && 'is-on')} onClick={() => toggle('showLabels')} role="switch" aria-checked={s.showLabels}><span className="nx-toggle__thumb" /></button>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Show Roads</strong><p>Road network overlay</p></div>
              <button type="button" className={classes('nx-toggle', s.showRoads && 'is-on')} onClick={() => toggle('showRoads')} role="switch" aria-checked={s.showRoads}><span className="nx-toggle__thumb" /></button>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Show POIs</strong><p>Points of interest</p></div>
              <button type="button" className={classes('nx-toggle', s.showPOIs && 'is-on')} onClick={() => toggle('showPOIs')} role="switch" aria-checked={s.showPOIs}><span className="nx-toggle__thumb" /></button>
            </div>
          </div>
        </section>

        {/* ── Signal Layers ────────────────────────────────────── */}
        <section className="nx-settings__group">
          <h2><Icon name="activity" className="nx-settings__group-icon" /> Signal Layers</h2>
          <div className="nx-settings__list">
            {LAYER_TOGGLES.map(layer => (
              <div key={layer.key} className="nx-setting-row">
                <div className="nx-setting-row__info"><strong>{layer.label}</strong></div>
                <button type="button" className={classes('nx-toggle', Boolean(s[layer.key]) && 'is-on')} onClick={() => toggle(layer.key)} role="switch" aria-checked={!!s[layer.key]}><span className="nx-toggle__thumb" /></button>
              </div>
            ))}
          </div>
        </section>

        {/* ── Map Advanced ─────────────────────────────────────── */}
        <section className="nx-settings__group">
          <h2><Icon name="map" className="nx-settings__group-icon" /> Map Advanced</h2>
          <div className="nx-settings__list">
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Map Brightness</strong><p>Basemap brightness ({s.mapBrightness.toFixed(1)})</p></div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={0.5} max={1.5} step={0.1} value={s.mapBrightness} onChange={e => setRange('mapBrightness', parseFloat(e.target.value))} />
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Atmospheric Intensity</strong><p>Glow and atmosphere ({(s.atmosphericIntensity * 100).toFixed(0)}%)</p></div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={0} max={1} step={0.05} value={s.atmosphericIntensity} onChange={e => setRange('atmosphericIntensity', parseFloat(e.target.value))} />
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Glow Intensity</strong><p>Marker glow strength ({(s.glowIntensity * 100).toFixed(0)}%)</p></div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={0} max={1} step={0.05} value={s.glowIntensity} onChange={e => setRange('glowIntensity', parseFloat(e.target.value))} />
              </div>
            </div>
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Label Density</strong><p>Map label frequency ({(s.labelDensity * 100).toFixed(0)}%)</p></div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={0} max={1} step={0.1} value={s.labelDensity} onChange={e => setRange('labelDensity', parseFloat(e.target.value))} />
              </div>
            </div>
          </div>
        </section>

        {/* ── Sound ────────────────────────────────────────────── */}
        <section className="nx-settings__group">
          <h2><Icon name="volume" className="nx-settings__group-icon" /> Sound</h2>
          <div className="nx-settings__list">
            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Sound Enabled</strong><p>Master audio toggle</p></div>
              <button type="button" className={classes('nx-toggle', s.soundEnabled && 'is-on')} onClick={() => toggle('soundEnabled')} role="switch" aria-checked={s.soundEnabled}><span className="nx-toggle__thumb" /></button>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Volume</strong>
                <p>{(s.soundVolume * 100).toFixed(0)}%</p>
              </div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={0} max={1} step={0.05} value={s.soundVolume} onChange={e => setRange('soundVolume', parseFloat(e.target.value))} />
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Sound Profile</strong>
                <p>Audio personality</p>
              </div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {SOUND_PROFILES.map(p => (
                    <button key={p.value} type="button" className={classes('nx-segmented__btn', s.soundProfile === p.value && 'is-active')} onClick={() => setSelect('soundProfile', p.value)}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="nx-settings__sub-header">Individual Sound Events</div>
            {SOUND_EVENTS.map(se => (
              <div key={se.key} className="nx-setting-row">
                <div className="nx-setting-row__info"><strong>{se.label}</strong></div>
                <div className="nx-setting-row__actions">
                  <button type="button" className="nx-inline-button" onClick={() => previewSound(se.event)}>Preview</button>
                  <button type="button" className={classes('nx-toggle', Boolean(s[se.key]) && 'is-on')} onClick={() => toggle(se.key)} role="switch" aria-checked={!!s[se.key]}><span className="nx-toggle__thumb" /></button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── UI ───────────────────────────────────────────────── */}
        <section className="nx-settings__group">
          <h2><Icon name="grid" className="nx-settings__group-icon" /> Interface</h2>
          <div className="nx-settings__list">
            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Density Mode</strong>
                <p>Information density</p>
              </div>
              <div className="nx-setting-row__control">
                <div className="nx-segmented">
                  {DENSITY_MODES.map(d => (
                    <button key={d.value} type="button" className={classes('nx-segmented__btn', s.densityMode === d.value && 'is-active')} onClick={() => setSelect('densityMode', d.value)}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Show Blades</strong><p>Home scene intelligence blades</p></div>
              <button type="button" className={classes('nx-toggle', s.showBlades && 'is-on')} onClick={() => toggle('showBlades')} role="switch" aria-checked={s.showBlades}><span className="nx-toggle__thumb" /></button>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info">
                <strong>Timeline Density</strong>
                <p>{s.timelineDensity} events</p>
              </div>
              <div className="nx-setting-row__control">
                <input type="range" className="nx-range" min={5} max={50} step={5} value={s.timelineDensity} onChange={e => setRange('timelineDensity', parseInt(e.target.value))} />
              </div>
            </div>

            <div className="nx-setting-row">
              <div className="nx-setting-row__info"><strong>Animations</strong><p>UI motion and transitions</p></div>
              <button type="button" className={classes('nx-toggle', s.animationsEnabled && 'is-on')} onClick={() => toggle('animationsEnabled')} role="switch" aria-checked={s.animationsEnabled}><span className="nx-toggle__thumb" /></button>
            </div>
          </div>
        </section>

        {/* ── Keyboard ─────────────────────────────────────────── */}
        <section className="nx-settings__group">
          <h2>Keyboard Commands</h2>
          <div className="nx-settings__shortcuts">
            <div className="nx-shortcut"><kbd>g h</kbd><span>Go Home (Live Dashboard)</span></div>
            <div className="nx-shortcut"><kbd>g i</kbd><span>Go Inbox</span></div>
            <div className="nx-shortcut"><kbd>g a</kbd><span>Go Alerts</span></div>
            <div className="nx-shortcut"><kbd>g s</kbd><span>Go Stats</span></div>
            <div className="nx-shortcut"><kbd>g p</kbd><span>Go Markets (Pipeline)</span></div>
            <div className="nx-shortcut"><kbd>g b</kbd><span>Go Buyer Intelligence</span></div>
            <div className="nx-shortcut"><kbd>g t</kbd><span>Go Title & Closing</span></div>
            <div className="nx-shortcut"><kbd>g w</kbd><span>Go Watchlists</span></div>
            <div className="nx-shortcut"><kbd>g d</kbd><span>Go Settings</span></div>
            <div className="nx-shortcut"><kbd>⌘K</kbd><span>Command Palette</span></div>
            <div className="nx-shortcut"><kbd>⌘M</kbd><span>Map Focus (on Live)</span></div>
            <div className="nx-shortcut"><kbd>⌘B</kbd><span>Battlefield Mode (on Live)</span></div>
            <div className="nx-shortcut"><kbd>x</kbd><span>Toggle Autopilot Approval</span></div>
            <div className="nx-shortcut"><kbd>n</kbd><span>Toggle Notifications</span></div>
          </div>
        </section>

        {/* ── About ────────────────────────────────────────────── */}
        <section className="nx-settings__group">
          <h2>About</h2>
          <div className="nx-settings__about">
            <p><strong>NEXUS</strong> Command Operating System</p>
            <p>React 19 · TypeScript · MapLibre GL · Vite</p>
          </div>
        </section>
      </div>
    </div>
  )
}
