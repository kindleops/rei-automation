import { describe, expect, it } from 'vitest'
import { cleanName, hashSeed, initialsOf, MONOGRAM_PALETTE, monogramColor, monogramFace, monogramIndex } from './monogram-model'

describe('monogram — initials', () => {
  it('first + last initial; one word → one letter; noise words skipped', () => {
    expect(initialsOf('Sondra E')).toBe('SE')
    expect(initialsOf('gale  leflore')).toBe('GL')
    expect(initialsOf('Cher')).toBe('C')
    expect(initialsOf('Mary Ann Smith')).toBe('MS')
    expect(initialsOf('Smith Family Trust LLC')).toBe('SF')
    expect(initialsOf("maría o'neil")).toBe('MO')
    expect(initialsOf('José Ñúñez')).toBe('JÑ')
  })
  it('unknown → null (fallback glyph): empty, a phone number, no letters', () => {
    expect(initialsOf(null)).toBeNull()
    expect(initialsOf('')).toBeNull()
    expect(initialsOf('(612) 555-0101')).toBeNull()
    expect(initialsOf('+16125550101')).toBeNull()
    expect(initialsOf('—')).toBeNull()
    expect(cleanName('  ')).toBeNull()
  })
})

describe('monogram — colour determinism', () => {
  it('the same seed always gets the same colour; hash is FNV-1a (stable across runs/builds)', () => {
    expect(hashSeed('')).toBe(0x811c9dc5)
    expect(hashSeed('a')).toBe(0xe40c292c)
    const seed = '+16125550101'
    const first = monogramColor(seed)
    for (let i = 0; i < 50; i++) expect(monogramColor(seed)).toBe(first)
    expect(monogramIndex(seed)).toBe(hashSeed(seed) % MONOGRAM_PALETTE.length)
  })
  it('case / surrounding space / unicode form do not change a seller’s colour', () => {
    expect(monogramColor('Sondra E')).toBe(monogramColor('  sondra e '))
    expect(monogramColor('José')).toBe(monogramColor('José'))
  })
  it('spreads sellers over the whole palette (no colour unused across 200 phones)', () => {
    const used = new Set<number>()
    for (let i = 0; i < 200; i++) used.add(monogramIndex(`+1612555${String(i).padStart(4, '0')}`))
    expect(used.size).toBe(MONOGRAM_PALETTE.length)
  })
  it('palette is LC tokens only — never the semantic red/amber/green', () => {
    for (const c of MONOGRAM_PALETTE) expect(c).toMatch(/var\(--lc-/)
    expect(MONOGRAM_PALETTE.join(' ')).not.toMatch(/--lc-(crit|attn|ok)-/)
  })
  it('face: the thread key seeds the colour so a seller keeps it before and after a name is known', () => {
    const unnamed = monogramFace({ name: null, seed: '+16125550101' })
    const named = monogramFace({ name: 'Sondra E', seed: '+16125550101' })
    expect(unnamed.initials).toBeNull()
    expect(unnamed.label).toBe('Unknown seller')
    expect(named.initials).toBe('SE')
    expect(named.color).toBe(unnamed.color)
  })
})
