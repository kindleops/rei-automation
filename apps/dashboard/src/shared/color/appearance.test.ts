import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_ENVIRONMENTS, DEFAULT_ENVIRONMENT, PALETTE_MAX, PALETTE_MIN, RECENT_MAX, SAVED_ENVIRONMENTS_MAX,
  defaultAppearance, defaultLibrary, deleteEnvironment, duplicateEnvironment, fieldsFromSnapshot, materialFamily, migrateAppearance,
  nextEnvironmentName, normalizeEnvironment, normalizeLibrary, normalizeMaterial, normalizePalette, pushRecentColor, renameEnvironment,
  saveEnvironment, snapshotOf, snapshotsEqual, toggleSavedColor,
} from './appearance'
import { RED_OPS_SIGNAL } from './accents'

describe('migration — nobody loses their look', () => {
  it('a brand-new operator gets the default environment', () => {
    const m = migrateAppearance({}, null)
    expect(m.accentPalette).toBe('cyan')
    expect(m.appearance.environment.type).toBe('liquid')
    expect(m.appearance.environment.autoHarmony).toBe(true)
    expect(m.appearance.motion).toBe('calm')
    expect(m.changed).toBe(true)
  })

  it('carries the old backdrop over: style, intensity, motion; Accent → Auto Harmony', () => {
    const m = migrateAppearance({ nexusTheme: 'dark', accentPalette: 'violet' }, { style: 'aurora', palette: 'accent', intensity: 72, motion: false })
    expect(m.accentPalette).toBe('violet')
    expect(m.appearance.accent.custom).toBe('#7C3AED')
    expect(m.appearance.environment).toMatchObject({ type: 'aurora', intensity: 72, autoHarmony: true })
    expect(m.appearance.motion).toBe('still')
  })

  it('Spectrum becomes the four anchors it used to paint', () => {
    const m = migrateAppearance({ accentPalette: 'cyan' }, { style: 'waves', palette: 'spectrum', intensity: 40 })
    expect(m.appearance.environment.autoHarmony).toBe(false)
    expect(m.appearance.environment.palette).toEqual(['#7C3AED', '#2563EB', '#06B6D4', '#10B981'])
  })

  it('Red Ops keeps the signal red it always painted (theme and accent were welded)', () => {
    const m = migrateAppearance({ nexusTheme: 'red_ops', accentPalette: 'emerald' }, null)
    expect(m.accentPalette).toBe('custom')
    expect(m.appearance.accent.custom).toBe(RED_OPS_SIGNAL)
  })

  it('leaves glass exactly as stored, only completing it', () => {
    const m = migrateAppearance({ liquidGlass: { preset: 'frosted', blur: 48, transparency: 30, sheen: 45 } }, null)
    expect(m.liquidGlass).toEqual({ preset: 'frosted', blur: 48, transparency: 30, sheen: 45, edge: 'balanced' })
  })

  it('is idempotent once at the current version', () => {
    const first = migrateAppearance({ nexusTheme: 'light', accentPalette: 'gold' }, { style: 'still', intensity: 30 })
    const again = migrateAppearance({ nexusTheme: 'light', accentPalette: first.accentPalette, appearance: first.appearance, appearanceLibrary: first.appearanceLibrary }, { style: 'aurora' })
    expect(again.appearance).toEqual(first.appearance)
    expect(again.changed).toBe(false)
  })
})

describe('corrupt settings fall back safely, field by field', () => {
  it('repairs an invalid hex, palette, material and enum without dropping the rest', () => {
    const m = migrateAppearance({
      accentPalette: 'banana',
      appearance: {
        version: 1,
        accent: { custom: 'not-a-colour', intensity: 999 },
        environment: { type: 'lava', palette: ['#zzz', 42, '#22d3ee'], intensity: 'loud', blend: -5, focalX: 7 },
        motion: 'warp',
      },
      liquidGlass: { preset: 'diamond', blur: 'x', transparency: 200, sheen: null, edge: 'jagged' },
    }, null)
    expect(m.accentPalette).toBe('cyan')
    expect(m.appearance.accent).toEqual({ custom: '#22D3EE', intensity: 100 })
    expect(m.appearance.environment.type).toBe('liquid')
    expect(m.appearance.environment.palette.length).toBeGreaterThanOrEqual(PALETTE_MIN)
    expect(m.appearance.environment.palette[0]).toBe('#22D3EE')
    expect(m.appearance.environment.intensity).toBe(DEFAULT_ENVIRONMENT.intensity)
    expect(m.appearance.environment.blend).toBe(0)
    expect(m.appearance.environment.focalX).toBe(1)
    expect(m.appearance.motion).toBe('calm')
    expect(m.liquidGlass).toMatchObject({ preset: 'theme', transparency: 100, edge: 'balanced' })
  })

  it('never returns fewer than two or more than four anchors', () => {
    expect(normalizePalette([])).toEqual(DEFAULT_ENVIRONMENT.palette)
    expect(normalizePalette(['#111111']).length).toBe(PALETTE_MIN)
    expect(normalizePalette(['#111111', '#222222', '#333333', '#444444', '#555555']).length).toBe(PALETTE_MAX)
  })

  it('skips saved environments that cannot be repaired and repairs the rest', () => {
    const lib = normalizeLibrary({
      recentColors: ['#fff', 'nope', '#FFFFFF', '#000'],
      saved: [
        null,
        'junk',
        { name: '', snapshot: { theme: 'light', accent: { palette: 'gold' } } },
        { id: 'builtin:hack', name: 'Spoof', snapshot: { theme: 'dark' } },
        { id: 'a', name: 'A', snapshot: null },
      ],
    })
    expect(lib.recentColors).toEqual(['#FFFFFF', '#000000'])
    expect(lib.saved).toHaveLength(2)
    expect(lib.saved[0].name).toBe('Custom Environment 1')
    expect(lib.saved[0].snapshot.accent.palette).toBe('gold')
    expect(lib.saved.every((s) => !s.id.startsWith('builtin:'))).toBe(true)
  })

  it('normalises unknown environment payloads to the default', () => {
    expect(normalizeEnvironment(undefined)).toEqual(DEFAULT_ENVIRONMENT)
  })
})

describe('material families', () => {
  it('reads theme / crystal as Crystal and matches old custom glass to its nearest preset', () => {
    expect(materialFamily(normalizeMaterial({ preset: 'theme' }))).toBe('crystal')
    expect(materialFamily(normalizeMaterial({ preset: 'custom', blur: 46, transparency: 26, sheen: 40 }))).toBe('frosted')
    expect(materialFamily(normalizeMaterial({ preset: 'custom', blur: 10, transparency: 85, sheen: 60 }))).toBe('clear')
    expect(normalizeMaterial({ preset: 'custom', blur: 30, transparency: 15, sheen: 25 }).base).toBe('smoke')
  })
})

describe('snapshots and saved environments', () => {
  const fields = { nexusTheme: 'true_black', accentPalette: 'custom' as const, appearance: { ...defaultAppearance(), accent: { custom: '#22D3EE', intensity: 60 } }, liquidGlass: normalizeMaterial({ preset: 'crystal', blur: 22, transparency: 62, sheen: 95 }) }

  it('round-trips: save → switch → return gives back the exact environment', () => {
    const snap = snapshotOf(fields)
    const back = fieldsFromSnapshot(snap, defaultAppearance())
    expect(back.nexusTheme).toBe('true_black')
    expect(back.accentPalette).toBe('custom')
    expect(back.appearance.accent).toEqual({ custom: '#22D3EE', intensity: 60 })
    expect(snapshotsEqual(snapshotOf({ ...back, liquidGlass: back.liquidGlass }), snap)).toBe(true)
  })

  it('stores UI preference only', () => {
    const snap = snapshotOf(fields)
    expect(Object.keys(snap).sort()).toEqual(['accent', 'environment', 'material', 'motion', 'theme'])
  })

  it('saves with a generated name, renames, duplicates and deletes — built-ins are immutable', () => {
    let lib = defaultLibrary()
    expect(nextEnvironmentName(lib)).toBe('Custom Environment 1')
    const saved = saveEnvironment(lib, '', snapshotOf(fields), 1000)
    lib = saved.lib
    expect(saved.entry.name).toBe('Custom Environment 1')
    expect(nextEnvironmentName(lib)).toBe('Custom Environment 2')
    lib = renameEnvironment(lib, saved.entry.id, '  Midnight   Cyan ')
    expect(lib.saved[0].name).toBe('Midnight Cyan')
    const dup = duplicateEnvironment(lib, BUILT_IN_ENVIRONMENTS[1], 2000)
    lib = dup.lib
    expect(dup.entry.builtIn).toBeUndefined()
    expect(dup.entry.name).toBe(`${BUILT_IN_ENVIRONMENTS[1].name} copy`)
    expect(deleteEnvironment(lib, BUILT_IN_ENVIRONMENTS[0].id)).toBe(lib)
    expect(deleteEnvironment(lib, saved.entry.id).saved.map((s) => s.id)).toEqual([dup.entry.id])
    expect(Object.isFrozen(BUILT_IN_ENVIRONMENTS[0])).toBe(true)
  })

  it('caps the library', () => {
    let lib = defaultLibrary()
    for (let i = 0; i < 40; i++) lib = saveEnvironment(lib, `E${i}`, snapshotOf(fields), i).lib
    expect(lib.saved).toHaveLength(SAVED_ENVIRONMENTS_MAX)
    for (let i = 0; i < 20; i++) lib = pushRecentColor(lib, `#${(i * 99999).toString(16).padStart(6, '0').slice(0, 6)}`)
    expect(lib.recentColors).toHaveLength(RECENT_MAX)
    const fav = toggleSavedColor(lib, '#22d3ee')
    expect(fav.savedColors).toEqual(['#22D3EE'])
    expect(toggleSavedColor(fav, '#22D3EE').savedColors).toEqual([])
  })

  it('every built-in is a valid, distinct snapshot', () => {
    const keys = new Set(BUILT_IN_ENVIRONMENTS.map((b) => JSON.stringify(b.snapshot)))
    expect(keys.size).toBe(BUILT_IN_ENVIRONMENTS.length)
    for (const b of BUILT_IN_ENVIRONMENTS) expect(b.id.startsWith('builtin:')).toBe(true)
  })
})
