/**
 * Where a Queue sheet mounts.
 *
 * On the desktop every app lives in a workspace pane that is its own
 * containing block and size container (see DesktopWorkspace), so a sheet
 * opened from the Queue mounts inside the Queue's own pane: it covers — and
 * lays out by — that pane, never the sidebar, the top bar or an app open
 * beside it. When more than one pane hosts the Queue surface (the Inbox can
 * embed it), the pane the operator just pressed in wins. Phones, and any
 * render outside a pane, portal to <body> as before.
 */
let lastPress: Element | null = null
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => { lastPress = e.target instanceof Element ? e.target : null }, true)
}

export function queueSheetHost(): HTMLElement {
  if (!document.documentElement.classList.contains('is-desktop-modern')) return document.body
  const panes = [...document.querySelectorAll('.occ-root.is-dispatch')]
    .map((el) => el.closest<HTMLElement>('.dsk-pane__body'))
    .filter((p): p is HTMLElement => Boolean(p))
  if (panes.length > 1) {
    const pressed = lastPress?.closest<HTMLElement>('.dsk-pane__body')
    if (pressed && panes.includes(pressed)) return pressed
  }
  return panes[0] ?? document.body
}
