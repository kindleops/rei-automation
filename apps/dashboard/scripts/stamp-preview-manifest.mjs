/**
 * Stamp the built manifest so an installed iOS Home-Screen app can launch a
 * protection-enabled preview deployment without leaving its own origin.
 *
 * Why this exists:
 *
 * With Vercel Deployment Protection on, an unauthenticated request to the
 * deployment — the document, /manifest.webmanifest and /sw.js alike — answers
 * `302 https://vercel.com/sso-api?...`. An installed iOS web app runs in its own
 * cookie container, so the SSO cookie held by Safari is simply not present
 * there. Every launch therefore hits a *cross-origin* redirect, which a
 * standalone container cannot follow, and iOS drops the session into Safari.
 * That is the whole reason a freshly installed icon opens in browser mode while
 * an older icon (whose container already holds a valid cookie for its specific
 * minted host) keeps working.
 *
 * Vercel's protection-bypass token answers this: requesting any path with
 * `x-vercel-protection-bypass` plus `x-vercel-set-bypass-cookie=true` returns
 * 200 and sets a bypass cookie scoped to that host. Putting those parameters on
 * `start_url` means the first request the standalone container makes on every
 * launch establishes its own cookie and returns 200 — no cross-origin hop, so
 * iOS keeps it standalone.
 *
 * The token is injected at build time from PREVIEW_BYPASS_TOKEN and is never
 * committed. With no token set this is a no-op, so production builds and any
 * unprotected deployment keep a clean `start_url`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const MANIFEST = resolve(process.cwd(), 'dist/manifest.webmanifest')
const token = (process.env.PREVIEW_BYPASS_TOKEN || '').trim()

if (!token) {
  console.log('[stamp-preview-manifest] PREVIEW_BYPASS_TOKEN unset — leaving start_url untouched')
  process.exit(0)
}
if (!existsSync(MANIFEST)) {
  console.log(`[stamp-preview-manifest] no manifest at ${MANIFEST} — nothing to stamp`)
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const base = String(manifest.start_url || '/')
const [path, existingQuery = ''] = base.split('?')

const params = new URLSearchParams(existingQuery)
params.set('x-vercel-protection-bypass', token)
// Ask Vercel to persist the bypass as a cookie for this container, so only the
// launch request carries the token and in-app navigation is plain same-origin.
params.set('x-vercel-set-bypass-cookie', 'true')

manifest.start_url = `${path}?${params.toString()}`

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[stamp-preview-manifest] start_url -> ${path}?x-vercel-protection-bypass=***&x-vercel-set-bypass-cookie=true`)
