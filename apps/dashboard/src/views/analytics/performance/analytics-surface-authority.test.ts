import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8')

describe('mobile Analytics surface', () => {
  it('is what phones render on /analytics', () => {
    const inbox = read('modules/inbox/InboxPage.tsx')
    expect(inbox).toMatch(/isMobile\s*\n?\s*\?\s*<AnalyticsSurface \/>/)
  })

  it('reads one server model and never aggregates events in the browser', () => {
    const surface = read('views/analytics/performance/AnalyticsSurface.tsx')
    const parts = read('views/analytics/performance/AnalyticsParts.tsx')
    expect(surface).toMatch(/fetchAnalyticsPerformance/)
    for (const src of [surface, parts]) {
      expect(src).not.toMatch(/from\('(send_queue|message_events)'\)/)
      expect(src).not.toMatch(/replyRate\s*=\s*[^=]/)
    }
  })

  it('owns its own vertical scroll (the installed PWA gives the document none)', () => {
    const css = read('views/analytics/performance/analytics-surface.css')
    const root = css.slice(css.indexOf('\n.anx {'), css.indexOf('}', css.indexOf('\n.anx {')))
    expect(root).toMatch(/position:\s*absolute/)
    expect(root).toMatch(/overflow-y:\s*auto/)
    expect(root).not.toMatch(/\d+(dvh|vh|lvh|svh)/)
  })

  it('never shades an area by a raw count', () => {
    const geo = read('views/analytics/performance/AnalyticsGeo.tsx')
    expect(geo).toMatch(/viz === 'areas' && effView === 'count' \? 'dots'/)
  })
})
