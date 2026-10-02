/**
 * ROLLBACK for Campaign Composer 2.0 (desktop).
 *
 * The Composer replaces the legacy New Campaign modal on the modern desktop.
 * The legacy modal is kept intact (and remains the phone's builder); an
 * operator or support can bring it back on desktop without a deploy:
 *
 *   ?composer=legacy                          this load only
 *   localStorage['lc.campaignComposer'] = 'legacy'   until cleared
 *
 * Anything else (absent, 'on', '2') means the Composer.
 */
export const COMPOSER_FLAG_KEY = 'lc.campaignComposer'

export function isLegacyBuilderForced(search = typeof window !== 'undefined' ? window.location.search : '', storage: Pick<Storage, 'getItem'> | null = typeof window !== 'undefined' ? window.localStorage : null): boolean {
  try {
    if (new URLSearchParams(search).get('composer') === 'legacy') return true
    return storage?.getItem(COMPOSER_FLAG_KEY) === 'legacy'
  } catch {
    return false
  }
}
