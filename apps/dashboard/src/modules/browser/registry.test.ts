import { describe, expect, it } from 'vitest'
import { classify, guardUrl, hostOf, interpretInput } from './registry'
import { sandboxAttr, DENIED_FEATURES } from './surface/embed-policy'

const OWN = ['https://ops.leadcommand.ai']

describe('URL guard (sanitizer floor)', () => {
  it.each([
    ['javascript:alert(1)', 'unsafe_scheme'],
    ['JaVaScRiPt:alert(1)', 'unsafe_scheme'],
    ['data:text/html,<script>alert(1)</script>', 'unsafe_scheme'],
    ['file:///etc/passwd', 'unsafe_scheme'],
    ['ftp://x.gov/a', 'unsafe_scheme'],
    ['https://user:pass@x.gov/', 'credentials_in_url'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
  ])('rejects %s', (raw, reason) => {
    const g = guardUrl(raw, OWN)
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.reason).toBe(reason)
  })

  it('never lets LeadCommand frame its own origin', () => {
    const g = guardUrl('https://ops.leadcommand.ai/inbox', OWN)
    expect(g).toEqual({ ok: false, reason: 'self_origin' })
  })

  it('accepts https and marks http insecure (legacy county sites are allowed, flagged)', () => {
    const a = guardUrl('https://www.hennepin.us/residents/property', OWN)
    expect(a.ok && a.insecure).toBe(false)
    const b = guardUrl('http://old-county.example.gov/search', OWN)
    expect(b.ok && b.insecure).toBe(true)
  })

  it('shows the real host, never a lookalike from the path', () => {
    expect(hostOf('https://evil.example/https://www.zillow.com/')).toBe('evil.example')
    expect(hostOf('https://www.zillow.com.evil.example/x')).toBe('zillow.com.evil.example')
    expect(hostOf('nonsense')).toBeNull()
  })
})

describe('address field interpretation', () => {
  it('treats hosts and URLs as addresses', () => {
    expect(interpretInput('hennepin.us')).toEqual({ kind: 'url', url: 'https://hennepin.us/' })
    expect(interpretInput('https://x.gov/a?b=1')).toEqual({ kind: 'url', url: 'https://x.gov/a?b=1' })
  })

  it('treats words as a web search with the query encoded', () => {
    const r = interpretInput('3635 emerson ave n minneapolis')
    expect(r.kind).toBe('search')
    if (r.kind === 'search') {
      expect(r.url.startsWith('https://www.google.com/search?q=')).toBe(true)
      expect(r.url).toContain('3635%20emerson')
    }
  })

  it('refuses dangerous schemes typed into the field', () => {
    expect(interpretInput('javascript:alert(1)')).toEqual({ kind: 'invalid', reason: 'unsafe_scheme' })
    expect(interpretInput('data:text/html,hi')).toEqual({ kind: 'invalid', reason: 'unsafe_scheme' })
  })
})

describe('embedding is opt-in per proven domain', () => {
  it('an unknown domain is EXTERNAL REQUIRED (nothing framed)', () => {
    const c = classify('https://unknown-site.example/')
    expect(c.embed === 'EMBEDS').toBe(false)
    expect(c.sandbox).toEqual([])
  })

  it('sandbox tokens are filtered to the permitted set (no downloads, no top navigation)', () => {
    expect(sandboxAttr(['allow-scripts', 'allow-downloads', 'allow-top-navigation', 'allow-forms', 'allow-scripts'])).toBe('allow-scripts allow-forms')
  })

  it('powerful features are denied to every framed page', () => {
    for (const f of ['camera', 'microphone', 'geolocation', 'clipboard-write', 'payment', 'display-capture']) expect(DENIED_FEATURES).toContain(`${f} 'none'`)
  })
})
