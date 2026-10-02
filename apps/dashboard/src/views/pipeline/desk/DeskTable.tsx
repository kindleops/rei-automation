/**
 * PIPELINE DESK · TABLE — every deal in scope in the shared data grid.
 * Sortable, resizable, groupable by stage or by whose move it is; selecting a
 * row opens the deal inspector. View-only: no inline edits, no stage moves.
 */
import { useMemo, useState } from 'react'
import { LCButton, LCDataGrid, LCSegmented, LCStatus, type LCColumn, type LCRowActivationEvent, type LCSort } from '../../../shared/lc'
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import { sound } from '../../../shared/sound'
import type { DeskCard } from './pipeline-desk-api'
import { HOLD_META, OWNER_META, STAGE_CODES, STAGE_SHORT_LABEL, fmtInt, relShort, stageTag, type LiveOwner } from './pipeline-desk-model'

type GroupBy = 'none' | 'stage' | 'owner'
const GROUPS: ReadonlyArray<{ value: GroupBy; label: string }> = [
  { value: 'none', label: 'No grouping' },
  { value: 'stage', label: 'By stage' },
  { value: 'owner', label: 'By whose move' },
]
const OWNER_RANK: Record<string, number> = { blocked: 0, needs_you: 1, autopilot: 2, scheduled: 3, external: 4, seller: 5, dormant: 6, closed_out: 7, complete: 8 }

const SORTERS: Record<string, (c: DeskCard) => number | string> = {
  deal: (c) => (c.address || c.seller || '').toLowerCase(),
  stage: (c) => c.stageIndex ?? 0,
  owner: (c) => OWNER_RANK[c.owner] ?? 9,
  age: (c) => c.daysInStage ?? -1,
  value: (c) => c.money.value ?? -1,
  ask: (c) => c.money.asking ?? -1,
  activity: (c) => (c.lastActivityAt ? Date.parse(c.lastActivityAt) : 0),
  market: (c) => (c.market || '').toLowerCase(),
}

export function DeskTable({ rows, loading, error, onRetry, owner, stage, showDormant, onShowDormant, selectedId, onOpen, now, total }: {
  rows: DeskCard[] | null
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
}) {
  const [sort, setSort] = useState<LCSort>({ id: 'owner', dir: 'asc' })
  const [group, setGroup] = useState<GroupBy>('none')
  const view = useMemo(() => {
    const list = (rows ?? []).filter((c) => c.owner !== 'closed_out' && (showDormant || c.owner !== 'dormant') && (!owner || c.owner === owner) && (!stage || c.stage === stage))
    if (!sort) return list
    const get = SORTERS[sort.id] ?? SORTERS.owner
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const x = get(a)
      const y = get(b)
      const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      return d * dir || (b.daysInStage ?? 0) - (a.daysInStage ?? 0)
    })
  }, [rows, owner, stage, showDormant, sort])

  const dormant = useMemo(() => (rows ?? []).filter((c) => c.owner === 'dormant').length, [rows])
  const columns = useMemo<LCColumn<DeskCard>[]>(() => [
    {
      id: 'deal', header: 'Deal', minWidth: 210, sortable: true,
      render: (c) => (
        <span className="pd2-cell-deal">
          <b>{c.address || c.seller || 'Unaddressed deal'}</b>
          <small>{[c.address ? c.seller : null, c.market].filter(Boolean).join(' · ') || '—'}</small>
        </span>
      ),
    },
    { id: 'stage', header: 'Stage', width: 124, sortable: true, render: (c) => <span className="pd2-cell-stage"><i style={{ ['--c' as string]: `var(--pd2-stage-${c.stageIndex ?? 0})` }} />{stageTag(c.stageIndex, c.stage)}</span> },
    { id: 'owner', header: 'Whose move', width: 150, sortable: true, render: (c) => <LCStatus label={OWNER_META[c.owner].label} tone={OWNER_META[c.owner].tone} quiet={!OWNER_META[c.owner].human} /> },
    {
      id: 'why', header: 'Why', minWidth: 210, hint: 'The evidence behind whose move it is',
      render: (c) => (
        <span className="pd2-cell-why" title={[c.lane.label, c.lane.detail, c.lane.evidence].filter(Boolean).join(' — ')}>
          <span>{c.hold ? HOLD_META[c.hold].label : c.lane.label}</span>
          <small>{c.lane.evidence || c.lane.detail || '—'}</small>
        </span>
      ),
    },
    {
      id: 'age', header: 'In stage', width: 108, align: 'right', sortable: true, hint: 'Days in stage, against the stage’s own clock',
      render: (c) => c.daysInStage === null ? <span className="pd2-none">—</span> : <span className={c.stall ? 'pd2-late' : undefined}>{c.daysInStage}d</span>,
    },
    { id: 'value', header: 'Est. value', width: 120, align: 'right', sortable: true, hint: 'Estimated value — the property record or the engine, never a price', render: (c) => compactMoney(c.money.value) ?? <span className="pd2-none">—</span> },
    { id: 'ask', header: 'Seller ask', width: 124, align: 'right', sortable: true, hint: 'Stated by the seller', render: (c) => c.money.askImplausible ? <span className="pd2-flag" title={`Recorded as ${compactMoney(c.money.asking) ?? '—'} — looks mis-captured`}>Mis-captured</span> : compactMoney(c.money.asking) ?? <span className="pd2-none">—</span> },
    { id: 'activity', header: 'Last activity', width: 112, align: 'right', sortable: true, hideable: true, hiddenByDefault: true, render: (c) => relShort(c.lastActivityAt, now) ?? <span className="pd2-none">—</span> },
    { id: 'market', header: 'Market', width: 150, sortable: true, hideable: true, hiddenByDefault: true, render: (c) => c.market || <span className="pd2-none">—</span> },
  ], [now])

  const groupBy = group === 'stage' ? (c: DeskCard) => c.stage : group === 'owner' ? (c: DeskCard) => c.owner : undefined
  const groupLabel = group === 'stage'
    ? (g: string, n: number) => `S${STAGE_CODES.indexOf(g as typeof STAGE_CODES[number]) + 1} · ${STAGE_SHORT_LABEL[g] ?? g} · ${fmtInt(n)}`
    : group === 'owner' ? (g: string, n: number) => `${OWNER_META[g as LiveOwner]?.label ?? g} · ${fmtInt(n)}` : undefined

  return (
    <section className="pd2-table" aria-label="Pipeline deals">
      <div className="pd2-table__bar">
        <span className="pd2-table__count"><b className="lc-num">{fmtInt(view.length)}</b> deals{rows && total > rows.length ? <small> · first {fmtInt(rows.length)} of {fmtInt(total)} loaded</small> : null}</span>
        <span className="pd2-table__tools">
          {!owner ? (
            <LCButton variant={showDormant ? 'secondary' : 'quiet'} size="sm" icon="moon" onClick={() => onShowDormant(!showDormant)} aria-pressed={showDormant}>
              {showDormant ? 'Hide dormant' : `Show dormant · ${fmtInt(dormant)}`}
            </LCButton>
          ) : null}
          <LCSegmented options={GROUPS} value={group} onChange={(g) => { sound.ui.select(); setGroup(g) }} label="Group deals" size="sm" />
        </span>
      </div>
      <div className="pd2-table__grid">
        <LCDataGrid
          id="pipeline-desk-deals"
          label="Pipeline deals"
          rows={view}
          rowKey={(c) => c.id}
          columns={columns}
          sort={sort}
          onSortChange={setSort}
          activeKey={selectedId}
          onActivate={onOpen}
          density="standard"
          groupBy={groupBy}
          groupLabel={groupLabel}
          rowTone={(c) => (c.owner === 'blocked' ? 'crit' : c.owner === 'needs_you' ? 'attn' : null)}
          loading={loading && !rows}
          error={error && !rows ? { what: 'The deals didn’t load', onRetry } : null}
          empty={{ title: 'No deals in this view', body: 'Clear the search or the filters, or include dormant deals.' }}
          total={view.length}
          height="100%"
        />
      </div>
    </section>
  )
}
