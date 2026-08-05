/**
 * LeadCommand breakpoint contract — Constitution §15.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR VIEWPORT BANDS.
 *
 * Before this file existed the phone breakpoint was defined three ways
 * (CSS `768px` ×18, CSS `767px` ×4, JS `PHONE_MAX = 767`) which disagreed at
 * exactly 768px — CSS said mobile, JS said tablet — and tablet was defined six
 * ways (900 / 960 / 980 / 1024 / 1100 / matchMedia 1024).
 *
 * CSS media queries cannot read custom properties, so CSS cannot literally
 * `var()` these values. The contract is instead enforced statically by
 * `scripts/lc-responsive-audit.mjs`, which fails if any stylesheet uses a width
 * breakpoint outside `CSS_MEDIA` below. Lane A mirrors the same numbers as
 * documentation tokens (`--lc-bp-*`) in `styles/lc-tokens.css`.
 *
 * | Band | Range        | Shape                                     |
 * |------|--------------|-------------------------------------------|
 * | xs   | < 480        | Single column, bottom nav, sheets          |
 * | sm   | 480–767      | Single column, wider gutters               |
 * | md   | 768–1023     | Two panes max, drawer for the third        |
 * | lg   | 1024–1439    | Three panes, compact density               |
 * | xl   | ≥ 1440       | Three panes, comfortable density           |
 */

export type LcBand = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/** Lower bound (inclusive) of each band, in CSS px. */
export const LC_BAND_MIN = {
  xs: 0,
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1440,
} as const satisfies Record<LcBand, number>

/**
 * Upper bound used in `max-width` queries. `.98` rather than `-1` so a
 * fractional viewport width (browser zoom, Windows scaling) can never fall
 * into the gap between two bands.
 */
export const LC_BAND_MAX = {
  xs: 479.98,
  sm: 767.98,
  md: 1023.98,
  lg: 1439.98,
} as const

/**
 * The complete set of width media queries permitted anywhere in the app.
 * `scripts/lc-responsive-audit.mjs` asserts CSS uses only these values.
 */
export const CSS_MEDIA = {
  /** < 480 — xs only */
  xsDown: `(max-width: ${LC_BAND_MAX.xs}px)`,
  /** < 768 — phone (xs + sm) */
  smDown: `(max-width: ${LC_BAND_MAX.sm}px)`,
  /** < 1024 — phone + tablet (xs + sm + md) */
  mdDown: `(max-width: ${LC_BAND_MAX.md}px)`,
  /** < 1440 — everything below the comfortable desktop band */
  lgDown: `(max-width: ${LC_BAND_MAX.lg}px)`,
  smUp: `(min-width: ${LC_BAND_MIN.sm}px)`,
  mdUp: `(min-width: ${LC_BAND_MIN.md}px)`,
  lgUp: `(min-width: ${LC_BAND_MIN.lg}px)`,
  xlUp: `(min-width: ${LC_BAND_MIN.xl}px)`,
} as const

/** Numeric values the static audit accepts in a width media query. */
export const ALLOWED_BREAKPOINT_VALUES: readonly number[] = [
  LC_BAND_MAX.xs,
  LC_BAND_MAX.sm,
  LC_BAND_MAX.md,
  LC_BAND_MAX.lg,
  LC_BAND_MIN.sm,
  LC_BAND_MIN.md,
  LC_BAND_MIN.lg,
  LC_BAND_MIN.xl,
]

export function resolveBand(width: number): LcBand {
  if (width < LC_BAND_MIN.sm) return 'xs'
  if (width < LC_BAND_MIN.md) return 'sm'
  if (width < LC_BAND_MIN.lg) return 'md'
  if (width < LC_BAND_MIN.xl) return 'lg'
  return 'xl'
}

/** True below the md band — i.e. what CSS `(max-width: 767.98px)` matches. */
export function isPhoneWidth(width: number): boolean {
  return width < LC_BAND_MIN.md
}

/** True inside the md band — i.e. CSS `(min-width: 768px) and (max-width: 1023.98px)`. */
export function isTabletWidth(width: number): boolean {
  return width >= LC_BAND_MIN.md && width < LC_BAND_MIN.lg
}
