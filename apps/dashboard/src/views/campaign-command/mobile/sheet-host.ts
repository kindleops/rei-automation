/**
 * Where a Campaign Command sheet (action menu, confirmation, builder) mounts.
 *
 * On the desktop every app lives in a workspace pane that is its own
 * containing block and size container (see DesktopWorkspace), so a sheet
 * opened from Campaign Command mounts inside that app's own pane: it covers —
 * and lays out by — that pane, never the sidebar, the top bar or an app open
 * beside it. The builder can also be opened from the Inbox's campaigns view;
 * when more than one pane hosts a campaigns surface, the pane the operator
 * just pressed in wins. Phones, and any render outside a pane, portal to
 * <body>.
 */
let lastPress: Element | null = null
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => { lastPress = e.target instanceof Element ? e.target : null }, true)
}

export function campaignSheetHost(): HTMLElement {
  if (!document.documentElement.classList.contains('is-desktop-modern')) return document.body
  const panes = [...document.querySelectorAll('.is-view-campaigns, .cxi, .ccc')]
    .map((el) => el.closest<HTMLElement>('.dsk-pane__body'))
    .filter((p): p is HTMLElement => Boolean(p))
  const unique = [...new Set(panes)]
  if (unique.length > 1) {
    const pressed = lastPress?.closest<HTMLElement>('.dsk-pane__body')
    if (pressed && unique.includes(pressed)) return pressed
  }
  return unique[0] ?? document.body
}
