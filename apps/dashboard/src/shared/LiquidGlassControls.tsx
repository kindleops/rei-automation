/**
 * Liquid glass picker — presets as live glass swatches over a moving colour
 * field, then Blur / Transparency / Sheen sliders. Any slider move makes it
 * "Custom". Writes the one global setting (shared/liquid-glass.ts), so the Map,
 * sheets, menus and panels change together.
 */
import { useEffect, useState } from 'react'
import { subscribeSettings } from './settings'
import { LIQUID_GLASS_PRESETS, readLiquidGlass, setLiquidGlass, type LiquidGlassPrefs } from './liquid-glass'
import './liquid-glass-controls-ui.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

function Slider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <label className="lgc-slider">
      <span className="lgc-slider__head"><span>{label}</span><em>{Math.round(value)}{unit}</em></span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--lgc-pct' as string]: `${pct}%` }}
      />
    </label>
  )
}

export function LiquidGlassControls({ compact = false }: { compact?: boolean }) {
  const [prefs, setPrefs] = useState<LiquidGlassPrefs>(readLiquidGlass)
  useEffect(() => subscribeSettings(() => setPrefs(readLiquidGlass())), [])

  const pick = (id: LiquidGlassPrefs['preset']) => {
    const preset = LIQUID_GLASS_PRESETS.find((p) => p.id === id)
    const next: LiquidGlassPrefs = { preset: id, ...(preset?.values ?? { blur: prefs.blur, transparency: prefs.transparency, sheen: prefs.sheen }) }
    setPrefs(next)
    setLiquidGlass(next)
  }
  const tweak = (patch: Partial<LiquidGlassPrefs>) => {
    const next: LiquidGlassPrefs = { ...prefs, ...patch, preset: 'custom' }
    setPrefs(next)
    setLiquidGlass(next)
  }

  return (
    <div className={cls('lgc', compact && 'is-compact')}>
      <div className="lgc-presets" role="radiogroup" aria-label="Liquid glass">
        {LIQUID_GLASS_PRESETS.map((p) => {
          const active = prefs.preset === p.id
          return (
            <button key={p.id} type="button" role="radio" aria-checked={active} className={cls('lgc-preset', `is-${p.id}`, active && 'is-active')} onClick={() => pick(p.id)} data-glass-preset={p.id}>
              <span className="lgc-preset__stage" aria-hidden="true">
                <i className="lgc-preset__blob a" /><i className="lgc-preset__blob b" /><i className="lgc-preset__blob c" />
                <span className="lgc-preset__pane" />
              </span>
              <strong>{p.label}</strong>
              {!compact && <span>{p.sub}</span>}
            </button>
          )
        })}
      </div>
      <div className={cls('lgc-sliders', prefs.preset === 'theme' && 'is-idle')}>
        <Slider label="Blur" value={prefs.blur} min={0} max={60} unit="px" onChange={(v) => tweak({ blur: v })} />
        <Slider label="Transparency" value={prefs.transparency} min={0} max={100} unit="%" onChange={(v) => tweak({ transparency: v })} />
        <Slider label="Sheen" value={prefs.sheen} min={0} max={100} unit="%" onChange={(v) => tweak({ sheen: v })} />
      </div>
      {prefs.preset === 'custom' && <p className="lgc-note">Custom glass · applies across the whole system</p>}
    </div>
  )
}
