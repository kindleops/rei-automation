/**
 * The instant the sun is drawn for. Always the real clock in production.
 *
 * Development only: `?sun_at=2026-10-03T23:30:00Z` on the URL shifts the SUN
 * (and nothing else — no local-time pill, contact window or data read) to that
 * instant and lets it run on from there, so day/night proofs can be captured
 * at a fixed moment. Ignored entirely in production builds.
 */
let offsetMs = 0
if (import.meta.env.DEV && typeof window !== 'undefined') {
  try {
    const raw = new URLSearchParams(window.location.search).get('sun_at')
    const t = raw ? Date.parse(raw) : NaN
    if (Number.isFinite(t)) offsetMs = t - Date.now()
  } catch { /* no location */ }
}

export const sunNow = (): Date => new Date(Date.now() + offsetMs)
/** True while a development override is shifting the sun. */
export const sunSimulated = () => offsetMs !== 0
/** The sun's instant for a given real-clock time (the chrome's minute clock). */
export const sunAt = (realMs: number): Date => new Date(realMs + offsetMs)
