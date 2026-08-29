/**
 * Copilot surface availability gate.
 *
 * The assistant architecture (orb, sidecar, console, voice, intent routing) stays
 * intact — this only decides whether its *UI* is allowed to mount on a given
 * surface. Mobile is off by default because the assistant is not in use in the
 * internal command center and its floating orb consumed live viewport space.
 *
 * Re-enable mobile without touching component code:
 *   VITE_COPILOT_MOBILE_UI=true
 */

const readFlag = (value: unknown, fallback: boolean): boolean => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  return raw === 'true' || raw === '1' || raw === 'on'
}

/** Mobile portrait assistant UI — disabled unless explicitly turned back on. */
export const COPILOT_MOBILE_UI_ENABLED = readFlag(
  import.meta.env?.VITE_COPILOT_MOBILE_UI,
  false,
)

/** Desktop / tablet / landscape phone keep the assistant unless explicitly disabled. */
export const COPILOT_DESKTOP_UI_ENABLED = readFlag(
  import.meta.env?.VITE_COPILOT_DESKTOP_UI,
  true,
)

export const isCopilotSurfaceEnabled = (isMobile: boolean): boolean =>
  isMobile ? COPILOT_MOBILE_UI_ENABLED : COPILOT_DESKTOP_UI_ENABLED
