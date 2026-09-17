import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INBOX_COMMAND_SHELL_ROUTES, routeHasInboxCommandShell } from './inbox-shell-routes'

/**
 * FINAL-FRONTEND-LOCK-1 §4/§19.
 *
 * NexusTopBar (rendered by InboxPage) and PortableCommandShell each paint a
 * `.nx-mobile-command-dock` at `position: fixed; top: 0; z-index: 150`. The
 * shell mounts PortableCommandShell only when the route is NOT in
 * INBOX_COMMAND_SHELL_ROUTES, so a route that renders InboxView but is missing
 * from that set gets TWO stacked top docks and the lower one's controls become
 * permanently unclickable.
 *
 * Production served exactly that on /analytics. This test reads routes.tsx and
 * fails if any route rendering InboxView/ConversationView is absent from the
 * set — so the list cannot drift away from the router again without a red test.
 */
const ROUTES_SRC = readFileSync(resolve(__dirname, '../../app/routes.tsx'), 'utf8')

/**
 * Extract (path, rendered JSX) pairs from the route definitions.
 *
 * Splitting on `path:` and reading up to the NEXT `path:` is deliberate. An
 * earlier version anchored each match on a trailing `,\n})`, which silently
 * skipped /pipeline and /comp-intelligence — and a parser that quietly matches
 * a subset makes every assertion built on it pass for the wrong reason.
 */
function routeRenders(): Array<{ path: string; render: string }> {
  const chunks = ROUTES_SRC.split(/path:\s*'/).slice(1)
  const out: Array<{ path: string; render: string }> = []
  for (const chunk of chunks) {
    const path = chunk.slice(0, chunk.indexOf("'"))
    const renderAt = chunk.indexOf('render:')
    if (!path || renderAt === -1) continue
    out.push({ path, render: chunk.slice(renderAt, renderAt + 220) })
  }
  return out
}

describe('inbox command shell route set', () => {
  it('parses the route table (guards the parser itself)', () => {
    const rs = routeRenders()
    // If this drops, the regex has stopped matching and every assertion below
    // would pass vacuously — the failure mode that let a bad check look green.
    expect(rs.length).toBeGreaterThan(10)
    expect(rs.some((r) => r.path === '/analytics')).toBe(true)
    expect(rs.some((r) => r.path === '/closing-desk')).toBe(true)
  })

  it('every route rendering the inbox shell is registered', () => {
    const missing = routeRenders()
      .filter((r) => /<InboxView|<ConversationView/.test(r.render))
      .map((r) => r.path)
      .filter((p) => !routeHasInboxCommandShell(p))
    expect(missing).toEqual([])
  })

  it('includes /analytics — the route that shipped two stacked top docks', () => {
    expect(routeHasInboxCommandShell('/analytics')).toBe(true)
  })

  it('does not claim the shell for routes that own their own chrome', () => {
    for (const p of ['/closing-desk', '/email-command', '/workflow-studio', '/queue', '/campaign-command', '/entity-graph', '/buyer-match']) {
      expect(routeHasInboxCommandShell(p)).toBe(false)
    }
  })

  it('holds no route that the router does not define', () => {
    const defined = new Set(routeRenders().map((r) => r.path))
    const dead = [...INBOX_COMMAND_SHELL_ROUTES].filter((p) => !defined.has(p))
    expect(dead).toEqual([])
  })
})
