import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Icon } from '../../../shared/icons'
import { LCEmpty, LCError, LCSkeleton, cx } from '../../../shared/lc'
import { useLcSelection } from '../../../shared/lc/selection'
import { LCBulkBar, type LCBulkAction } from '../../../shared/lc/BulkBar'
import { useBulkArchive } from '../../../lib/data/useBulkArchive'
import { GROUPS, nf, type GroupKey, type RailRow } from './war-room-model'

const CAMPAIGN_NOUN = { one: 'campaign', many: 'campaigns' }
const CAMPAIGN_ARCHIVE_EFFECTS = [
  { kind: 'stops' as const, text: 'They leave the portfolio KPIs, the market index and the campaign scans.' },
  { kind: 'stops' as const, text: 'Live campaigns and campaigns with pending sends are refused — pause or archive those one at a time.' },
  { kind: 'keeps' as const, text: 'Send history is kept. Unarchive restores a campaign to Draft.' },
]

/**
 * MISSION RAIL — every campaign by its real operational state: live now,
 * needs attention, scheduled, waiting for the window, paused, drafts,
 * completed, archived. One dense row each: source, place, state in the
 * product's words, progress against the EXECUTABLE cohort, replies, and the
 * one thing that is next or in the way. ↑ ↓ move the selection.
 */

const COLLAPSED_BY_DEFAULT: GroupKey[] = ['archived']

function Row({ row, selected, onSelect, picked, selecting, onPick }: {
  row: RailRow
  selected: boolean
  onSelect: (id: string) => void
  /** [8.3] bulk selection */
  picked: boolean
  selecting: boolean
  onPick: (id: string, e: MouseEvent, onCheckbox?: boolean) => boolean
}) {
  const m = row.mission
  const quiet = m.group === 'drafts' || m.group === 'archived' || m.group === 'completed'
  return (
    <li
      role="option"
      aria-selected={selected}
      id={`cc3-row-${row.id}`}
      data-cc3-row={row.id}
      className={cx('cc3-row', selected && 'is-selected', quiet && 'is-quiet', picked && 'is-picked', selecting && 'is-selecting')}
      data-tone={m.tone}
      data-group={m.group}
      onClick={(e) => { if (onPick(row.id, e)) { e.preventDefault(); return } onSelect(row.id) }}
    >
      <button
        type="button"
        className="lc-rowcheck cc3-row__check"
        role="checkbox"
        aria-checked={picked}
        aria-label={`Select ${row.title}`}
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); onPick(row.id, e, true) }}
      >
        <span className={cx('lc-check', picked && 'is-on')} aria-hidden="true" />
      </button>
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
  const flat = useMemo(() => groups.filter((g) => open[g.key]).flatMap((g) => g.rows.map((r) => r.id)), [groups, open])

  /* [8.3] multi-select over the visible rows → bulk Archive / Unarchive through the lifecycle */
  const selection = useLcSelection(flat)
  const rowById = useMemo(() => new Map(groups.flatMap((g) => g.rows).map((r) => [r.id, r])), [groups])
  const labelOf = useCallback((id: string) => rowById.get(id)?.title ?? id, [rowById])
  const bulk = useBulkArchive({ objectType: 'campaign', noun: CAMPAIGN_NOUN, consequences: CAMPAIGN_ARCHIVE_EFFECTS, labelOf, onChanged: onRetry, source: 'campaigns' })
  const { onRowClick: pickRow, ids: pickedIds, clear: clearPicked } = selection
  const onPick = useCallback((id: string, e: MouseEvent, onCheckbox?: boolean) => pickRow(id, e, onCheckbox), [pickRow])
  const pickedArchived = pickedIds.filter((id) => rowById.get(id)?.mission.group === 'archived')
  const pickedOpen = pickedIds.filter((id) => rowById.get(id)?.mission.group !== 'archived')
  const { archive: bulkArchive, undo: bulkRestore } = bulk
  const bulkActions: LCBulkAction[] = []
  if (pickedOpen.length) {
    bulkActions.push({
      id: 'archive', label: pickedArchived.length ? `Archive ${nf(pickedOpen.length)}` : 'Archive', icon: 'archive', disabled: bulk.busy,
      onRun: () => { void bulkArchive(pickedOpen).then((r) => { if (r) clearPicked() }) },
    })
  }
  if (pickedArchived.length) {
    bulkActions.push({
      id: 'unarchive', label: pickedOpen.length ? `Unarchive ${nf(pickedArchived.length)}` : 'Unarchive', icon: 'refresh-cw', disabled: bulk.busy,
      onRun: () => { clearPicked(); void bulkRestore(pickedArchived) },
    })
  }

  useEffect(() => {
    if (!selectedId || !list.current) return
    list.current.querySelector<HTMLElement>(`[data-cc3-row="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (selection.onKeyDown(e)) return
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
                    {g.rows.map((r) => <Row key={r.id} row={r} selected={r.id === selectedId} onSelect={onSelect} picked={selection.selected.has(r.id)} selecting={selection.active} onPick={onPick} />)}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <LCBulkBar
        className="cc3-bulkbar"
        count={selection.count}
        inView={flat.length}
        all={selection.all}
        noun={CAMPAIGN_NOUN}
        onSelectAll={selection.selectAll}
        onClear={selection.clear}
        actions={bulkActions}
        progress={bulk.progress}
        outcome={bulk.outcome}
        onDismissOutcome={bulk.dismissOutcome}
      />
      <footer className="cc3-rail__foot"><kbd className="lc-kbd">↑</kbd><kbd className="lc-kbd">↓</kbd><span>move between campaigns</span></footer>
    </nav>
  )
})
