/**
 * THE INSPECTOR — one network, read top-down: who controls it, what they own,
 * who can be reached and how sure the vendor match is, which entities hold
 * title, what is recorded against the property (debt, liens, transfers), and
 * who is related and why. Every fact is the network endpoint's (owner →
 * properties → people/phones/emails → entities → seller.* records); a value
 * the record does not carry says "not recorded", never a default.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { LCButton, LCError, LCInspector, LCInspectorSection, LCSkeleton, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import type { EntityGraphAction, UniversalEntityContext } from '../../../domain/entity-graph/entity-graph.types'
import { EMPTY_UNIVERSAL_ENTITY_CONTEXT } from '../../../domain/entity-graph/universal-entity-context'
import { buildEntityGraphActions } from '../../../domain/entity-graph/entity-graph-actions'
import { callBackend } from '../../../lib/api/backendClient'
import { openInboxThread } from '../../mobile/mobile-inbox-bridge'
import { REASON_LABEL, type EntityNetwork, type NetworkProperty } from '../console/entity-network-api'
import { DeskGraph } from './DeskGraph'
import { fmtCount, fmtMoney, matchingTagTone, type NetworkAnchor } from './desk-model'
import { equityDisplay } from '../equity-display'
import { EntityGraphPropertyVisual } from '../mobile/EntityGraphPropertyVisual'
import { SignalBadges } from './SignalBadges'
import { networkPropertySignals } from './network-signals'
import { humanize, lastContactLabel, relativeDay, smsReasonLabel, useNetworkOutreach, type OutreachState } from './desk-outreach'

const ACTION_LABEL: Partial<Record<EntityGraphAction, string>> = {
  open_in_map: 'Map',
  open_deal_intelligence: 'Deal Intelligence',
  open_comp_intelligence: 'Comps',
  open_buyer_match: 'Buyer Match',
  open_thread: 'Conversation',
  view_threads: 'Threads',
}

type Props = {
  open: boolean
  mode: 'dock' | 'float'
  anchor: NetworkAnchor | null
  network: EntityNetwork | null
  loading: boolean
  error: boolean
  /** why the network failed (status · reason), shown under the error */
  errorDetail?: string
  onRetry: () => void
  onClose: () => void
  onOpen: (anchor: NetworkAnchor) => void
  onOpenGraph: () => void
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
  onOpenBuyer?: (buyerId: string) => void
  /** Pin these properties on a draft campaign (the stack dialog). */
  onAddToCampaign?: (propertyIds: string[], label: string) => void
}

/** The ONE equity rendering (equity-display.ts) — identical to the grid cell and the hover card. */
const equityOf = (p: Pick<NetworkProperty, 'equityPct' | 'equity' | 'equityRule'>) => equityDisplay({ percent: p.equityPct, amount: p.equity, rule: p.equityRule })
const equityText = (p: Pick<NetworkProperty, 'equityPct' | 'equity' | 'equityRule'>) => equityOf(p).text
const yr = (s: string | null | undefined) => (s ? String(s).slice(0, 4) : null)
const day = (s: string | null | undefined) => {
  if (!s) return null
  const d = new Date(String(s).length === 10 ? `${s}T12:00:00` : String(s))
  return Number.isNaN(d.getTime()) ? String(s).slice(0, 10) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
const spec = (parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ')

function None({ children }: { children: ReactNode }) {
  return <p className="egdk-none">{children}</p>
}

export function DeskInspector({ open, mode, anchor, network, loading, error, errorDetail, onRetry, onClose, onOpen, onOpenGraph, onAction, onOpenBuyer, onAddToCampaign }: Props) {
  const anchorProperty = useMemo<NetworkProperty | null>(() => {
    if (!network || network.anchor.type !== 'property') return null
    return network.properties.find((p) => p.id === network.anchor.id) ?? null
  }, [network])

  const context = useMemo<UniversalEntityContext | null>(() => {
    if (!network) return null
    const thread = network.outreach.threads.find((t) => !anchorProperty || t.propertyId === anchorProperty.id) ?? null
    if (network.anchor.type === 'property') {
      return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'property', entityId: network.anchor.id, propertyId: network.anchor.id, masterOwnerId: network.owner.id, threadKey: thread?.threadKey ?? null }
    }
    if (network.anchor.type === 'person') {
      return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'prospect', entityId: network.anchor.id, prospectId: network.anchor.id, masterOwnerId: network.owner.id, threadKey: thread?.threadKey ?? null }
    }
    return { ...EMPTY_UNIVERSAL_ENTITY_CONTEXT, entityType: 'master_owner', entityId: network.anchor.id, masterOwnerId: network.anchor.id, threadKey: thread?.threadKey ?? null }
  }, [network, anchorProperty])

  const actions = useMemo(() => (context ? buildEntityGraphActions(context, network?.outreach.threads.length ?? 0) : []), [context, network])
  const shown = actions.filter((a) => ['open_in_map', 'open_deal_intelligence', 'open_comp_intelligence', 'open_buyer_match', 'open_thread', 'view_threads'].includes(a.key))

  const title = !network ? (loading ? 'Loading network…' : 'Network unavailable')
    : anchorProperty ? anchorProperty.address : network.owner.name
  const eyebrow = !network ? (anchor?.type === 'property' ? 'Property' : anchor?.type === 'person' ? 'Person' : 'Owner')
    : anchorProperty ? 'Property' : network.anchor.type === 'person' ? 'Person · owner network' : `Owner · ${network.owner.kindLabel}`
  const subtitle = !network ? null
    : anchorProperty ? spec([[anchorProperty.city, anchorProperty.state].filter(Boolean).join(', '), anchorProperty.market, anchorProperty.county ? `${anchorProperty.county} County` : null])
      : spec([`${fmtCount(network.owner.propertyCount)} ${network.owner.propertyCount === 1 ? 'property' : 'properties'}`, network.owner.markets.slice(0, 3).join(', '), network.owner.linked ? null : 'not linked to a master owner'])

  return (
    <LCInspector
      open={open}
      onClose={onClose}
      id="entity-graph-desk"
      mode={mode}
      width={440}
      minWidth={360}
      maxWidth={720}
      eyebrow={eyebrow}
      title={title}
      subtitle={subtitle}
      contentKey={network ? `${network.anchor.type}:${network.anchor.id}` : `state:${loading ? 'l' : 'e'}`}
      className="egdk-insp"
      footer={network && shown.length ? (
        <div className="egdk-insp__actions">
          {shown.map((a) => (
            <LCButton
              key={a.key}
              size="sm"
              variant={a.key === 'open_in_map' ? 'secondary' : 'quiet'}
              disabled={a.disabled}
              title={a.hint}
              onClick={() => {
                if (!context) return
                if (a.key === 'open_thread' && context.threadKey) { openInboxThread({ threadKey: context.threadKey }); return }
                onAction?.(a.key, context)
              }}
            >
              {ACTION_LABEL[a.key] ?? a.label}
            </LCButton>
          ))}
        </div>
      ) : null}
    >
      {loading && !network ? (
        <div className="egdk-insp__loading"><LCSkeleton shape="lines" count={8} label="Reading the relationship network" /></div>
      ) : error || !network ? (
        <LCError what="The relationship network didn’t load" detail={errorDetail} onRetry={onRetry} compact />
      ) : (
        <InspectorBody
          network={network}
          anchorProperty={anchorProperty}
          onOpen={onOpen}
          onOpenGraph={onOpenGraph}
          onOpenBuyer={onOpenBuyer}
          onOpenMap={context ? () => onAction?.('open_in_map', context) : undefined}
          onAddToCampaign={onAddToCampaign}
        />
      )}
    </LCInspector>
  )
}

function InspectorBody({ network, anchorProperty, onOpen, onOpenGraph, onOpenBuyer, onOpenMap, onAddToCampaign }: { network: EntityNetwork; anchorProperty: NetworkProperty | null; onOpen: (a: NetworkAnchor) => void; onOpenGraph: () => void; onOpenBuyer?: (id: string) => void; onOpenMap?: () => void; onAddToCampaign?: (ids: string[], label: string) => void }) {
  const o = network.owner
  const outreachIds = useMemo(() => (anchorProperty ? [anchorProperty.id] : network.properties.map((p) => p.id)), [anchorProperty, network.properties])
  const outreach = useNetworkOutreach(outreachIds)
  const rec = network.records ?? null
  const openMortgages = rec ? rec.mortgages.filter((m) => m.open) : []
  const phonesByPerson = new Map<string, EntityNetwork['phones']>()
  const loosePhones: EntityNetwork['phones'] = []
  for (const ph of network.phones) {
    if (ph.personId && network.people.some((p) => p.id === ph.personId)) phonesByPerson.set(ph.personId, [...(phonesByPerson.get(ph.personId) ?? []), ph])
    else loosePhones.push(ph)
  }
  const emailsByPerson = new Map<string, EntityNetwork['emails']>()
  for (const em of network.emails) if (em.personId) emailsByPerson.set(em.personId, [...(emailsByPerson.get(em.personId) ?? []), em])

  return (
    <div className="egdk-insp__body">
      {anchorProperty ? (
        /* ONE selected property = ONE intentional Street View request (the
           fan-out rule: off on lists, on for a single detail). The panorama
           stays opt-in inside the visual. */
        <div className="egdk-insp__visual">
          <EntityGraphPropertyVisual address={[anchorProperty.address, anchorProperty.city, anchorProperty.state, anchorProperty.zip].filter(Boolean).join(', ')} lat={anchorProperty.lat} lng={anchorProperty.lng} onOpenMap={onOpenMap} />
        </div>
      ) : null}
      {anchorProperty ? (
        <div className="egdk-insp__signals">
          <SignalBadges size="md" signals={networkPropertySignals(anchorProperty, rec)} />
        </div>
      ) : null}
      <OutreachSection
        anchorProperty={anchorProperty}
        ids={outreachIds}
        states={outreach}
        onAddToCampaign={onAddToCampaign ? () => onAddToCampaign(outreachIds, anchorProperty ? anchorProperty.address : `${network.owner.name} · network`) : undefined}
        onOpenPerson={(id) => onOpen({ type: 'person', id })}
      />
      {anchorProperty ? (
        <div className="egdk-figures">
          <Figure label="Est. value" value={fmtMoney(anchorProperty.value)} />
          {(() => {
            // ONE rule everywhere (equityTruth on the server, equity-display here)
            const e = equityOf(anchorProperty)
            return <Figure label="Equity" value={e.figure} hint={e.hint} tone={e.tone} />
          })()}
          <Figure label="Open loans" value={rec ? String(rec.totals.openMortgages) : '—'} hint={rec ? (rec.totals.balance !== null ? `${fmtMoney(rec.totals.balance)} balance` : 'no balance on file') : 'not captured'} />
          <Figure label="Last sale" value={anchorProperty.lastSale?.price ? fmtMoney(anchorProperty.lastSale.price) : '—'} hint={yr(anchorProperty.lastSale?.date) ?? undefined} />
        </div>
      ) : (
        <div className="egdk-figures">
          <Figure label="Properties" value={fmtCount(o.propertyCount)} hint={o.units ? `${fmtCount(o.units)} units` : undefined} />
          <Figure label="Portfolio value" value={fmtMoney(o.portfolio?.value ?? network.debt.totalValue)} />
          <Figure label="Known equity" value={fmtMoney(network.debt.totalEquity)} hint={network.properties.length ? `known on ${network.debt.equityKnown ?? 0} of ${network.properties.length}` : undefined} />
          <Figure label="Loan balance" value={network.debt.withDebt ? fmtMoney(network.debt.totalLoanBalance) : '—'} hint={network.debt.withDebt ? `${network.debt.withDebt} with a balance` : 'no balance on file'} />
        </div>
      )}
      {anchorProperty ? (
        <p className="egdk-spec">{spec([anchorProperty.type, anchorProperty.units && anchorProperty.units > 1 ? `${anchorProperty.units} units` : null, anchorProperty.beds ? `${anchorProperty.beds} bd` : null, anchorProperty.baths ? `${anchorProperty.baths} ba` : null, anchorProperty.sqft ? `${anchorProperty.sqft.toLocaleString('en-US')} sqft` : null, anchorProperty.yearBuilt ? `built ${anchorProperty.yearBuilt}` : null, anchorProperty.ownershipYears !== null ? `owned ${anchorProperty.ownershipYears} yrs` : null])}</p>
      ) : null}

      {anchorProperty?.zip ? <ZipMarketSection zip={anchorProperty.zip} /> : null}
      <LCInspectorSection title="Controlled by">
        <button type="button" className="egdk-party" onClick={() => o.id && onOpen({ type: 'owner', id: o.id })} disabled={!o.id || network.anchor.type === 'owner'}>
          <span className={cx('egdk-dot', 'is-owner')} aria-hidden="true" />
          <span className="egdk-party__main">
            <strong>{o.name}</strong>
            <small>{spec([o.kindLabel, o.linked ? `${fmtCount(o.propertyCount)} ${o.propertyCount === 1 ? 'property' : 'properties'}` : 'grouped by owner name — no master owner record', o.maxOwnershipYears ? `held up to ${o.maxOwnershipYears} yrs` : null])}</small>
          </span>
          {o.id && network.anchor.type !== 'owner' ? <Icon name="chevron-right" size={13} /> : null}
        </button>
        {network.mailing ? (
          <p className="egdk-line"><span>Mailing</span>{spec([network.mailing.address, [network.mailing.city, network.mailing.state].filter(Boolean).join(', '), network.mailing.outOfState ? 'out of state' : null])}</p>
        ) : null}
        {network.ownerBuyer ? (
          <p className="egdk-line"><span>Also a buyer</span>{spec([network.ownerBuyer.purchases ? `${network.ownerBuyer.purchases} purchases` : null, network.ownerBuyer.status, network.ownerBuyer.basis ? `matched by ${network.ownerBuyer.basis.replace('_', ' ')}` : null])}
            {onOpenBuyer ? <button type="button" className="egdk-link" onClick={() => onOpenBuyer(network.ownerBuyer!.id)}>View buyer</button> : null}
          </p>
        ) : null}
      </LCInspectorSection>

      <LCInspectorSection title="Relationships" aside={<button type="button" className="egdk-link" onClick={onOpenGraph}>Open graph</button>}>
        <DeskGraph network={network} compact onExpand={onOpenGraph} />
      </LCInspectorSection>

      <LCInspectorSection title={`Properties · ${fmtCount(o.propertyCount || network.properties.length)}`}>
        <ul className="egdk-list">
          {network.properties.slice(0, 12).map((p) => (
            <li key={p.id}>
              <button type="button" className={cx('egdk-row', p.id === anchorProperty?.id && 'is-current')} onClick={() => onOpen({ type: 'property', id: p.id })} disabled={p.id === anchorProperty?.id}>
                <span className="egdk-row__main"><strong>{p.address}</strong><small>{spec([[p.city, p.state].filter(Boolean).join(', '), p.type, p.units && p.units > 1 ? `${p.units} units` : null])}</small></span>
                <span className="egdk-row__num"><b>{fmtMoney(p.value)}</b><small>{equityText(p) === 'Unknown' ? 'equity unknown' : `equity ${equityText(p)}`}</small></span>
              </button>
            </li>
          ))}
        </ul>
        {network.properties.length > 12 || network.propertiesTruncated > 0 ? (
          <None>{fmtCount((o.propertyCount || network.properties.length) - Math.min(12, network.properties.length))} more in this portfolio — the relationship view clusters them.</None>
        ) : null}
      </LCInspectorSection>

      <LCInspectorSection title={`People & contacts · ${network.people.length}`}>
        {network.people.length === 0 && loosePhones.length === 0 && network.emails.length === 0 ? <None>No people or contact methods are linked to this owner.</None> : null}
        <ul className="egdk-people">
          {network.people.map((person) => (
            <li key={person.id} className="egdk-person">
              <button type="button" className="egdk-person__head" onClick={() => onOpen({ type: 'person', id: person.id })} disabled={network.anchor.type === 'person' && network.anchor.id === person.id}>
                <span className={cx('egdk-dot', 'is-person')} aria-hidden="true" />
                <strong>{person.name}</strong>
                <small>{spec([person.role, person.language, person.occupation, person.linkedBy === 'property' ? 'linked to this property' : null])}</small>
              </button>
              <div className="egdk-tags" aria-label="Contact matching tags">
                {(person.matchingTags ?? []).length ? (person.matchingTags ?? []).map((t) => (
                  <span key={t} className={cx('egdk-tag', `is-${matchingTagTone(t)}`)}>{t}</span>
                )) : <span className="egdk-tag is-none">No matching tag</span>}
              </div>
              {(phonesByPerson.get(person.id) ?? []).map((ph) => <ContactLine key={ph.id} icon="phone" value={ph.display} meta={spec([ph.type, ph.active, ph.wrongNumber ? 'wrong number' : null])} warn={ph.wrongNumber} onClick={network.anchor.type === 'person' && network.anchor.id === person.id ? undefined : () => onOpen({ type: 'person', id: person.id })} />)}
              {(emailsByPerson.get(person.id) ?? []).map((em) => <ContactLine key={em.id} icon="mail" value={em.value} meta="Email" onClick={network.anchor.type === 'person' && network.anchor.id === person.id ? undefined : () => onOpen({ type: 'person', id: person.id })} />)}
            </li>
          ))}
          {loosePhones.length ? (
            <li className="egdk-person">
              <span className="egdk-person__head is-static"><span className={cx('egdk-dot', 'is-contact')} aria-hidden="true" /><strong>Owner contact methods</strong><small>not tied to a person</small></span>
              {loosePhones.map((ph) => <ContactLine key={ph.id} icon="phone" value={ph.display} meta={spec([ph.type, ph.active, ph.wrongNumber ? 'wrong number' : null])} warn={ph.wrongNumber} onClick={o.id && network.anchor.type !== 'owner' ? () => onOpen({ type: 'owner', id: o.id! }) : undefined} />)}
            </li>
          ) : null}
        </ul>
      </LCInspectorSection>

      <LCInspectorSection title={`Title entities · ${network.entities.length}`}>
        {network.entities.length === 0 ? <None>Title is held in the owner’s own name — no separate entity on record.</None> : (
          <ul className="egdk-list">
            {network.entities.map((e) => (
              <li key={e.id}>
                {/* a title entity opens its master owner's network (the entity holds title for that owner) */}
                <button type="button" className="egdk-row" onClick={() => o.id && onOpen({ type: 'owner', id: o.id })} disabled={!o.id || network.anchor.type === 'owner'} title={o.id ? `Open ${o.name}` : undefined}>
                  <span className={cx('egdk-dot', 'is-entity')} aria-hidden="true" />
                  <span className="egdk-row__main"><strong>{e.name}</strong><small>{spec([e.kindLabel, e.mailing, `holds title for ${o.name}`])}</small></span>
                  {o.id && network.anchor.type !== 'owner' ? <Icon name="chevron-right" size={13} /> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </LCInspectorSection>

      {anchorProperty ? (
        <LCInspectorSection title="Debt & recorded documents">
          {!rec ? <None>Recorded documents were not captured for this property.</None> : (
            <>
              {/* every loan, lien, filing and sale is its own row — open one to read the whole record */}
              <span className="egdk-eyebrow">Open loans · {openMortgages.length}</span>
              {openMortgages.length === 0 ? <None>No open mortgage on record.</None> : (
                <ul className="egdk-list">
                  {openMortgages.map((m) => (
                    <RecordRow key={m.slot} dot="is-debt"
                      title={m.lender ?? 'Lender not recorded'}
                      sub={spec([m.position ? `${m.position === 1 ? '1st' : m.position === 2 ? '2nd' : `${m.position}th`} position` : null, m.loanType, m.rate ? `${m.rate}%` : null, m.privateLender ? 'private lender' : null])}
                      num={m.balance !== null ? fmtMoney(m.balance) : fmtMoney(m.amount)} numHint={m.balance !== null ? 'balance' : m.amount !== null ? 'original' : 'amount not recorded'}
                      facts={[['Lender', m.lender], ['Position', m.position ? String(m.position) : null], ['Original amount', m.amount !== null ? fmtMoney(m.amount) : null], ['Est. balance', m.balance !== null ? fmtMoney(m.balance) : null], ['Est. payment', m.payment !== null ? `${fmtMoney(m.payment)}/mo` : null], ['Rate', m.rate ? `${m.rate}%` : null], ['Loan type', m.loanType], ['Financing', m.financing], ['Term', m.termMonths ? `${m.termMonths} months` : null], ['Recorded', day(m.recorded)], ['Matures', day(m.due)], ['Private lender', m.privateLender ? 'Yes' : null]]} />
                  ))}
                </ul>
              )}
              {(() => {
                // liens (lien + judgment classes) apart from every other recorded filing
                const liens = rec.liens.filter((l) => l.isLien ?? true)
                const filings = rec.liens.filter((l) => l.isLien === false)
                const docFacts = (l: typeof rec.liens[number]): Array<[string, string | null]> => [['Document', l.label], ['Category', l.category], ['Title', l.title], ['Description', l.description], ['Amount due', l.amountDue !== null ? fmtMoney(l.amountDue) : null], ['Recorded', day(l.recorded)], ['Party 1', l.party1], ['Party 2', l.party2], ['HOA', l.hoaName], ['Default amount', l.defaultAmount !== null ? fmtMoney(l.defaultAmount) : null], ['Date of death', day(l.dateOfDeath)], ['Tax period', l.taxPeriod ? l.taxPeriod.filter(Boolean).map((x) => day(x)).join(' – ') : null], ['County', l.county]]
                return (
                  <>
                    <span className="egdk-eyebrow">Liens & foreclosure · {liens.length + rec.foreclosures.length}</span>
                    {liens.length || rec.foreclosures.length ? (
                      <ul className="egdk-list">
                        {rec.foreclosures.map((f, i) => (
                          <RecordRow key={`fc${i}`} dot="is-alert" alert title={f.stage ?? 'Foreclosure'} sub={spec([f.auctionDate ? `auction ${day(f.auctionDate)}` : null, f.lender])}
                            num={fmtMoney(f.unpaidBalance)} numHint={f.unpaidBalance !== null ? 'unpaid' : ''}
                            facts={[['Stage', f.stage], ['Recorded', day(f.recorded)], ['Default date', day(f.defaultDate)], ['Auction', spec([day(f.auctionDate), f.auctionTime, f.auctionLocation])], ['Case', f.caseNumber], ['Unpaid balance', f.unpaidBalance !== null ? fmtMoney(f.unpaidBalance) : null], ['Opening bid', f.minBid !== null ? fmtMoney(f.minBid) : null], ['Lender', f.lender], ['Original loan', f.originalLoan !== null ? fmtMoney(f.originalLoan) : null], ['Trustee', f.trustee], ['Borrower', f.borrower]]} />
                        ))}
                        {liens.map((l) => (
                          <RecordRow key={l.id} dot={l.distress ? 'is-alert' : 'is-lien'} alert={l.distress} title={l.label} sub={spec([day(l.recorded), l.party1, l.county])}
                            num={l.amountDue !== null ? fmtMoney(l.amountDue) : ''} numHint={l.amountDue !== null ? 'due' : ''} facts={docFacts(l)} />
                        ))}
                      </ul>
                    ) : <None>No liens or foreclosure filings on record.</None>}
                    {filings.length ? (
                      <>
                        <span className="egdk-eyebrow">Other recorded filings · {filings.length} · not liens</span>
                        <ul className="egdk-list">
                          {filings.map((l) => (
                            <RecordRow key={l.id} dot={l.distress ? 'is-alert' : 'is-record'} alert={l.distress} title={l.label} sub={spec([day(l.recorded), l.party1, l.county])}
                              num={l.amountDue !== null ? fmtMoney(l.amountDue) : ''} numHint={l.amountDue !== null ? 'stated amount' : ''} facts={docFacts(l)} />
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </>
                )
              })()}
            </>
          )}
          {anchorProperty.repairReference ? (
            /* valuation lanes (owner, BINDING): repairs exist only in the MLS ARV lane —
               never in the SFR investor-cluster value; a vendor reference, collapsed */
            <details className="egdk-lane">
              <summary>MLS ARV lane · vendor reference</summary>
              <p className="egdk-line"><span>Vendor repair estimate</span>{fmtMoney(anchorProperty.repairReference.value)} · {anchorProperty.repairReference.label}</p>
              <small className="egdk-none">A flat vendor $/sqft tier × building sqft ({anchorProperty.repairReference.lane === 'sfr' ? 'single family' : '2–4 units'}); not an input to the investor-cluster value or any offer shown here.</small>
            </details>
          ) : null}
        </LCInspectorSection>
      ) : (
        <LCInspectorSection title="Portfolio debt">
          <p className="egdk-spec">{spec([`${network.debt.withDebt} of ${network.debt.properties} with a loan balance on file`, network.debt.blendedLtv !== null ? `blended LTV ${network.debt.blendedLtv}%` : null, network.debt.activeLiens ? `${network.debt.activeLiens} active liens` : null, network.debt.taxDelinquent ? `${network.debt.taxDelinquent} tax delinquent` : null])}</p>
          <None>Recorded mortgages and liens open per property — select one to read its documents.</None>
        </LCInspectorSection>
      )}

      <LCInspectorSection title={`Transactions · ${(rec?.sales.length ?? 0) || network.history.length}`}>
        {rec && rec.sales.length ? (
          <ul className="egdk-list">
            {rec.sales.map((s) => (
              <RecordRow key={s.id} dot="is-sale"
                title={`${day(s.date) ?? 'Date not recorded'}${s.current ? ' · last sale' : ''}`}
                sub={spec([s.docType, s.buyerName ? `to ${s.buyerName}` : null, s.sellerName ? `from ${s.sellerName}` : null, s.cash ? 'cash' : null])}
                num={s.price ? fmtMoney(s.price) : '—'}
                numHint={s.price && anchorProperty?.value && s.price > anchorProperty.value * 4 ? 'price ≫ value · bulk / multi-parcel?' : s.price && anchorProperty?.value && s.price < anchorProperty.value * 0.1 ? 'nominal price' : ''}
                facts={[['Date', day(s.date)], ['Price', s.price ? fmtMoney(s.price) : null], ['Document', s.docType], ['Buyer', spec([s.buyerName, s.buyer2Name])], ['Seller', spec([s.sellerName, s.seller2Name])], ['Cash', s.cash === true ? 'Yes' : s.cash === false ? 'No' : null], ["Arm's length", s.armsLength === false ? 'No' : s.armsLength === true ? 'Yes' : null], ['Price note', s.priceNote], ['Lender', s.lender], ['Loan amount', s.loanAmount ? fmtMoney(s.loanAmount) : null], ['Buyer match', s.buyer ? spec([s.buyer.name, s.buyer.basis ? `by ${s.buyer.basis}` : null]) : null]]}
                action={s.buyer?.id && onOpenBuyer ? <button type="button" className="egdk-link" onClick={() => onOpenBuyer(s.buyer!.id)}>Open buyer</button> : undefined} />
            ))}
          </ul>
        ) : network.history.length ? (
          <ul className="egdk-list">
            {network.history.slice(0, 8).map((s) => (
              <li key={s.id} className="egdk-row is-static">
                <span className={cx('egdk-dot', 'is-sale')} aria-hidden="true" />
                <span className="egdk-row__main"><strong>{s.address ?? 'Address not recorded'}</strong><small>{spec([day(s.date), s.buyer ? `to ${s.buyer}` : null, s.source])}</small></span>
                <span className="egdk-row__num"><b>{fmtMoney(s.price)}</b></span>
              </li>
            ))}
          </ul>
        ) : <None>No recorded transfers for this network.</None>}
      </LCInspectorSection>

      <LCInspectorSection title={`Related owners · ${network.related.length}`}>
        {network.related.length === 0 ? <None>No owner shares this household, owner cluster or mailing address.</None> : (
          <ul className="egdk-list">
            {network.related.map((r) => (
              <li key={r.id}>
                <button type="button" className="egdk-row" onClick={() => onOpen({ type: 'owner', id: r.id })}>
                  <span className={cx('egdk-dot', 'is-related')} aria-hidden="true" />
                  <span className="egdk-row__main"><strong>{r.name}</strong><small>{r.reasons.map((x) => REASON_LABEL[x] ?? x).join(' · ')}</small></span>
                  <span className="egdk-row__num"><b>{fmtCount(r.propertyCount)}</b><small>{r.propertyCount === 1 ? 'property' : 'properties'}</small></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </LCInspectorSection>

      <LCInspectorSection title={`Conversations · ${network.outreach.threads.length}`}>
        {network.outreach.threads.length === 0 ? <None>{network.outreach.lastSend ? `No conversation yet · last send ${network.outreach.lastSend.status} ${day(network.outreach.lastSend.at) ?? ''}` : 'No conversation with this network yet.'}</None> : (
          <ul className="egdk-list">
            {network.outreach.threads.map((t) => (
              <li key={t.threadKey}>
                <button type="button" className="egdk-row" onClick={() => openInboxThread({ threadKey: t.threadKey })}>
                  <span className={cx('egdk-dot', t.hot ? 'is-attn' : 'is-thread')} aria-hidden="true" />
                  <span className="egdk-row__main"><strong>{t.stage ? t.stage.replace(/_/g, ' ') : 'Conversation'}</strong><small>{t.preview ?? ''}</small></span>
                  <span className="egdk-row__num"><small>{day(t.at) ?? ''}</small></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </LCInspectorSection>

    </div>
  )
}

/** One recorded item (loan, lien, filing, foreclosure, sale): a row that opens to its whole record. */
function RecordRow({ dot, alert, title, sub, num, numHint, facts, action }: { dot: string; alert?: boolean; title: string; sub?: string; num?: string; numHint?: string; facts: Array<[string, string | null | undefined]>; action?: ReactNode }) {
  const shown = facts.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== '—')
  return (
    <li className={cx('egdk-recrow', alert && 'is-alert')}>
      <details>
        <summary className="egdk-row">
          <span className={cx('egdk-dot', dot)} aria-hidden="true" />
          <span className="egdk-row__main"><strong>{title}</strong>{sub ? <small>{sub}</small> : null}</span>
          <span className="egdk-row__num">{num ? <b>{num}</b> : null}{numHint ? <small>{numHint}</small> : null}</span>
          <Icon name="chevron-down" size={12} />
        </summary>
        <dl className="egdk-recrow__facts">
          {shown.length ? shown.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>) : <div><dt>Record</dt><dd>No further fields recorded</dd></div>}
        </dl>
        {action ? <div className="egdk-recrow__action">{action}</div> : null}
      </details>
    </li>
  )
}

function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className={cx('egdk-figure', tone && `is-${tone}`)}>
      <span className="egdk-figure__label">{label}</span>
      <b className="egdk-figure__value">{value}</b>
      {hint ? <span className="egdk-figure__hint">{hint}</span> : null}
    </div>
  )
}

function ContactLine({ icon, value, meta, warn, onClick }: { icon: 'phone' | 'mail'; value: string; meta: string; warn?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <Icon name={icon} size={12} />
      <span className="egdk-contact__value">{value}</span>
      <small>{meta}</small>
    </>
  )
  // a contact point opens its person's network
  return onClick
    ? <button type="button" className={cx('egdk-contact', 'is-link', warn && 'is-warn')} onClick={onClick}>{body}</button>
    : <div className={cx('egdk-contact', warn && 'is-warn')}>{body}</div>
}

/**
 * OUTREACH & PIPELINE — last contact, stage, status, SMS eligibility (+ the
 * blocking reason: the campaign target builder's own readiness rule), the
 * latest message and campaign membership. A network shows the roll-up.
 */
const RESOLUTION_LABEL: Record<string, string> = { resolved_owner: 'Resolved owner', graph_person: 'Graph person · no phone', linked_unresolved: 'Linked · unresolved' }

function OutreachSection({ anchorProperty, ids, states, onAddToCampaign, onOpenPerson }: { anchorProperty: NetworkProperty | null; ids: string[]; states: Map<string, OutreachState | null>; onAddToCampaign?: () => void; onOpenPerson?: (prospectId: string) => void }) {
  const loaded = ids.filter((id) => states.has(id))
  const list = loaded.map((id) => states.get(id)).filter((x): x is OutreachState => Boolean(x))
  const aside = onAddToCampaign ? <button type="button" className="egdk-link" onClick={onAddToCampaign}>Add to campaign</button> : null
  if (!loaded.length) {
    return (
      <LCInspectorSection title="Outreach & pipeline" aside={aside}>
        <LCSkeleton shape="lines" count={2} label="Reading outreach state" />
      </LCInspectorSection>
    )
  }
  if (anchorProperty) {
    const st = states.get(anchorProperty.id) ?? null
    return (
      <LCInspectorSection title="Outreach & pipeline" aside={aside}>
        {!st ? <None>Outreach state is not available for this property.</None> : (
          <div className="egdk-outreach">
            <div className={cx('egdk-outreach__sms', st.sms ? (st.sms.eligible ? 'is-ok' : 'is-blocked') : 'is-na')}>
              <span className="egdk-outreach__k">SMS eligible</span>
              <strong>{st.sms ? (st.sms.eligible ? 'Yes' : 'No') : 'Not available'}</strong>
              {st.sms && !st.sms.eligible ? <small>{st.entityContact?.requiresReview && st.sms.reason === 'entity_contact_requires_review' ? 'The entity’s contact needs role review — candidate below' : st.contactCandidates && st.contactCandidates.phones > 0 && ['missing_phone', 'NO_PHONE', 'not_in_campaign_audience', 'missing_identity_linkage'].includes(st.sms.reason ?? '') ? 'The campaign graph has no phone for this property — candidates below' : smsReasonLabel(st.sms.reason)}</small> : st.sms ? <small>{`${st.sms.ready} of ${st.sms.rows} contact ${st.sms.rows === 1 ? 'route' : 'routes'} ready`}</small> : null}
            </div>
            {st.entityContact ? (
              /* the entity's candidate contact (display only; eligibility stays the campaign graph's) */
              <div className="egdk-outreach__cands">
                <p className="egdk-outreach__candhead">
                  {`Entity contact${st.entityContact.entityName ? ` · ${st.entityContact.entityName}` : ''}`}
                  <small>Role: {st.entityContact.roleLabel}</small>
                </p>
                <ul>
                  <li>
                    <span className={cx('egdk-tag', st.entityContact.requiresReview ? 'is-attn' : 'is-ok')}>{st.entityContact.requiresReview ? 'Needs review' : 'Resolved'}</span>
                    <strong>{st.entityContact.person ?? 'No person identified'}</strong>
                    <small>{spec([st.entityContact.phoneMasked ? `${st.entityContact.phoneMasked} · ${st.entityContact.phoneCallable ? 'callable' : 'not callable'}` : 'no phone selected', st.entityContact.hasEmail ? (st.entityContact.emailUsable ? 'email usable' : 'email on file') : null, st.entityContact.entityStatus])}</small>
                  </li>
                  {st.entityContact.reviewReasons.map((r) => <li key={r.code}><small>{r.label}</small></li>)}
                </ul>
              </div>
            ) : null}
            <dl className="egdk-outreach__facts">
              <div><dt>Last contact</dt><dd>{lastContactLabel(st.lastContact) ?? 'Never contacted'}</dd></div>
              {/* pipeline and conversation apart — two different vocabularies */}
              <div><dt>Pipeline</dt><dd>{(() => { const p = st.pipeline !== undefined ? st.pipeline : st.stage?.source === 'pipeline' ? { stage: st.stage.value, status: st.status?.source === 'pipeline' ? st.status.value : null } : null; return p ? spec([humanize(p.stage), p.status ? humanize(p.status) : null]) || 'Deal' : 'No deal' })()}</dd></div>
              <div><dt>Conversation</dt><dd>{(() => { const c = st.conversationState !== undefined ? st.conversationState : st.stage?.source === 'conversation' ? { stage: st.stage.value, status: st.status?.source === 'conversation' ? st.status.value : null } : null; return c ? spec([humanize(c.stage), c.status ? humanize(c.status) : null]) || 'Open' : 'No conversation' })()}</dd></div>
              <div><dt>Campaigns</dt><dd>{st.campaigns ? (st.campaigns.count ? `${st.campaigns.latest?.name ?? 'Campaign'}${st.campaigns.count > 1 ? ` +${st.campaigns.count - 1}` : ''}` : 'Not in a campaign') : '—'}{st.campaigns?.latest?.targetStatus ? <small>{humanize(st.campaigns.latest.targetStatus)}{st.campaigns.latest.blockReason ? ` · ${smsReasonLabel(st.campaigns.latest.blockReason)}` : ''}</small> : null}</dd></div>
            </dl>
            {st.contactCandidates && st.contactCandidates.phones > 0 ? (
              <div className="egdk-outreach__cands">
                <p className="egdk-outreach__candhead">
                  {`${st.contactCandidates.phones} phone ${st.contactCandidates.phones === 1 ? 'candidate' : 'candidates'} on linked people`}
                  <small>Evidence only — not in the campaign graph, so not SMS-eligible until the graph resolves them.</small>
                </p>
                <ul>
                  {st.contactCandidates.candidates.map((c) => (
                    <li key={`${c.name}:${c.phones.map((p) => p.masked).join()}`}>
                      <span className={cx('egdk-tag', c.resolution === 'linked_unresolved' ? 'is-attn' : 'is-ok')}>{RESOLUTION_LABEL[c.resolution]}</span>
                      {/* a candidate is a person: open their network */}
                      {c.prospectId && onOpenPerson ? <button type="button" className="egdk-link" onClick={() => onOpenPerson(c.prospectId!)}><strong>{c.name}</strong></button> : <strong>{c.name}</strong>}
                      <small>{c.phones.map((p) => spec([p.masked, p.type === 'W' ? 'wireless' : p.type === 'L' ? 'landline' : p.type, p.score !== null ? `score ${p.score}` : null])).join(' · ')}</small>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {st.conversation?.preview ? (
              <blockquote className="egdk-outreach__msg">
                <span>{st.conversation.direction === 'inbound' ? 'Seller' : 'Us'} · {relativeDay(st.conversation.at)}</span>
                {st.conversation.preview}
              </blockquote>
            ) : null}
          </div>
        )}
      </LCInspectorSection>
    )
  }
  const eligible = list.filter((x) => x.sms?.eligible).length
  const latest = list.map((x) => x.lastContact).filter(Boolean).sort((a, b) => Date.parse(b!.at) - Date.parse(a!.at))[0] ?? null
  const deals = list.filter((x) => x.stage?.source === 'pipeline')
  const inCampaign = list.filter((x) => (x.campaigns?.count ?? 0) > 0).length
  return (
    <LCInspectorSection title="Outreach & pipeline" aside={aside}>
      <dl className="egdk-outreach__facts">
        <div><dt>SMS eligible</dt><dd>{`${fmtCount(eligible)} of ${fmtCount(loaded.length)} properties`}</dd></div>
        <div><dt>Last contact</dt><dd>{lastContactLabel(latest) ?? 'Never contacted'}</dd></div>
        <div><dt>Pipeline deals</dt><dd>{deals.length ? deals.map((d) => humanize(d.stage?.value)).slice(0, 3).join(', ') : 'None'}</dd></div>
        <div><dt>In a campaign</dt><dd>{`${fmtCount(inCampaign)} of ${fmtCount(loaded.length)}`}</dd></div>
      </dl>
    </LCInspectorSection>
  )
}

type ZipContext = { zip: string; sales90d: number | null; sales1y: number | null; investorShare1y: number | null; cashShare1y: number | null; medianPrice1y: number | null; medianPpsf1y: number | null; latestSale: string | null; buyers: number | null; activeBuyers: number | null; demographics: { medianIncome: number | null; population: number | null; renterRate: number | null; vacancyRate: number | null } | null }
const zipCache = new Map<string, ZipContext | null>()

/** ZIP market context — Market Intelligence rollup + buyers active in the zip (one keyed read). */
function ZipMarketSection({ zip }: { zip: string }) {
  const z5 = String(zip).slice(0, 5)
  const [state, setState] = useState<{ zip: string; data: ZipContext | null; done: boolean }>(() => ({ zip: z5, data: zipCache.get(z5) ?? null, done: zipCache.has(z5) }))
  useEffect(() => {
    if (zipCache.has(z5)) { setState({ zip: z5, data: zipCache.get(z5) ?? null, done: true }); return }
    const ctl = new AbortController()
    void callBackend<{ ok: boolean; zips: Record<string, ZipContext>; demographicsAvailable?: boolean }>(`/api/cockpit/entity-graph/zip-context?zips=${encodeURIComponent(z5)}&buyers=1`, { signal: ctl.signal })
      .then((res) => { if (ctl.signal.aborted) return; const d = res.ok ? res.data?.zips?.[z5] ?? null : null; zipCache.set(z5, d); setState({ zip: z5, data: d, done: true }) })
      .catch(() => { if (!ctl.signal.aborted) setState({ zip: z5, data: null, done: true }) })
    return () => ctl.abort()
  }, [z5])
  const d = state.zip === z5 ? state.data : null
  return (
    <LCInspectorSection title={`ZIP ${z5} market`}>
      {!state.done ? <LCSkeleton shape="lines" count={2} label="Reading the ZIP market" /> : !d || d.sales1y === null ? <None>No Market Intelligence rollup for this ZIP.</None> : (
        <>
          <div className="egdk-figures">
            <Figure label="Sales · 1y" value={fmtCount(d.sales1y)} hint={d.sales90d !== null ? `${fmtCount(d.sales90d)} in 90 days` : undefined} />
            <Figure label="Median price" value={fmtMoney(d.medianPrice1y)} hint={d.medianPpsf1y !== null ? `$${Math.round(d.medianPpsf1y)}/sqft` : undefined} />
            <Figure label="Active buyers" value={d.activeBuyers !== null ? fmtCount(d.activeBuyers) : '—'} hint={d.buyers !== null ? `${fmtCount(d.buyers)} bought here` : undefined} />
            <Figure label="Investor share" value={d.investorShare1y !== null ? `${d.investorShare1y}%` : '—'} hint={d.cashShare1y !== null ? `${d.cashShare1y}% cash` : undefined} />
          </div>
          <p className="egdk-spec">{spec([d.latestSale ? `latest sale ${day(d.latestSale)}` : null, d.demographics ? spec([d.demographics.medianIncome ? `median income ${fmtMoney(d.demographics.medianIncome)}` : null, d.demographics.renterRate !== null ? `${Math.round(d.demographics.renterRate)}% renters` : null]) : 'demographics: no census data loaded'])}</p>
        </>
      )}
    </LCInspectorSection>
  )
}
