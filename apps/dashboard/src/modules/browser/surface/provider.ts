import type { ComponentType } from 'react'
import type { EmbedMode } from '../destinations/types'

/**
 * BROWSER SURFACE PROVIDERS — the seam between the research session (tabs,
 * history, context: ../session-model) and whatever actually draws a page.
 *
 *   WebEmbedProvider        today: a sandboxed, credentialless <iframe>, used
 *                           ONLY for domains the registry proved embeddable
 *   DesktopWebViewProvider  later (NOT built): a Tauri WebView in its own OS
 *                           process. It would report `canRender` for BLOCKED /
 *                           AUTH sites too, since a native view is not a frame
 *                           and frame-ancestors does not apply to it. Same
 *                           props, same events; the session never changes.
 *
 * A provider draws and reports; it never owns state, never reads a page's
 * content, and never injects anything into it.
 */

export type SurfaceStatus =
  /** request issued, nothing back yet */
  | 'loading'
  /** the frame reported load */
  | 'loaded'
  /** no load after the patience window — likely network or a stalled site */
  | 'timeout'
  /** the browser is offline */
  | 'offline'

export interface SurfaceProps {
  tabId: string
  url: string
  title: string
  /** iframe sandbox tokens proven for this domain (registry audit) */
  sandbox: string[]
  /** bumping this reloads THIS surface only */
  reloadKey: number
  /** false while another tab is in front (kept alive, not shown) */
  visible: boolean
  onStatus: (tabId: string, status: SurfaceStatus) => void
  /** the page moved inside itself (a link inside the site) — its address is no longer known */
  onInnerNavigation: (tabId: string) => void
}

export interface BrowserSurfaceProvider {
  id: 'web-embed' | 'desktop-webview'
  /** may this provider show a page with this embed mode at all */
  canRender: (embed: EmbedMode | null) => boolean
  Surface: ComponentType<SurfaceProps>
}

/** How long a framed page may stay silent before the Browser says so. */
export const LOAD_PATIENCE_MS = 20_000
