import type { EmbedMode } from '../destinations/types'
import type { BrowserSurfaceProvider } from './provider'
import { WebEmbedSurface } from './WebEmbedSurface'

/** Today's provider: a sandboxed, credentialless iframe — only for domains the registry proved embeddable. */
export const WebEmbedProvider: BrowserSurfaceProvider = {
  id: 'web-embed',
  canRender: (embed: EmbedMode | null) => embed === 'EMBEDS',
  Surface: WebEmbedSurface,
}

/*
 * DesktopWebViewProvider — seam only. When LeadCommand ships a Tauri shell:
 *   export const DesktopWebViewProvider: BrowserSurfaceProvider = {
 *     id: 'desktop-webview',
 *     canRender: (embed) => embed !== null,   // native views are not frames
 *     Surface: NativeWebViewSurface,          // positions a child WebView over the pane rect
 *   }
 * and `providerFor` in ../BrowserApp picks it when `window.__TAURI__` exists.
 */
