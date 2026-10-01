import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { LCEmpty, LCError, LCSkeleton, cx } from '../../../shared/lc'
import { GROUPS, nf, type GroupKey, type RailRow } from './war-room-model'

/**
 * MISSION RAIL — every campaign by its real operational state: live now,
 * needs attention, scheduled, waiting for the window, paused, drafts,
 * completed, archived. One dense row each: source, place, state in the
 * product's words, progress against the EXECUTABLE cohort, replies, and the
 * one thing that is next or in the way. ↑ ↓ move the selection.
 */

const COLLAPSED_BY_DEFAULT: GroupKey[] = ['archived']

function Row({ row, selected, onSelect }: { row: RailRow; selected: boolean; onSelect: (id: string) => void }) {
  const m = row.mission
  const quiet = m.group === 'drafts' || m.group === 'archived' || m.group === 'completed'
  return (
    <li
      role="option"
      aria-selected={selected}
      id={`cc3-row-${row.id}`}
      data-cc3-row={row.id}
      className={cx('cc3-row', selected && 'is-selected', quiet && 'is-quiet')}
      data-tone={m.tone}
      data-group={m.group}
      onClick={() => onSelect(row.id)}
    >
      <span className="cc3-row__top">
        <span className="cc3-row__eyebrow">{row.eyebrow}</span>
        {row.replies ? <span className="cc3-row__replies lc-num" title={`${row.replies} sellers replied`}><Icon name="message" size={11} />{nf(row.replies)}</span> : null}
      </span>
      <span className="cc3-row__title">
        {m.live ? <i className="cc3-row__live" aria-label="Live" /> : null}
        <span>{row.title}</span>
      </span>
      <span className="cc3-row__state">
        <span className="cc3-row__word" data-tone={m.tone}>{m.label}</span>
        {row.cue && row.cue !== m.label ? <span className="cc3-row__cue" data-tone={row.cueTone}>{row.cue}</span> : null}
      </span>
      {row.progress ? (
        <span className="cc3-row__progress">
          <span className="cc3-row__track"><i style={{ width: `${row.progress.pct}%` }} /></span>
          <span className="cc3-row__count lc-num"><b>{nf(row.progress.sent)}</b> / {nf(row.progress.of)} sent</span>
        </span>
      ) : null}
    </li>
  )
}

export const MissionRail = memo(function MissionRail({
  groups, selectedId, onSelect, loading, failed, onRetry, total, onClose,
}: {
  groups: Array<{ key: GroupKey; label: string; rows: RailRow[] }>
  selectedId: string | null
  onSelect: (id: string) => void
  loading: boolean
  failed: boolean
  onRetry: () => void
  total: number
  onClose?: () => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(GROUPS.map((g) => [g.key, !COLLAPSED_BY_DEFAULT.includes(g.key)])))
  const list = useRef<HTMLUListElement>(null)
  const flat = groups.filter((g) => open[g.key]).flatMap((g) => g.rows.map((r) => r.id))

  useEffect(() => {
    if (!selectedId || !list.current) return
    list.current.querySelector<HTMLElement>(`[data-cc3-row="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!flat.length) return
    const at = Math.max(0, flat.indexOf(selectedId ?? ''))
    let next = -1
    if (e.key === 'ArrowDown') next = Math.min(flat.length - 1, at + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = flat.length - 1
    else if (e.key === 'Escape' && onClose) { e.preventDefault(); onClose(); return }
    if (next < 0) return
    e.preventDefault()
    onSelect(flat[next])
  }

  return (
    <nav className="cc3-rail" aria-label="Campaigns">
      <header className="cc3-rail__head">
        <span className="cc3-rail__title">Campaigns</span>
        <span className="cc3-rail__count lc-num">{nf(total)}</span>
        {onClose ? <button type="button" className="cc3-rail__close" onClick={onClose} aria-label="Close campaigns"><Icon name="x" size={14} /></button> : null}
      </header>
      <div className="cc3-rail__scroll lc-scroll">
        {loading && !total ? <LCSkeleton shape="rows" count={7} label="Campaigns loading" /> : failed && !total ? (
          <LCError what="Campaigns didn’t load" onRetry={onRetry} compact />
        ) : !groups.length ? (
          <LCEmpty title={total ? 'No campaign matches' : 'No campaigns yet'} body={total ? 'Clear the search to see every campaign.' : 'Create one to start an outbound execution.'} compact />
        ) : (
          <ul ref={list} className="cc3-rail__list" role="listbox" aria-label="Campaigns by state" tabIndex={0} aria-activedescendant={selectedId ? `cc3-row-${selectedId}` : undefined} onKeyDown={onKey}>
            {groups.map((g) => (
              <li key={g.key} className="cc3-group" data-group={g.key} role="presentation">
                <button type="button" className="cc3-group__head" aria-expanded={open[g.key]} onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}>
                  <span>{g.label}</span>
                  <b className="lc-num">{nf(g.rows.length)}</b>
                  <Icon name="chevron-down" size={12} className={cx('cc3-group__chev', !open[g.key] && 'is-closed')} />
                </button>
                {open[g.key] ? (
                  <ul className="cc3-group__rows" role="group" aria-label={g.label}>
                    {g.rows.map((r) => <Row key={r.id} row={r} selected={r.id === selectedId} onSelect={onSelect} />)}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className="cc3-rail__foot"><kbd className="lc-kbd">↑</kbd><kbd className="lc-kbd">↓</kbd><span>move between campaigns</span></footer>
    </nav>
  )
})
