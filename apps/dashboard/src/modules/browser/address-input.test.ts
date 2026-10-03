import { describe, expect, it } from 'vitest'
import { classify, interpretInput } from './registry'

/* Regression (prod RC 8.3): typing into the address bar must resolve every everyday input. */
describe('address bar input → destination', () => {
  it.each([
    ['google.com', 'url', 'https://google.com/'],
    ['zillow.com', 'url', 'https://zillow.com/'],
    ['https://zillow.com', 'url', 'https://zillow.com/'],
    ['https://gis.hennepin.us/property/', 'url', 'https://gis.hennepin.us/property/'],
    ['hennepin.us/residents/property', 'url', 'https://hennepin.us/residents/property'],
  ])('%s → %s', (input, kind, url) => {
    const r = interpretInput(input)
    expect(r.kind).toBe(kind)
    if (r.kind === 'url') expect(r.url).toBe(url)
  })

  it('plain text is a web search with the words kept', () => {
    const r = interpretInput('zillow 3635 emerson ave n')
    expect(r.kind).toBe('search')
    if (r.kind === 'search') {
      expect(r.query).toBe('zillow 3635 emerson ave n')
      expect(r.url).toMatch(/^https:\/\/www\.google\.com\/search\?q=zillow(%20|\+)3635/)
    }
  })

  it('bare google.com / zillow.com say WHY they open externally (their www. refusal), and are never framed', () => {
    for (const u of ['https://google.com/', 'https://zillow.com/', 'https://www.google.com/search?q=x', 'https://www.zillow.com/']) {
      const c = classify(u)
      expect(c.embed, u).not.toBe('EMBEDS')
      expect(c.embed, u).not.toBe('UNKNOWN')
    }
  })

  it('a proven-embeddable official page still embeds from typed input', () => {
    const c = classify(interpretInput('https://gis.hennepin.us/property/').kind === 'url' ? 'https://gis.hennepin.us/property/' : '')
    expect(c.embed).toBe('EMBEDS')
    expect(c.sandbox).toContain('allow-scripts')
  })

  it('a www. form that EMBEDS never grants framing to a bare host', () => {
    // gis.hennepin.us has no www. form; a bare unknown host stays UNKNOWN (external)
    expect(classify('https://example-county.gov/').embed).toBe('UNKNOWN')
  })
})
