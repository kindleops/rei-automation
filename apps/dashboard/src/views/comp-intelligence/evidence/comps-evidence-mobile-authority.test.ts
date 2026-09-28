import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(here, rel), 'utf8')

describe('Comps mobile surface authority', () => {
  /**
   * The installed PWA gives the document no scroll. A root that relies on
   * document scroll renders the first screen and then freezes: "Comp
   * intelligence can't scroll". The surface owns its scroll, absolute against
   * the workspace section (never a viewport-unit height).
   */
  it('owns its own vertical scroll on mobile', () => {
    const css = read('comps-evidence.css')
    const at = css.indexOf('\n.cev {')
    const root = css.slice(at, css.indexOf('}', at))
    expect(root).toMatch(/position:\s*absolute/)
    expect(root).toMatch(/inset:\s*0/)
    expect(root).toMatch(/overflow-y:\s*auto/)
    expect(root).not.toMatch(/\d+(dvh|vh|lvh|svh)/)
  })

  it('follows the property the global context chip shows', () => {
    const entry = read('../CompIntelligenceWorkspace.tsx')
    expect(entry).toMatch(/readSelectedContext\(\)/)
    expect(entry).toMatch(/PROPERTY_LOCATOR_EVENT, onLocator/)
    expect(entry).toMatch(/dealContext\?\.property_id \|\| chipPropertyId \|\|/)
  })
})
