import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../shared/icons'
import type { CommandResult, GlobalCommandSearchContext } from '../../domain/command-center/command.types'
import { useGlobalCommandSearch } from '../command-center/useGlobalCommandSearch'
import { canonicalizeRoutePath } from '../../domain/app-registry/app-registry'
import { openApp } from './workspace/workspace-store'
import type { WorkspaceCommand } from './deck/deck-model'
import { sound } from '../../shared/sound'
import { inspectRefOfCommand, objectRefOfCommand } from './inspector/command-inspect'
import { openInspector } from './inspector/inspector-store'
import { MOD_KEY, openObjectBeside } from './objects/object-actions'

/**
 * THE COMMAND BAR — one field that searches the whole product.
 *
 * Same providers, same ranking and same execute path as the command palette
 * (useGlobalCommandSearch + the app's executeGlobalCommand); on the desktop it
 * lives in the top bar instead of a modal. ⌘K focuses it from anywhere, arrows
 * move, Enter opens, ⌘/Ctrl↵ opens beside (⌥↵ still works), ⇧↵ inspects, Esc lets go. Results arrive grouped, best matches first,
 * with a live preview of the highlighted result beside them.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface DesktopCommandBarProps {
  open: boolean
  initialQuery: string
  context: GlobalCommandSearchContext
  onOpen: () => void
  onClose: () => void
  onExecute: (result: CommandResult) => void
  /** the focused app's language: "Search sellers, replies, properties…" */
  placeholder?: string
  /** which app the search speaks for first (shown as a quiet scope chip) */
  scope?: string | null
  /** deterministic workspace commands for what was typed */
  extraResults?: (query: string) => CommandResult[]
  onWorkspaceCommand?: (cmd: WorkspaceCommand) => void
}

export function DesktopCommandBar({ open, initialQuery, context, onOpen, onClose, onExecute, placeholder, scope, extraResults, onWorkspaceCommand }: DesktopCommandBarProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { results, loading, groupedResults } = useGlobalCommandSearch(open ? query : '', context)

  // Opened from anywhere (⌘K, "/", a surface asking for search): take focus and
  // any query the caller brought with it.
  useEffect(() => {
    if (!open) return
    if (initialQuery) setQuery(initialQuery)
    setActiveIndex(0)
    const t = window.setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 16)
    return () => window.clearTimeout(t)
  }, [open, initialQuery])

  useEffect(() => { setActiveIndex(0) }, [query])

  // Click outside lets go.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose() }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open, onClose])

  const groups = useMemo(() => {
    const best = new Set(groupedResults.bestMatches.map((r) => r.id))
    return groupedResults.groups
      .map((g) => ({ ...g, items: g.items.filter((r) => !best.has(r.id)) }))
      .filter((g) => g.items.length > 0)
  }, [groupedResults])
  const workspace = useMemo(() => (open && extraResults ? extraResults(query) : []), [open, extraResults, query])
  const ordered = useMemo(() => [...workspace, ...groupedResults.bestMatches, ...groups.flatMap((g) => g.items)], [workspace, groupedResults.bestMatches, groups])
  const active = ordered[activeIndex] ?? null

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const run = (r: CommandResult | null, split = false) => {
    if (!r || r.meta?.disabled) return
    const wsCmd = (r.payload as { __workspace?: WorkspaceCommand } | undefined)?.__workspace
    if (wsCmd) {
      onWorkspaceCommand?.(wsCmd)
      setQuery('')
      onClose()
      inputRef.current?.blur()
      return
    }
    sound.command.execute()
    // ⌘↵ / ⌘-click (⌥ too): open the result BESIDE what is on screen (split pane).
    // An object result goes through the object registry (canonical deep link +
    // linked context); a plain route splits as it always did.
    const obj = split ? objectRefOfCommand(r) : null
    if (obj && openObjectBeside(obj).ok) { /* opened beside */ }
    else if (split && r.route) openApp(canonicalizeRoutePath(r.route), 'beside')
    else onExecute(r)
    setQuery('')
    onClose()
    inputRef.current?.blur()
  }

  const inspect = (ref: NonNullable<ReturnType<typeof inspectRefOfCommand>>) => {
    openInspector(ref, { replace: true }); sound.ui.select(); setQuery(''); onClose(); inputRef.current?.blur()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, Math.max(ordered.length - 1, 0))); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      // ⇧↵ inspects a seller/property result in place instead of navigating
      const ref = inspectRefOfCommand(ordered[activeIndex] ?? null)
      if (ref) { e.preventDefault(); inspect(ref); return }
    }
    // ↵ open · ⌘/Ctrl↵ open beside (⌥↵ kept as an alias)
    if (e.key === 'Enter') { e.preventDefault(); run(ordered[activeIndex] ?? null, e.metaKey || e.ctrlKey || e.altKey); return }
    if (e.key === 'Escape') { e.preventDefault(); if (query) setQuery(''); else { onClose(); inputRef.current?.blur() } }
  }

  let index = -1
  const row = (r: CommandResult) => {
    index += 1
    const i = index
    return (
      <button
        key={r.id}
        type="button"
        className={cls('dsk-cmd__item', i === activeIndex && 'is-active', r.meta?.disabled && 'is-disabled')}
        data-cmd-index={i}
        onMouseMove={() => { if (i !== activeIndex) setActiveIndex(i) }}
        onClick={(e) => {
          // the click grammar: ⇧-click inspects, ⌘/Ctrl-click opens beside
          const ref = e.shiftKey && !e.metaKey && !e.ctrlKey ? inspectRefOfCommand(r) : null
          if (ref) inspect(ref)
          else run(r, e.altKey || e.metaKey || e.ctrlKey)
        }}
      >
        <span className="dsk-cmd__icon"><Icon name={r.icon || 'command'} size={15} strokeWidth={1.7} /></span>
        <span className="dsk-cmd__copy">
          <strong>{r.title}</strong>
          {r.subtitle ? <small>{r.subtitle}</small> : null}
        </span>
        {r.badge ? <b className="dsk-cmd__badge">{r.badge}</b> : null}
        <em className="dsk-cmd__hint">{r.meta?.hint || (r.route ? 'Open' : 'Run')}</em>
      </button>
    )
  }

  return (
    <div className={cls('dsk-cmd', open && 'is-open')} ref={rootRef}>
      <label className="dsk-cmd__field">
        <Icon name="search" size={16} strokeWidth={1.8} />
        {scope ? <span className="dsk-cmd__scope" title={`Searching ${scope} first, then everything`}>{scope}</span> : null}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); if (!open) onOpen() }}
          onFocus={() => { if (!open) onOpen() }}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? 'Search sellers, properties, buyers, campaigns, markets, actions…'}
          autoComplete="off"
          spellCheck={false}
          aria-label="Search everything"
          aria-expanded={open}
          aria-controls="dsk-cmd-results"
        />
        {loading && open ? <span className="dsk-cmd__spin" aria-hidden /> : null}
        <kbd>{open ? 'esc' : '⌘K'}</kbd>
      </label>

      {open ? (
        <div className="dsk-cmd__panel" role="listbox" id="dsk-cmd-results">
          <div className="dsk-cmd__results" ref={listRef}>
            {workspace.length > 0 ? (
              <section className="dsk-cmd__group">
                <header>Workspace</header>
                {workspace.map(row)}
              </section>
            ) : null}
            {groupedResults.bestMatches.length > 0 ? (
              <section className="dsk-cmd__group">
                <header>{query.trim() ? 'Best matches' : 'Jump back in'}</header>
                {groupedResults.bestMatches.map(row)}
              </section>
            ) : null}
            {groups.map((g) => (
              <section key={g.key} className="dsk-cmd__group">
                <header>{g.label}</header>
                {g.items.map(row)}
              </section>
            ))}
            {!loading && results.length === 0 && workspace.length === 0 ? (
              <div className="dsk-cmd__empty">
                <strong>{query.trim() ? 'Nothing matches that yet' : 'Search the whole command center'}</strong>
                <span>Sellers, properties, buyers, markets, campaigns, workflows, map themes and actions.</span>
              </div>
            ) : null}
          </div>
          <aside className="dsk-cmd__preview" aria-live="polite">
            <p className="dsk-cmd__eyebrow">{active?.preview?.eyebrow || (active ? active.type.replace(/_/g, ' ') : 'Command center')}</p>
            <h3>{active?.preview?.title || active?.title || 'Everything, one field'}</h3>
            <p className="dsk-cmd__summary">{active?.preview?.summary || active?.subtitle || 'Type a name, an address, a phone, a market or what you want to do.'}</p>
            {(active?.preview?.details ?? []).length ? (
              <dl className="dsk-cmd__details">
                {(active?.preview?.details ?? []).map((d) => (
                  <div key={`${d.label}-${d.value}`}><dt>{d.label}</dt><dd>{d.value}</dd></div>
                ))}
              </dl>
            ) : null}
            {active ? (
              <footer className="dsk-cmd__run">
                <span>{active.route ? active.route : active.action?.label || 'Action'}</span>
                <b>↵ {active.meta?.hint || (active.route ? 'Open' : 'Run')}{active.route || objectRefOfCommand(active) ? <span className="dsk-cmd__alt">{MOD_KEY === '⌘' ? '⌘↵' : 'Ctrl↵'} Beside</span> : null}{inspectRefOfCommand(active) ? <span className="dsk-cmd__alt">⇧↵ Inspect</span> : null}</b>
              </footer>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  )
}
