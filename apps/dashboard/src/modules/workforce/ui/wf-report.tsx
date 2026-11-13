import { type ReactNode } from 'react'
import { Icon } from '../../../shared/icons'
import { LCStatus, LCTooltip, cx } from '../../../shared/lc'
import type { WfAssignment, WfRankedItem, WfReport, WfReportItem } from '../api/wf-types'
import { evSummary, nextActionMeta, reconcileReport, reportTotals, score100, usd, verdictCounts, verdictMeta } from '../model/wf-model'
import { useWfNav } from './wf-context'
import { WfRefChip, WfRefs, WfTime, WfUnknown } from './wf-parts'

/** A score 0..100 as a hairline bar with its number; null is Unknown. */
export function WfScore({ v, label }: { v: number | null; label: string }) {
  const s = score100(v)
  if (s === null) return <WfUnknown reason={`${label} not scored`} />
  return (
    <span className="wf-score" title={`${label} ${s}`}>
      <span className="wf-score__bar"><i style={{ width: `${Math.max(2, Math.min(100, s))}%` }} /></span>
      <span className="wf-score__n lc-num">{s}</span>
    </span>
  )
}

export function WfVerdict({ item }: { item: WfRankedItem }) {
  const v = item.cfo_verdict
  const m = verdictMeta(v?.verdict)
  const status = <span><LCStatus label={m.label} tone={m.tone} quiet={m.tone === 'neutral'} hollow={!v?.verdict} /></span>
  return v?.reasons.length ? <LCTooltip content={<ul className="wf-tip-list">{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}>{status}</LCTooltip> : status
}

export function WfEv({ item }: { item: WfRankedItem }) {
  const ev = item.components.ev_usd
  return ev === null ? <WfUnknown reason={item.components.ev_reason ?? 'Calibrated inputs absent'} /> : <span className="lc-num wf-ev">{usd(ev)}</span>
}

export function WfNextAction({ item }: { item: WfRankedItem }) {
  const m = nextActionMeta(item.next_action)
  return (
    <span className="wf-na" title={item.next_action_reason ?? undefined}>
      <Icon name={m.icon} size={12} />
      <span className="wf-na__l">{m.label}</span>
      {item.next_action_reason ? <small>{item.next_action_reason}</small> : null}
    </span>
  )
}

/** The ranked list (§6 `ranked[]`): rank, records, score components, CFO verdict, next action, assignment. */
export function WfRankedTable({ ranked, dense }: { ranked: ReadonlyArray<WfRankedItem>; dense?: boolean }) {
  const nav = useWfNav()
  return (
    <div className="wf-ranked-wrap">
    <div className={cx('wf-ranked', dense && 'is-dense')} role="table" aria-label="Ranked opportunities">
      <div className="wf-ranked__h" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">Opportunity</span>
        <span role="columnheader" title="Contact and identity confidence">Contact</span>
        <span role="columnheader" title="Seller pressure">Pressure</span>
        <span role="columnheader">Deal quality</span>
        <span role="columnheader" title="Expected value: only when calibrated inputs exist">EV</span>
        <span role="columnheader">CFO</span>
        <span role="columnheader">Next action</span>
      </div>
      {ranked.map((r) => {
        const property = r.refs.find((x) => x.type === 'property')
        const others = r.refs.filter((x) => x !== property)
        return (
          <div key={`${r.rank}:${property?.id ?? r.label}`} className="wf-ranked__r" role="row" data-verdict={r.cfo_verdict?.verdict ?? 'none'}>
            <span className="wf-ranked__rank lc-num" role="cell">{r.rank}</span>
            <span className="wf-ranked__sub" role="cell">
              {property ? <WfRefChip r={{ ...property, label: property.label ?? r.label }} /> : <b>{r.label ?? 'Unlabelled'}</b>}
              <span className="wf-ranked__meta">
                {r.market ? <span>{r.market}</span> : null}
                {others.length ? <WfRefs refs={others} quiet short /> : null}
                {r.assignment_id ? <button type="button" className="wf-link is-quiet" onClick={() => nav.openAssignment(r.assignment_id!)}>Assignment</button> : null}
              </span>
              <span className="wf-ranked__na-inline"><WfNextAction item={r} /></span>
            </span>
            <span role="cell" className="wf-ranked__c" data-label="Contact"><WfScore v={r.components.contact} label="Contact" /></span>
            <span role="cell" className="wf-ranked__c" data-label="Pressure"><WfScore v={r.components.pressure} label="Pressure" /></span>
            <span role="cell" className="wf-ranked__c" data-label="Deal quality"><WfScore v={r.components.deal_quality} label="Deal quality" /></span>
            <span role="cell" className="wf-ranked__ev" data-label="EV"><WfEv item={r} /></span>
            <span role="cell" className="wf-ranked__cfo"><WfVerdict item={r} /></span>
            <span role="cell" className="wf-ranked__na"><WfNextAction item={r} /></span>
            <span className="wf-ranked__scores" aria-hidden="true">
              <span>C <b className="lc-num">{score100(r.components.contact) ?? 'Unknown'}</b></span>
              <span>P <b className="lc-num">{score100(r.components.pressure) ?? 'Unknown'}</b></span>
              <span>DQ <b className="lc-num">{score100(r.components.deal_quality) ?? 'Unknown'}</b></span>
            </span>
          </div>
        )
      })}
    </div>
    </div>
  )
}

function ItemList({ items, tone, empty, icon }: { items: ReadonlyArray<WfReportItem>; tone: 'ok' | 'attn' | 'crit' | 'neutral' | 'exec'; empty: string; icon: Parameters<typeof Icon>[0]['name'] }) {
  if (!items.length) return <p className="wf-quiet">{empty}</p>
  return (
    <ul className="wf-ritems" data-tone={tone}>
      {items.map((it, i) => (
        <li key={`${it.assignment_id ?? it.step_key ?? ''}:${i}`}>
          <Icon name={icon} size={12} className="wf-ritems__g" />
          <div className="wf-ritems__b">
            <span className="wf-ritems__t">{it.label}</span>
            {it.reasons.length ? <ul className="wf-ritems__why">{it.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
            {it.refs.length ? <WfRefs refs={it.refs} quiet /> : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

function Block({ title, count, tone, children, id }: { title: string; count: number; tone: string; children: ReactNode; id?: string }) {
  return (
    <section className="wf-rblock" data-tone={tone} id={id}>
      <header><span>{title}</span><b className="lc-num">{count}</b></header>
      {children}
    </section>
  )
}

/** The whole §6 report: summary, ranked, escalations, refused, unknowns, pending, completed, costs. */
export function WfReportView({ report, assignments = [], compact }: { report: WfReport; assignments?: ReadonlyArray<WfAssignment>; compact?: boolean }) {
  const nav = useWfNav()
  const { report: r, contradictions } = reconcileReport(report, assignments)
  const t = reportTotals(r)!
  const vc = verdictCounts(r.ranked)
  const ev = evSummary(r.ranked)
  return (
    <div className={cx('wf-report', compact && 'is-compact')}>
      {r.summary ? <p className="wf-report__sum">{r.summary}</p> : null}
      {contradictions.length ? (
        <div className="wf-report__warn" role="alert"><Icon name="alert" size={13} /><span>Moved {contradictions.length} item{contradictions.length === 1 ? '' : 's'} from completed to pending: the assignment state disagrees. {contradictions.join(' · ')}</span></div>
      ) : null}
      <div className="wf-report__totals">
        <span data-tone="ok"><b className="lc-num">{t.completed}</b> completed</span>
        <span data-tone="neutral"><b className="lc-num">{t.pending}</b> pending</span>
        <span data-tone="attn"><b className="lc-num">{t.escalations}</b> escalation{t.escalations === 1 ? '' : 's'}</span>
        <span data-tone="crit"><b className="lc-num">{t.refused}</b> refused</span>
        <span data-tone="neutral"><b className="lc-num">{t.unknowns}</b> unknown</span>
        {r.generated_at ? <span className="wf-report__at">Reported <WfTime iso={r.generated_at} now={nav.now} /></span> : null}
      </div>
      {r.ranked.length ? (
        <section className="wf-report__ranked">
          <header className="wf-report__rh">
            <span>Ranked opportunities</span>
            <span className="wf-quiet">
              CFO <b>{vc.supported}</b> supported · <b>{vc.challenge}</b> challenged · <b>{vc.insufficient_evidence}</b> insufficient{vc.none ? <> · <b>{vc.none}</b> unreviewed</> : null}
              {' · '}EV known for <b>{ev.known}</b> of {ev.total}
            </span>
          </header>
          <WfRankedTable ranked={r.ranked} dense={compact} />
        </section>
      ) : null}
      <div className="wf-report__grid">
        <Block title="Escalations" count={t.escalations} tone="attn"><ItemList items={r.escalations} tone="attn" icon="flag" empty="Nothing escalated." /></Block>
        <Block title="Refused" count={t.refused} tone="crit"><ItemList items={r.refused} tone="crit" icon="shield" empty="Nothing refused." /></Block>
        <Block title="Unknowns" count={t.unknowns} tone="neutral"><ItemList items={r.unknowns} tone="neutral" icon="eye" empty="No unknowns declared." /></Block>
        <Block title="Pending" count={t.pending} tone="neutral"><ItemList items={r.pending} tone="neutral" icon="clock" empty="Nothing pending." /></Block>
        <Block title="Completed" count={t.completed} tone="ok"><ItemList items={r.completed} tone="ok" icon="check" empty="Nothing completed." /></Block>
        <Block title="Costs" count={r.costs?.by_job.length ?? 0} tone="neutral">
          {!r.costs ? <WfUnknown reason="The report carries no cost section" inline /> : r.costs.status === 'unknown' ? <WfUnknown reason={r.costs.reason ?? 'Spend ledger not linked'} inline /> : (
            <div className="wf-costs">
              <span className="wf-costs__total lc-num">{usd(r.costs.total_usd, true)}</span>
              <ul>
                {r.costs.by_job.map((l, i) => (
                  <li key={l.runtime_job_id ?? i}>
                    {l.runtime_job_id ? <WfRefChip r={{ type: 'job', id: l.runtime_job_id, label: l.kind ?? l.runtime_job_id }} quiet /> : <span>{l.kind ?? 'Job'}</span>}
                    <span className="lc-num">{l.usd === null ? <WfUnknown /> : usd(l.usd, true)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Block>
      </div>
    </div>
  )
}
