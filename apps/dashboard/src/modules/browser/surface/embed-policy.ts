/** The iframe policy for third-party research pages (see ./WebEmbedSurface). */
export const DENIED_FEATURES = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'; clipboard-read 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; display-capture 'none'; fullscreen 'none'; midi 'none'; publickey-credentials-get 'none'; screen-wake-lock 'none'; xr-spatial-tracking 'none'"

/** Tokens the Browser will pass through even if a registry entry asked for more. */
const PERMITTED_TOKENS = new Set(['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox'])

export function sandboxAttr(tokens: readonly string[]): string {
  return [...new Set(tokens.filter((t) => PERMITTED_TOKENS.has(t)))].join(' ')
}

