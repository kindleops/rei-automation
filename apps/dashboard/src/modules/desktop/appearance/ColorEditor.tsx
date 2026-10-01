import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { motion } from 'framer-motion'
import { Icon } from '../../../shared/icons'
import { LCTooltip } from '../../../shared/lc'
import { LC_MOTION, useLcReducedMotion } from '../../../shared/lc/motion'
import { ACCENT_PRESETS } from '../../../shared/color/accents'
import { clamp, hsvToRgb, parseColor, rgbToHsl, rgbToHsv, rgbToOklch, toHex, type HSV } from '../../../shared/color/oklch'
import { Disclosure } from './controls'
import { Glyph } from './glyphs'
import { cx, useEscapeLayer, useFlash } from './hooks'

/**
 * THE COLOUR EDITOR — a LeadCommand surface, not the browser's picker.
 *
 * The chosen swatch expands into this field (shared layout morph) and
 * contracts back on Done. Dragging repaints the whole product live through
 * CSS variables (`onPreview`); nothing is stored until the gesture settles
 * or Done. Esc cancels the edit and restores the colour it opened with.
 *
 *   saturation / brightness field · hue rail · HEX (paste #22D3EE, 22D3EE,
 *   rgb(…), hsl(…)) · copy · eyedropper (only where the browser has one)
 *   · recent · saved · Advanced (RGB · HSL · OKLCH)
 */

interface EyeDropperCtor { new (): { open: () => Promise<{ sRGBHex: string }> } }
const eyeDropper = (): EyeDropperCtor | null =>
  typeof window !== 'undefined' && 'EyeDropper' in window ? (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper : null

const PRESET_NAME = new Map<string, string>(ACCENT_PRESETS.map((p) => [p.hex, p.label]))
/** Copy only exists where the browser can actually write to the clipboard. */
const canCopy = () => typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'

export interface ColorEditorProps {
  /** shared-layout id of the swatch this editor grows out of */
  morphId: string
  title: string
  value: string
  recent: string[]
  saved: string[]
  /** the engine had to move this colour noticeably to keep it readable */
  adjusted?: boolean
  onPreview: (hex: string) => void
  onDone: (hex: string) => void
  onCancel: () => void
  onToggleSaved: (hex: string) => void
  onRemove?: () => void
}

const hsvFromHex = (hex: string, fallbackHue = 190): HSV => {
  const rgb = parseColor(hex)
  if (!rgb) return { h: fallbackHue, s: 0.8, v: 0.85 }
  const hsv = rgbToHsv(rgb)
  return hsv.s === 0 ? { ...hsv, h: fallbackHue } : hsv
}

export function ColorEditor({ morphId, title, value, recent, saved, adjusted, onPreview, onDone, onCancel, onToggleSaved, onRemove }: ColorEditorProps) {
  const reduced = useLcReducedMotion()
  // the colour this edit started from (Cancel / Esc / Reset return to it)
  const [opening] = useState(value)
  const [hsv, setHsv] = useState<HSV>(() => hsvFromHex(value))
  const hex = useMemo(() => toHex(hsvToRgb(hsv)), [hsv])
  const [text, setText] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [flash, setFlash] = useFlash()
  const field = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const Dropper = eyeDropper()

  useEscapeLayer(true, () => { onPreview(opening); onCancel() })

  const set = (next: HSV, keepText = false) => {
    setHsv(next)
    if (!keepText) setText(null)
    onPreview(toHex(hsvToRgb(next)))
  }
  /** Apply any colour string the operator typed or pasted; false when it is not a colour. */
  const setHex = (h: string, keepText = false) => {
    const rgb = parseColor(h)
    if (!rgb) return false
    const next = rgbToHsv(rgb)
    set(next.s === 0 ? { ...next, h: hsv.h } : next, keepText)
    return true
  }

  /* ── pointer: field and rail ───────────────────────────────────────── */
  const drag = (el: HTMLDivElement | null, e: PointerEvent, apply: (x: number, y: number) => void) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    apply(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1))
  }
  const fieldAt = (x: number, y: number) => set({ h: hsv.h, s: x, v: 1 - y })
  const railAt = (x: number) => set({ ...hsv, h: Math.min(359.9, x * 360) })

  const onFieldKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key]
    if (!d) return
    e.preventDefault()
    set({ h: hsv.h, s: clamp(hsv.s + d[0], 0, 1), v: clamp(hsv.v + d[1], 0, 1) })
  }
  const onRailKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 2
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0
    if (!d) return
    e.preventDefault()
    set({ ...hsv, h: (hsv.h + d + 360) % 360 })
  }

  const rgb = hsvToRgb(hsv)
  const hsl = rgbToHsl(rgb)
  const lch = rgbToOklch(rgb)
  const name = PRESET_NAME.get(hex) ?? 'Custom'
  const isSaved = saved.includes(hex)
  const invalid = text !== null && !parseColor(text)

  // keep the copy-confirmation honest: only say "Copied" when the clipboard took it
  const copy = () => {
    void navigator.clipboard.writeText(hex).then(() => setFlash('Copied'), () => undefined)
  }

  const swatches = (list: string[], label: string) => (
    <div className="es-ce__swatches" role="listbox" aria-label={label}>
      {list.map((c) => (
        <button key={c} type="button" role="option" aria-selected={c === hex} aria-label={`${PRESET_NAME.get(c) ?? c}`} className={cx('es-ce__mini', c === hex && 'is-active')} style={{ ['--sw' as string]: c }} onClick={() => setHex(c)} />
      ))}
    </div>
  )

  return (
    <div className="es-ce" role="dialog" aria-label={`${title} colour`}>
      <div className="es-ce__main">
        <motion.div
          layoutId={morphId}
          className="es-ce__field"
          transition={reduced ? { duration: 0 } : LC_MOTION.color.swatchExpand}
          style={{ ['--hue' as string]: `${hsv.h}` }}
        >
          <div
            ref={field}
            className="es-ce__sv"
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag(field.current, e, fieldAt) }}
            onPointerMove={(e) => { if (e.buttons & 1) drag(field.current, e, fieldAt) }}
          >
            <span
              className="es-ce__thumb"
              role="slider"
              tabIndex={0}
              aria-label="Saturation and brightness"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(hsv.s * 100)}
              aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, ['--sw' as string]: hex }}
              onKeyDown={onFieldKey}
            />
          </div>
        </motion.div>
        <div
          ref={rail}
          className="es-ce__rail"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag(rail.current, e, (x) => railAt(x)) }}
          onPointerMove={(e) => { if (e.buttons & 1) drag(rail.current, e, (x) => railAt(x)) }}
        >
          <span
            className="es-ce__rail-thumb"
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv.h)}
            style={{ left: `${(hsv.h / 360) * 100}%`, ['--hue' as string]: `${hsv.h}` }}
            onKeyDown={onRailKey}
          />
        </div>
      </div>

      <div className="es-ce__side">
        <div className="es-ce__now">
          <span className="es-ce__chip" style={{ ['--sw' as string]: hex }} aria-hidden="true" />
          <span className="es-ce__now-copy">
            <b>{title}</b>
            <span>{name}{adjusted ? (
              <LCTooltip content="LeadCommand keeps your colour as the inspiration and uses a deeper or lighter version wherever it must stay readable.">
                <em className="es-ce__adjusted" tabIndex={0}>Adjusted for contrast</em>
              </LCTooltip>
            ) : null}</span>
          </span>
        </div>

        <div className="es-ce__hexrow">
          <label className={cx('es-ce__hex', invalid && 'is-invalid')}>
            <span>HEX</span>
            <input
              value={text ?? hex}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={invalid || undefined}
              aria-label="Colour value — paste HEX, rgb() or hsl()"
              onChange={(e) => { setText(e.target.value); setHex(e.target.value, true) }}
              onBlur={() => setText(null)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const typed = text === null ? null : parseColor(text)
                if (text !== null && !typed) return
                onDone(typed ? toHex(typed) : hex)
              }}
            />
          </label>
          {canCopy() ? (
            <LCTooltip content={flash ?? 'Copy HEX'}>
              <button type="button" className="es-ce__tool" onClick={copy} aria-label="Copy HEX">
                {flash ? <Icon name="check" size={14} strokeWidth={2.2} /> : <Glyph name="copy" />}
              </button>
            </LCTooltip>
          ) : null}
          {Dropper ? (
            <LCTooltip content="Pick from screen">
              <button type="button" className="es-ce__tool" aria-label="Pick a colour from the screen" onClick={() => { void new Dropper().open().then((r) => setHex(r.sRGBHex), () => undefined) }}>
                <Glyph name="eyedropper" />
              </button>
            </LCTooltip>
          ) : null}
        </div>

        {recent.length ? (
          <div className="es-ce__group">
            <span className="es-ce__label">Recent</span>
            {swatches(recent, 'Recent colours')}
          </div>
        ) : null}

        <div className="es-ce__group">
          <span className="es-ce__label">
            Saved
            <button type="button" className={cx('es-ce__save', isSaved && 'is-on')} aria-pressed={isSaved} onClick={() => onToggleSaved(hex)}>
              <Icon name="star" size={12} strokeWidth={1.9} />
              {isSaved ? 'Saved' : 'Save colour'}
            </button>
          </span>
          {saved.length ? swatches(saved, 'Saved colours') : <span className="es-ce__empty">Colours you save appear here.</span>}
        </div>

        <Disclosure label="Advanced" open={advanced} onToggle={() => setAdvanced((v) => !v)}>
          <div className="es-ce__adv">
            <span>RGB</span>
            <div className="es-ce__nums">
              {(['r', 'g', 'b'] as const).map((k) => (
                <input key={k} aria-label={k.toUpperCase()} inputMode="numeric" value={Math.round(rgb[k])} onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n) && n >= 0 && n <= 255) setHex(toHex({ ...rgb, [k]: n }))
                }} />
              ))}
            </div>
            <span>HSL</span>
            <div className="es-ce__nums">
              <input aria-label="Hue" inputMode="numeric" value={Math.round(hsl.h)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0 && n <= 360) setHex(`hsl(${n} ${hsl.s * 100}% ${hsl.l * 100}%)`) }} />
              <input aria-label="Saturation" inputMode="numeric" value={Math.round(hsl.s * 100)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0 && n <= 100) setHex(`hsl(${hsl.h} ${n}% ${hsl.l * 100}%)`) }} />
              <input aria-label="Lightness" inputMode="numeric" value={Math.round(hsl.l * 100)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0 && n <= 100) setHex(`hsl(${hsl.h} ${hsl.s * 100}% ${n}%)`) }} />
            </div>
            <span>OKLCH</span>
            <code className="es-ce__oklch">{`${(lch.l * 100).toFixed(1)}% ${lch.c.toFixed(3)} ${Math.round(lch.h)}°`}</code>
          </div>
        </Disclosure>
      </div>

      <footer className="es-ce__foot">
        <button type="button" className="es-ce__quiet" onClick={() => setHex(opening)} disabled={hex === (parseColor(opening) ? toHex(parseColor(opening)!) : hex)}>
          <Glyph name="reset" size={13} /> Reset
        </button>
        {onRemove ? (
          <button type="button" className="es-ce__quiet" onClick={onRemove}>
            <Glyph name="trash" size={13} /> Remove colour
          </button>
        ) : null}
        <span className="es-ce__spacer" />
        <button type="button" className="es-ce__btn" onClick={() => { onPreview(opening); onCancel() }}>Cancel</button>
        <button type="button" className="es-ce__btn is-primary" onClick={() => onDone(hex)}>Done</button>
      </footer>
    </div>
  )
}
