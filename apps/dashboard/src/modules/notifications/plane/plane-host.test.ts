import { describe, expect, it } from 'vitest'
import { dialogLayerOpen, pressDismissesPlane } from './plane-host'

/** a stand-in element: `closest` matches when any of its "ancestors" match a selector in the list */
const el = (...ancestors: string[]) => ({ closest: (sel: string) => (sel.split(',').map((x) => x.trim()).some((x) => ancestors.includes(x)) ? {} : null) })

describe('plane dismissal (portaled layers are never "outside")', () => {
  it('a press on a confirm opened from the plane — its button, the dialog, the scrim — never dismisses the plane', () => {
    expect(pressDismissesPlane(el('.lc-dialog'), false)).toBe(false) // "Arm rule" / "Disarm rule"
    expect(pressDismissesPlane(el('[role="alertdialog"]'), false)).toBe(false)
    expect(pressDismissesPlane(el('.lc-scrim'), false)).toBe(false)
    expect(pressDismissesPlane(el('.lc-sheet'), false)).toBe(false)
    expect(pressDismissesPlane(el('[data-radix-popper-content-wrapper]'), false)).toBe(false) // menus / selects
    expect(pressDismissesPlane(el('.lc-toast'), false)).toBe(false)
  })
  it('the bell toggles; inside presses stay; a genuine outside press dismisses', () => {
    expect(pressDismissesPlane(el('button.cd-btn[aria-label^="Notifications"]'), false)).toBe(false)
    expect(pressDismissesPlane(el(), true)).toBe(false)
    expect(pressDismissesPlane(el('.workspace'), false)).toBe(true)
    expect(pressDismissesPlane(null, false)).toBe(false)
  })
  it('Escape belongs to an open dialog layer, not the plane under it', () => {
    expect(dialogLayerOpen({ querySelector: (s: string) => (s.includes('.lc-dialog') ? {} : null) })).toBe(true)
    expect(dialogLayerOpen({ querySelector: () => null })).toBe(false)
  })
})
