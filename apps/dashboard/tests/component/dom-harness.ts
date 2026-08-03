/**
 * jsdom + React Testing Library harness for `node --test`.
 *
 * The repository has no vitest/jest runner, so component tests bootstrap a DOM manually
 * and drive React 18's concurrent renderer through `act`. Import this module FIRST in any
 * component test — React reads `document` at import time.
 */

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const globalAny = globalThis as unknown as Record<string, unknown>

globalAny.window = dom.window
globalAny.document = dom.window.document
// `globalThis.navigator` is a getter-only accessor on modern Node, so it is redefined
// rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => dom.window.navigator,
})
globalAny.HTMLElement = dom.window.HTMLElement
globalAny.HTMLButtonElement = dom.window.HTMLButtonElement
globalAny.Element = dom.window.Element
globalAny.Node = dom.window.Node
globalAny.Event = dom.window.Event
globalAny.MouseEvent = dom.window.MouseEvent
globalAny.KeyboardEvent = dom.window.KeyboardEvent
globalAny.getComputedStyle = dom.window.getComputedStyle
globalAny.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(Date.now()), 0)
globalAny.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id)

// React 18 reads this to decide whether it is running inside a test that manages `act`.
globalAny.IS_REACT_ACT_ENVIRONMENT = true

export { dom }
