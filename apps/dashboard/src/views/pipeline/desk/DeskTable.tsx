/**
 * PIPELINE DESK · TABLE — every deal in scope in the shared data grid.
 * Sortable, resizable, groupable by stage or by whose move it is; selecting a
 * row opens the deal inspector. No inline edits, no stage moves.
 * [8.3] Multi-select (checkbox · ⇧ range · ⌘ toggle · ⌘A · Esc) → bulk Archive
 * through the canonical opportunity status, with Undo.
 * Columns come from the catalog (./pipeline-columns): the operator picks,
 * orders and sizes them (DeskColumnPicker); the layout persists per operator.
 * Property / owner / engine columns load only while shown, for the deals in
 * view (./use-pipeline-enrichment).
 */
import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { LCButton, LCDataGrid, LCSegmented, LCStatus, type LCColumn, type LCRowActivationEvent, type LCSort } from '../../../shared/lc'
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import { sound } from '../../../shared/sound'
import { useAuth } from '../../../components/auth/AuthProvider'
import type { DeskCard, DeskOfferRow, DeskOffers } from './pipeline-desk-api'
import { COLUMN_BY_ID, LENS_DEFAULTS, archivedNote, formatValue, nextFollowUp, normalizeLayout, sortKey, DEFAULT_COLUMNS, type ColumnLayout, type DeskColumnDef, type RowContext, type TableLens } from './pipeline-columns'
import { usePipelineEnrichment } from './use-pipeline-enrichment'
import { DeskColumnPicker } from './DeskColumnPicker'
import { LCBulkBar, useLcSelection } from '../../../shared/lc'
import { useBulkArchive } from '../../../lib/data/useBulkArchive'
import type { BulkRunReport } from '../../../lib/data/bulkArchiveData'
import { HOLD_META, OWNER_META, STAGE_CODES, STAGE_SHORT_LABEL, fmtInt, intentWords, stageTag, stampCT, type LiveOwner } from './pipeline-desk-model'

type GroupBy = 'none' | 'stage' | 'owner'
const GROUPS: ReadonlyArray<{ value: GroupBy; label: string }> = [
  { value: 'none', label: 'No grouping' },
  { value: 'stage', label: 'By stage' },
  { value: 'owner', label: 'By whose move' },
]
const DEAL_NOUN = { one: 'deal', many: 'deals' }
/** Today's archive (lead visibility off): the status moves to archived and automation is reconciled. */
const DEAL_ARCHIVE_EFFECTS = [
  { kind: 'stops' as const, text: 'They leave the Pipeline views, stage counts and the pipeline metrics.' },
  { kind: 'stops' as const, text: 'Automation on an archived deal is reconciled to cancelled. Won deals are refused.' },
  { kind: 'keeps' as const, text: 'Unarchive restores the status each deal had before.' },
]
/** The shared archive (lead_visibility_sync_enabled on): a visibility overlay — stage, status and scheduled follow-ups stay. */
const DEAL_ARCHIVE_EFFECTS_OVERLAY = [
  { kind: 'stops' as const, text: 'They leave the Pipeline views and counts, and appear under Archived.' },
  { kind: 'keeps' as const, text: 'Stage and status are kept. A scheduled follow-up keeps running — each result says what is still scheduled.' },
  { kind: 'keeps' as const, text: 'Unarchive brings them back exactly as they were. A seller reply brings a deal back on its own.' },
]
const EMPTY_IDS: ReadonlySet<string> = new Set()

const LAYOUT_KEY = 'nexus.pipeline.desk.columns.v1'
type Stored = ColumnLayout & { sort?: LCSort; group?: GroupBy }

function readLayout(key: string, defaults: readonly string[] = DEFAULT_COLUMNS): Stored {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) || 'null') as Stored | null
    const layout = normalizeLayout(raw, defaults)
    const sort = raw?.sort && typeof raw.sort.id === 'string' && COLUMN_BY_ID.get(raw.sort.id)?.sortable ? raw.sort : { id: 'owner', dir: 'asc' as const }
    const group = raw?.group === 'stage' || raw?.group === 'owner' ? raw.group : 'none'
    return { ...layout, sort, group }
  } catch { return { visible: [...defaults], sort: { id: 'owner', dir: 'asc' }, group: 'none' } }
}

/** The operator's own table layout (columns, order, sort, grouping), per signed-in operator. */
function useTableLayout(lens: TableLens) {
  const uid = useAuth().user?.id || 'local'
  // each lens keeps its own columns (Working keeps the original key)
  const key = `${LAYOUT_KEY}:${uid}${lens === 'working' ? '' : `:${lens}`}`
  const defaults = LENS_DEFAULTS[lens]
  const [state, setState] = useState<{ key: string; v: Stored }>(() => ({ key, v: readLayout(key, defaults) }))
  const v = state.key === key ? state.v : readLayout(key, defaults)
  const save = useCallback((patch: Partial<Stored>) => {
    setState((cur) => {
      const next = { ...(cur.key === key ? cur.v : readLayout(key, defaults)), ...patch }
      try { window.localStorage.setItem(key, JSON.stringify(next)) } catch { /* private mode */ }
      return { key, v: next }
    })
  }, [key, defaults])
  return { layout: v, save, uid, defaults }
}

const none = (text = '—') => <span className="pd2-none">{text}</span>

export function DeskTable({ rows, loading, error, onRetry, owner, stage, showDormant, onShowDormant, selectedId, onOpen, now, total, onBulkChanged, offers, lens = 'working', onLens, lensCounts, visibilityOn = false }: {
  rows: DeskCard[] | null
  /** Working (the main view, nurture excluded) · Nurture · Archived — counts from the same server predicate */
  lens?: TableLens
  onLens?: (lens: TableLens) => void
  lensCounts?: { working: number | null; nurture: number | null; archived: number | null }
  /** lead_visibility_sync_enabled — picks the archive copy; Archived lens only then */
  visibilityOn?: boolean
  /** the Offers read the rail already holds — offer-on-record columns join it, no extra read */
  offers?: DeskOffers | null
  loading: boolean
  error: string | null
  onRetry: () => void
  owner: LiveOwner | null
  stage: string | null
  showDormant: boolean
  onShowDormant: (v: boolean) => void
  selectedId: string | null
  onOpen: (card: DeskCard, e?: LCRowActivationEvent) => void
  now: number
  total: number
  /** [8.3] a bulk archive / undo changed deals — re-read the pipeline */
  onBulkChanged?: () => void
}) {
  const { layout, save, uid, defaults } = useTableLayout(lens)
  const sort = layout.sort ?? null
  const group = layout.group ?? 'none'
  const setSort = useCallback((next: LCSort) => save({ sort: next }), [save])
  const setGroup = useCallback((next: GroupBy) => save({ group: next }), [save])
  const offerById = useMemo(() => new Map<string, DeskOfferRow>((offers?.rows ?? []).map((r) => [r.card.id, r])), [offers])
  // [8.3] deals archived here leave the table at once; Undo brings them back
  const [archivedHere, setArchivedHere] = useState<{ rows: DeskCard[] | null; ids: ReadonlySet<string> }>({ rows, ids: EMPTY_IDS })
  const goneIds = archivedHere.rows === rows ? archivedHere.ids : EMPTY_IDS
  const filtered = useMemo(
    // a lens is the server's list as it is: no dormant / closed-out pruning (that is the working view's)
    () => (rows ?? []).filter((c) => !goneIds.has(c.id) && (lens !== 'working' || (c.owner !== 'closed_out' && (showDormant || c.owner !== 'dormant'))) && (!owner || c.owner === owner) && (!stage || c.stage === stage)),
    [rows, goneIds, owner, stage, showDormant, lens],
  )
  // property / owner / engine fields, only for the visible columns and the deals in view
  const enrichment = usePipelineEnrichment(filtered, layout.visible)
  const lookup = enrichment.lookup
  const ctxOf = useCallback((c: DeskCard): RowContext => ({ card: c, x: lookup(c), offer: offerById.get(c.id) ?? null, now }), [lookup, offerById, now])
  const view = useMemo(() => {
    const def = sort ? COLUMN_BY_ID.get(sort.id) : null
    if (!sort || !def) return filtered
    const dir = sort.dir === 'asc' ? 1 : -1
    const keyed = filtered.map((c) => ({ c, k: sortKey(def.kind === 'custom' ? kindForSort(def) : def.kind, def.value(ctxOf(c))) }))
    keyed.sort((a, b) => {
      // empty always sorts last, whichever direction
      if (a.k === null || b.k === null) return a.k === b.k ? (b.c.daysInStage ?? 0) - (a.c.daysInStage ?? 0) : a.k === null ? 1 : -1
      const d = typeof a.k === 'number' && typeof b.k === 'number' ? a.k - b.k : String(a.k).localeCompare(String(b.k))
      return d * dir || (b.c.daysInStage ?? 0) - (a.c.daysInStage ?? 0)
    })
    return keyed.map((x) => x.c)
  }, [filtered, sort, ctxOf])

  const order = useMemo(() => view.map((c) => c.id), [view])
  const selection = useLcSelection(order)
  const labelById = useMemo(() => new Map((rows ?? []).map((c) => [c.id, c.address || c.seller || 'Unaddressed deal'])), [rows])
  const labelOf = useCallback((id: string) => labelById.get(id) ?? id, [labelById])
  const onBulkReport = useCallback((report: BulkRunReport) => {
    setArchivedHere((prev) => {
      const next = new Set(prev.rows === rows ? prev.ids : [])
      for (const id of report.changedIds) {
        if (report.action === 'archive') next.add(id)
        else next.delete(id)
      }
      return { rows, ids: next }
    })
    onBulkChanged?.()
  }, [onBulkChanged, rows])
  const bulk = useBulkArchive({ objectType: 'opportunity', noun: DEAL_NOUN, consequences: visibilityOn ? DEAL_ARCHIVE_EFFECTS_OVERLAY : DEAL_ARCHIVE_EFFECTS, labelOf, onChanged: onBulkReport, source: 'pipeline' })
  const { archive: bulkArchive } = bulk
  const { ids: selectedIds, clear: clearSelection, onKeyDown: selectionKeyDown } = selection
  const archiveSelected = useCallback(async () => {
    const report = await bulkArchive(selectedIds)
    if (report) clearSelection()
  }, [bulkArchive, clearSelection, selectedIds])
  const onGridKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => { selectionKeyDown(e) }, [selectionKeyDown])

  const dormant = useMemo(() => (rows ?? []).filter((c) => c.owner === 'dormant').length, [rows])
  const columns = useMemo<LCColumn<DeskCard>[]>(() => layout.visible.flatMap((id) => {
    const def = COLUMN_BY_ID.get(id)
    if (!def) return []
    const numeric = ['money', 'int', 'num', 'pct', 'score', 'rel'].includes(def.kind) || ['age', 'ask', 'offer_record', 'p_year'].includes(def.id)
    const pendingEnrich = Boolean(def.needs) && enrichment.loading
    return [{
      id: def.id,
      header: def.header,
      width: def.width,
      minWidth: def.minWidth,
      align: numeric ? 'right' as const : undefined,
      sortable: def.sortable,
      hint: [def.hint, `Source: ${def.source}`].filter(Boolean).join(' · '),
      render: (c: DeskCard) => renderCell(def, ctxOf(c), pendingEnrich),
    }]
  }), [layout.visible, ctxOf, enrichment.loading])

  const groupBy = group === 'stage' ? (c: DeskCard) => c.stage : group === 'owner' ? (c: DeskCard) => c.owner : undefined
  const groupLabel = group === 'stage'
    ? (g: string, n: number) => `S${STAGE_CODES.indexOf(g as typeof STAGE_CODES[number]) + 1} · ${STAGE_SHORT_LABEL[g] ?? g} · ${fmtInt(n)}`
    : group === 'owner' ? (g: string, n: number) => `${OWNER_META[g as LiveOwner]?.label ?? g} · ${fmtInt(n)}` : undefined

  return (
    <section className="pd2-table" aria-label="Pipeline deals">
      <div className="pd2-table__bar">
        <span className="pd2-table__count"><b className="lc-num">{fmtInt(view.length)}</b> deals{rows && total > rows.length ? <small> · first {fmtInt(rows.length)} of {fmtInt(total)} loaded · sorting covers these</small> : null}{enrichment.error ? <small className="pd2-table__warn"> · some property fields didn’t load</small> : null}</span>
        <span className="pd2-table__tools">
          {onLens ? (
            <LCSegmented
              options={[
                { value: 'working' as const, label: `Working${lensCounts?.working != null ? ` · ${fmtInt(lensCounts.working)}` : ''}`, title: 'The main view — nurture deals are in their own lens' },
                { value: 'nurture' as const, label: `Nurture${lensCounts?.nurture != null ? ` · ${fmtInt(lensCounts.nurture)}` : ''}`, title: 'Status nurture with no seller reply since — their follow-ups keep running; a reply brings a deal back' },
                ...(visibilityOn ? [{ value: 'archived' as const, label: `Archived${lensCounts?.archived != null ? ` · ${fmtInt(lensCounts.archived)}` : ''}`, title: 'Archived by the shared archive — stage and status kept' }] : []),
              ]}
              value={lens}
              onChange={(l) => { sound.ui.select(); onLens(l) }}
              label="Table lens"
              size="sm"
            />
          ) : null}
          {!owner && lens === 'working' ? (
            <LCButton variant={showDormant ? 'secondary' : 'quiet'} size="sm" icon="moon" onClick={() => onShowDormant(!showDormant)} aria-pressed={showDormant}>
              {showDormant ? 'Hide dormant' : `Show dormant · ${fmtInt(dormant)}`}
            </LCButton>
          ) : null}
          <LCSegmented options={GROUPS} value={group} onChange={(g) => { sound.ui.select(); setGroup(g) }} label="Group deals" size="sm" />
          <DeskColumnPicker layout={layout} onChange={(next) => save({ visible: next.visible })} onReset={() => save({ visible: [...defaults] })} partial={Boolean(rows && total > rows.length)} />
        </span>
      </div>
      <div className="pd2-table__grid" onKeyDown={onGridKeyDown}>
        <LCDataGrid
          id={`pipeline-desk-deals.${uid}`}
          label="Pipeline deals"
          rows={view}
          rowKey={(c) => c.id}
          columns={columns}
          sort={sort}
          onSortChange={setSort}
          activeKey={selectedId}
          onActivate={onOpen}
          selected={selection.selected}
          onSelectedChange={selection.set}
          density="standard"
          groupBy={groupBy}
          groupLabel={groupLabel}
          rowTone={(c) => (c.owner === 'blocked' ? 'crit' : c.owner === 'needs_you' ? 'attn' : null)}
          loading={loading && !rows}
          error={error && !rows ? { what: 'The deals didn’t load', onRetry } : null}
          empty={lens === 'nurture' ? { title: 'No deal in nurture', body: 'A seller reply brings a nurture deal back to Working on its own.' } : lens === 'archived' ? { title: 'Nothing archived', body: 'Deals archived from the Inbox or here appear in this lens.' } : { title: 'No deals in this view', body: 'Clear the search or the filters, or include dormant deals.' }}
          total={view.length}
          height="100%"
        />
      </div>
      <LCBulkBar
        className="pd2-bulkbar"
        count={selection.count}
        inView={view.length}
        all={selection.all}
        noun={DEAL_NOUN}
        onSelectAll={selection.selectAll}
        onClear={selection.clear}
        actions={[{ id: 'archive', label: 'Archive', icon: 'archive', onRun: () => { void archiveSelected() }, disabled: bulk.busy }]}
        progress={bulk.progress}
        outcome={bulk.outcome}
        onDismissOutcome={bulk.dismissOutcome}
      />
    </section>
  )
}

/** A custom column's sort semantics. */
function kindForSort(def: DeskColumnDef): DeskColumnDef['kind'] {
  if (['next_send', 'next_action', 'n_next', 'archived'].includes(def.id)) return 'date'
  if (['stage', 'owner', 'age', 'ask', 'offer_record', 'p_year'].includes(def.id)) return 'num'
  return 'text'
}

function renderCell(def: DeskColumnDef, r: RowContext, pendingEnrich: boolean): ReactNode {
  const c = r.card
  switch (def.id) {
    case 'deal':
      return (
        <span className="pd2-cell-deal">
          <b>{c.address || c.seller || 'Unaddressed deal'}</b>
          <small>{[c.address ? c.seller : null, c.market].filter(Boolean).join(' · ') || '—'}</small>
        </span>
      )
    case 'stage':
      return <span className="pd2-cell-stage"><i style={{ ['--c' as string]: `var(--pd2-stage-${c.stageIndex ?? 0})` }} />{stageTag(c.stageIndex, c.stage)}</span>
    case 'owner':
      return <LCStatus label={OWNER_META[c.owner].label} tone={OWNER_META[c.owner].tone} quiet={!OWNER_META[c.owner].human} />
    case 'why':
      return (
        <span className="pd2-cell-why" title={[c.lane.label, c.lane.detail, c.lane.evidence].filter(Boolean).join(' — ')}>
          <span>{c.hold ? HOLD_META[c.hold].label : c.lane.label}</span>
          <small>{c.lane.evidence || c.lane.detail || '—'}</small>
        </span>
      )
    case 'age':
      return c.daysInStage === null ? none() : <span className={c.stall ? 'pd2-late' : undefined}>{c.daysInStage}d</span>
    case 'ask':
      return c.money.askImplausible ? <span className="pd2-flag" title={`Recorded as ${compactMoney(c.money.asking) ?? '—'} — looks mis-captured`}>Mis-captured</span> : compactMoney(c.money.asking) ?? none()
    case 'offer_record': {
      const o = r.offer?.offer
      if (!o?.price || !o.status) return none()
      return <span className="pd2-cell-two"><b>{compactMoney(o.price) ?? '—'}</b><small>{o.status.toLowerCase().replace(/_/g, ' ')}</small></span>
    }
    case 'last_msg':
      return c.lastMessage
        ? <span className="pd2-cell-msg" title={c.lastMessage}><i className={c.lastDirection?.startsWith('in') ? 'is-in' : 'is-out'} aria-hidden="true" />{c.lastMessage}</span>
        : none()
    case 'direction':
      return c.lastDirection ? (c.lastDirection.startsWith('in') ? 'Seller' : 'Us') : none()
    case 'intent':
      return c.intentLabel || (c.intent ? c.intent.replace(/_/g, ' ') : null) || none()
    case 'next_send': {
      const n = c.queue?.next
      if (n) return <span className="pd2-cell-two"><b>{n.kind === 'follow_up' ? 'Follow-up' : 'Reply'}</b><small>{n.future ? stampCT(n.at) ?? 'scheduled' : 'sending'}</small></span>
      const at = c.ext?.nextScheduledFor
      return at ? <span className="pd2-cell-two"><b>Scheduled</b><small>{stampCT(at)}</small></span> : none()
    }
    case 'next_action': {
      const n = c.intent_next
      if (!n) return none()
      return <span className="pd2-cell-two"><b>{intentWords(n.action) ?? n.action}</b>{n.due ? <small>{stampCT(n.due)}</small> : null}</span>
    }
    case 'n_next': {
      const f = nextFollowUp(c)
      return f ? <span className="pd2-cell-two"><b>{stampCT(f.at) ?? '—'}</b><small>{f.queued ? 'queued' : 'stated · the queue has no row yet'}</small></span> : none()
    }
    case 'conv_state': {
      const v = c.conversation
      if (!v) return none()
      const chips = [v.archived ? 'Archived' : null, v.snoozedUntil ? `Snoozed · ${stampCT(v.snoozedUntil) ?? ''}` : null, v.unread ? 'Unread' : null].filter((x): x is string => Boolean(x))
      return chips.length ? <span className="pd2-cell-chips">{chips.map((t) => <i key={t}>{t}</i>)}</span> : <span className="pd2-none">Open</span>
    }
    case 'archived': {
      const note = archivedNote(c)
      return note ? <span className="pd2-cell-two"><b>{note.split(' · ')[0]}</b><small>{[c.archived?.at ? stampCT(c.archived.at) : null, note.includes('follow-up') ? note.slice(note.indexOf('follow-up')) : null].filter(Boolean).join(' · ')}</small></span> : none()
    }
    case 'p_year': {
      const v = def.value(r)
      return typeof v === 'number' || typeof v === 'string' ? String(Math.round(Number(v))) : pendingEnrich ? <span className="pd2-cell-wait" aria-label="Loading" /> : none()
    }
    default: {
      const v = def.value(r)
      if (def.id === 'p_phone_type' || def.kind === 'custom') return typeof v === 'string' && v ? v : pendingEnrich && v === null ? <span className="pd2-cell-wait" aria-label="Loading" /> : none(def.emptyText)
      const text = formatValue(def.kind, v, r.now)
      if (text !== null) return text
      return pendingEnrich ? <span className="pd2-cell-wait" aria-label="Loading" /> : none(def.emptyText)
    }
  }
}
