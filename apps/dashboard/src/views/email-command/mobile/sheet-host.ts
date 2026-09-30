/**
 * Where the conversation room mounts.
 *
 * On the desktop every app lives in a workspace pane that is its own
 * containing block and size container (see DesktopWorkspace), so the room
 * opens inside Email Command's own pane — docked beside the list on a wide
 * pane, over it on a narrow one — never over the sidebar, the top bar or an
 * app open beside it. When more than one pane hosts the surface, the pane the
 * operator just pressed in wins. Phones, and any render outside a pane,
 * portal to <body>.
 */
let lastPress: Element | null = null
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => { lastPress = e.target instanceof Element ? e.target : null }, true)
}

export function emailRoomHost(): HTMLElement {
  if (!document.documentElement.classList.contains('is-desktop-modern')) return document.body
  const panes = [...document.querySelectorAll('[data-testid="email-surface"]')]
    .map((el) => el.closest<HTMLElement>('.dsk-pane__body'))
    .filter((p): p is HTMLElement => Boolean(p))
  if (panes.length > 1) {
    const pressed = lastPress?.closest<HTMLElement>('.dsk-pane__body')
    if (pressed && panes.includes(pressed)) return pressed
  }
  return panes[0] ?? document.body
}
