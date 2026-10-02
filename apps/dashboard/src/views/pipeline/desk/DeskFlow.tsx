/**
 * PIPELINE DESK · FLOW — every live deal, placed by stage and by how long it
 * has been there. Rows are S1–S10; columns are age-in-stage; the stage's own
 * clock is marked, so a deal drifting right is a deal going stale. Beads are
 * coloured by whose move it is (the same ownership the river re-projects).
 * View-only: nothing here moves a stage.
 */
import { useMemo, useRef } from 'react'
import { Icon } from '../../../shared/icons'
import { LCButton, LCEmpty, LCError, LCSkeleton, LCTooltip, cx, type LCRowActivationEvent } from '../../../shared/lc'
import { compactMoney } from '../../../domain/pipeline/pipeline-command-api'
import type { DeskCard, DeskStage, StageFlow } from './pipeline-desk-api'
import {
  AGE_BUCKETS,
  LIVE_OWNERS,
  OWNER_META,
  STAGE_CODES,
  STAGE_SHORT_LABEL,
  byOwnerThenAge,
  fmtInt,
  relShort,
  type LiveOwner,
} from './pipeline-desk-model'
import { useElementWidth } from './use-pipeline-desk'

const COMPACT_BUCKETS: ReadonlyArray<{ key: string; label: string; max: number }> = [
  { key: 'w1', label: '≤1w', max: 7 },
  { key: 'm1', label: '1–4w', max: 30 },
  { key: 'm4', label: '1–4mo', max: 120 },
  { key: 'old', label: '4mo+', max: Number.POSITIVE_INFINITY },
]

type Props = {
  rows: DeskCard[] | null
  loading: boolean
  error: string | null
  onRetry: () => void
  stages: DeskStage[] | null
  flows: StageFlow[] | null
  periodLabel: string
  owner: LiveOwner | null
  onOwner: (o: LiveOwner | null) => void
  stage: string | null
  onStage: (code: string | null) => void
  showDormant: boolean
  onShowDormant: (v: boolean) => void
  selectedId: string | null
  onOpen: (card: DeskCard, e?: LCRowActivationEvent) => void
  now: number
}

export function DeskFlowMatrix({ rows, loading, error, onRetry, stages, flows, periodLabel, owner, onOwner, stage, onStage, showDormant, onShowDormant, selectedId, onOpen, now }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const buckets = width && width < 860 ? COMPACT_BUCKETS : AGE_BUCKETS
  const bucketOf = (days: number | null) => {
    if (typeof days !== 'number') return buckets.length - 1
    const i = buckets.findIndex((b) => days <= b.max)
    return i < 0 ? buckets.length - 1 : i
  }
  const lateFrom = (clock: number | null | undefined) => {
    if (typeof clock !== 'number') return null
    const i = buckets.findIndex((_, k) => (k === 0 ? 0 : buckets[k - 1].max) >= clock)
    return i < 0 ? null : i
  }
  const visible = useMemo(() => (rows ?? []).filter((c) => !['closed_out'].includes(c.owner) && (showDormant || c.owner !== 'dormant')), [rows, showDormant])
  const byStage = useMemo(() => {
    const m = new Map<string, DeskCard[]>()
    for (const c of visible) {
      const list = m.get(c.stage) ?? []
      list.push(c)
      m.set(c.stage, list)
    }
    for (const list of m.values()) list.sort(byOwnerThenAge)
    return m
  }, [visible])
  const dormantTotal = useMemo(() => (rows ?? []).filter((c) => c.owner === 'dormant').length, [rows])
  const codes = stage ? STAGE_CODES.filter((c) => c === stage) : STAGE_CODES

  return (
    <section className="pd2-flow" aria-label="Deal flow by stage and age in stage" ref={ref} aria-busy={loading}>
      <div className="pd2-flow__bar">
        <div className="pd2-flow__owners" role="group" aria-label="Highlight by whose move">
          {LIVE_OWNERS.map((k) => (
            <button key={k} type="button" className={cx('pd2-chipkey', owner === k && 'is-on', owner && owner !== k && 'is-dim')} onClick={() => onOwner(owner === k ? null : k)} aria-pressed={owner === k} title={OWNER_META[k].definition}>
              <i style={{ background: OWNER_META[k].color }} />{OWNER_META[k].short}
            </button>
          ))}
        </div>
        <span className="pd2-flow__spacer" />
        {stage ? <LCButton variant="quiet" size="sm" icon="close" onClick={() => onStage(null)}>All stages</LCButton> : null}
        <LCButton variant={showDormant ? 'secondary' : 'quiet'} size="sm" icon="moon" onClick={() => onShowDormant(!showDormant)} aria-pressed={showDormant}>
          {showDormant ? 'Hide dormant' : `Show dormant · ${fmtInt(dormantTotal)}`}
        </LCButton>
      </div>

      {error && !rows ? <LCError what="The deals didn’t load" onRetry={onRetry} /> : null}

      <div className="pd2-matrix" style={{ ['--pd2-buckets' as string]: buckets.length }} role="table" aria-label="Deals by stage (rows) and days in stage (columns)">
        <div className="pd2-matrix__head" role="row">
          <span className="pd2-matrix__corner" role="columnheader">Stage · {periodLabel}</span>
          {buckets.map((b) => <span key={b.key} role="columnheader" className="pd2-matrix__bucket">{b.label}</span>)}
        </div>
        {!rows ? (
          <LCSkeleton shape="rows" count={6} />
        ) : codes.map((code) => {
          const s = stages?.find((x) => x.code === code) ?? null
          const list = byStage.get(code) ?? []
          const flow = flows?.find((f) => f.code === code)
          const late = lateFrom(s?.aging?.clockDays ?? null)
          const cells = buckets.map(() => [] as DeskCard[])
          for (const c of list) cells[bucketOf(c.daysInStage)].push(c)
          const i = STAGE_CODES.indexOf(code)
          return (
            <div key={code} role="row" className={cx('pd2-mrow', !list.length && 'is-dry')}>
              <button type="button" role="rowheader" className="pd2-mrow__head" onClick={() => onStage(stage === code ? null : code)} aria-pressed={stage === code} title={stage === code ? 'Show every stage' : 'Show only this stage'}>
                <span className="pd2-mrow__name"><em>S{i + 1}</em>{STAGE_SHORT_LABEL[code]}</span>
                <span className="pd2-mrow__count"><b className="lc-num">{fmtInt(list.length)}</b>{s?.value ? <small>{compactMoney(s.value)} est.</small> : null}</span>
                <span className="pd2-mrow__meta">
                  {flow && (flow.entered || flow.left) ? <span className="lc-num">+{fmtInt(flow.entered)} −{fmtInt(flow.left)}</span> : <span>no movement</span>}
                  {s?.aging?.clockDays ? <span>clock {s.aging.clockDays}d</span> : null}
                </span>
              </button>
              {!list.length ? (
                <span className="pd2-mrow__none" role="cell">{code === 'closed' ? 'No closings recorded — S10 is reached only through the Closing Desk' : 'No live deals'}</span>
              ) : cells.map((cell, k) => (
                <div key={buckets[k].key} role="cell" className={cx('pd2-cell', late !== null && k >= late && 'is-late')}>
                  {cell.map((c) => (
                    <LCTooltip key={c.id} side="top" content={<BeadTip card={c} now={now} />}>
                      <button
                        type="button"
                        className={cx('pd2-bead', `is-${c.owner}`, owner && c.owner !== owner && 'is-dim', selectedId === c.id && 'is-on', c.hot && 'is-hot')}
                        style={{ ['--c' as string]: OWNER_META[c.owner].color }}
                        onClick={(e) => onOpen(c, e)}
                        aria-label={`${c.address || c.seller || 'Deal'} — ${OWNER_META[c.owner].label}, ${c.daysInStage ?? '?'} days in stage`}
                        data-pd2-deal={c.id}
                      />
                    </LCTooltip>
                  ))}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {rows && !visible.length ? <LCEmpty title="No deals in this view" body="Clear the search or filters, or show dormant deals." /> : null}
      <p className="pd2-flow__note"><Icon name="clock" size={12} /> Tinted cells are past the stage’s own clock. Beads are coloured by whose move it is; hover for the deal, click to inspect.</p>
    </section>
  )
}

function BeadTip({ card, now }: { card: DeskCard; now: number }) {
  return (
    <span className="pd2-tip">
      <b>{card.address || card.seller || 'Unaddressed deal'}</b>
      {card.address && card.seller ? <span>{card.seller}</span> : null}
      <span><i className="pd2-tip__dot" style={{ background: OWNER_META[card.owner].color }} />{OWNER_META[card.owner].label} — {card.lane.detail || card.lane.label}</span>
      <span>{card.daysInStage !== null ? `${card.daysInStage}d in S${card.stageIndex}` : `S${card.stageIndex}`}{card.money.value ? ` · ${compactMoney(card.money.value)} est.` : ''}{card.money.asking ? ` · ask ${compactMoney(card.money.asking)}` : ''}</span>
      {card.lastActivityAt ? <span>Last activity {relShort(card.lastActivityAt, now)}</span> : null}
    </span>
  )
}
