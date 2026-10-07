/**
 * THE INSPECTOR — one network, read top-down: who controls it, what they own,
 * who can be reached and how sure the vendor match is, which entities hold
 * title, what is recorded against the property (debt, liens, transfers), and
 * who is related and why. Every fact is the network endpoint's (owner →
 * properties → people/phones/emails → entities → seller.* records); a value
 * the record does not carry says "not recorded", never a default.
 */
import { useMemo, type ReactNode } from 'react'
import { LCButton, LCError, LCInspector, LCInspectorSection, LCSkeleton, cx } from '../../../shared/lc'
import { Icon } from '../../../shared/icons'
import type { EntityGraphAction, UniversalEntityContext } from '../../../domain/entity-graph/entity-graph.types'
import { EMPTY_UNIVERSAL_ENTITY_CONTEXT } from '../../../domain/entity-graph/universal-entity-context'
import { buildEntityGraphActions } from '../../../domain/entity-graph/entity-graph-actions'
import { openInboxThread } from '../../mobile/mobile-inbox-bridge'
import { REASON_LABEL, type EntityNetwork, type NetworkProperty } from '../console/entity-network-api'
import { DeskGraph } from './DeskGraph'
import { fmtCount, fmtMoney, matchingTagTone, type NetworkAnchor } from './desk-model'

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
  onRetry: () => void
  onClose: () => void
  onOpen: (anchor: NetworkAnchor) => void
  onOpenGraph: () => void
  onAction?: (action: EntityGraphAction, context: UniversalEntityContext) => void
  onOpenBuyer?: (buyerId: string) => void
}

/** equity_known_v1: free & clear, a known %, a vendor class, or Unknown — never a vendor 100%. */
const equityText = (p: Pick<NetworkProperty, 'equityPct' | 'equityRule'>) => (
  p.equityRule === 'free_and_clear' ? 'Free & clear'
    : p.equityRule === 'loan_and_value' && p.equityPct !== null ? `${Math.round(p.equityPct)}%`
      : p.equityRule === 'vendor_high_equity_flag' ? 'High (flag)'
        : p.equityRule === 'vendor_low_equity_flag' ? 'Low (flag)' : 'Unknown'
)
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

export function DeskInspector({ open, mode, anchor, network, loading, error, onRetry, onClose, onOpen, onOpenGraph, onAction, onOpenBuyer }: Props) {
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
        <LCError what="The relationship network didn’t load" onRetry={onRetry} compact />
      ) : (
        <InspectorBody network={network} anchorProperty={anchorProperty} onOpen={onOpen} onOpenGraph={onOpenGraph} onOpenBuyer={onOpenBuyer} />
      )}
    </LCInspector>
  )
}

function InspectorBody({ network, anchorProperty, onOpen, onOpenGraph, onOpenBuyer }: { network: EntityNetwork; anchorProperty: NetworkProperty | null; onOpen: (a: NetworkAnchor) => void; onOpenGraph: () => void; onOpenBuyer?: (id: string) => void }) {
  const o = network.owner
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
        <div className="egdk-figures">
          <Figure label="Est. value" value={fmtMoney(anchorProperty.value)} />
          <Figure label="Equity" value={equityText(anchorProperty)} hint={anchorProperty.equity !== null ? fmtMoney(anchorProperty.equity) : anchorProperty.equityRule?.startsWith('vendor') ? 'vendor class · no loan data' : 'no loan on file'} />
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
                <span className="egdk-row__num"><b>{fmtMoney(p.value)}</b><small>{equityText(p) === 'Unknown' ? 'equity unknown' : `${equityText(p)}${p.equityRule === 'loan_and_value' ? ' equity' : ''}`}</small></span>
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
                <small>{spec([person.role, person.language, person.occupation])}</small>
              </button>
              <div className="egdk-tags" aria-label="Contact matching tags">
                {(person.matchingTags ?? []).length ? (person.matchingTags ?? []).map((t) => (
                  <span key={t} className={cx('egdk-tag', `is-${matchingTagTone(t)}`)}>{t}</span>
                )) : <span className="egdk-tag is-none">No matching tag</span>}
              </div>
              {(phonesByPerson.get(person.id) ?? []).map((ph) => <ContactLine key={ph.id} icon="phone" value={ph.display} meta={spec([ph.type, ph.active, ph.wrongNumber ? 'wrong number' : null])} warn={ph.wrongNumber} />)}
              {(emailsByPerson.get(person.id) ?? []).map((em) => <ContactLine key={em.id} icon="mail" value={em.value} meta="Email" />)}
            </li>
          ))}
          {loosePhones.length ? (
            <li className="egdk-person">
              <span className="egdk-person__head is-static"><span className={cx('egdk-dot', 'is-contact')} aria-hidden="true" /><strong>Owner contact methods</strong><small>not tied to a person</small></span>
              {loosePhones.map((ph) => <ContactLine key={ph.id} icon="phone" value={ph.display} meta={spec([ph.type, ph.active, ph.wrongNumber ? 'wrong number' : null])} warn={ph.wrongNumber} />)}
            </li>
          ) : null}
        </ul>
      </LCInspectorSection>

      <LCInspectorSection title={`Title entities · ${network.entities.length}`}>
        {network.entities.length === 0 ? <None>Title is held in the owner’s own name — no separate entity on record.</None> : (
          <ul className="egdk-list">
            {network.entities.map((e) => (
              <li key={e.id} className="egdk-row is-static">
                <span className={cx('egdk-dot', 'is-entity')} aria-hidden="true" />
                <span className="egdk-row__main"><strong>{e.name}</strong><small>{spec([e.kindLabel, e.mailing])}</small></span>
              </li>
            ))}
          </ul>
        )}
      </LCInspectorSection>

      {anchorProperty ? (
        <LCInspectorSection title="Debt & recorded documents">
          {!rec ? <None>Recorded documents were not captured for this property.</None> : (
            <>
              {openMortgages.length === 0 ? <None>No open mortgage on record.</None> : (
                <ul className="egdk-list">
                  {openMortgages.map((m) => (
                    <li key={m.slot} className="egdk-row is-static">
                      <span className={cx('egdk-dot', 'is-debt')} aria-hidden="true" />
                      <span className="egdk-row__main"><strong>{m.lender ?? 'Lender not recorded'}</strong><small>{spec([m.position ? `${m.position === 1 ? '1st' : m.position === 2 ? '2nd' : `${m.position}th`} position` : null, m.loanType, m.rate ? `${m.rate}%` : null, m.privateLender ? 'private lender' : null, day(m.recorded) ? `recorded ${day(m.recorded)}` : null])}</small></span>
                      <span className="egdk-row__num"><b>{m.balance !== null ? fmtMoney(m.balance) : fmtMoney(m.amount)}</b><small>{m.balance !== null ? 'balance' : m.amount !== null ? 'original' : 'amount not recorded'}</small></span>
                    </li>
                  ))}
                </ul>
              )}
              {rec.liens.length || rec.foreclosures.length ? (
                <ul className="egdk-list">
                  {rec.foreclosures.map((f, i) => (
                    <li key={`fc${i}`} className="egdk-row is-static is-alert">
                      <span className={cx('egdk-dot', 'is-alert')} aria-hidden="true" />
                      <span className="egdk-row__main"><strong>{f.stage ?? 'Foreclosure'}</strong><small>{spec([f.auctionDate ? `auction ${day(f.auctionDate)}` : null, f.lender, f.caseNumber ? `case ${f.caseNumber}` : null])}</small></span>
                      <span className="egdk-row__num"><b>{fmtMoney(f.unpaidBalance)}</b><small>{f.unpaidBalance !== null ? 'unpaid' : ''}</small></span>
                    </li>
                  ))}
                  {rec.liens.map((l) => (
                    <li key={l.id} className={cx('egdk-row', 'is-static', l.distress && 'is-alert')}>
                      <span className={cx('egdk-dot', l.distress ? 'is-alert' : 'is-lien')} aria-hidden="true" />
                      <span className="egdk-row__main"><strong>{l.label}</strong><small>{spec([day(l.recorded), l.party1, l.county])}</small></span>
                      <span className="egdk-row__num"><b>{l.amountDue !== null ? fmtMoney(l.amountDue) : ''}</b></span>
                    </li>
                  ))}
                </ul>
              ) : <None>No liens or filings on record.</None>}
            </>
          )}
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
              <li key={s.id} className="egdk-row is-static">
                <span className={cx('egdk-dot', 'is-sale')} aria-hidden="true" />
                <span className="egdk-row__main"><strong>{day(s.date) ?? 'Date not recorded'}{s.current ? ' · last sale' : ''}</strong><small>{spec([s.docType, s.buyerName ? `to ${s.buyerName}` : null, s.sellerName ? `from ${s.sellerName}` : null, s.cash ? 'cash' : null])}</small></span>
                <span className="egdk-row__num"><b>{s.price ? fmtMoney(s.price) : '—'}</b>{s.buyer?.id && onOpenBuyer ? <button type="button" className="egdk-link" onClick={() => onOpenBuyer(s.buyer!.id)}>Buyer</button> : null}</span>
              </li>
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

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="egdk-figure">
      <span className="egdk-figure__label">{label}</span>
      <b className="egdk-figure__value">{value}</b>
      {hint ? <span className="egdk-figure__hint">{hint}</span> : null}
    </div>
  )
}

function ContactLine({ icon, value, meta, warn }: { icon: 'phone' | 'mail'; value: string; meta: string; warn?: boolean }) {
  return (
    <div className={cx('egdk-contact', warn && 'is-warn')}>
      <Icon name={icon} size={12} />
      <span className="egdk-contact__value">{value}</span>
      <small>{meta}</small>
    </div>
  )
}
