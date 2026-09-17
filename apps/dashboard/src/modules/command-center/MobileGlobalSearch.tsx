import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../shared/icons'
import type { CommandResult, CommandResultType, GlobalCommandSearchContext } from '../../domain/command-center/command.types'
import { useGlobalCommandSearch } from './useGlobalCommandSearch'
import { readRecentCommandResults, clearRecentCommandResults, type RecentCommandResult } from './recent-command-results'
import { useMobileKeyboardInset } from '../mobile/useMobileKeyboardInset'
import './mobile-global-search.css'

/**
 * THE ONE GLOBAL SEARCH, on a phone.
 *
 * Before this the product had two global searches on mobile and which one you got
 * depended on the route you happened to be standing on:
 *
 *   inbox family      NexusTopBar -> MobileSearchOverlay -> useInboxTopSearch
 *                     (a half-height sheet, six entity providers, no actions,
 *                      no applications, no recents beyond map locations)
 *   everywhere else   PortableCommandShell -> GlobalCommandOverlay
 *                     (the DESKTOP command palette, complete with a side preview
 *                      pane, rendered inside 390px)
 *
 * They searched different things and looked nothing alike. This is the single
 * surface both now open: one hook (`useGlobalCommandSearch`, the superset), one
 * full-screen mobile layer, one dismissal model.
 *
 * Full-screen rather than a sheet is deliberate — §2 allows a popover only for a
 * couple of immediate actions, and a search with an input, grouped results and a
 * long scroll is the textbook case for a layer.
 */

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

/** Result-type glyphs, so a row's kind is legible before its text is read. */
const TYPE_ICON: Partial<Record<CommandResultType, Parameters<typeof Icon>[0]['name']>> = {
  property: 'home',
  seller: 'users',
  conversation: 'message',
  buyer: 'users',
  market: 'map',
  pipeline: 'radar',
  queue: 'send',
  location: 'pin',
  leads: 'inbox',
  comps: 'stats',
  underwrite: 'dollar-sign',
  app: 'grid',
  filter: 'filter',
  map_action: 'map',
  system_action: 'settings',
  recent: 'clock',
}

interface MobileGlobalSearchProps {
  open: boolean
  initialQuery?: string
  context: GlobalCommandSearchContext
  onClose: () => void
  onExecute: (result: CommandResult) => void
}

export const MobileGlobalSearch = ({
  open,
  initialQuery = '',
  context,
  onClose,
  onExecute,
}: MobileGlobalSearchProps) => {
  const [query, setQuery] = useState(initialQuery)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const keyboardInset = useMobileKeyboardInset(open)
  const { results, loading, groupedResults } = useGlobalCommandSearch(query, context)

  // Read once per open. The store is localStorage-backed and only changes when a
  // result is executed — which closes this layer — so re-reading per keystroke
  // would be pure work.
  const [recents, setRecents] = useState<RecentCommandResult[]>([])

  useEffect(() => {
    if (!open) return
    setQuery(initialQuery)
    setRecents(readRecentCommandResults())
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open, initialQuery, onClose])

  /**
   * Scroll lock while the layer is up. Without it the page underneath scrolls with
   * the results list on iOS and the layer appears to drift — the same "floating
   * surface" complaint §3 raises about the menu.
   */
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [open])

  const trimmed = query.trim()
  const showRecents = trimmed.length === 0 && recents.length > 0

  /**
   * "Best Matches" is a claim about a query. With an empty field there is no query,
   * so the groups render under their own headings and the first one reads as a jump
   * list rather than as the best answer to a question nobody asked.
   */
  const sections = useMemo(() => {
    if (trimmed.length === 0) return groupedResults.groups
    const best = groupedResults.bestMatches
    const bestIds = new Set(best.map((item) => item.id))
    const rest = groupedResults.groups
      .map((group) => ({ ...group, items: group.items.filter((item) => !bestIds.has(item.id)) }))
      .filter((group) => group.items.length > 0)
    return best.length > 0
      ? [{ key: 'best', label: 'Best Matches', items: best }, ...rest]
      : rest
  }, [groupedResults, trimmed])

  const firstResult = sections[0]?.items[0]

  if (!open || typeof document === 'undefined') return null

  const renderRow = (
    key: string,
    icon: Parameters<typeof Icon>[0]['name'],
    title: string,
    subtitle: string | undefined,
    badge: string | undefined,
    onClick: () => void,
    disabled?: boolean,
  ) => (
    <button
      key={key}
      type="button"
      className={cls('nx-mgs__row', disabled && 'is-disabled')}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="nx-mgs__row-icon" aria-hidden><Icon name={icon} size={15} strokeWidth={1.6} /></span>
      <span className="nx-mgs__row-copy">
        <strong>{title}</strong>
        {subtitle ? <small>{subtitle}</small> : null}
      </span>
      {badge ? <em className="nx-mgs__row-badge">{badge}</em> : null}
    </button>
  )

  const layer = (
    <div
      className="nx-mgs"
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
      /* The keyboard covers the bottom of the layout viewport on iOS rather than
         shrinking it, so the results list gives up exactly that much height and the
         last row stays reachable instead of sitting under the keys. */
      style={{ '--nx-mgs-keyboard': `${keyboardInset}px` } as React.CSSProperties}
    >
      <header className="nx-mgs__bar">
        <div className="nx-mgs__field">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            /* 16px in CSS — anything smaller triggers iOS focus zoom, which breaks
               every fixed surface in the shell including this one. */
            placeholder="Sellers, properties, buyers, campaigns…"
            aria-label="Search everything"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (firstResult && !firstResult.meta?.disabled) onExecute(firstResult)
            }}
          />
          {trimmed ? (
            <button
              type="button"
              className="nx-mgs__clear"
              aria-label="Clear search"
              onClick={() => { setQuery(''); inputRef.current?.focus() }}
            >
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </div>
        <button type="button" className="nx-mgs__cancel" onClick={onClose}>Cancel</button>
      </header>

      <div className="nx-mgs__body">
        {showRecents ? (
          <section className="nx-mgs__group">
            <header className="nx-mgs__group-head">
              <span>Recent</span>
              <button
                type="button"
                onClick={() => { clearRecentCommandResults(); setRecents([]) }}
              >
                Clear
              </button>
            </header>
            {recents.map((recent) => renderRow(
              `recent-${recent.id}`,
              TYPE_ICON[recent.type] ?? 'clock',
              recent.title,
              recent.subtitle,
              recent.badge,
              () => onExecute(recent as CommandResult),
            ))}
          </section>
        ) : null}

        {sections.map((group) => (
          <section key={group.key} className="nx-mgs__group">
            <header className="nx-mgs__group-head"><span>{group.label}</span></header>
            {group.items.map((result) => renderRow(
              result.id,
              result.icon ?? TYPE_ICON[result.type] ?? 'command',
              result.title,
              result.subtitle,
              result.badge,
              () => onExecute(result),
              result.meta?.disabled,
            ))}
          </section>
        ))}

        {/* Loading is only claimed while a remote lookup is genuinely outstanding;
            an idle field with no query is not "searching". */}
        {loading ? (
          <div className="nx-mgs__state" role="status">
            <span className="nx-mgs__spinner" aria-hidden />
            <span>Searching…</span>
          </div>
        ) : null}

        {!loading && trimmed.length >= 2 && results.length === 0 ? (
          <div className="nx-mgs__state">
            <strong>No matches for “{trimmed}”</strong>
            <span>Try an address, a seller name, a phone number, a market or a campaign.</span>
          </div>
        ) : null}

        {!loading && trimmed.length === 0 && !showRecents && sections.length === 0 ? (
          <div className="nx-mgs__state">
            <strong>Search everything</strong>
            <span>Sellers, properties, buyers, markets, conversations, queue state and applications.</span>
          </div>
        ) : null}
      </div>
    </div>
  )

  return createPortal(layer, document.body)
}
