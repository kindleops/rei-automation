/**
 * BROWSER-LOCAL KEYS — only while the Browser is the focused pane.
 *
 *   ⌘/Ctrl L        focus the address field
 *   ⌘/Ctrl R        reload THIS tab (never the whole cockpit)
 *   ⌘/Ctrl T        new tab          (see note)
 *   ⌘/Ctrl W        close tab        (see note)
 *   ⌥/Alt ← / →     back / forward   (not while typing: ⌥← is word-jump there)
 *
 * ⌘K is never touched: it stays the Command Deck. Workspace chords (⌥⇧…)
 * are never matched (Shift is required to be up for every Browser chord).
 *
 * Note: a desktop browser tab reserves ⌘T / ⌘W / ⌘N for itself — Chrome
 * does not deliver them to the page, so they work only where the cockpit
 * runs as an installed app window (or the future native shell). The tab
 * strip's + and × are always the reliable path.
 *
 * A keystroke inside a third-party page goes to that page's document, not
 * ours: the Browser can never see (or steal) keys typed into a site.
 */
export type BrowserKeyAction = 'focus-address' | 'reload' | 'new-tab' | 'close-tab' | 'back' | 'forward'

export interface KeyLike { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

export interface KeyScope {
  /** the Browser is the focused pane (or runs alone) */
  active: boolean
  /** focus is in a text field */
  editing: boolean
  mac: boolean
}

export function browserKeyAction(e: KeyLike, scope: KeyScope): BrowserKeyAction | null {
  if (!scope.active || e.shiftKey) return null
  const mod = scope.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  const k = (e.key || '').toLowerCase()
  if (mod && !e.altKey) {
    if (k === 'k') return null // the Command Deck
    if (k === 'l') return 'focus-address'
    if (k === 'r') return 'reload'
    if (k === 't') return 'new-tab'
    if (k === 'w') return 'close-tab'
    return null
  }
  if (e.altKey && !e.metaKey && !e.ctrlKey && !scope.editing) {
    if (e.key === 'ArrowLeft') return 'back'
    if (e.key === 'ArrowRight') return 'forward'
  }
  return null
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')

export const isEditing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))
}
