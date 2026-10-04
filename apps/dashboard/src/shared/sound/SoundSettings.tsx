import { useState, useSyncExternalStore } from 'react'
import { LCButton, LCSegmented, LCSelect, cx } from '../lc'
import { previewTyping, sound, type AlertCategory } from './index'
import { readSoundPrefs, subscribeSoundPrefs, writeSoundPrefs, type ExperienceSoundPrefs, type TypingMaterialPref } from './prefs'
import './sound-settings.css'

/**
 * SOUND & ALERTS — two separate decisions:
 *   Interface sounds  (taps, panels, drag & drop)   Off · Subtle · Full
 *   Operational alerts (what the machine tells you)  per alert type
 * Every control can be auditioned; nothing plays while a slider is moving.
 */

const ALERTS: Array<{ key: AlertCategory; label: string; hint: string; cue: 'ready' | 'attention' | 'error' | 'success' | 'warning' }> = [
  { key: 'sellerReplies', label: 'Seller replies', hint: 'A new reply arrives', cue: 'ready' },
  { key: 'needsAttention', label: 'Needs you', hint: 'Automation stops for a person', cue: 'attention' },
  { key: 'sendFailures', label: 'Send failures', hint: 'A message could not be delivered', cue: 'error' },
  { key: 'campaignCompletion', label: 'Campaign completion', hint: 'A campaign finishes', cue: 'success' },
  { key: 'closingMilestones', label: 'Closing milestones', hint: 'Clear to close, closed', cue: 'success' },
  { key: 'workflowHolds', label: 'Workflow holds', hint: 'A run waits for approval', cue: 'attention' },
  { key: 'systemDegradation', label: 'System degradation', hint: 'A runtime falls behind', cue: 'warning' },
]

const MATERIAL_LABEL: Record<ExperienceSoundPrefs['material'], string> = { mech: 'Mechanical', default: 'Glass', press: 'Press' }
const TYPING_HINT: Record<Exclude<TypingMaterialPref, 'follow'>, string> = {
  mech: 'Bright click, felt plate, key-return snap',
  default: 'A soft tick that rings like glass',
  press: 'One crisp premium switch',
  bubble: 'Soft pitched blips',
}

const usePrefs = () => useSyncExternalStore(subscribeSoundPrefs, readSoundPrefs, readSoundPrefs)

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx('snd-switch', on && 'is-on')} onClick={() => { onChange(!on); sound.ui.toggle(!on) }}>
      <i aria-hidden="true" />
    </button>
  )
}

export function SoundSettings() {
  const prefs = usePrefs()
  // volume is previewed on release, persisted on release — never per pixel
  const [draftVolume, setDraftVolume] = useState<number | null>(null)
  const volume = draftVolume ?? prefs.volume
  const set = (patch: Partial<ExperienceSoundPrefs>) => writeSoundPrefs(patch)
  const [draftTyping, setDraftTyping] = useState<number | null>(null)
  const typingVolume = draftTyping ?? prefs.typingVolume
  const commitTyping = () => { if (draftTyping !== null) { set({ typingVolume: draftTyping }); previewTyping({ volume: draftTyping }); setDraftTyping(null) } }
  const typingOptions: Array<{ value: TypingMaterialPref; label: string; hint: string }> = [
    { value: 'follow', label: `Match sound material (${MATERIAL_LABEL[prefs.material]})`, hint: 'Follows the material above' },
    { value: 'mech', label: 'Mechanical', hint: TYPING_HINT.mech },
    { value: 'default', label: 'Glass', hint: TYPING_HINT.default },
    { value: 'press', label: 'Press', hint: TYPING_HINT.press },
    { value: 'bubble', label: 'Bubble', hint: TYPING_HINT.bubble },
  ]

  return (
    <div className="snd">
      <section className="snd-sec" aria-label="Interface sounds">
        <header><b>Interface sounds</b><small>Taps, panels, drag and drop. Subtle plays only what matters.</small></header>
        <LCSegmented
          label="Interface sounds"
          value={prefs.interface}
          onChange={(v) => { set({ interface: v }); if (v !== 'off') sound.preview('select') }}
          options={[{ value: 'off', label: 'Off' }, { value: 'subtle', label: 'Subtle' }, { value: 'full', label: 'Full' }]}
        />
        <div className="snd-row">
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(volume * 100)}
            aria-label="Sound volume"
            onChange={(e) => setDraftVolume(Number(e.target.value) / 100)}
            onPointerUp={() => { if (draftVolume !== null) { set({ volume: draftVolume }); setDraftVolume(null); sound.preview('tap') } }}
            onKeyUp={() => { if (draftVolume !== null) { set({ volume: draftVolume }); setDraftVolume(null); sound.preview('tap') } }}
          />
          <b className="snd-num">{Math.round(volume * 100)}%</b>
        </div>
        <div className="snd-row">
          <span>Material</span>
          <LCSegmented
            label="Sound material"
            size="sm"
            value={prefs.material}
            onChange={(v) => { set({ material: v }); sound.preview('select', { material: v }) }}
            options={[{ value: 'mech', label: 'Mechanical' }, { value: 'default', label: 'Glass' }, { value: 'press', label: 'Press' }]}
          />
        </div>
        {prefs.interface !== 'off' ? (
          <div className="snd-row">
            <span>Typing sounds<small>Very quiet keystrokes in text fields. Never in password fields.</small></span>
            <Toggle on={prefs.typing} onChange={(typing) => { set({ typing }); if (typing) previewTyping() }} label="Typing sounds" />
          </div>
        ) : null}
        {prefs.interface !== 'off' && prefs.typing ? (
          <div className="snd-typing">
            <div className="snd-row">
              <span>Typing material</span>
              <LCSelect
                label="Typing material"
                size="sm"
                value={prefs.typingMaterial}
                options={typingOptions}
                onChange={(v) => { set({ typingMaterial: v }); previewTyping({ material: v === 'follow' ? prefs.material : v }) }}
              />
            </div>
            <div className="snd-row">
              <span>Typing volume</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(typingVolume * 100)}
                aria-label="Typing volume"
                onChange={(e) => setDraftTyping(Number(e.target.value) / 100)}
                onPointerUp={commitTyping}
                onKeyUp={commitTyping}
              />
              <b className="snd-num">{Math.round(typingVolume * 100)}%</b>
            </div>
            <div className="snd-row">
              <span><small>Plays under the main volume. Shortcuts, arrows and held keys stay silent.</small></span>
              <LCButton variant="ghost" size="sm" onClick={() => previewTyping()} aria-label="Preview typing sounds">Preview</LCButton>
            </div>
          </div>
        ) : null}
      </section>

      <section className="snd-sec" aria-label="Operational alerts">
        <header>
          <b>Operational alerts</b>
          <small>What the machine tells you. Routine sending stays silent; one event makes one sound.</small>
          <Toggle on={prefs.alerts} onChange={(alerts) => set({ alerts })} label="Operational alerts" />
        </header>
        <ul className={cx('snd-alerts', !prefs.alerts && 'is-off')}>
          {ALERTS.map((a) => (
            <li key={a.key}>
              <span className="snd-alerts__copy"><b>{a.label}</b><small>{a.hint}</small></span>
              <LCButton variant="ghost" size="sm" onClick={() => sound.preview(a.cue)} aria-label={`Preview ${a.label}`}>Preview</LCButton>
              <Toggle on={prefs.alertTypes[a.key]} onChange={(v) => set({ alertTypes: { ...prefs.alertTypes, [a.key]: v } })} label={a.label} />
            </li>
          ))}
        </ul>
        <div className="snd-row">
          <span>When LeadCommand is in the background</span>
          <LCSegmented
            label="Background alerts"
            size="sm"
            value={prefs.background}
            onChange={(v) => set({ background: v })}
            options={[{ value: 'critical', label: 'Critical only' }, { value: 'off', label: 'Silent' }]}
          />
        </div>
      </section>
    </div>
  )
}
