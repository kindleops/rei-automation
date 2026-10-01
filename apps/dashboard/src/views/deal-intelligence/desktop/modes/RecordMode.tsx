import { Icon, type IconName } from '../../../../shared/icons'
import { cx, LCButton, LCTimeline, type LCTimelineItem } from '../../../../shared/lc'
import { dateShort, usd } from '../di-format'
import type { DiLinks } from '../di-links'
import { fieldNature, recordCategories, type RecordCategoryKey } from '../di-model'
import type { DiDecision, DiSelection } from '../di-types'
import { Empty, Plane, Tag } from '../di-ui'

const ICON: Record<RecordCategoryKey, IconName> = {
  valuation: 'trending-up', property: 'home', debt: 'dollar-sign', tax: 'file-text', ownership: 'key', distress: 'alert', transactions: 'clock', other: 'database',
}

/**
 * RECORD — the property's full record as an intelligence dossier: a
 * category rail, each category's summary and key values first, the full
 * field list on demand, and every field inspectable with its source and
 * whether it is recorded or an estimate. Populated fields only.
 */
export function RecordMode({ d, category, onCategory, selection, onSelect, links, now }: {
  d: DiDecision
  category: RecordCategoryKey
  onCategory: (c: RecordCategoryKey) => void
  selection: DiSelection | null
  onSelect: (s: DiSelection) => void
  links: DiLinks | null
  now: number
}) {
  const cats = recordCategories(d)
  const cat = cats.find((c) => c.key === category) ?? cats[0]
  if (!cats.length || !cat) return <Empty icon="database" title="No parcel record" body="No county or provider record is linked to this property." />
  return (
    <div className="dr-mode dr-record">
      <nav className="dr-rail" aria-label="Record categories">
        {cats.map((c) => (
          <button key={c.key} type="button" className={cx('dr-rail__item', cat.key === c.key && 'is-on')} onClick={() => onCategory(c.key)} aria-current={cat.key === c.key ? 'true' : undefined}>
            <Icon name={ICON[c.key]} size={14} />
            <span>{c.label}</span>
            <b className="lc-num">{c.count}</b>
          </button>
        ))}
      </nav>
      <div className="dr-record__body">
        <Plane id={`record-${cat.key}`} eyebrow={`Record · ${cat.count} ${cat.key === 'transactions' ? 'events' : 'fields'}`} title={cat.label} under="exec" aside={<span className="dr-quiet">{cat.source}</span>}>
          {cat.summary.length ? (
            <div className="dr-keyvals">
              {cat.summary.map((k) => (
                <button key={k.label} type="button" className={cx('dr-keyval', selection?.type === 'field' && selection.label === k.label && 'is-selected')} onClick={() => onSelect({ type: 'field', group: k.group, label: k.label })}>
                  <span>{k.label}{fieldNature(k.label) === 'estimated' ? <Tag kind="estimated" /> : null}</span>
                  <b className="lc-num">{k.value}</b>
                </button>
              ))}
            </div>
          ) : null}

          {cat.key === 'ownership' ? <OwnershipSnapshot d={d} onOpenGraph={links?.graph ?? null} /> : null}

          {cat.key === 'transactions' ? <RecordTimeline d={d} onSelect={onSelect} /> : null}

          {cat.groups.map((g) => (
            <details key={g.title} className="dr-details" open={cat.groups.length === 1 || g.fields.length <= 12}>
              <summary>{g.title}<em>{g.fields.length} fields</em></summary>
              <div className="dr-fieldgrid" role="list">
                {g.fields.map((f) => {
                  const sel = selection?.type === 'field' && selection.group === g.title && selection.label === f.label
                  return (
                    <button key={`${f.label}-${f.value}`} type="button" role="listitem" className={cx('dr-field', f.value.length > 28 && 'is-wide', sel && 'is-selected')} onClick={() => onSelect({ type: 'field', group: g.title, label: f.label })}>
                      <span className="dr-field__k">{f.label}{fieldNature(f.label) === 'estimated' ? <i className="dr-est" title="Estimate">est.</i> : null}</span>
                      <span className="dr-field__v">{f.value}</span>
                    </button>
                  )
                })}
              </div>
            </details>
          ))}

          {cat.key === 'debt' && (d.economics.recordedDocuments ?? []).length ? (
            <p className="dr-quiet">{d.economics.lienSummary?.liens ?? 0} liens · {d.economics.lienSummary?.releases ?? 0} releases · {d.economics.lienSummary?.documents ?? 0} other instruments · {d.economics.lienSummary?.conflicts ?? 0} conflicts — itemized in Evidence → Debt &amp; liens.</p>
          ) : null}
          {cat.key === 'distress' && d.economics.foreclosure ? (
            <div className="dr-foreclosure">
              <Icon name="alert" size={13} />
              <div><b>{d.economics.foreclosure.status ?? 'Foreclosure filing'}</b><span>{[d.economics.foreclosure.docType, d.economics.foreclosure.auctionAt ? `auction ${dateShort(d.economics.foreclosure.auctionAt, now)}` : null].filter(Boolean).join(' · ')}</span></div>
            </div>
          ) : null}
        </Plane>

        {cat.key === 'ownership' && d.record.prospects.length ? (
          <Plane id="record-people" eyebrow="People linked to the owner" title={`${d.record.prospects.length} ${d.record.prospects.length === 1 ? 'person' : 'people'}`} depth={1}>
            <ul className="dr-people">
              {d.record.prospects.map((p) => (
                <li key={p.id}>
                  <details className="dr-details">
                    <summary><span className="dr-person__mark">{p.name.slice(0, 1)}</span>{p.name}{p.primary ? <em>primary</em> : null}</summary>
                    <dl className="dr-fieldgrid is-compact">
                      {p.fields.map((f) => <div key={f.label} className="dr-field is-static"><dt className="dr-field__k">{f.label}</dt><dd className="dr-field__v">{f.value}</dd></div>)}
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
            <p className="dr-quiet">Separate records from separate providers — nothing here asserts that these people are the owner of record.</p>
          </Plane>
        ) : null}
      </div>
    </div>
  )
}

/** OWNER → PROPERTY → COMPANY / PEOPLE, as recorded. Open Entity Graph for the full graph. */
function OwnershipSnapshot({ d, onOpenGraph }: { d: DiDecision; onOpenGraph: (() => void) | null }) {
  const owner = d.record.owner?.name ?? d.record.sections.find((s) => s.title === 'Ownership')?.fields.find((f) => f.label === 'Owner of record')?.value ?? null
  const companies = d.record.sections.find((s) => s.title === 'Ownership')?.fields.find((f) => f.label === 'Companies linked')?.value ?? null
  const others = d.record.sections.find((s) => s.title === 'Ownership')?.fields.find((f) => f.label === 'Owns other property')?.value ?? null
  const portfolio = d.record.owner?.sections.find((s) => s.title === 'Portfolio')?.fields.find((f) => f.label === 'Properties')?.value ?? null
  const people = d.record.prospects.slice(0, 4)
  if (!owner) return null
  return (
    <div className="dr-graph" aria-label="Ownership relationships">
      <div className="dr-graph__node is-owner"><span>Owner</span><b>{owner}</b>{portfolio ? <em>{portfolio} properties in portfolio</em> : others === 'Yes' ? <em>owns other property</em> : null}</div>
      <span className="dr-graph__edge" aria-hidden="true" />
      <div className="dr-graph__node is-property"><span>Property</span><b>{d.subject.address?.split(',')[0] ?? 'This property'}</b><em>{d.subject.propertyType ?? ''}</em></div>
      {companies || people.length ? <span className="dr-graph__edge" aria-hidden="true" /> : null}
      {companies || people.length ? (
        <div className="dr-graph__fan">
          {companies ? <div className="dr-graph__node is-company"><span>Companies</span><b>{companies} linked</b></div> : null}
          {people.map((p) => <div key={p.id} className="dr-graph__node is-person"><span>{p.primary ? 'Primary person' : 'Person'}</span><b>{p.name}</b></div>)}
        </div>
      ) : null}
      {onOpenGraph ? <LCButton size="sm" variant="quiet" icon="link" onClick={onOpenGraph}>Open in Entity Graph</LCButton> : null}
    </div>
  )
}

function RecordTimeline({ d, onSelect }: { d: DiDecision; onSelect: (s: DiSelection) => void }) {
  const items: LCTimelineItem[] = d.history
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.kind === 'sale' || h.kind === 'mortgage' || h.kind === 'lien' || h.kind === 'foreclosure')
    .map(({ h, i }) => ({
      id: `${h.kind}-${i}`,
      at: Date.parse(h.at),
      title: <>{h.title}{h.amount ? <b className="dr-tl-amt lc-num"> {usd(h.amount)}</b> : null}</>,
      body: h.detail ?? undefined,
      icon: h.kind === 'sale' ? 'home' : h.kind === 'mortgage' ? 'dollar-sign' : h.kind === 'lien' ? 'flag' : 'alert',
      onOpen: () => onSelect({ type: 'event', index: i, source: 'history' }),
    }))
  if (!items.length) return <p className="dr-none">No recorded sales, loans, liens or filings.</p>
  return <LCTimeline items={items} label="Recorded transactions" />
}
