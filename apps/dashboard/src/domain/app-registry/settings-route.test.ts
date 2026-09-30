import { describe, expect, it } from 'vitest'
import { resolveAppForRoute } from './app-registry'
import { getStaticCommandRegistry } from '../../modules/command-center/command.registry'

describe('desktop Settings page routing', () => {
  it('names /settings as the Settings app (pane label + split de-duplication)', () => {
    expect(resolveAppForRoute('/settings').id).toBe('settings')
    expect(resolveAppForRoute('/settings/').id).toBe('settings')
    // unrelated paths are untouched
    expect(resolveAppForRoute('/inbox').id).toBe('inbox')
    expect(resolveAppForRoute('/settingsx').id).toBe('inbox')
  })

  it('offers Settings as a search destination only on the modern desktop', () => {
    const desk = getStaticCommandRegistry({ routePath: '/home', isMobile: true, isModernDesktop: true })
    const phone = getStaticCommandRegistry({ routePath: '/home', isMobile: true })
    const classic = getStaticCommandRegistry({ routePath: '/home', isMobile: false })
    expect(desk.find((r) => r.id === 'app-open-settings')?.route).toBe('/settings')
    expect(phone.some((r) => r.id === 'app-open-settings')).toBe(false)
    expect(classic.some((r) => r.id === 'app-open-settings')).toBe(false)
  })
})
