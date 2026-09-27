/**
 * The intelligence sheet under the stage — whatever is in focus, told well.
 *
 * Nothing focused: the network itself (who controls it, the portfolio, the
 * debt across it, its sale history, the people and the other owners that are
 * really the same party). A focused node gets its own view. Money leads, debt
 * is first-class, history is a timeline — never a table dump.
 */
import { useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { EntityNetwork, NetworkNode, NetworkProperty, NetworkSale } from './entity-network-api'
import { money, pct, REASON_LABEL, shortDate } from './entity-network-api'
import { NODE_ICON } from './EntityNetworkStage'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const label = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '')

export interface InspectorActions {
  openNetwork: (type: 'owner' | 'property' | 'person', id: string) => void
  focus: (nodeId: string) => void
  toggleSelect: (nodeIds: string[], on?: boolean) => void
  showOnMap: (propertyId: string) => void
  openConversation: (threadKey: string) => void
  addToCampaign: (propertyIds: string[]) => void
}

interface Props {
  network: EntityNetwork
  node: NetworkNode | null
  selected: ReadonlySet<string>
  actions: InspectorActions
}

function Kpis({ items }: { items: Array<{ k: string; v: string; tone?: string; sub?: string }> }) {
  return (
    <div className="egx-kpis" style={{ gridTemplateColumns: `repeat(${items.length === 4 ? 2 : items.length}, minmax(0, 1fr))` }}>
      {items.map((it) => (
        <div key={it.k} className={cls('egx-kpi', it.tone && `is-${it.tone}`)}>
          <strong>{it.v}</strong>
          <span>{it.k}</span>
          {it.sub && <em>{it.sub}</em>}
        </div>
      ))}
    </div>
  )
}

/** Value vs debt as one bar: equity glows, debt is the dark share. */
function EquityBar({ value, balance }: { value: number | null; balance: number | null }) {
  if (!value) return null
  const debt = Math.max(0, Math.min(1, (balance ?? 0) / value))
  return (
    <div className="egx-eqbar" aria-label={`Debt is ${Math.round(debt * 100)}% of value`}>
      <div className="egx-eqbar__track">
        <span className="egx-eqbar__debt" style={{ width: `${debt * 100}%` }} />
        <span className="egx-eqbar__equity" style={{ width: `${(1 - debt) * 100}%` }} />
      </div>
      <div className="egx-eqbar__legend">
        <span><i className="is-debt" />Debt {money(balance ?? 0)}</span>
        <span><i className="is-equity" />Equity {money(value - (balance ?? 0))}</span>
      </div>
    </div>
  )
}

function LtvGauge({ ltv }: { ltv: number | null }) {
  if (ltv === null) return null
  const t = Math.max(0, Math.min(1, ltv / 100))
  const tone = ltv >= 80 ? 'hot' : ltv >= 50 ? 'warm' : 'cool'
  return (
    <div className={cls('egx-ltv', `is-${tone}`)}>
      <svg viewBox="0 0 120 64" aria-hidden="true">
        <path d="M10,60 A50,50 0 0 1 110,60" className="egx-ltv__track" />
        <path d="M10,60 A50,50 0 0 1 110,60" className="egx-ltv__fill" style={{ strokeDasharray: `${157 * t} 157` }} />
      </svg>
      <strong>{Math.round(ltv)}%</strong>
      <span>Loan-to-value</span>
    </div>
  )
}

const SOURCE_LABEL: Record<string, string> = { mls: 'MLS sale', public: 'Public record', public_record: 'Public record', investor: 'Investor purchase', deed: 'Recorded deed' }

function Timeline({ events, onFocusProperty }: { events: NetworkSale[]; onFocusProperty?: (id: string) => void }) {
  if (!events.length) return <p className="egx-empty">No recorded sales for this network.</p>
  return (
    <ol className="egx-timeline">
      {events.map((e) => (
        <li key={e.id} className={cls('egx-tl', `is-${e.source ?? 'deed'}`)}>
          <span className="egx-tl__dot" aria-hidden="true" />
          <div className="egx-tl__head">
            <strong>{money(e.price)}</strong>
            <span>{shortDate(e.date)}</span>
          </div>
          <div className="egx-tl__meta">
            <span className="egx-chip">{SOURCE_LABEL[e.source ?? ''] ?? label(e.source) ?? 'Sale'}</span>
            {e.docType && <span className="egx-chip">{label(e.docType)}</span>}
            {e.portfolioSale && <span className="egx-chip is-warn">Portfolio sale</span>}
            {e.buyerClass && e.buyerClass !== 'unknown' && <span className="egx-chip">{label(e.buyerClass)}</span>}
          </div>
          {e.buyer && <p className="egx-tl__who">Bought by <b>{e.buyer}</b></p>}
          {e.address && onFocusProperty && (
            <button type="button" className="egx-tl__where" onClick={() => onFocusProperty(e.propertyId)}>{e.address}</button>
          )}
        </li>
      ))}
    </ol>
  )
}

function PropertyRow({ p, selected, onToggle, onFocus }: { p: NetworkProperty; selected: boolean; onToggle: () => void; onFocus: () => void }) {
  return (
    <div className={cls('egx-prow', selected && 'is-selected')}>
      <button type="button" className="egx-prow__check" aria-pressed={selected} aria-label={selected ? 'Deselect' : 'Select'} onClick={onToggle}>
        {selected && <Icon name="check" />}
      </button>
      <button type="button" className="egx-prow__body" onClick={onFocus}>
        <strong>{p.address}</strong>
        <span>{[p.city, p.state].filter(Boolean).join(', ')}{p.type ? ` · ${p.type}` : ''}{p.units && p.units > 1 ? ` · ${p.units} units` : ''}</span>
        <div className="egx-prow__nums">
          <em>{money(p.value)}</em>
          {p.equityPct !== null && <em className="is-eq">{pct(p.equityPct)} equity</em>}
          {p.loanBalance ? <em className="is-debt">{money(p.loanBalance)} debt</em> : p.freeAndClear ? <em className="is-free">Free &amp; clear</em> : null}
          {p.activeLien && <em className="is-warn">Lien</em>}
          {p.taxDelinquent && <em className="is-warn">Tax delinquent</em>}
        </div>
      </button>
    </div>
  )
}

function Section({ title, count, children, right }: { title: string; count?: number | string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="egx-sec">
      <header>
        <h3>{title}{count !== undefined && <span>{count}</span>}</h3>
        {right}
      </header>
      {children}
    </section>
  )
}

function NetworkSummary({ network, selected, actions }: Omit<Props, 'node'>) {
  const { owner, debt } = network
  const [showAll, setShowAll] = useState(false)
  const propIds = network.properties.map((p) => `property:${p.id}`)
  const allSelected = propIds.length > 0 && propIds.every((id) => selected.has(id))
  const list = showAll ? network.properties : network.properties.slice(0, 8)
  return (
    <>
      <Kpis items={[
        { k: 'Portfolio value', v: money(owner.portfolio?.value ?? debt.totalValue) },
        { k: 'Equity', v: money(owner.portfolio?.equity ?? debt.totalEquity), tone: 'eq' },
        { k: 'Debt', v: money(owner.portfolio?.loanBalance ?? debt.totalLoanBalance), tone: 'debt', sub: debt.blendedLtv !== null ? `${Math.round(debt.blendedLtv)}% LTV` : undefined },
        { k: 'Properties', v: owner.propertyCount.toLocaleString(), sub: owner.units ? `${owner.units.toLocaleString()} units` : undefined },
      ]} />

      <Section title="Debt across the portfolio">
        <EquityBar value={debt.totalValue} balance={debt.totalLoanBalance} />
        <div className="egx-facts">
          <span><b>{debt.freeAndClear}</b> free &amp; clear</span>
          <span><b>{debt.withDebt}</b> financed</span>
          {debt.monthlyPayment ? <span><b>{money(debt.monthlyPayment)}</b>/mo payments</span> : null}
          {debt.activeLiens ? <span className="is-warn"><b>{debt.activeLiens}</b> active liens</span> : null}
          {debt.taxDelinquent ? <span className="is-warn"><b>{debt.taxDelinquent}</b> tax delinquent</span> : null}
        </div>
        {network.propertiesTruncated > 0 && <p className="egx-note">Across the {network.properties.length} highest-value properties shown · {network.propertiesTruncated} more in the portfolio.</p>}
      </Section>

      <Section
        title="Portfolio"
        count={owner.propertyCount}
        right={propIds.length > 0 && (
          <button type="button" className="egx-link" onClick={() => actions.toggleSelect(propIds, !allSelected)}>{allSelected ? 'Clear' : 'Select all'}</button>
        )}
      >
        <div className="egx-plist">
          {list.map((p) => (
            <PropertyRow key={p.id} p={p} selected={selected.has(`property:${p.id}`)} onToggle={() => actions.toggleSelect([`property:${p.id}`])} onFocus={() => actions.focus(`property:${p.id}`)} />
          ))}
        </div>
        {network.properties.length > 8 && (
          <button type="button" className="egx-more" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${network.properties.length}`}</button>
        )}
      </Section>

      {network.related.length > 0 && (
        <Section title="Same party, other records" count={network.related.length}>
          <div className="egx-cards">
            {network.related.map((r) => (
              <button key={r.id} type="button" className="egx-rcard" onClick={() => actions.openNetwork('owner', r.id)}>
                <span className="egx-rcard__icon"><Icon name="link" /></span>
                <strong>{r.name}</strong>
                <span>{r.propertyCount} {r.propertyCount === 1 ? 'property' : 'properties'}{r.value ? ` · ${money(r.value)}` : ''}</span>
                <div>{r.reasons.map((x) => <em key={x}>{REASON_LABEL[x]}</em>)}</div>
              </button>
            ))}
          </div>
        </Section>
      )}

      {(network.people.length > 0 || network.phones.length > 0) && (
        <Section title="People & contact paths" count={network.people.length || undefined}>
          <PeopleList network={network} actions={actions} />
        </Section>
      )}

      {network.entities.length > 0 && (
        <Section title="Holds title as" count={network.entities.length}>
          <div className="egx-chips-wrap">
            {network.entities.map((e) => (
              <button key={e.id} type="button" className={cls('egx-entity', `k-${e.kind}`)} onClick={() => actions.focus(`entity:${e.id}`)}>
                <Icon name="briefcase" /><span><b>{e.name}</b><em>{e.kindLabel}</em></span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="Transaction history" count={network.history.length || undefined}>
        <Timeline events={network.history.slice(0, 12)} onFocusProperty={(id) => actions.focus(`property:${id}`)} />
      </Section>

      {(owner.markets.length > 0 || owner.tags.length > 0 || owner.language || owner.maxOwnershipYears) && (
        <Section title="Profile">
          <div className="egx-facts">
            {owner.markets.length > 0 && <span>Markets <b>{owner.markets.join(', ')}</b></span>}
            {owner.maxOwnershipYears ? <span>Held up to <b>{Math.round(owner.maxOwnershipYears)} yrs</b></span> : null}
            {owner.language && <span>Language <b>{owner.language}</b></span>}
            {owner.bestChannel && <span>Best channel <b>{label(owner.bestChannel)}</b></span>}
            {network.mailing && <span>Mail <b>{network.mailing.address}</b>{network.mailing.outOfState ? ' · out of state' : ''}</span>}
          </div>
          {owner.tags.length > 0 && <div className="egx-tags">{owner.tags.map((t) => <span key={t}>{t}</span>)}</div>}
        </Section>
      )}
    </>
  )
}

function PeopleList({ network, actions, personId }: { network: EntityNetwork; actions: InspectorActions; personId?: string }) {
  const people = personId ? network.people.filter((p) => p.id === personId) : network.people
  const orphanPhones = personId ? [] : network.phones.filter((ph) => !ph.personId || !network.people.some((p) => p.id === ph.personId))
  return (
    <div className="egx-people">
      {people.map((p) => {
        const phones = network.phones.filter((ph) => ph.personId === p.id)
        const emails = network.emails.filter((em) => em.personId === p.id)
        const thread = network.outreach.threads.find((t) => t.personId === p.id)
        return (
          <div key={p.id} className="egx-person">
            <button type="button" className="egx-person__head" onClick={() => actions.focus(`person:${p.id}`)}>
              <span className="egx-person__avatar">{p.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>
              <span><strong>{p.name}</strong><em>{p.role}{p.language ? ` · ${p.language}` : ''}</em></span>
              {p.primary && <b className="egx-badge">Primary</b>}
            </button>
            {(phones.length > 0 || emails.length > 0) && (
              <div className="egx-contacts">
                {phones.map((ph) => (
                  <span key={ph.id} className={cls('egx-contact', ph.wrongNumber && 'is-wrong')}><Icon name="phone" />{ph.display}<em>{ph.wrongNumber ? 'Wrong number' : ph.type}</em></span>
                ))}
                {emails.map((em) => <span key={em.id} className="egx-contact"><Icon name="mail" />{em.value}</span>)}
              </div>
            )}
            {thread && (
              <button type="button" className="egx-convo" onClick={() => actions.openConversation(thread.threadKey)}>
                <Icon name="message" /><span><b>{thread.stage ? label(thread.stage) : 'Conversation'}</b>{thread.preview ? ` — ${thread.preview}` : ''}</span><Icon name="chevron-right" />
              </button>
            )}
          </div>
        )
      })}
      {orphanPhones.length > 0 && (
        <div className="egx-contacts">
          {orphanPhones.map((ph) => (
            <span key={ph.id} className={cls('egx-contact', ph.wrongNumber && 'is-wrong')}><Icon name="phone" />{ph.display}<em>{ph.wrongNumber ? 'Wrong number' : ph.type}</em></span>
          ))}
        </div>
      )}
    </div>
  )
}

function PropertyView({ p, network, selected, actions }: { p: NetworkProperty; network: EntityNetwork; selected: ReadonlySet<string>; actions: InspectorActions }) {
  const sales = network.history.filter((e) => e.propertyId === p.id)
  const threads = network.outreach.threads.filter((t) => t.propertyId === p.id)
  const nodeId = `property:${p.id}`
  return (
    <>
      {p.streetview && (
        <div className="egx-hero">
          <img src={p.streetview} alt={`Street view of ${p.address}`} loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }} />
          <span className="egx-hero__scrim" />
        </div>
      )}
      <div className="egx-facts is-lead">
        {p.type && <span><b>{p.type}</b></span>}
        {p.units && p.units > 1 ? <span><b>{p.units}</b> units</span> : null}
        {p.beds ? <span><b>{p.beds}</b> bd</span> : null}
        {p.baths ? <span><b>{p.baths}</b> ba</span> : null}
        {p.sqft ? <span><b>{Math.round(p.sqft).toLocaleString()}</b> sqft</span> : null}
        {p.yearBuilt ? <span>Built <b>{p.yearBuilt}</b></span> : null}
        {p.county && <span>{p.county} County</span>}
      </div>
      <Kpis items={[
        { k: 'Est. value', v: money(p.value) },
        { k: (p.equity ?? 0) < 0 || (p.equityPct ?? 0) < 0 ? 'Underwater' : 'Equity', v: p.equity !== null ? money(p.equity) : pct(p.equityPct), tone: (p.equity ?? 0) < 0 || (p.equityPct ?? 0) < 0 ? 'debt' : 'eq', sub: p.equityPct !== null ? pct(p.equityPct) : undefined },
        { k: 'Loan balance', v: p.loanBalance ? money(p.loanBalance) : p.freeAndClear ? 'None' : '—', tone: 'debt' },
      ]} />

      <Section title="Debt & financing">
        <div className="egx-debt">
          <LtvGauge ltv={p.ltv ?? (p.freeAndClear ? 0 : null)} />
          <div className="egx-debt__rows">
            <div><span>Balance</span><b>{p.loanBalance ? money(p.loanBalance) : p.freeAndClear ? 'Free & clear' : '—'}</b></div>
            {p.loanAmount ? <div><span>Original loans</span><b>{money(p.loanAmount)}</b></div> : null}
            {p.loanPayment ? <div><span>Payment</span><b>{money(p.loanPayment)}/mo</b></div> : null}
            <div><span>Liens</span><b className={p.activeLien ? 'is-warn' : ''}>{p.activeLien ? 'Active lien' : 'None recorded'}</b></div>
            <div><span>Property tax</span><b className={p.taxDelinquent ? 'is-warn' : ''}>{p.taxDelinquent ? `Delinquent${p.taxDelinquentYear ? ` since ${p.taxDelinquentYear}` : ''}` : p.taxAmount ? `${money(p.taxAmount)}/yr` : 'Current'}</b></div>
          </div>
        </div>
        <EquityBar value={p.value} balance={p.loanBalance} />
      </Section>

      <Section title="Sale history" count={sales.length || undefined}>
        <Timeline events={sales} />
        {p.ownershipYears ? <p className="egx-note">Current owner has held it {Math.round(p.ownershipYears)} years.</p> : null}
      </Section>

      <Section title="Controlled by">
        <button type="button" className="egx-owner-link" onClick={() => actions.focus(network.graph.nodes.find((n) => n.type === 'owner')?.id ?? '')}>
          <span className="egx-owner-link__icon"><Icon name="star" /></span>
          <span><strong>{network.owner.name}</strong><em>{network.owner.kindLabel} · {network.owner.propertyCount} {network.owner.propertyCount === 1 ? 'property' : 'properties'}</em></span>
          <Icon name="chevron-right" />
        </button>
        {network.mailing && <p className="egx-note">Mail goes to {network.mailing.address}{network.mailing.outOfState ? ' — out of state' : ''}.</p>}
      </Section>

      {p.tags.length > 0 && <Section title="Signals"><div className="egx-tags">{p.tags.map((t) => <span key={t}>{t}</span>)}</div></Section>}

      <div className="egx-actions">
        {threads[0] && <button type="button" className="egx-act is-primary" onClick={() => actions.openConversation(threads[0].threadKey)}><Icon name="message" />Open conversation</button>}
        <button type="button" className="egx-act" onClick={() => actions.showOnMap(p.id)}><Icon name="map" />Show on map</button>
        <button type="button" className={cls('egx-act', selected.has(nodeId) && 'is-on')} onClick={() => actions.toggleSelect([nodeId])}><Icon name="check" />{selected.has(nodeId) ? 'Selected' : 'Select'}</button>
        <button type="button" className="egx-act" onClick={() => actions.addToCampaign([p.id])}><Icon name="send" />Add to campaign</button>
      </div>
    </>
  )
}

export function EntityNetworkInspector({ network, node, selected, actions }: Props) {
  const property = useMemo(() => (node?.type === 'property' ? network.properties.find((p) => `property:${p.id}` === node.id) ?? null : null), [network, node])
  const type = node?.type ?? 'network'

  const header = (() => {
    if (!node || node.type === 'owner') {
      return { icon: 'star' as const, eyebrow: network.owner.kindLabel === 'Name on title' ? 'Owner' : network.owner.kindLabel, title: network.owner.name, sub: `${network.owner.propertyCount} ${network.owner.propertyCount === 1 ? 'property' : 'properties'}${network.owner.markets.length ? ` · ${network.owner.markets.slice(0, 2).join(', ')}` : ''}` }
    }
    if (property) return { icon: 'home' as const, eyebrow: 'Property', title: property.address, sub: [property.city, property.state, property.zip].filter(Boolean).join(', ') }
    return { icon: NODE_ICON[node.type] ?? 'grid', eyebrow: label(node.type === 'related_owner' ? 'Related owner' : node.type), title: node.label, sub: node.sub ?? '' }
  })()

  return (
    <div className={cls('egx-insp', `is-${type}`)}>
      <header className="egx-insp__head">
        <span className={cls('egx-insp__icon', `is-${node?.type ?? 'owner'}`)}><Icon name={header.icon} /></span>
        <div>
          <span className="egx-insp__eyebrow">{header.eyebrow}</span>
          <h2>{header.title}</h2>
          {header.sub && <p>{header.sub}</p>}
        </div>
      </header>

      {(!node || node.type === 'owner') && <NetworkSummary network={network} selected={selected} actions={actions} />}
      {property && <PropertyView p={property} network={network} selected={selected} actions={actions} />}

      {node?.type === 'person' && (
        <>
          {(() => {
            const person = network.people.find((p) => `person:${p.id}` === node.id)
            return person ? (
              <>
                <div className="egx-facts is-lead">
                  <span><b>{person.role}</b></span>
                  {person.language && <span>Speaks <b>{person.language}</b></span>}
                  {person.occupation && <span>{person.occupation}</span>}
                  {person.householdIncome && <span>Household income <b>{person.householdIncome}</b></span>}
                  {person.netAssets && <span>Net assets <b>{person.netAssets}</b></span>}
                  {!person.smsEligible && <span className="is-warn">Not SMS eligible</span>}
                </div>
                <Section title="Contact paths"><PeopleList network={network} actions={actions} personId={person.id} /></Section>
              </>
            ) : null
          })()}
        </>
      )}

      {(node?.type === 'phone' || node?.type === 'email') && (() => {
        const ph = network.phones.find((x) => `phone:${x.id}` === node.id)
        const em = network.emails.find((x) => `email:${x.id}` === node.id)
        const personId = ph?.personId ?? em?.personId
        const person = network.people.find((p) => p.id === personId)
        const thread = network.outreach.threads.find((t) => t.personId && t.personId === personId)
        return (
          <>
            <div className="egx-facts is-lead">
              {ph && <span><b>{ph.type}</b></span>}
              {ph?.wrongNumber && <span className="is-warn">Marked wrong number</span>}
              {ph?.active && <span>{label(ph.active)}</span>}
              {person && <span>Reaches <b>{person.name}</b></span>}
            </div>
            {thread && <div className="egx-actions"><button type="button" className="egx-act is-primary" onClick={() => actions.openConversation(thread.threadKey)}><Icon name="message" />Open conversation</button></div>}
          </>
        )
      })()}

      {node?.type === 'mailing' && network.mailing && (
        <>
          <div className="egx-facts is-lead">
            <span><b>{network.mailing.address}</b></span>
            {network.mailing.outOfState && <span className="is-warn">Out-of-state owner</span>}
          </div>
          {network.related.some((r) => r.reasons.includes('mailing')) && (
            <Section title="Other owners mailed here" count={network.related.filter((r) => r.reasons.includes('mailing')).length}>
              <div className="egx-cards">
                {network.related.filter((r) => r.reasons.includes('mailing')).map((r) => (
                  <button key={r.id} type="button" className="egx-rcard" onClick={() => actions.openNetwork('owner', r.id)}>
                    <span className="egx-rcard__icon"><Icon name="link" /></span><strong>{r.name}</strong><span>{r.propertyCount} properties{r.value ? ` · ${money(r.value)}` : ''}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      {node?.type === 'related_owner' && (() => {
        const r = network.related.find((x) => `related:${x.id}` === node.id)
        return r ? (
          <>
            <div className="egx-facts is-lead">
              {r.reasons.map((x) => <span key={x}><b>{REASON_LABEL[x]}</b></span>)}
              <span><b>{r.propertyCount}</b> properties</span>
              {r.value ? <span><b>{money(r.value)}</b> portfolio</span> : null}
            </div>
            {r.mailing && <p className="egx-note">Mail goes to {r.mailing}.</p>}
            <div className="egx-actions"><button type="button" className="egx-act is-primary" onClick={() => actions.openNetwork('owner', r.id)}><Icon name="link" />Open this network</button></div>
          </>
        ) : null
      })()}

      {node?.type === 'entity' && (() => {
        const e = network.entities.find((x) => `entity:${x.id}` === node.id)
        return e ? (
          <>
            <div className="egx-facts is-lead">
              <span><b>{e.kindLabel}</b></span>
              <span>Title holder for <b>{network.owner.name}</b></span>
            </div>
            {e.mailing && <p className="egx-note">Registered / mailing address: {e.mailing}</p>}
            <p className="egx-note">Filing-state and officer records are not in the data yet; this is the name the property is held under.</p>
          </>
        ) : null
      })()}

      {node?.type === 'conversation' && (() => {
        const t = network.outreach.threads.find((x) => `thread:${x.threadKey}` === node.id)
        return t ? (
          <>
            <div className="egx-facts is-lead">
              {t.stage && <span><b>{label(t.stage)}</b></span>}
              {t.hot && <span className="is-hot">Hot</span>}
              {t.intent && <span>Intent <b>{label(t.intent)}</b></span>}
              {t.at && <span>{shortDate(t.at)}</span>}
            </div>
            {t.preview && <blockquote className="egx-quote">{t.preview}</blockquote>}
            {t.nextAction && <p className="egx-note">Next: {label(t.nextAction)}</p>}
            <div className="egx-actions"><button type="button" className="egx-act is-primary" onClick={() => actions.openConversation(t.threadKey)}><Icon name="message" />Open conversation</button></div>
          </>
        ) : null
      })()}
    </div>
  )
}
