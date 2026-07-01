/** Debug flag for map property diagnostics overlay — hidden from normal production users. */

export const MAP_DIAGNOSTICS_DEBUG_KEY = 'nx.map.diagnostics.debug'
export const MAP_VERIFICATION_MODE_KEY = 'nx.map.verification.mode'
export const MAP_DIAGNOSTICS_QUERY_PARAM = 'mapDiagnostics'

export const isMapVerificationMode = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(MAP_VERIFICATION_MODE_KEY) === '1'
  } catch {
    return false
  }
}

export const isMapDiagnosticsDebugEnabled = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get(MAP_DIAGNOSTICS_QUERY_PARAM) === '1') return true
    if (window.localStorage.getItem(MAP_DIAGNOSTICS_DEBUG_KEY) === '1') return true
  } catch {
    // ignore storage errors
  }
  return false
}

export const enableMapDiagnosticsDebug = (): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(MAP_DIAGNOSTICS_DEBUG_KEY, '1')
}