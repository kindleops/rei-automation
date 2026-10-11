/**
 * MONOGRAM — a seller's initials on a colour that is always theirs.
 *
 * Pure. The colour is chosen from the Experience System's categorical palette
 * (lc-tokens.css --lc-chart-2…8 + the machine cyan — never red / amber /
 * green, which mean something) by a stable hash of the seller's identity (the
 * thread key when there is one, so the same seller keeps the same colour even
 * before a name is known), never by position or render order.
 */

/** Token references — the palette lives in lc-tokens.css; this only picks one. */
export const MONOGRAM_PALETTE = Object.freeze([
  'var(--lc-chart-2, #a9a6f9)',
  'var(--lc-chart-3, #ef8bc5)',
  'var(--lc-chart-4, #8ab4ff)',
  'var(--lc-chart-5, #5fd3c4)',
  'var(--lc-chart-6, #f49752)',
  'var(--lc-chart-7, #d294ee)',
  'var(--lc-chart-8, #a6be4e)',
  'rgb(var(--lc-exec-rgb, 76, 201, 240))',
])

const PHONEISH = /^[\s()+\-.\d]{7,}$/
const NOISE = new Set(['llc', 'inc', 'trust', 'the', 'estate', 'of', 'and', 'co', 'corp', 'ltd', 'lp', 'llp', 'jr', 'sr', 'ii', 'iii', 'iv'])

/** FNV-1a, 32-bit — stable across runs, browsers and builds. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  const s = seed.normalize('NFKC').trim().toLowerCase()
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** A usable person/company name, or null (empty, a phone number, no letters). */
export function cleanName(name: string | null | undefined): string | null {
  const n = String(name ?? '').trim()
  if (!n || PHONEISH.test(n) || !/\p{L}/u.test(n)) return null
  return n
}

/** "Sondra E" → "SE" · "maría o'neil" → "MO" · "Cher" → "C" · "Smith Family Trust LLC" → "SF" · null when unknown. */
export function initialsOf(name: string | null | undefined): string | null {
  const n = cleanName(name)
  if (!n) return null
  const words = n.split(/[\s,/&]+/).map((w) => w.replace(/[^\p{L}\p{N}'’-]/gu, '')).filter((w) => /\p{L}/u.test(w))
  const meaningful = words.filter((w) => !NOISE.has(w.toLowerCase()))
  const use = meaningful.length ? meaningful : words
  if (!use.length) return null
  const first = (w: string) => (w.match(/\p{L}/u)?.[0] ?? '').toLocaleUpperCase()
  return use.length === 1 ? first(use[0]) : `${first(use[0])}${first(use[use.length - 1])}`
}

/** Index into MONOGRAM_PALETTE for a seller; the seed is their stable id (thread key) or, without one, their name. */
export function monogramIndex(seed: string | null | undefined): number {
  const s = String(seed ?? '').trim()
  return s ? hashSeed(s) % MONOGRAM_PALETTE.length : 0
}

export function monogramColor(seed: string | null | undefined): string {
  return MONOGRAM_PALETTE[monogramIndex(seed)]
}

export interface MonogramFace {
  initials: string | null
  color: string
  /** accessible label: the name when known */
  label: string
}

export function monogramFace({ name, seed }: { name?: string | null; seed?: string | null }): MonogramFace {
  const initials = initialsOf(name)
  const clean = cleanName(name)
  return { initials, color: monogramColor(seed || clean || ''), label: clean ?? 'Unknown seller' }
}
