/**
 * Shared property-media contract (frontend constitution §13).
 *
 * One typed vocabulary for every Street View / aerial surface in the app.
 * "No imagery available" without a reason is a defect (R13.7) — every failure
 * path in this module resolves to exactly one of these reasons.
 */

export type MediaFailureReason =
  | 'NO_COORDINATES'
  | 'NO_PANORAMA_AT_LOCATION'
  | 'PROVIDER_QUOTA'
  | 'PROVIDER_ERROR'
  | 'NETWORK'
  | 'KEY_MISSING'

/** Operator-facing copy. Never a bare "unavailable". */
export const MEDIA_FAILURE_COPY: Record<MediaFailureReason, { title: string; detail: string }> = {
  NO_COORDINATES: {
    title: 'No location on file',
    detail: 'This record has no address or coordinates, so imagery cannot be requested.',
  },
  NO_PANORAMA_AT_LOCATION: {
    title: 'No street imagery here',
    detail: 'Google has not captured this location. Aerial view may still be available.',
  },
  PROVIDER_QUOTA: {
    title: 'Imagery quota reached',
    detail: 'The Google Maps quota for this key is exhausted. Imagery resumes when it resets.',
  },
  PROVIDER_ERROR: {
    title: 'Imagery provider rejected the request',
    detail: 'Google returned an error for this location. Retry, or check the Maps key restrictions.',
  },
  NETWORK: {
    title: 'Could not reach imagery provider',
    detail: 'The request did not complete. Check connectivity and retry.',
  },
  KEY_MISSING: {
    title: 'Maps key not configured',
    detail: 'VITE_GOOGLE_MAPS_API_KEY is unset for this build, so no imagery can be requested.',
  },
}

/** Loading / resolved / failed — the only three states a media pane may be in. */
export type MediaPhase = 'idle' | 'probing' | 'loading' | 'ready' | 'failed'

export interface MediaState {
  phase: MediaPhase
  /** Present whenever `phase === 'failed'`. */
  reason: MediaFailureReason | null
  /**
   * The last visual that successfully painted for this surface. Kept across a
   * key change so a new property never clears the pane to blank first (R13.3).
   */
  lastGoodUrl: string | null
}

/** Normalized, stable identity for a property's media. */
export interface PropertyMediaIdentity {
  /** Stable cache + React key. Never an array index, thread id, or pane width. */
  key: string
  lat: number | null
  lng: number | null
  address: string | null
  /** Server-provided imagery that wins over anything we build. */
  storedStreetUrl: string | null
  storedAerialUrl: string | null
}
