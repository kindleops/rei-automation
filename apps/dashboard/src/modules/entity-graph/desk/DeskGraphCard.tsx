/**
 * THE GRAPH HOVER CARD (owner, 2026-10-08: "the hover card is basic —
 * property / address / market / conversation: new reply"). A hovered node
 * now reads like a small inspector: for a property its address, value,
 * equity, owner(s) and entity type, units, last sale, debt and liens where
 * recorded, the conversation (stage, last message), campaign status, SMS
 * eligibility (+ reason) and distress flags; for an owner / person / phone /
 * record node, the facts the network carries for it.
 *
 * Every fact comes from the network payload already on screen plus the
 * outreach state fetched ONCE per network (never per hover). No imagery on
 * hover — Street View is a single-detail request (the fan-out rule), shown in
 * the inspector, not on a card the pointer sweeps across.
 */
import type { CSSProperties } from 'react'
import { cx } from '../../../shared/lc'
import type { EntityNetwork, NetworkNode, NetworkProperty } from '../console/entity-network-api'
import { fmtCount, fmtMoney, nodeAnchor } from './desk-model'
import { humanize, lastContactLabel, relativeDay, smsReasonLabel, type OutreachState } from './desk-outreach'

const TYPE_LABEL: Record<string, string> = {
  owner: 'Owner', property: 'Property', entity: 'Title entity', person: 'Person', phone: 'Phone', email: 'Email',
  mailing: 'Mailing address', related_owner: 'Related owner', conversation: 'Conversation', mortgage: 'Mortgage',
  lien: 'Lien / record', sale: 'Transaction', buyer: 'Buyer',
}

const idOf = (node: NetworkNode) => node.id.split(':').slice(1).join(':')
const spec = (parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ')
const yr = (s: string | null | undefined) => (s ? String(s).slice(0, 4) : null)

function equityText(p: NetworkProperty): string {
  if (p.equityRule === 'free_and_clear') return 'Free & clear'
  if (p.equityRule === 'loan_and_value' && p.equityPct !== null) return `${Math.round(p.equityPct)}%`
  if (p.equityRule === 'vendor_high_equity_flag') return 'High (flag)'
  if (p.equityRule === 'vendor_low_equity_flag') return 'Low (flag)'
  return 'Unknown'
}

type Row = { k: string; v: string; tone?: 'ok' | 'attn' | 'crit' }

/** Pure: the facts a node's card shows (tested in desk-graph-card.test.ts). */
export function nodeCardFacts(node: NetworkNode, network: EntityNetwork, outreach: Map<string, OutreachState | null>): { title: string; subtitle: string | null; figures: Row[]; rows: Row[]; flags: string[]; message: { who: string; text: string } | null } {
  const empty = { title: node.label, subtitle: node.sub ?? null, figures: [] as Row[], rows: [] as Row[], flags: [] as string[], message: null as { who: string; text: string } | null }
  if (node.type === 'property' && node.meta?.cluster) {
    return { ...empty, title: `${node.label} more properties`, subtitle: 'Click to expand the cluster' }
  }
  if (node.type === 'property') {
    const p = network.properties.find((x) => x.id === idOf(node))
    if (!p) return empty
    const isAnchor = network.anchor.type === 'property' && network.anchor.id === p.id
    const rec = isAnchor ? network.records ?? null : null
    const st = outreach.get(p.id) ?? null
    const thread = network.outreach.threads.filter((t) => t.propertyId === p.id).sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? ''))[0] ?? null
    const owners = [network.owner.name, ...network.entities.map((e) => e.name)].filter(Boolean)
    const flags = [
      ...(p.taxDelinquent ? [`Tax delinquent${p.taxDelinquentYear ? ` ${p.taxDelinquentYear}` : ''}`] : []),
      ...(p.activeLien ? ['Active lien'] : []),
      ...(rec ? rec.liens.filter((l) => l.distress).map((l) => l.label) : []),
      ...p.tags.slice(0, 6),
    ]
    const rows: Row[] = [
      { k: 'Owner', v: spec([owners.slice(0, 2).join(' · '), owners.length > 2 ? `+${owners.length - 2}` : null, network.owner.kindLabel]) },
      { k: 'Asset', v: spec([p.type, p.units && p.units > 1 ? `${p.units} units` : null, p.beds ? `${p.beds} bd` : null, p.sqft ? `${p.sqft.toLocaleString('en-US')} sqft` : null, p.yearBuilt ? `built ${p.yearBuilt}` : null]) || '—' },
      { k: 'Last sale', v: p.lastSale?.price || p.lastSale?.date ? spec([p.lastSale?.price ? fmtMoney(p.lastSale.price) : null, yr(p.lastSale?.date), p.lastSale?.docType]) : 'Not recorded' },
      {
        k: 'Debt',
        v: rec
          ? (rec.totals.openMortgages ? spec([`${rec.totals.openMortgages} open ${rec.totals.openMortgages === 1 ? 'loan' : 'loans'}`, rec.totals.balance !== null ? `${fmtMoney(rec.totals.balance)} balance` : null]) : 'No open mortgage recorded')
          : p.loanBalance ? `${fmtMoney(p.loanBalance)} loan balance` : 'No loan on file',
      },
    ]
    if (rec && rec.liens.length) rows.push({ k: 'Liens', v: spec([`${rec.liens.length} recorded`, rec.liens.slice(0, 2).map((l) => l.label).join(', ')]) })
    if (st?.sms) rows.push({ k: 'SMS eligible', v: st.sms.eligible ? 'Yes' : `No · ${smsReasonLabel(st.sms.reason)}`, tone: st.sms.eligible ? 'ok' : 'attn' })
    rows.push({ k: 'Last contact', v: lastContactLabel(st?.lastContact ?? null) ?? (st ? 'Never contacted' : '—') })
    if (st?.stage || st?.status) rows.push({ k: 'Stage', v: spec([st?.stage ? humanize(st.stage.value) : null, st?.status ? humanize(st.status.value) : null, st?.stage?.source === 'pipeline' ? 'pipeline deal' : st?.stage ? 'conversation' : null]) })
    if (st?.campaigns) rows.push({ k: 'Campaign', v: st.campaigns.count ? spec([st.campaigns.latest?.name ?? 'Campaign', st.campaigns.count > 1 ? `+${st.campaigns.count - 1}` : null, st.campaigns.latest?.targetStatus ? humanize(st.campaigns.latest.targetStatus) : null]) : 'Not in a campaign' })
    const preview = st?.conversation?.preview ?? thread?.preview ?? null
    return {
      title: p.address,
      subtitle: spec([[p.city, p.state].filter(Boolean).join(', '), p.market]),
      figures: [
        { k: 'Value', v: fmtMoney(p.value) },
        { k: 'Equity', v: equityText(p) },
        { k: 'Units', v: p.units ? String(p.units) : '—' },
      ],
      rows,
      flags,
      message: preview ? { who: `${(st?.conversation?.direction ?? '') === 'inbound' ? 'Seller' : 'Last message'} · ${relativeDay(st?.conversation?.at ?? thread?.at ?? null)}${thread?.stage ? ` · ${humanize(thread.stage)}` : ''}`, text: preview } : null,
    }
  }
  if (node.type === 'owner') {
    const o = network.owner
    const eligible = network.properties.filter((p) => outreach.get(p.id)?.sms?.eligible).length
    return {
      title: o.name,
      subtitle: spec([o.kindLabel, o.markets.slice(0, 2).join(', ')]),
      figures: [
        { k: 'Properties', v: fmtCount(o.propertyCount) },
        { k: 'Value', v: fmtMoney(o.portfolio?.value ?? network.debt.totalValue) },
        { k: 'Debt', v: network.debt.withDebt ? fmtMoney(network.debt.totalLoanBalance) : '—' },
      ],
      rows: [
        { k: 'People', v: `${network.people.length} linked · ${network.phones.length} phones` },
        { k: 'Title entities', v: network.entities.length ? network.entities.slice(0, 2).map((e) => e.name).join(', ') : 'Own name' },
        ...(outreach.size ? [{ k: 'SMS eligible', v: `${eligible} of ${network.properties.length} properties`, tone: eligible ? 'ok' as const : 'attn' as const }] : []),
        ...(network.debt.taxDelinquent ? [{ k: 'Tax delinquent', v: `${network.debt.taxDelinquent} properties`, tone: 'attn' as const }] : []),
      ],
      flags: o.tags.slice(0, 6),
      message: null,
    }
  }
  if (node.type === 'person') {
    const person = network.people.find((x) => x.id === idOf(node))
    if (!person) return empty
    const phones = network.phones.filter((ph) => ph.personId === person.id)
    return {
      ...empty,
      title: person.name,
      subtitle: spec([person.role, person.primary ? 'primary contact' : null]),
      rows: [
        { k: 'Language', v: person.language ?? '—' },
        { k: 'Occupation', v: person.occupation ?? '—' },
        { k: 'Phones', v: phones.length ? spec([`${phones.length}`, phones.filter((p) => p.wrongNumber).length ? `${phones.filter((p) => p.wrongNumber).length} wrong number` : null]) : 'None linked' },
        { k: 'SMS eligible (vendor)', v: person.smsEligible ? 'Yes' : 'No', tone: person.smsEligible ? 'ok' : 'attn' },
      ],
      flags: person.matchingTags ?? [],
    }
  }
  if (node.type === 'related_owner') {
    const r = network.related.find((x) => x.id === idOf(node))
    return { ...empty, rows: r ? [{ k: 'Properties', v: fmtCount(r.propertyCount) }, { k: 'Value', v: fmtMoney(r.value) }, { k: 'Why related', v: r.reasons.map((x) => humanize(x)).join(', ') }, ...(r.mailing ? [{ k: 'Mailing', v: r.mailing }] : [])] : [] }
  }
  if (node.type === 'phone') {
    const ph = network.phones.find((x) => `phone:${x.id}` === node.id)
    return { ...empty, title: TYPE_LABEL.phone, subtitle: null, rows: ph ? [{ k: 'Line', v: ph.type || '—' }, { k: 'Activity', v: ph.active ?? '—' }, ...(ph.wrongNumber ? [{ k: 'Status', v: 'Wrong number', tone: 'crit' as const }] : [])] : [] }
  }
  if (node.type === 'entity') {
    return { ...empty, rows: [{ k: 'Kind', v: node.sub ?? '—' }, ...(node.meta?.mailing ? [{ k: 'Mailing', v: String(node.meta.mailing) }] : [])] }
  }
  if (node.type === 'mortgage') {
    const m = node.meta ?? {}
    return { ...empty, rows: [{ k: 'Balance', v: fmtMoney(m.balance as number) }, { k: 'Original', v: fmtMoney(m.amount as number) }, { k: 'Rate', v: m.rate ? `${m.rate}%` : '—' }, { k: 'Type', v: m.privateLender ? 'Private lender' : (m.loanType as string) || '—' }] }
  }
  if (node.type === 'sale') {
    const m = node.meta ?? {}
    return { ...empty, rows: [{ k: 'Price', v: fmtMoney(m.price as number) }, { k: 'Date', v: (m.date as string)?.slice(0, 10) ?? '—' }, ...(m.cash ? [{ k: 'Financing', v: 'Cash' }] : [])] }
  }
  if (node.type === 'conversation') {
    const t = network.outreach.threads.find((x) => `thread:${x.threadKey}` === node.id)
    return {
      ...empty,
      title: t?.stage ? humanize(t.stage) : 'Conversation',
      subtitle: t?.at ? relativeDay(t.at) : null,
      rows: t ? [...(t.intent ? [{ k: 'Intent', v: humanize(t.intent) }] : []), ...(t.nextAction ? [{ k: 'Next', v: humanize(t.nextAction) }] : []), ...(t.hot ? [{ k: 'Temperature', v: 'Hot', tone: 'crit' as const }] : [])] : [],
      message: t?.preview ? { who: 'Latest message', text: t.preview } : null,
    }
  }
  return empty
}

export function GraphHoverCard({ node, network, outreach, style }: { node: NetworkNode; network: EntityNetwork; outreach: Map<string, OutreachState | null>; style?: CSSProperties }) {
  const f = nodeCardFacts(node, network, outreach)
  return (
    <div className={cx('egdk-gcard', `is-${node.type}`)} role="status" style={style}>
      <div className="egdk-gcard__head">
        <span className={cx('egdk-dot', `is-${node.type === 'related_owner' ? 'related' : node.type === 'phone' || node.type === 'email' ? 'contact' : node.type}`)} aria-hidden="true" />
        <span className="egdk-gcard__type">{TYPE_LABEL[node.type] ?? node.type}</span>
      </div>
      <strong className="egdk-gcard__title">{f.title}</strong>
      {f.subtitle ? <span className="egdk-gcard__sub">{f.subtitle}</span> : null}
      {f.figures.length ? (
        <div className="egdk-gcard__figs">
          {f.figures.map((x) => <div key={x.k}><span>{x.k}</span><b>{x.v}</b></div>)}
        </div>
      ) : null}
      {f.rows.length ? (
        <dl className="egdk-gcard__rows">
          {f.rows.map((r) => <div key={r.k} className={cx(r.tone && `is-${r.tone}`)}><dt>{r.k}</dt><dd>{r.v}</dd></div>)}
        </dl>
      ) : null}
      {f.flags.length ? <div className="egdk-gcard__flags">{f.flags.slice(0, 6).map((x) => <span key={x}>{x}</span>)}</div> : null}
      {f.message ? <blockquote className="egdk-gcard__msg"><span>{f.message.who}</span>{f.message.text}</blockquote> : null}
      {nodeAnchor(node) ? <span className="egdk-gcard__hint">Click to open its network</span> : null}
    </div>
  )
}
