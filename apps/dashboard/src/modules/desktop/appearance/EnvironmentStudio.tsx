import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion'
import { Icon } from '../../../shared/icons'
import { LCMenu, LCSegmented, LCTooltip, lcMenu } from '../../../shared/lc'
import { LC_MOTION, useLcReducedMotion } from '../../../shared/lc/motion'
import { sound } from '../../../shared/sound'
import { updateSetting, type AccentPalette, type NexusTheme } from '../../../shared/settings'
import { ACCENT_PRESETS, accentPresetLabel } from '../../../shared/color/accents'
import {
  ENVIRONMENT_TYPES, GLASS_PRESET_VALUES, PALETTE_MAX, PALETTE_MIN, materialFamily, nextEnvironmentName, snapshotOf, snapshotsEqual,
  type EnvironmentState, type EnvironmentType, type MaterialState, type MotionLevel, type SavedEnvironment,
} from '../../../shared/color/appearance'
import { FOUNDATIONS, GLASS_FAMILIES, HARMONY_IDS, deriveAccent, harmonyPalette, type EdgeLevel, type FoundationId, type GlassFamily, type HarmonyId } from '../../../shared/color/derive'
import { clamp, normalizeHex, parseColor, toHex } from '../../../shared/color/oklch'
import { ColorEditor } from './ColorEditor'
import { Disclosure, Section, StudioSlider, StudioSwitch } from './controls'
import { Glyph } from './glyphs'
import { cx, useEscapeLayer, useFlash } from './hooks'
import { EnvironmentStage, EnvironmentThumb, EnvironmentTile, GlassTile, LiveSample } from './previews'
import {
  BUILT_INS, applyEnvironment, commitAppearance, deleteSavedEnvironment, duplicateSavedEnvironment, flushPreview, previewAppearance,
  rememberColor, renameSavedEnvironment, resetAccent, resetEnvironment, resetEverything, resetMaterial, restoreEnvironment, saveCurrentEnvironment, themeDefaultAccent,
  toggleFavoriteColor, undoAppearance, useAppearanceView, useUndoAvailable, type AppearanceView,
} from './use-appearance'
import './studio.css'

/**
 * LEADCOMMAND ENVIRONMENT STUDIO 3.0
 *
 * The operator controls mood — theme foundation, environment, colour,
 * material, motion. LeadCommand controls usability: every choice runs through
 * the colour engine (shared/color) and comes out contrast-safe, with semantic
 * colours untouched. Everything previews live against the real product; there
 * is no Apply button. Discrete choices commit at once inside one coherent
 * transition; drags repaint through CSS variables and persist when they settle.
 *
 * Rendered by the Operator panel (Appearance tab) and the Settings page.
 */

export interface EnvironmentStudioProps {
  variant?: 'panel' | 'page'
  /** Switch the host to Sound & Alerts (the panel owns its tabs). */
  onOpenSound?: () => void
  /** The colour editor asks its host for room: the panel widens while it is open. */
  onExpandChange?: (expanded: boolean) => void
}

const THEMES: Array<{ value: FoundationId; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'true_black', label: 'True Black' },
  { value: 'red_ops', label: 'Red Ops' },
]
const ENV_LABEL: Record<EnvironmentType, string> = { liquid: 'Liquid', waves: 'Waves', aurora: 'Aurora', still: 'Still', custom: 'Custom' }
const HARMONY_LABEL: Record<HarmonyId, string> = { analogous: 'Analogous', monochrome: 'Monochrome', complement: 'Complement', 'deep-aurora': 'Deep Aurora', 'cool-glass': 'Cool Glass' }
const GLASS_LABEL: Record<GlassFamily, string> = { clear: 'Clear', crystal: 'Crystal', frosted: 'Frosted', smoke: 'Smoke' }
const MOTION_OPTIONS: Array<{ value: MotionLevel; label: string }> = [
  { value: 'still', label: 'Still' },
  { value: 'calm', label: 'Calm' },
  { value: 'fluid', label: 'Fluid' },
]
const EDGE_OPTIONS: Array<{ value: EdgeLevel; label: string }> = [
  { value: 'soft', label: 'Soft' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'crisp', label: 'Crisp' },
]

/** What is being edited — and what Cancel / Esc restores if opening it changed anything. */
type Editing =
  | { kind: 'accent'; restoreAccent?: AccentPalette }
  | { kind: 'anchor'; index: number; restoreEnv?: EnvironmentState }
  | null

const pct = (v: number) => `${Math.round(v)}%`

function summaryOf(v: AppearanceView): string {
  const theme = THEMES.find((t) => t.value === v.foundation)?.label ?? 'Dark'
  const accent = v.accentPalette === 'custom' ? 'Custom colour' : accentPresetLabel(v.accentPalette)
  return `${theme} · ${ENV_LABEL[v.appearance.environment.type]} · ${accent} · ${GLASS_LABEL[materialFamily(v.liquidGlass)]} · ${MOTION_OPTIONS.find((m) => m.value === v.appearance.motion)?.label}`
}

/** The anchors the environment is painted from, as the operator sees them (source colours). */
function sourceAnchors(v: AppearanceView): string[] {
  const env = v.appearance.environment
  if (!env.autoHarmony) return env.palette
  const src = parseColor(v.accentPalette === 'custom' ? v.appearance.accent.custom : ACCENT_PRESETS.find((p) => p.id === v.accentPalette)?.hex)
  return harmonyPalette(src ?? { r: 6, g: 182, b: 212 }, env.harmony).map(toHex)
}

export function EnvironmentStudio({ variant = 'panel', onOpenSound, onExpandChange }: EnvironmentStudioProps) {
  const view = useAppearanceView()
  const undoAvailable = useUndoAvailable()
  const reduced = useLcReducedMotion()
  const [editing, setEditing] = useState<Editing>(null)
  const [compose, setCompose] = useState(false)
  const [materialAdvanced, setMaterialAdvanced] = useState(false)
  // Esc closes this menu first, never the panel behind it
  const [resetOpen, setResetOpen] = useState(false)
  useEscapeLayer(resetOpen, () => setResetOpen(false))

  const env = view.appearance.environment
  const family = materialFamily(view.liquidGlass)
  const moving = view.animationsEnabled && view.appearance.motion !== 'still' && !reduced
  const foundation = FOUNDATIONS[view.foundation]

  // the colour editor needs room: the host (the panel) widens while it is open
  const openEditor = (target: NonNullable<Editing>) => {
    sound.panel.open()
    setEditing(target)
    onExpandChange?.(true)
  }
  useEffect(() => () => onExpandChange?.(false), [onExpandChange])

  /* ── writes ─────────────────────────────────────────────────────────── */
  const setEnv = (patch: Partial<EnvironmentState>, live = false) => {
    const next = { ...view.appearance, environment: { ...view.appearance.environment, ...patch } }
    if (live) previewAppearance({ appearance: next })
    else commitAppearance({ appearance: next })
  }
  const setMaterial = (patch: Partial<MaterialState>, live = false) => {
    const current = view.liquidGlass
    const fam = materialFamily(current)
    // any advanced tweak turns the preset into "custom" glass of the same family
    const base = current.preset === 'theme' ? { ...current, ...GLASS_PRESET_VALUES.crystal } : current
    const next: MaterialState = { ...base, ...patch, preset: 'custom', base: fam }
    if (live) previewAppearance({ liquidGlass: next })
    else commitAppearance({ liquidGlass: next }, { transition: 'material' })
  }
  const settle = () => flushPreview({ endGesture: true })

  /* ── theme ──────────────────────────────────────────────────────────── */
  const selectTheme = (id: FoundationId) => {
    if (id === view.foundation && id === view.nexusTheme) return
    sound.ui.select()
    commitAppearance({ nexusTheme: id as NexusTheme }, { transition: 'theme' })
  }

  /* ── accent ─────────────────────────────────────────────────────────── */
  const presetSwatches = useMemo(() => ACCENT_PRESETS.map((p) => ({
    ...p,
    // the swatch shows the colour this theme will actually use
    shown: toHex(deriveAccent(foundation, parseColor(p.hex)!, 50).base),
  })), [foundation])
  const selectPreset = (id: AccentPalette) => {
    if (id === view.accentPalette) return
    sound.ui.select()
    commitAppearance({ accentPalette: id }, { transition: 'accent' })
  }
  const openAccentEditor = () => {
    const from = view.accentPalette
    if (from !== 'custom') commitAppearance({ accentPalette: 'custom' }, { transition: 'accent' })
    openEditor({ kind: 'accent', restoreAccent: from !== 'custom' ? from : undefined })
  }
  const closeEditor = (hex?: string) => {
    if (hex) rememberColor(hex)
    sound.panel.close()
    setEditing(null)
    onExpandChange?.(false)
  }
  const themeDefault = themeDefaultAccent(view.foundation)
  const accentIsDefault = view.accentPalette === themeDefault.palette
    && (themeDefault.palette !== 'custom' || normalizeHex(view.appearance.accent.custom) === normalizeHex(themeDefault.custom))
    && view.appearance.accent.intensity === 50

  /* ── environment palette ────────────────────────────────────────────── */
  const anchors = sourceAnchors(view)
  const accentSource = parseColor(view.accentPalette === 'custom' ? view.appearance.accent.custom : ACCENT_PRESETS.find((p) => p.id === view.accentPalette)?.hex) ?? { r: 6, g: 182, b: 212 }
  const editAnchor = (index: number) => {
    if (env.autoHarmony) commitAppearance({ appearance: { ...view.appearance, environment: { ...env, autoHarmony: false, palette: anchors.slice(0, PALETTE_MAX) } } })
    openEditor({ kind: 'anchor', index, restoreEnv: env.autoHarmony ? env : undefined })
  }
  const addAnchor = () => {
    if (anchors.length >= PALETTE_MAX) return
    const pool = harmonyPalette(parseColor(anchors[0]) ?? { r: 6, g: 182, b: 212 }, 'deep-aurora').map(toHex)
    const extra = pool.find((c) => !anchors.includes(c)) ?? pool[pool.length - 1]
    const palette = [...anchors, extra]
    commitAppearance({ appearance: { ...view.appearance, environment: { ...env, autoHarmony: false, palette } } })
    // Cancel on a just-added colour takes the colour away again
    openEditor({ kind: 'anchor', index: palette.length - 1, restoreEnv: env })
  }
  const removeAnchor = (index: number) => {
    if (anchors.length <= PALETTE_MIN) return
    commitAppearance({ appearance: { ...view.appearance, environment: { ...env, autoHarmony: false, palette: anchors.filter((_, i) => i !== index) } } })
    closeEditor()
  }

  const editorFor = (target: NonNullable<Editing>) => {
    const isAccent = target.kind === 'accent'
    const value = isAccent ? view.appearance.accent.custom : (anchors[target.index] ?? anchors[0])
    return (
      <ColorEditor
        key={isAccent ? 'accent' : `anchor-${target.index}`}
        morphId={isAccent ? 'es-swatch-custom' : `es-anchor-${target.index}`}
        title={isAccent ? 'Accent' : `Environment colour ${target.index + 1}`}
        value={value}
        recent={view.library.recentColors}
        saved={view.library.savedColors}
        adjusted={isAccent && view.computed.accent.adjusted}
        onPreview={(hex) => {
          if (isAccent) previewAppearance({ accentPalette: 'custom', appearance: { ...view.appearance, accent: { ...view.appearance.accent, custom: hex } } })
          else {
            const palette = [...env.palette]
            palette[target.index] = hex
            previewAppearance({ appearance: { ...view.appearance, environment: { ...env, autoHarmony: false, palette } } })
          }
        }}
        onDone={(hex) => { flushPreview({ endGesture: true }); closeEditor(hex) }}
        onCancel={() => {
          flushPreview({ endGesture: true, undoable: false })
          // Cancel restores at once — no transition for undoing an edit
          if (target.kind === 'accent' && target.restoreAccent) commitAppearance({ accentPalette: target.restoreAccent }, { undoable: false })
          if (target.kind === 'anchor' && target.restoreEnv) restoreEnvironment(target.restoreEnv)
          closeEditor()
        }}
        onToggleSaved={(hex) => toggleFavoriteColor(hex)}
        onRemove={!isAccent && anchors.length > PALETTE_MIN ? () => removeAnchor(target.index) : undefined}
      />
    )
  }

  /* ── render ─────────────────────────────────────────────────────────── */
  const resetItems = lcMenu(
    [
      { label: 'Accent to theme default', icon: 'palette', disabled: accentIsDefault, reason: 'Already the theme default', onSelect: () => resetAccent(view) },
      { label: 'Environment', icon: 'layers', onSelect: () => resetEnvironment(view) },
      { label: 'Material', icon: 'grid', onSelect: () => resetMaterial() },
    ],
    [{ label: 'Everything — LeadCommand Dark', icon: 'refresh-cw', hint: 'Undo stays available', onSelect: () => resetEverything() }],
  )

  return (
    <LayoutGroup id="lc-env-studio">
      <div className={cx('es', `is-${variant}`, editing && 'is-editing')} data-foundation={view.foundation}>
        <header className="es-hero">
          <LiveSample type={env.type} />
          <div className="es-hero__meta">
          <span className="es-hero__summary">{summaryOf(view)}</span>
          <div className="es-hero__actions">
            {undoAvailable ? (
              <LCTooltip content="Undo last appearance change">
                <button type="button" className="es-iconbtn" aria-label="Undo last appearance change" onClick={() => { sound.ui.select('back'); undoAppearance() }}>
                  <Glyph name="undo" />
                </button>
              </LCTooltip>
            ) : null}
            <LCMenu
              label="Reset appearance"
              open={resetOpen}
              onOpenChange={setResetOpen}
              items={resetItems}
              trigger={(
                <button type="button" className="es-iconbtn" aria-label="Reset">
                  <Glyph name="reset" />
                </button>
              )}
            />
          </div>
          </div>
        </header>

        <div className="es-cols">
          <div className="es-col">
            <Section title="Theme">
              <LCSegmented<FoundationId>
                className="es-themes"
                label="Theme"
                value={view.foundation}
                onChange={selectTheme}
                options={THEMES.map((t) => ({ value: t.value, label: t.label, accessory: <i className={cx('es-themedot', `is-${t.value}`)} aria-hidden="true" /> }))}
              />
            </Section>

            <Section
              title="Environment"
              aside={<span className="es-quiet">{env.autoHarmony ? 'Follows your accent' : 'Your palette'}</span>}
            >
              <div className="es-envtiles" role="radiogroup" aria-label="Environment">
                {ENVIRONMENT_TYPES.map((t) => (
                  <EnvironmentTile
                    key={t}
                    type={t}
                    label={ENV_LABEL[t]}
                    active={env.type === t}
                    moving={moving}
                    onSelect={() => { if (env.type !== t) { sound.ui.select(); setEnv({ type: t }) } }}
                  />
                ))}
              </div>

              <div className="es-palette">
                <span className="es-label">Colours</span>
                <div className="es-anchors">
                  {anchors.map((hex, i) => {
                    const open = editing?.kind === 'anchor' && editing.index === i
                    return (
                      <LCTooltip key={`${i}-${hex}`} content={env.autoHarmony ? 'Edit — switches to your own palette' : 'Edit colour'}>
                        <button type="button" className={cx('es-anchor', open && 'is-open')} aria-label={`Environment colour ${i + 1}`} onClick={() => (open ? closeEditor() : editAnchor(i))}>
                          {open ? <span className="es-anchor__ring" /> : <motion.span layoutId={`es-anchor-${i}`} className="es-anchor__disc" style={{ background: hex }} transition={reduced ? { duration: 0 } : LC_MOTION.color.swatchCollapse} />}
                        </button>
                      </LCTooltip>
                    )
                  })}
                  {!env.autoHarmony && anchors.length < PALETTE_MAX ? (
                    <LCTooltip content="Add a colour">
                      <button type="button" className="es-anchor is-add" aria-label="Add an environment colour" onClick={addAnchor}><Glyph name="plus" size={13} /></button>
                    </LCTooltip>
                  ) : null}
                </div>
                <StudioSwitch
                  label="Auto harmony"
                  on={env.autoHarmony}
                  hint="Generate the environment colours from your accent"
                  onChange={(on) => { sound.ui.select(); setEnv(on ? { autoHarmony: true } : { autoHarmony: false, palette: anchors.slice(0, PALETTE_MAX) }) }}
                />
              </div>

              {env.autoHarmony ? (
                <div className="es-harmonies" role="radiogroup" aria-label="Harmony">
                  {HARMONY_IDS.map((h) => {
                    const [h1, h2, h3, h4] = harmonyPalette(accentSource, h).map(toHex)
                    return (
                      <button
                        key={h}
                        type="button"
                        role="radio"
                        aria-checked={env.harmony === h}
                        className={cx('es-harmony', env.harmony === h && 'is-active')}
                        style={{ ['--h1' as string]: h1, ['--h2' as string]: h2, ['--h3' as string]: h3, ['--h4' as string]: h4 }}
                        onClick={() => { if (env.harmony !== h) { sound.ui.select(); setEnv({ harmony: h }) } }}
                      >
                        <span className="es-harmony__bar" aria-hidden="true" />
                        <span className="es-harmony__name">{HARMONY_LABEL[h]}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}

              <AnimatePresence initial={false}>
                {editing?.kind === 'anchor' ? (
                  <motion.div key="anchor-editor" className="es-editor-slot" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
                    {editorFor(editing)}
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <StudioSlider
                label="Intensity"
                track="environment"
                value={env.intensity}
                format={pct}
                onPreview={(v) => setEnv({ intensity: v }, true)}
                onSettle={settle}
              />

              <Disclosure label="Compose" open={compose} onToggle={() => setCompose((v) => !v)}>
                <div className="es-compose">
                  <StudioSlider label="Blend" ends={['Soft', 'Deep']} value={env.blend} onPreview={(v) => setEnv({ blend: v }, true)} onSettle={settle} />
                  <StudioSlider label="Spread" ends={['Focused', 'Ambient']} value={env.spread} onPreview={(v) => setEnv({ spread: v }, true)} onSettle={settle} />
                  <StudioSlider label="Depth" ends={['Flat', 'Spatial']} value={env.depth} onPreview={(v) => setEnv({ depth: v }, true)} onSettle={settle} />
                  <StudioSlider label="Luminosity" track="luminosity" ends={['Dim', 'Luminous']} value={env.luminosity} onPreview={(v) => setEnv({ luminosity: v }, true)} onSettle={settle} />
                  <StudioSlider label="Temperature" track="temperature" ends={['Cool', 'Warm']} format={(v) => (v < 40 ? 'Cool' : v > 60 ? 'Warm' : 'Neutral')} value={env.temperature} onPreview={(v) => setEnv({ temperature: v }, true)} onSettle={settle} />
                  {env.type === 'custom' ? <FocalPad view={view} onPreview={(x, y) => setEnv({ focalX: x, focalY: y }, true)} onSettle={settle} /> : null}
                  <button type="button" className="es-link" onClick={() => resetEnvironment(view)}><Glyph name="reset" size={12} /> Reset environment</button>
                </div>
              </Disclosure>
            </Section>

            <Section
              title="Colour"
              aside={!accentIsDefault ? <button type="button" className="es-link" onClick={() => resetAccent(view)}>Reset to theme default</button> : null}
            >
              <div className="es-swatches" role="radiogroup" aria-label="Primary accent">
                {presetSwatches.map((p) => (
                  <LCTooltip key={p.id} content={p.label}>
                    <button type="button" role="radio" aria-checked={view.accentPalette === p.id} aria-label={p.label} className={cx('es-swatch', view.accentPalette === p.id && 'is-active')} style={{ ['--sw' as string]: p.shown }} onClick={() => selectPreset(p.id)} />
                  </LCTooltip>
                ))}
                <LCTooltip content={view.accentPalette === 'custom' ? 'Edit custom colour' : 'Custom colour'}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={view.accentPalette === 'custom'}
                    aria-label="Custom colour"
                    aria-expanded={editing?.kind === 'accent'}
                    className={cx('es-swatch is-custom', view.accentPalette === 'custom' && 'is-active')}
                    onClick={() => (editing?.kind === 'accent' ? closeEditor() : openAccentEditor())}
                  >
                    {editing?.kind === 'accent'
                      ? <span className="es-swatch__ring" />
                      : <motion.span layoutId="es-swatch-custom" className="es-swatch__disc" style={{ background: view.appearance.accent.custom }} transition={reduced ? { duration: 0 } : LC_MOTION.color.swatchCollapse} />}
                    <span className="es-swatch__plus" aria-hidden="true"><Glyph name="plus" size={9} /></span>
                  </button>
                </LCTooltip>
              </div>

              <AnimatePresence initial={false}>
                {editing?.kind === 'accent' ? (
                  <motion.div key="accent-editor" className="es-editor-slot" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
                    {editorFor(editing)}
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <StudioSlider
                label="Accent intensity"
                track="accent"
                value={view.appearance.accent.intensity}
                format={(v) => (v < 35 ? 'Quiet' : v > 65 ? 'Vivid' : 'Balanced')}
                onPreview={(v) => previewAppearance({ appearance: { ...view.appearance, accent: { ...view.appearance.accent, intensity: v } } })}
                onSettle={settle}
              />
              {view.computed.accent.reserved ? (
                <p className="es-note">
                  <Icon name="shield" size={12} />
                  Red keeps meaning failure — selection and focus stay neutral with this accent.
                </p>
              ) : view.accentPalette === 'custom' && view.computed.accent.adjusted ? (
                <p className="es-note">
                  <Icon name="check" size={12} />
                  Adjusted for contrast — your colour stays the inspiration; text and controls use a readable version.
                </p>
              ) : null}
            </Section>
          </div>

          <div className="es-col">
            <Section
              title="Material"
              aside={view.computed.material.clamped ? <LCTooltip content="This environment is bright behind the glass, so the glass keeps enough body for text to stay readable."><span className="es-quiet is-info">Kept readable</span></LCTooltip> : null}
            >
              <div className="es-glasses" role="radiogroup" aria-label="Glass material">
                {GLASS_FAMILIES.map((f) => (
                  <GlassTile
                    key={f}
                    family={f}
                    label={GLASS_LABEL[f]}
                    active={family === f}
                    computed={view.computed}
                    current={view.liquidGlass}
                    type={env.type}
                    onSelect={() => {
                      if (family === f && view.liquidGlass.preset !== 'custom') return
                      sound.ui.select()
                      const values = GLASS_PRESET_VALUES[f]
                      commitAppearance({ liquidGlass: { preset: f === 'crystal' ? 'theme' : f, ...values, edge: view.liquidGlass.edge ?? 'balanced' } }, { transition: 'material' })
                    }}
                  />
                ))}
              </div>
              <Disclosure
                label="Advanced"
                open={materialAdvanced}
                onToggle={() => setMaterialAdvanced((v) => !v)}
                badge={view.liquidGlass.preset === 'custom' || view.liquidGlass.preset === 'crystal' ? <span className="es-badge">Adjusted</span> : null}
              >
                <MaterialAdvanced view={view} onPreview={(p) => setMaterial(p, true)} onSettle={settle} onEdge={(edge) => { sound.ui.select(); commitAppearance({ liquidGlass: { ...view.liquidGlass, edge } }, { transition: 'material' }) }} />
              </Disclosure>
            </Section>

            <Section title="Behaviour" aside={onOpenSound ? <button type="button" className="es-link" onClick={onOpenSound}>Sound &amp; Alerts <Icon name="chevron-right" size={11} /></button> : null}>
              <div className="es-row">
                <span className="es-label">Motion</span>
                <LCSegmented<MotionLevel>
                  label="Environment motion"
                  size="sm"
                  value={view.appearance.motion}
                  options={MOTION_OPTIONS}
                  onChange={(m) => { sound.ui.select(); commitAppearance({ appearance: { ...view.appearance, motion: m } }) }}
                />
              </div>
              <div className="es-row">
                <span className="es-label">Interface</span>
                <StudioSwitch
                  label="Reduce motion"
                  on={!view.animationsEnabled}
                  hint="Stills every interface animation and the environment (the system reduce-motion setting is always honoured)"
                  onChange={(on) => { updateSetting('animationsEnabled', !on) }}
                />
              </div>
            </Section>

            <SavedEnvironments view={view} />
          </div>
        </div>
      </div>
    </LayoutGroup>
  )
}

/* ── material advanced ─────────────────────────────────────────────────── */

function MaterialAdvanced({ view, onPreview, onSettle, onEdge }: { view: AppearanceView; onPreview: (p: Partial<MaterialState>) => void; onSettle: () => void; onEdge: (e: EdgeLevel) => void }) {
  const m = view.liquidGlass.preset === 'theme' ? { ...view.liquidGlass, ...GLASS_PRESET_VALUES.crystal } : view.liquidGlass
  return (
    <div className="es-compose">
      <StudioSlider label="Blur" min={6} max={48} value={clamp(m.blur, 6, 48)} format={(v) => `${Math.round(v)} px`} onPreview={(v) => onPreview({ blur: v })} onSettle={onSettle} />
      <StudioSlider label="Transparency" value={m.transparency} format={pct} onPreview={(v) => onPreview({ transparency: v })} onSettle={onSettle} />
      <StudioSlider label="Sheen" value={m.sheen} format={pct} onPreview={(v) => onPreview({ sheen: v })} onSettle={onSettle} />
      <div className="es-row">
        <span className="es-label">Edge</span>
        <LCSegmented<EdgeLevel> label="Edge definition" size="sm" value={view.liquidGlass.edge ?? 'balanced'} options={EDGE_OPTIONS} onChange={onEdge} />
      </div>
      <button type="button" className="es-link" onClick={() => resetMaterial()}><Glyph name="reset" size={12} /> Reset material</button>
    </div>
  )
}

/* ── custom focal point ────────────────────────────────────────────────── */

function FocalPad({ view, onPreview, onSettle }: { view: AppearanceView; onPreview: (x: number, y: number) => void; onSettle: () => void }) {
  // the dragged position lives here (only this pad re-renders while dragging)
  const [live, setLive] = useState<{ x: number; y: number } | null>(null)
  const focalX = live?.x ?? view.appearance.environment.focalX
  const focalY = live?.y ?? view.appearance.environment.focalY
  const move = (x: number, y: number) => {
    const next = { x: Number(clamp(x, 0, 1).toFixed(3)), y: Number(clamp(y, 0, 1).toFixed(3)) }
    setLive(next)
    onPreview(next.x, next.y)
  }
  const settle = () => { if (live) { setLive(null); onSettle() } }
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    move((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
  }
  const onKey = (e: KeyboardEvent) => {
    const d = { ArrowLeft: [-0.03, 0], ArrowRight: [0.03, 0], ArrowUp: [0, -0.03], ArrowDown: [0, 0.03] }[e.key]
    if (!d) return
    e.preventDefault()
    move(focalX + d[0], focalY + d[1])
  }
  return (
    <div className="es-focal">
      <span className="es-label">Light source</span>
      <div
        className="es-focal__pad"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); at(e) }}
        onPointerMove={(e) => { if (e.buttons & 1) at(e) }}
        onPointerUp={settle}
      >
        <EnvironmentStage type="custom" className="es-focal__stage" />
        <span
          className="es-focal__dot"
          role="slider"
          tabIndex={0}
          aria-label="Light source position"
          aria-valuetext={`${Math.round(focalX * 100)}% across, ${Math.round(focalY * 100)}% down`}
          aria-valuenow={Math.round(focalX * 100)}
          style={{ left: `${focalX * 100}%`, top: `${focalY * 100}%` }}
          onKeyDown={onKey}
          onKeyUp={settle}
        />
      </div>
    </div>
  )
}

/* ── saved environments ────────────────────────────────────────────────── */

function SavedEnvironments({ view }: { view: AppearanceView }) {
  const current = useMemo(() => snapshotOf({ nexusTheme: view.nexusTheme, accentPalette: view.accentPalette, appearance: view.appearance, liquidGlass: view.liquidGlass }), [view.nexusTheme, view.accentPalette, view.appearance, view.liquidGlass])
  const [naming, setNaming] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [flash, setFlash] = useFlash(1600)
  const [justSaved, setJustSaved] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const entries: SavedEnvironment[] = [...view.library.saved, ...BUILT_INS]

  useEscapeLayer(naming !== null || renaming !== null || deleting !== null || menuFor !== null, () => { setMenuFor(null); setNaming(null); setRenaming(null); setDeleting(null) })

  const save = () => {
    const entry = saveCurrentEnvironment(naming ?? '')
    setNaming(null)
    setJustSaved(entry.id)
    setFlash('Saved')
    sound.outcome.success('subtle')
  }

  return (
    <Section
      title="Saved"
      aside={flash ? <motion.span key={flash} className="es-quiet is-ok" initial={{ opacity: 0, y: LC_MOTION.state.swap.offset }} animate={{ opacity: 1, y: 0 }}><Icon name="check" size={11} strokeWidth={2.4} /> {flash}</motion.span> : null}
    >
      <AnimatePresence initial={false} mode="wait">
        {naming === null ? (
          <motion.button key="save" type="button" className="es-savebtn" onClick={() => setNaming(nextEnvironmentName(view.library))} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
            <Glyph name="plus" size={13} /> Save environment
          </motion.button>
        ) : (
          <motion.form key="name" className="es-saveform" onSubmit={(e) => { e.preventDefault(); save() }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
            <EnvironmentThumb snapshot={current} className="es-saveform__thumb" />
            <input autoFocus aria-label="Environment name" value={naming} maxLength={40} onChange={(e) => setNaming(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="es-ce__btn" onClick={() => setNaming(null)}>Cancel</button>
            <button type="submit" className="es-ce__btn is-primary">Save</button>
          </motion.form>
        )}
      </AnimatePresence>

      <ul className="es-saved" aria-label="Saved environments">
        {entries.map((entry) => {
          const active = snapshotsEqual(entry.snapshot, current)
          const user = !entry.builtIn
          return (
            <li key={entry.id} className={cx('es-card', active && 'is-active', justSaved === entry.id && 'is-new')}>
              {deleting === entry.id ? (
                <div className="es-card__confirm" role="alertdialog" aria-label={`Delete ${entry.name}?`}>
                  <span>Delete “{entry.name}”?</span>
                  <div>
                    <button type="button" className="es-ce__btn" onClick={() => setDeleting(null)}>Keep</button>
                    <button type="button" className="es-ce__btn is-danger" onClick={() => { deleteSavedEnvironment(entry.id); setDeleting(null) }}>Delete</button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="es-card__apply"
                    aria-pressed={active}
                    aria-label={`${entry.name}${active ? ' — current' : ''}`}
                    onClick={() => { if (!active) { sound.ui.select(); applyEnvironment(entry) } }}
                  >
                    <EnvironmentThumb snapshot={entry.snapshot} />
                    {renaming?.id === entry.id ? null : (
                      <span className="es-card__name">
                        {active ? <Icon name="check" size={11} strokeWidth={2.6} /> : null}
                        {entry.name}
                      </span>
                    )}
                  </button>
                  {renaming?.id === entry.id ? (
                    <form className="es-card__rename" onSubmit={(e) => { e.preventDefault(); renameSavedEnvironment(entry.id, renaming.name); setRenaming(null) }}>
                      <input autoFocus aria-label="Rename environment" value={renaming.name} maxLength={40} onChange={(e) => setRenaming({ id: entry.id, name: e.target.value })} onBlur={() => { renameSavedEnvironment(entry.id, renaming.name); setRenaming(null) }} />
                    </form>
                  ) : null}
                  <LCMenu
                    label={`${entry.name} actions`}
                    open={menuFor === entry.id}
                    onOpenChange={(open) => setMenuFor(open ? entry.id : null)}
                    items={lcMenu(
                      [
                        { label: 'Apply', icon: 'check', disabled: active, reason: 'Already applied', onSelect: () => { sound.ui.select(); applyEnvironment(entry) } },
                        { label: 'Duplicate', icon: 'layers', hint: user ? undefined : 'Built-ins stay as they are — customise a copy', onSelect: () => { const copy = duplicateSavedEnvironment(entry); setJustSaved(copy.id) } },
                      ],
                      user
                        ? [
                            { label: 'Rename', icon: 'file-text', onSelect: () => setRenaming({ id: entry.id, name: entry.name }) },
                            { label: 'Delete', icon: 'x', tone: 'danger', onSelect: () => setDeleting(entry.id) },
                          ]
                        : [],
                    )}
                    trigger={(
                      <button type="button" className="es-card__more" aria-label={`${entry.name} actions`}>
                        <Icon name="more" size={14} />
                      </button>
                    )}
                  />
                </>
              )}
            </li>
          )
        })}
      </ul>
      <p className="es-foot">Saved environments keep only how LeadCommand looks — theme, colour, environment, glass and motion.</p>
    </Section>
  )
}
