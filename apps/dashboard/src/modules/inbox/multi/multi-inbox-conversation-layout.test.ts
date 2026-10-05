import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A pane conversation is [PaneConversationHeader, thread body, composer]. The body — not the
 * header — must take the pane's free height. The old rule grew `> :first-child`, which became the
 * header once 72fed778 added it, so a short thread's header ballooned to half the pane (RC 8.4 v2
 * visual pass: 1920 3-pane and 3840 2-pane).
 */
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'multi-inbox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const src = (f: string) => readFileSync(join(here, f), 'utf8')

const rulesFor = (selectorPart: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .filter(([, sel]) => sel.includes(selectorPart))
  .map(([, sel, body]) => ({ sel: sel.trim(), body }))

describe('multi-inbox pane conversation layout', () => {
  it('never grows the first child of a pane conversation (that is the header)', () => {
    const grow = rulesFor('.ixm-conversation > :first-child').filter((r) => /flex:\s*1/.test(r.body))
    expect(grow).toEqual([])
  })

  it('grows the element after the pane header, and the header itself stays fixed', () => {
    const body = rulesFor('.ixm-conversation > .ixm-conv-head + *')
    expect(body.some((r) => /flex:\s*1 1 auto/.test(r.body) && /min-height:\s*0/.test(r.body))).toBe(true)
    const head = rulesFor('.ixm-conv-head').filter((r) => /\.ixm-conv-head\s*$/.test(r.sel))
    expect(head.some((r) => /flex:\s*0 0 auto/.test(r.body))).toBe(true)
  })

  it('both conversation surfaces render the pane header first, then the body', () => {
    const pane = src('PaneConversation.tsx')
    expect(pane.indexOf('<PaneConversationHeader')).toBeGreaterThan(pane.indexOf('className="ixm-conversation"'))
    expect(pane.indexOf('<PaneConversationHeader')).toBeLessThan(pane.indexOf('<ChatThread'))
    const primary = readFileSync(join(here, '..', 'InboxPage.tsx'), 'utf8')
    const at = primary.indexOf('ixm-conversation ixm-conversation--primary')
    expect(at).toBeGreaterThan(-1)
    const tail = primary.slice(at, at + 600)
    expect(tail.indexOf('<PaneConversationHeader')).toBeLessThan(tail.indexOf('renderSmsThreadPane()'))
  })
})
