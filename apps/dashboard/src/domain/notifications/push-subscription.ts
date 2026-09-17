import { callBackend } from '../../lib/api/backendClient'

/**
 * WEB PUSH — the client half.
 *
 * Every function here answers with a STATE, never a boolean, because §5's rule is
 * that push must never fake success. There are six genuinely different outcomes and
 * conflating any of them produces a lie:
 *
 *   unsupported    the browser has no Push API (iOS Safari outside standalone,
 *                  most in-app webviews)
 *   needs_install  iOS specifically: Push exists only once the PWA is installed to
 *                  the Home Screen. Telling an iPhone operator to "allow
 *                  notifications" in Safari is advice that cannot work.
 *   unconfigured   the deployment has no VAPID keypair. Not the operator's problem
 *                  and not an error — a state.
 *   denied         the operator (or the OS) refused. The browser will not re-prompt;
 *                  only Settings can undo it, so the UI has to say that.
 *   prompt         permission has not been asked for yet
 *   granted        subscribed and stored server-side
 *
 * The permission prompt is NEVER invoked on load. `enablePush()` is only reachable
 * from an explicit in-product control, which is both what §5 requires and what keeps
 * the browser from permanently blocking the origin after a reflexive dismissal.
 */

export type PushState =
  | 'unsupported'
  | 'needs_install'
  | 'unconfigured'
  | 'denied'
  | 'prompt'
  | 'granted'

export interface PushStatus {
  state: PushState
  /** Operator-facing explanation. Present whenever the state is not `granted`. */
  detail: string | null
}

interface PushConfigResponse {
  ok: boolean
  configured: boolean
  vapid_public_key: string | null
  reason: string | null
}

const PUSH_PATH = '/api/cockpit/notifications/push'

const isStandalone = (): boolean => {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)')?.matches) return true
  // iOS Safari predates display-mode and exposes its own flag.
  return Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)
}

const isIos = (): boolean =>
  typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent)

export function resolvePlatformSupport(): PushStatus | null {
  if (typeof window === 'undefined') return { state: 'unsupported', detail: 'No browser environment.' }
  if (!('serviceWorker' in navigator)) {
    return { state: 'unsupported', detail: 'This browser has no service worker support.' }
  }
  if (!('PushManager' in window) || !('Notification' in window)) {
    /**
     * On iOS this is not a dead end — it is the pre-install state. Safari only
     * exposes PushManager to an installed Home Screen app, so the correct advice is
     * "install", not "your browser cannot do this".
     */
    if (isIos() && !isStandalone()) {
      return {
        state: 'needs_install',
        detail: 'On iPhone, add LeadCommand to your Home Screen first — iOS only delivers push to an installed app.',
      }
    }
    return { state: 'unsupported', detail: 'This browser does not support web push.' }
  }
  return null
}

/** Base64url (what VAPID keys are transmitted as) to the Uint8Array the API wants. */
function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(normalized)
  // Allocate the ArrayBuffer explicitly and return IT: `applicationServerKey` is
  // typed as BufferSource over a plain ArrayBuffer, and a bare Uint8Array is
  // generic over ArrayBufferLike (which includes SharedArrayBuffer) so it does not
  // satisfy the DOM signature.
  const buffer = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i)
  return buffer
}

async function fetchPushConfig(): Promise<PushConfigResponse | null> {
  const res = await callBackend<PushConfigResponse>(PUSH_PATH)
  // callBackend returns the BODY under `data` — reading it shallowly is a mistake
  // this codebase has already paid for once.
  return res.ok ? (res.data ?? null) : null
}

/**
 * Read the current state WITHOUT prompting. Safe to call on mount.
 */
export async function readPushStatus(): Promise<PushStatus> {
  const platform = resolvePlatformSupport()
  if (platform) return platform

  const config = await fetchPushConfig()
  if (!config || !config.configured || !config.vapid_public_key) {
    return {
      state: 'unconfigured',
      detail: config?.reason === 'vapid_subject_missing_or_invalid'
        ? 'Push is half-configured on this deployment: VAPID_SUBJECT is missing or invalid.'
        : 'Push is not configured on this deployment yet.',
    }
  }

  if (Notification.permission === 'denied') {
    return {
      state: 'denied',
      detail: 'Notifications are blocked for this site. Re-enable them in your browser or iOS settings.',
    }
  }
  if (Notification.permission === 'granted') {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    // Permission granted with NO subscription is a real state — the operator
    // allowed notifications and then site data was cleared. Reporting `granted`
    // here would claim delivery that cannot happen.
    if (subscription) return { state: 'granted', detail: null }
    return { state: 'prompt', detail: 'Permission is allowed but this device is not registered yet.' }
  }
  return { state: 'prompt', detail: null }
}

/**
 * Ask, subscribe, persist. Only ever called from an explicit operator action.
 */
export async function enablePush(): Promise<PushStatus> {
  const platform = resolvePlatformSupport()
  if (platform) return platform

  const config = await fetchPushConfig()
  if (!config?.configured || !config.vapid_public_key) {
    return { state: 'unconfigured', detail: config?.reason ?? 'Push is not configured on this deployment yet.' }
  }

  const permission = await Notification.requestPermission()
  if (permission === 'denied') {
    return { state: 'denied', detail: 'Notifications were blocked. Re-enable them in your browser or iOS settings.' }
  }
  if (permission !== 'granted') {
    return { state: 'prompt', detail: 'Notification permission was dismissed.' }
  }

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.subscribe({
      // Required by every current browser; a subscription that can push silently
      // is not obtainable and asking for one fails outright.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapid_public_key),
    })

    const stored = await callBackend(PUSH_PATH, {
      method: 'POST',
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    })

    if (!stored.ok) {
      // The browser subscribed but the server did not record it, so nothing will
      // ever be delivered. Rolling the local subscription back keeps the reported
      // state and the real state identical.
      await subscription.unsubscribe().catch(() => undefined)
      return { state: 'prompt', detail: 'Could not register this device with LeadCommand. Try again.' }
    }

    return { state: 'granted', detail: null }
  } catch (error) {
    return {
      state: 'prompt',
      detail: error instanceof Error ? error.message : 'Push registration failed.',
    }
  }
}

/**
 * Drop this device. Also called on sign-out so a shared handset stops receiving
 * another operator's alerts.
 */
export async function disablePush(): Promise<PushStatus> {
  const platform = resolvePlatformSupport()
  if (platform) return platform

  try {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription) {
      await callBackend(PUSH_PATH, {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      })
      await subscription.unsubscribe().catch(() => undefined)
    }
  } catch {
    /* Local teardown is best-effort; the server row is what decides delivery. */
  }
  return { state: 'prompt', detail: null }
}
