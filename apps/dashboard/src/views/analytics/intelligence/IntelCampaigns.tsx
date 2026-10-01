/**
 * CAMPAIGNS — comparison, not a leaderboard.
 *
 * Sellers are attributed to the campaign of their FIRST delivered message in
 * the period, so a campaign's reached, replied, interested and opted-out add
 * up across campaigns. Message-grain columns (sent, delivery, filtered,
 * refused, held) count that campaign's messages. Held is not undelivered is
 * not refused. A rate below its minimum sample is faded and never ranked as a
 * finding; test and proof campaigns sort last and say so.
 *
 * Not in this read model, so not shown: campaign audience / eligibility
 * (Campaign Command owns targets), and stage moves, offers, contracts and
 * closings by campaign (the stage history does not carry a campaign; offers,
 * contracts and closings are zero in production).
 */
import { useMemo, useState } from 'react'
import type { LabQuery } from '../../../domain/analytics/analytics-lab-api'
import { fmtMetric } from '../../../domain/analytics/analytics-lab-api'
import { LCDataGrid, cx } from '../../../shared/lc'
import type { LCColumn, LCSort } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import { pushRoutePath } from '../../../app/router'
import { useLab } from './intel-context'
import { paths, useIntel } from './intel-data'
import { fmtInt } from './intel-format'
import { serverContext } from './intel-state'

const CAMPAIGN_METRICS = ['sellers_reached', 'reply_rate', 'interest_rate', 'opportunity_rate', 'opt_out_rate', 'messages_sent', 'delivery_rate', 'content_filter_rate', 'transport_failures', 'provider_rejections', 'sender_health_blocks', 'send_gate_holds'] as const
const OVERVIEW_METRICS = ['sellers_reached', 'reply_rate', 'interest_rate', 'delivery_rate', 'content_filter_rate'] as const
const TEMPLATE_METRICS = ['sellers_reached', 'reply_rate', 'interest_rate', 'opt_out_rate'] as const
type Cell = { value: number | null; num: number | null; den: number | null; n: number; insufficient?: boolean }
type Row = { key: string; label: string; test?: boolean; values: Record<string, Cell>; prev?: Record<string, { value: number | null }> | null }

function useTable(metrics: readonly string[], dim: string, limit: number) {
  const { ctx } = useLab()
  return useIntel<LabQuery>(paths.query(serverContext(ctx, { metric: metrics[0], groupBy: dim, limit, metrics: [...metrics] }), 'table'))
}

function columnsFor(metrics: readonly string[], dim: string, onCell: (r: Row, id: string) => void): LCColumn<Row>[] {
  return metrics.map((id) => ({
    id, header: id, width: 112, align: 'right' as const, sortable: true,
    render: (r: Row) => <CellView row={r} id={id} onCell={onCell} />,
    hint: dim,
  }))
}

function CellView({ row, id, onCell }: { row: Row; id: string; onCell: (r: Row, id: string) => void }) {
  const { defs } = useLab()
  const def = defs[id]
  const v = row.values[id]
  if (!v) return <span className="ix-muted" title="Not attributable to this dimension">—</span>
  const rate = def?.unit === 'rate'
  return (
    <button type="button" className={cx('ix-cellbtn', v.insufficient && 'is-thin')} onClick={() => onCell(row, id)} title={rate ? `${fmtInt(v.num)} of ${fmtInt(v.den)}${v.insufficient ? ' · below the minimum sample' : ''}` : 'Open the records'}>
      <b>{fmtMetric(def, v.value)}</b>{rate ? <small>{fmtInt(v.num)}/{fmtInt(v.den)}</small> : null}
    </button>
  )
}

export function IntelCampaigns({ variant = 'overview' }: { variant?: 'overview' | 'lens' }) {
  const { act, defs, records, inspect, refreshing } = useLab()
  const metrics = variant === 'lens' ? CAMPAIGN_METRICS : OVERVIEW_METRICS
  const q = useTable(metrics, 'campaign', 60)
  const rows = useMemo(() => ((q.data?.result?.rows || []) as unknown as Row[]), [q.data])
  const [sort, setSort] = useState<LCSort>({ id: 'sellers_reached', dir: 'desc' })
  const sorted = useMemo(() => {
    if (!sort) return rows
    const v = (r: Row) => (sort.id === 'label' ? r.label.toLowerCase() : r.values[sort.id]?.value ?? -1)
    // test campaigns never rank: they stay last whatever the sort
    return [...rows].sort((a, b) => Number(Boolean(a.test)) - Number(Boolean(b.test)) || ((x, y) => (x > y ? 1 : x < y ? -1 : 0))(v(a), v(b)) * (sort.dir === 'asc' ? 1 : -1))
  }, [rows, sort])
  const onCell = (r: Row, id: string) => records({ cohort: { metric: id, part: defs[id]?.unit === 'rate' ? 'numerator' : undefined, group: { dim: 'campaign', key: r.key, label: r.label } }, title: `${defs[id]?.label} · ${r.label}` })
  const columns: LCColumn<Row>[] = [
    {
      id: 'label', header: 'Campaign', minWidth: 230, sortable: true,
      render: (r) => (
        <span className="ix-camp">
          <button type="button" className="ix-link" disabled={r.test || r.key === '__none'} onClick={() => inspect({ kind: 'group', dim: 'campaign', key: r.key, label: r.label, metric: 'reply_rate' })} title={r.test ? 'Test / proof campaign — not ranked' : 'Inspect this campaign'}>{r.label}</button>
          {r.test ? <em className="ix-tag">test · not ranked</em> : null}
        </span>
      ),
    },
    ...columnsFor(metrics, 'campaign', onCell).map((c) => ({ ...c, header: defs[c.id]?.short || c.id, hint: defs[c.id]?.description })),
  ]
  return (
    <section className={cx('ix-camps lc-plane is-solid is-d2', variant === 'lens' && 'is-lens', refreshing && 'is-refreshing')} aria-label="Campaign performance">
      <header className="ix-plane__head">
        <div>
          <span className="ix-eyebrow">Campaigns</span>
          <h2>Which campaigns produce replies — and which get filtered</h2>
        </div>
        <p className="ix-muted">sellers by their first delivered message · faded = small sample · click a cell for its records</p>
      </header>
      <div className="ix-grid">
        <LCDataGrid
          id={variant === 'lens' ? 'intel-campaigns-lens' : 'intel-campaigns'}
          label="Campaign comparison"
          rows={sorted}
          rowKey={(r) => r.key}
          columns={columns}
          sort={sort}
          onSortChange={setSort}
          loading={q.loading && !rows.length}
          error={q.error && !rows.length ? { what: 'Campaign comparison didn’t load', onRetry: q.reload } : null}
          empty={{ title: 'No campaign activity in this slice' }}
          rowMenu={(r) => (r.key === '__none' ? [] : [
            { id: 'narrow', label: 'Narrow the Lab to this campaign', icon: 'filter', disabled: Boolean(r.test), reason: 'Test campaigns are excluded from every figure', onSelect: () => act.pushSegment({ dim: 'campaign', value: r.key, label: r.label }) },
            { id: 'open', label: 'Open in Campaign Command', icon: 'arrow-up-right', onSelect: () => pushRoutePath(`/campaign-command?campaign=${encodeURIComponent(r.key)}`) },
            { id: 'records', label: 'Sellers reached', icon: 'list', onSelect: () => onCell(r, 'sellers_reached') },
          ])}
          total={rows.length}
          height={Math.min(variant === 'lens' ? 470 : 340, 68 + Math.max(3, sorted.length) * 36)}
        />
      </div>
      {variant === 'lens' ? <CampaignDeep /> : null}
    </section>
  )
}

function CampaignDeep() {
  const { act, defs, records } = useLab()
  const tq = useTable(TEMPLATE_METRICS, 'template', 30)
  const sq = useTable(['sellers_reached', 'reply_rate', 'interest_rate', 'delivery_rate', 'content_filter_rate'], 'campaign_source', 10)
  const trows = useMemo(() => ((tq.data?.result?.rows || []) as unknown as Row[]), [tq.data])
  const srows = useMemo(() => ((sq.data?.result?.rows || []) as unknown as Row[]), [sq.data])
  const [sort, setSort] = useState<LCSort>({ id: 'sellers_reached', dir: 'desc' })
  const sortedT = useMemo(() => {
    if (!sort) return trows
    const v = (r: Row) => (sort.id === 'label' ? r.label.toLowerCase() : r.values[sort.id]?.value ?? -1)
    return [...trows].sort((a, b) => ((x, y) => (x > y ? 1 : x < y ? -1 : 0))(v(a), v(b)) * (sort.dir === 'asc' ? 1 : -1))
  }, [trows, sort])
  const cell = (dim: string) => (r: Row, id: string) => records({ cohort: { metric: id, part: defs[id]?.unit === 'rate' ? 'numerator' : undefined, group: { dim, key: r.key, label: r.label } }, title: `${defs[id]?.label} · ${r.label}` })
  const tcols: LCColumn<Row>[] = [
    { id: 'label', header: 'Template', minWidth: 240, sortable: true, render: (r) => <button type="button" className="ix-link" onClick={() => act.pushSegment({ dim: 'template', value: r.key, label: r.label })} title="Narrow the Lab to this template">{r.label}</button> },
    ...columnsFor(TEMPLATE_METRICS, 'template', cell('template')).map((c) => ({ ...c, header: defs[c.id]?.short || c.id, hint: defs[c.id]?.description })),
  ]
  return (
    <div className="ix-camps__deep">
      <div className="ix-subhead"><span className="ix-eyebrow">Templates · first-touch attribution</span><small className="ix-muted">no template is called better without the sample to say so</small></div>
      <div className="ix-grid">
        <LCDataGrid id="intel-templates" label="Template comparison" rows={sortedT} rowKey={(r) => r.key} columns={tcols} sort={sort} onSortChange={setSort} loading={tq.loading && !trows.length} empty={{ title: 'No template activity in this slice' }} height={Math.min(380, 44 + Math.max(3, sortedT.length) * 36)} />
      </div>
      <div className="ix-subhead"><span className="ix-eyebrow">Where campaigns came from</span></div>
      <div className="ix-tablewrap lc-scroll">
        <table className="ix-table">
          <thead><tr><th>Source</th>{['sellers_reached', 'reply_rate', 'interest_rate', 'delivery_rate', 'content_filter_rate'].map((id) => <th key={id} title={defs[id]?.description}>{defs[id]?.short}</th>)}</tr></thead>
          <tbody>
            {srows.map((r) => (
              <tr key={r.key}>
                <th>{r.label}</th>
                {['sellers_reached', 'reply_rate', 'interest_rate', 'delivery_rate', 'content_filter_rate'].map((id) => <td key={id}><CellView row={r} id={id} onCell={cell('campaign_source')} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ix-note"><Icon name="hash" size={12} /> Audience and eligibility live in Campaign Command (targets), not in this read model. Stage moves, offers, contracts and closings are not attributed to campaigns here: the stage history carries no campaign, and offers, contracts and closings are zero in production.</p>
    </div>
  )
}
