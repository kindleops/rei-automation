import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * INBOX-FINAL-HARDEN-2 §4 — no Google API key literal in source.
 *
 * Four call sites read VITE_GOOGLE_MAPS_API_KEY with a literal key as the `||`
 * fallback, so the key shipped inside every built bundle and Maps kept working
 * whether or not the environment was configured — which is precisely why the
 * missing configuration went unnoticed. Two DIFFERENT keys were checked in
 * across those four sites.
 *
 * Config is now the only source and every caller fails closed. This guard
 * fails the build if a literal comes back.
 *
 * Deliberately a source scan rather than an assertion about one module: the
 * point is that no file anywhere can carry one, including a new one.
 */

const SRC_ROOT = join(__dirname, '..', '..')
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css', '.html']

/**
 * Google API keys are `AIza` followed by 35 URL-safe characters. Matched by
 * shape so an unfamiliar key is caught too, and assembled at runtime so this
 * file does not itself contain something that looks like one.
 */
const GOOGLE_KEY_PATTERN = new RegExp(['AIza', '[0-9A-Za-z_-]{35}'].join(''))

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full)
  }
  return out
}

describe('google maps key hygiene', () => {
  it('no source file contains a Google API key literal', () => {
    const offenders: string[] = []
    for (const file of walk(SRC_ROOT)) {
      // This guard names the pattern it looks for, so it must not flag itself.
      if (file.endsWith('maps-key-hygiene.test.ts')) continue
      const contents = readFileSync(file, 'utf8')
      if (GOOGLE_KEY_PATTERN.test(contents)) offenders.push(relative(SRC_ROOT, file))
    }
    expect(
      offenders,
      `a Google API key literal is present in source — read it from config and fail closed instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  /**
   * The absent-config case, exercised by stubbing the env rather than relying
   * on the test runner's: VITE_GOOGLE_MAPS_API_KEY IS configured here (that is
   * the point — config, not a literal, is what makes Maps work), so asserting
   * absence unconditionally would only prove the runner's environment.
   */
  it('fails closed when no key is configured', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '')
    vi.resetModules()
    try {
      const loader = await import('./loadGoogleMaps')
      expect(loader.getGoogleMapsApiKey()).toBeNull()
      expect(loader.hasGoogleMapsApiKey()).toBe(false)
      await expect(loader.loadGoogleMaps()).rejects.toThrow(
        /google_maps_api_key_not_configured|only available in the browser/,
      )

      const { buildStreetViewUrl, buildAerialViewUrl } = await import('../../domain/inbox/inbox-normalization')
      expect(buildStreetViewUrl('1115 Nw 64th St, Miami, Fl 33150', 25.85, -80.21)).toBeNull()
      expect(buildAerialViewUrl('1115 Nw 64th St, Miami, Fl 33150', 25.85, -80.21)).toBeNull()
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('uses the configured key when config provides one', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key-from-config')
    vi.resetModules()
    try {
      const loader = await import('./loadGoogleMaps')
      expect(loader.getGoogleMapsApiKey()).toBe('test-key-from-config')
      expect(loader.hasGoogleMapsApiKey()).toBe(true)

      const { buildStreetViewUrl } = await import('../../domain/inbox/inbox-normalization')
      const url = buildStreetViewUrl('1115 Nw 64th St, Miami, Fl 33150', 25.85, -80.21)
      expect(url).toContain('key=test-key-from-config')
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
