/**
 * PROPERTY DOSSIER — one parcel, everything the system knows about it.
 *
 * Progressive disclosure, in the order an acquisitions operator asks:
 *   what is it (hero) → who holds it (owner, and whether they also buy) →
 *   what is it worth / owe (value, equity, debt) → what is wrong with it
 *   (signals) → how did it get here (ownership chain) → what is recorded
 *   against it (mortgages, liens, foreclosure) → every other field.
 *
 * Buyer / seller parties on a sale carry their evidence: Resolved (registry /
 * engine link) is drawn solid, Observed-by-name dashed, Inferred faint. A
 * natural-person buyer is never named by the intelligence layer — the deed's
 * own public-record name is shown, and the entity pill reads "Individual buyer".
 */
import { useMemo, useState, type ReactNode } from 'react'
import { propertyObject, showOnMap } from '../../desktop/objects'
import { researchProperty } from '../../browser/research-launch'
import { Icon, type IconName } from '../../../shared/icons'
import { CountUp } from '../../../shared/motion/CountUp'
import type {
  ContactLadderEntry,
  EntityGraphAction,
  EntityGraphDossier,
  EntitySearchResult,
} from '../../../domain/entity-graph/entity-graph.types'
import type { EntityGraphActionItem } from '../../../domain/entity-graph/entity-graph-actions'
import {
  EVIDENCE_LABEL,
  evidenceTierFor,
  type LienRecord,
  type MortgageRecord,
  type PartyRef,
  type PropertyRecords,
  type SaleRecord,
} from '../../../domain/entity-graph/entity-graph-intel-api'
import { DossierHero } from './DossierHero'
import {
  buildDetailGroups,
  day,
  money,
  monthYear,
  num,
  pct,
  text,
  titleCase,
  year,
  yearsSince,
  type DetailGroup,
  type Row,
} from './dossier-format'
import './dossier.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export type PropertyDossierProps = {
  result: EntitySearchResult
  dossier: EntityGraphDossier | null
  loading: boolean
  actions: EntityGraphActionItem[]
  onAction: (action: EntityGraphAction) => void
  onOpenEntity: (entityType: string, entityId: string) => void
  onOpenBuyer: (buyerId: string) => void
  onOpenGraph: () => void
}

/* ── Primitives ───────────────────────────────────────────────────────── */

function Section({
  id,
  icon,
  label,
  meta,
  tone,
  defaultOpen = false,
  children,
}: {
  id: string
  icon: IconName
  label: string
  meta?: ReactNode
  tone?: 'debt' | 'alert' | 'chain' | 'owner'
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={cls('egd-sec', open && 'is-open', tone && `is-${tone}`)} data-section={id}>
      <button type="button" className="egd-sec__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="egd-sec__icon"><Icon name={icon} /></span>
        <span className="egd-sec__label">{label}</span>
        {meta !== undefined && meta !== null ? <span className="egd-sec__meta">{meta}</span> : null}
        <span className="egd-sec__chev"><Icon name="chevron-down" /></span>
      </button>
      <div className="egd-sec__body" hidden={!open}>{open ? children : null}</div>
    </section>
  )
}

function Fact({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className={cls('egd-fact', strong && 'is-strong')}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/** An entity on a relationship, with its evidence drawn into the border. */
function PartyPill({
  party,
  deedName,
  role,
  onOpenBuyer,
}: {
  party: PartyRef | null
  deedName: string | null
  role: 'buyer' | 'seller' | 'owner'
  onOpenBuyer: (id: string) => void
}) {
  if (!party) {
    return deedName ? <span className="egd-party is-plain">{deedName}</span> : <span className="egd-party is-plain is-muted">Not recorded</span>
  }
  const tier = evidenceTierFor(party)
  const person = party.kind === 'person'
  const name = person ? (deedName ?? 'Individual') : (party.name ?? deedName ?? 'Company')
  const bits = [
    person ? 'Individual buyer' : null,
    party.purchases ? `${party.purchases} purchase${party.purchases === 1 ? '' : 's'}` : null,
    party.status === 'active' ? 'Active' : null,
  ].filter(Boolean)
  return (
    <button
      type="button"
      className={cls('egd-party', `is-${tier}`, `is-${role}`)}
      onClick={() => onOpenBuyer(party.id)}
      title={`${EVIDENCE_LABEL[tier]}${party.method ? ` · ${party.method}` : ''}`}
    >
      <span className="egd-party__dot" aria-hidden="true" />
      <span className="egd-party__body">
        <span className="egd-party__name">{name}</span>
        {bits.length ? <span className="egd-party__meta">{bits.join(' · ')}</span> : null}
      </span>
      <span className="egd-party__tier">{EVIDENCE_LABEL[tier]}</span>
    </button>
  )
}

function Skeleton() {
  return (
    <div className="egd-skel" aria-label="Loading property">
      <div className="egd-skel__hero" />
      <div className="egd-skel__row"><i /><i /><i /></div>
      <div className="egd-skel__bar" />
      <div className="egd-skel__bar is-short" />
      <div className="egd-skel__card" />
      <div className="egd-skel__card" />
    </div>
  )
}

/* ── Signals ──────────────────────────────────────────────────────────── */

type Signal = { key: string; label: string; tone: 'alert' | 'warn' | 'info' | 'good' }

function buildSignals(summary: Row, records: PropertyRecords | null | undefined): Signal[] {
  const out: Signal[] = []
  const push = (s: Signal) => { if (!out.some((x) => x.key === s.key)) out.push(s) }
  for (const f of records?.foreclosures ?? []) {
    push({ key: 'fc', label: f.auctionDate ? `Auction ${monthYear(f.auctionDate)}` : (titleCase(f.stage) ?? 'Foreclosure'), tone: 'alert' })
  }
  const cats = new Set((records?.liens ?? []).map((l) => l.category))
  if (cats.has('PROBATE')) push({ key: 'probate', label: 'Probate', tone: 'alert' })
  if (cats.has('LIS PENDENS')) push({ key: 'lp', label: 'Lis pendens', tone: 'alert' })
  if ((records?.liens ?? []).some((l) => l.dateOfDeath) || cats.has('AFFIDAVIT OF DEATH')) push({ key: 'death', label: 'Death record', tone: 'warn' })
  if ((records?.liens ?? []).some((l) => l.defaultAmount)) push({ key: 'nod', label: 'Notice of default', tone: 'alert' })
  if (summary.tax_delinquent === true || text(summary.tax_delinquent) === 'true') {
    push({ key: 'tax', label: num(summary.tax_delinquent_year) ? `Tax delinquent since ${num(summary.tax_delinquent_year)}` : 'Tax delinquent', tone: 'warn' })
  }
  if (cats.has('JUDGMENT')) push({ key: 'judgment', label: 'Judgment', tone: 'warn' })
  if (cats.has('MECHANICS LIEN')) push({ key: 'mech', label: "Mechanic's lien", tone: 'warn' })
  if (cats.has('STATE TAX LIEN')) push({ key: 'taxlien', label: 'Tax lien', tone: 'warn' })
  if ((records?.mortgages ?? []).some((m) => m.open && m.privateLender)) push({ key: 'private', label: 'Private lender', tone: 'info' })
  if ((records?.mortgages ?? []).some((m) => m.open && m.financing && /variable|adjust/i.test(m.financing))) push({ key: 'arm', label: 'Adjustable rate', tone: 'info' })
  if (records && records.totals.openMortgages === 0 && records.mortgages.length === 0 && (num(summary.total_loan_balance) ?? 0) <= 0) push({ key: 'free', label: 'No recorded mortgage', tone: 'good' })
  if (summary.out_of_state_owner === true) push({ key: 'absentee', label: 'Out-of-state owner', tone: 'info' })
  if (summary.is_corporate_owner === true) push({ key: 'corp', label: 'Company-owned', tone: 'info' })
  const mls = text(summary.mls_market_status)
  if (mls && /active|pending|contingent/i.test(mls)) push({ key: 'mls', label: `MLS ${mls.toLowerCase()}`, tone: 'info' })
  const years = num(summary.ownership_years)
  if (years !== null && years >= 15) push({ key: 'tenure', label: `Owned ${Math.round(years)} yrs`, tone: 'good' })
  return out
}

/* ── Ownership chain ──────────────────────────────────────────────────── */

function salePrice(sale: SaleRecord): { label: string; muted: boolean } {
  if (sale.price && sale.price > 0) return { label: money(sale.price, { compact: sale.price >= 1e6 }) ?? '', muted: false }
  if (sale.armsLength === false || /non-arms/i.test(sale.priceNote ?? '')) return { label: 'Non-arms-length transfer', muted: true }
  return { label: 'Price not disclosed', muted: true }
}

function OwnershipChain({
  sales,
  ownerName,
  ownerBuyer,
  onOpenBuyer,
  onOpenOwner,
}: {
  sales: SaleRecord[]
  ownerName: string | null
  ownerBuyer: PartyRef | null
  onOpenBuyer: (id: string) => void
  onOpenOwner: (() => void) | null
}) {
  const ordered = [...sales].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
  const heldSince = ordered[0]?.date ?? null
  const held = yearsSince(heldSince)
  return (
    <ol className="egd-chain">
      <li className="egd-chain__now">
        <span className="egd-chain__rail" aria-hidden="true"><i /></span>
        <div className="egd-chain__card is-owner">
          <div className="egd-chain__when">
            <strong>Today</strong>
            <span>Current owner{held !== null ? ` · held ${held < 1 ? '< 1 yr' : `${Math.floor(held)} yr${Math.floor(held) === 1 ? '' : 's'}`}` : ''}</span>
          </div>
          {onOpenOwner ? (
            <button type="button" className="egd-party is-owner is-resolved" onClick={onOpenOwner}>
              <span className="egd-party__dot" aria-hidden="true" />
              <span className="egd-party__body">
                <span className="egd-party__name">{ownerName ?? 'Owner'}</span>
                <span className="egd-party__meta">Owner of record</span>
              </span>
              <span className="egd-party__tier"><Icon name="chevron-right" /></span>
            </button>
          ) : (
            <span className="egd-party is-plain">{ownerName ?? 'Owner not recorded'}</span>
          )}
          {ownerBuyer ? (
            <div className="egd-chain__also">
              <PartyPill party={ownerBuyer} deedName={ownerName} role="owner" onOpenBuyer={onOpenBuyer} />
            </div>
          ) : null}
        </div>
      </li>
      {ordered.map((sale, index) => {
        const price = salePrice(sale)
        const financed = sale.lender || sale.loanAmount
        return (
          <li key={sale.id} className="egd-chain__step" style={{ ['--i' as string]: index + 1 }}>
            <span className="egd-chain__rail" aria-hidden="true"><i /></span>
            <div className="egd-chain__card">
              <div className="egd-chain__when">
                <strong>{year(sale.date) ?? '—'}</strong>
                <span>{day(sale.date) ?? 'Date not recorded'}{sale.current ? ' · last sale' : ''}</span>
              </div>
              <div className={cls('egd-chain__price', price.muted && 'is-muted')}>{price.label}</div>
              <div className="egd-chain__tags">
                {sale.docType ? <span>{titleCase(sale.docType)}</span> : null}
                {sale.cash === true ? <span className="is-cash">Cash</span> : null}
                {financed ? <span className="is-financed">Financed{sale.lender ? ` · ${sale.lender}` : ''}{sale.loanAmount ? ` · ${money(sale.loanAmount)}` : ''}</span> : null}
                {sale.armsLength === false && sale.price ? <span>Non-arms-length</span> : null}
              </div>
              <div className="egd-chain__parties">
                <div className="egd-chain__party">
                  <em>Seller</em>
                  <PartyPill party={sale.seller} deedName={sale.sellerName} role="seller" onOpenBuyer={onOpenBuyer} />
                </div>
                <span className="egd-chain__arrow" aria-hidden="true"><Icon name="chevron-down" /></span>
                <div className="egd-chain__party">
                  <em>Buyer</em>
                  <PartyPill party={sale.buyer} deedName={sale.buyerName} role="buyer" onOpenBuyer={onOpenBuyer} />
                </div>
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/* ── Debt ─────────────────────────────────────────────────────────────── */

const ordinal = (n: number | null) => (n === null ? null : n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`)

function MortgageCard({ m, index }: { m: MortgageRecord; index: number }) {
  const paid = m.amount && m.balance !== null && m.amount > 0 ? Math.max(0, Math.min(1, 1 - m.balance / m.amount)) : null
  return (
    <article className={cls('egd-loan', !m.open && 'is-history')} style={{ ['--i' as string]: index }}>
      <header>
        <div>
          <strong>{m.lender ?? 'Lender not recorded'}</strong>
          <span>{[ordinal(m.position) ? `${ordinal(m.position)} position` : null, titleCase(m.loanType), titleCase(m.financing)].filter(Boolean).join(' · ') || 'Recorded mortgage'}</span>
        </div>
        {m.rate ? <b className="egd-loan__rate">{m.rate.toFixed(m.rate % 1 ? 2 : 0)}<small>%</small></b> : null}
      </header>
      {m.open && (m.balance !== null || m.amount !== null) ? (
        <div className="egd-loan__meter">
          <div className="egd-loan__nums">
            <span><em>Est. balance</em>{money(m.balance) ?? '—'}</span>
            <span><em>Original</em>{money(m.amount) ?? '—'}</span>
          </div>
          {paid !== null ? (
            <div className="egd-loan__track" role="img" aria-label={`${Math.round(paid * 100)}% paid down`}>
              <i style={{ width: `${Math.max(2, paid * 100)}%` }} />
            </div>
          ) : null}
          {paid !== null ? <small>{Math.round(paid * 100)}% paid down</small> : null}
        </div>
      ) : null}
      <dl className="egd-facts is-tight">
        {!m.open ? <Fact label="Amount" value={money(m.amount)} /> : null}
        <Fact label="Payment" value={m.payment ? `${money(m.payment, { compact: false })}/mo` : null} />
        <Fact label="Recorded" value={day(m.recorded)} />
        <Fact label="Matures" value={day(m.due)} />
        <Fact label="Term" value={m.termMonths ? `${Math.round(m.termMonths / 12 * 10) / 10} yrs` : null} />
      </dl>
      {m.privateLender ? <span className="egd-badge is-info">Private lender</span> : null}
    </article>
  )
}

function LienCard({ l, index }: { l: LienRecord; index: number }) {
  return (
    <article className={cls('egd-lien', l.distress && 'is-distress')} style={{ ['--i' as string]: index }}>
      <header>
        <span className="egd-lien__glyph"><Icon name={l.distress ? 'alert' : 'file-text'} /></span>
        <div>
          <strong>{l.label}</strong>
          <span>{[day(l.recorded), l.county ? `${l.county} County` : null].filter(Boolean).join(' · ') || 'Recorded notice'}</span>
        </div>
        {l.amountDue ? <b>{money(l.amountDue)}</b> : null}
      </header>
      <dl className="egd-facts is-tight">
        <Fact label="Document" value={l.title ?? l.description} />
        <Fact label="Party" value={l.party1} />
        <Fact label="Counterparty" value={l.party2} />
        <Fact label="HOA" value={l.hoaName} />
        <Fact label="Default amount" value={money(l.defaultAmount, { compact: false })} />
        <Fact label="Date of death" value={day(l.dateOfDeath)} />
        <Fact label="Tax period" value={l.taxPeriod ? [day(l.taxPeriod[0]), day(l.taxPeriod[1])].filter(Boolean).join(' – ') : null} />
      </dl>
    </article>
  )
}

/* ── Details ──────────────────────────────────────────────────────────── */

function DetailGroups({ groups }: { groups: DetailGroup[] }) {
  const [q, setQ] = useState('')
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set(['building']))
  const query = q.trim().toLowerCase()
  const shown = query
    ? groups.map((g) => ({ ...g, fields: g.fields.filter((f) => f.label.toLowerCase().includes(query) || f.key.includes(query) || f.value.toLowerCase().includes(query)) })).filter((g) => g.fields.length)
    : groups
  const total = groups.reduce((n, g) => n + g.fields.length, 0)
  return (
    <div className="egd-details">
      <label className="egd-find">
        <Icon name="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${total} fields…`} type="search" aria-label="Search property fields" />
        {q ? <button type="button" onClick={() => setQ('')} aria-label="Clear">×</button> : null}
      </label>
      {shown.length === 0 ? <p className="egd-empty">No field matches “{q}”.</p> : shown.map((group) => {
        const open = Boolean(query) || openKeys.has(group.key)
        return (
          <div key={group.key} className={cls('egd-group', open && 'is-open')}>
            <button
              type="button"
              className="egd-group__head"
              aria-expanded={open}
              onClick={() => setOpenKeys((cur) => { const next = new Set(cur); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next })}
            >
              <span>{group.label}</span>
              <small>{group.fields.length}</small>
              <Icon name="chevron-down" />
            </button>
            {open ? (
              <dl className="egd-facts">
                {group.fields.map((f) => <Fact key={f.key} label={f.label} value={f.value} />)}
              </dl>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/* ── People & contact ─────────────────────────────────────────────────── */

function ContactRow({ entry, onOpenEntity }: { entry: ContactLadderEntry; onOpenEntity: (t: string, id: string) => void }) {
  const state = entry.wrongNumber ? 'Wrong number' : entry.optedOut ? 'Opted out' : entry.suppressed ? 'Suppressed' : entry.eligible ? 'Reachable' : 'Not eligible'
  return (
    <button type="button" className={cls('egd-row', !entry.eligible && 'is-dim')} onClick={() => onOpenEntity(entry.type, entry.id)}>
      <span className="egd-row__icon"><Icon name={entry.type === 'phone' ? 'phone' : 'mail'} /></span>
      <span className="egd-row__body">
        <strong>{entry.value}</strong>
        <small>{[state, entry.phoneType, entry.relationship].filter(Boolean).join(' · ')}</small>
      </span>
      <Icon name="chevron-right" />
    </button>
  )
}

/* ── The dossier ──────────────────────────────────────────────────────── */

const PRIMARY_KEYS = new Set<EntityGraphAction>(['add_to_campaign', 'open_in_map', 'show_on_map', 'open_buyer_match'])

export function PropertyDossier({
  result,
  dossier,
  loading,
  actions,
  onAction,
  onOpenEntity,
  onOpenBuyer,
  onOpenGraph,
}: PropertyDossierProps) {
  const summary = useMemo(() => (dossier?.summary ?? {}) as Row, [dossier])
  const records: PropertyRecords | null | undefined = dossier ? (dossier.records ?? null) : undefined
  const parcel = (records?.parcel ?? null) as Row | null
  const groups = useMemo(() => buildDetailGroups(dossier ? summary : null, parcel), [dossier, summary, parcel])

  if (loading && !dossier) return <div className="egd"><Skeleton /></div>

  const d = result.details ?? {}
  const address = text(summary.property_address_full)?.split(',')[0] ?? result.title
  const locality = [text(summary.property_address_city) ?? d.city, text(summary.property_address_state) ?? d.state, text(summary.property_address_zip) ?? d.zip]
    .filter(Boolean).map((s) => titleCase(String(s))).join(', ').replace(/, ([A-Z][a-z])$/, (m) => m.toUpperCase())
  const lat = num(summary.latitude)
  const lng = num(summary.longitude)

  const chips = [
    text(summary.property_type) ?? d.assetType ?? null,
    num(summary.units_count) && (num(summary.units_count) as number) > 1 ? `${num(summary.units_count)} units` : null,
    num(summary.total_bedrooms) ? `${num(summary.total_bedrooms)} bd` : null,
    num(summary.total_baths) ? `${num(summary.total_baths)} ba` : null,
    num(summary.building_square_feet) ? `${(num(summary.building_square_feet) as number).toLocaleString()} sq ft` : null,
    num(summary.year_built) ? `Built ${num(summary.year_built)}` : null,
  ].filter(Boolean) as string[]

  const owner = (dossier?.owner ?? null) as Row | null
  const ownerId = text(owner?.master_owner_id) ?? text(summary.master_owner_id)
  const ownerName = titleCase(text(owner?.display_name) ?? text(summary.owner_display_name) ?? text(summary.owner_name))
  const mailing = titleCase(text(summary.owner_address_full) ?? text(owner?.primary_owner_address))
  // Every owner bought this property once; the buyer role only means
  // something for a REPEAT buyer or one still acquiring.
  const rawOwnerBuyer = records?.ownerBuyer ?? null
  const ownerBuyer = rawOwnerBuyer && ((rawOwnerBuyer.purchases ?? 0) >= 2 || rawOwnerBuyer.status === 'active') ? rawOwnerBuyer : null

  const value = num(summary.estimated_value) ?? d.value ?? null
  const equityPct = num(summary.equity_percent) ?? (typeof d.equity === 'number' ? d.equity : null)
  const equityAmt = num(summary.equity_amount)
  const balance = records?.totals.balance ?? num(summary.total_loan_balance)
  const payment = records?.totals.payment ?? num(summary.total_loan_payment)
  const signals = buildSignals(summary, records)

  const openMortgages = (records?.mortgages ?? []).filter((m) => m.open)
  const priorMortgages = (records?.mortgages ?? []).filter((m) => !m.open)
  const liens = records?.liens ?? []
  const sales = records?.sales ?? []
  const foreclosures = records?.foreclosures ?? []

  const people = (dossier?.prospects ?? []) as Row[]
  const phones = dossier?.contactLadder?.phones ?? []
  const emails = dossier?.contactLadder?.emails ?? []
  const portfolio: Row[] = Array.isArray(dossier?.portfolio) ? (dossier?.portfolio as unknown as Row[]) : []
  const related = portfolio.filter((p) => text(p.property_id) !== result.entityId)
  const secondary = actions.filter((a) => !PRIMARY_KEYS.has(a.key) && a.key !== 'open_workflow_studio')
  const ringPct = equityPct === null ? null : Math.max(0, Math.min(100, equityPct))

  // [8.2] Show on Map focuses the Map (beside, or in place when it is open) — Entity Graph stays put
  const showMap = () => {
    if (!result.entityId) { onAction('open_in_map'); return }
    showOnMap(propertyObject({ propertyId: result.entityId, label: address ?? null, source: 'entity-graph', lat: typeof lat === 'number' ? lat : null, lng: typeof lng === 'number' ? lng : null }), { source: 'entity-graph' })
  }

  return (
    <div className="egd">
      <DossierHero address={address} locality={locality || null} lat={lat} lng={lng} chips={chips} onOpenMap={showMap} onResearch={result.entityId ? () => { researchProperty({ kind: 'property', id: result.entityId!, label: address ?? null }) } : null} />

      {/* ── Owner ── */}
      <div className="egd-owner egd-rise" style={{ ['--i' as string]: 1 }}>
        <button
          type="button"
          className="egd-owner__main"
          disabled={!ownerId}
          onClick={() => ownerId && onOpenEntity('master_owner', ownerId)}
        >
          <span className="egd-owner__avatar" aria-hidden="true">{(ownerName ?? '?').trim().charAt(0)}</span>
          <span className="egd-owner__body">
            <em>Owner of record</em>
            <strong>{ownerName ?? 'Owner not recorded'}</strong>
            {mailing ? <small>{summary.out_of_state_owner === true ? 'Out of state · ' : ''}Mail to {mailing}</small> : null}
          </span>
          {ownerId ? <Icon name="chevron-right" /> : null}
        </button>
        {ownerBuyer ? (
          <button type="button" className={cls('egd-alsobuyer', `is-${evidenceTierFor(ownerBuyer)}`)} onClick={() => onOpenBuyer(ownerBuyer.id)}>
            <Icon name="zap" />
            <span>
              Also a buyer
              {ownerBuyer.purchases ? ` · ${ownerBuyer.purchases} purchase${ownerBuyer.purchases === 1 ? '' : 's'}` : ''}
              {ownerBuyer.sold ? ` · ${ownerBuyer.sold} sold` : ''}
            </span>
            <em>{EVIDENCE_LABEL[evidenceTierFor(ownerBuyer)]}</em>
          </button>
        ) : null}
      </div>

      {/* ── Value ── */}
      <div className="egd-value egd-rise" style={{ ['--i' as string]: 2 }}>
        <div className="egd-value__main">
          <em>Estimated value</em>
          <strong><CountUp value={value} format={(v) => money(v) ?? '—'} /></strong>
          <div className="egd-value__grid">
            <span><em>Equity</em><b>{equityAmt !== null ? <CountUp value={equityAmt} format={(v) => money(v) ?? '—'} /> : '—'}</b></span>
            <span><em>Owed</em><b>{balance !== null ? <CountUp value={balance} format={(v) => money(v) ?? '—'} /> : '—'}</b></span>
            <span><em>Payment</em><b>{payment ? `${money(payment)}/mo` : '—'}</b></span>
          </div>
        </div>
        <div className="egd-ring" role="img" aria-label={ringPct === null ? 'Equity unknown' : `${Math.round(ringPct)}% equity`}>
          <svg viewBox="0 0 88 88" aria-hidden="true">
            <defs>
              <linearGradient id="egd-ring-g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--egd-cyan)" />
                <stop offset="100%" stopColor="var(--egd-aqua)" />
              </linearGradient>
            </defs>
            <circle cx="44" cy="44" r="36" className="egd-ring__track" />
            {ringPct !== null ? (
              <circle cx="44" cy="44" r="36" className="egd-ring__arc" pathLength={100} style={{ strokeDasharray: `${ringPct} 100` }} />
            ) : null}
          </svg>
          <span className="egd-ring__label">
            <b>{equityPct === null ? '—' : <CountUp value={equityPct} format={(v) => `${Math.round(v)}%`} />}</b>
            <small>equity</small>
          </span>
        </div>
      </div>

      {signals.length ? (
        <div className="egd-signals egd-rise" style={{ ['--i' as string]: 3 }}>
          {signals.map((s) => <span key={s.key} className={`is-${s.tone}`}>{s.label}</span>)}
        </div>
      ) : null}

      {records === null ? (
        <div className="egd-unavailable">
          <Icon name="alert-circle" />
          <span>Recorded documents (mortgages, liens, sale history) are unavailable right now.</span>
        </div>
      ) : null}

      {/* ── Ownership chain ── */}
      {records && (sales.length > 0 || ownerName) ? (
        <Section
          id="chain"
          icon="link"
          label="Ownership history"
          tone="chain"
          meta={sales.length ? `${sales.length} sale${sales.length === 1 ? '' : 's'}` : 'No recorded sales'}
          defaultOpen
        >
          <OwnershipChain
            sales={sales}
            ownerName={ownerName}
            ownerBuyer={ownerBuyer}
            onOpenBuyer={onOpenBuyer}
            onOpenOwner={ownerId ? () => onOpenEntity('master_owner', ownerId) : null}
          />
        </Section>
      ) : null}

      {/* ── Debt ── */}
      {records && records.mortgages.length > 0 ? (
        <Section
          id="debt"
          icon="dollar-sign"
          label="Mortgages"
          tone="debt"
          meta={openMortgages.length ? `${openMortgages.length} open · ${money(records.totals.balance) ?? '—'}` : 'None open'}
          defaultOpen
        >
          <div className="egd-stack">
            {openMortgages.map((m, i) => <MortgageCard key={m.slot} m={m} index={i} />)}
            {priorMortgages.length ? (
              <details className="egd-prior">
                <summary>Prior financing · {priorMortgages.length}</summary>
                <div className="egd-stack">
                  {priorMortgages.map((m, i) => <MortgageCard key={m.slot} m={m} index={i} />)}
                </div>
              </details>
            ) : null}
          </div>
        </Section>
      ) : null}

      {/* ── Liens ── */}
      {liens.length > 0 ? (
        <Section
          id="liens"
          icon="file-text"
          label="Liens & recorded notices"
          tone={liens.some((l) => l.distress) ? 'alert' : undefined}
          meta={`${liens.length}${records?.totals.distressLiens ? ` · ${records.totals.distressLiens} distress` : ''}`}
          defaultOpen={liens.some((l) => l.distress)}
        >
          <div className="egd-stack">{liens.map((l, i) => <LienCard key={l.id} l={l} index={i} />)}</div>
        </Section>
      ) : null}

      {/* ── Foreclosure ── */}
      {foreclosures.length > 0 ? (
        <Section id="fc" icon="alert" label="Foreclosure" tone="alert" meta={titleCase(foreclosures[0].stage) ?? undefined} defaultOpen>
          <div className="egd-stack">
            {foreclosures.map((f, i) => (
              <article key={`${f.recorded}-${i}`} className="egd-lien is-distress">
                <header>
                  <span className="egd-lien__glyph"><Icon name="alert" /></span>
                  <div>
                    <strong>{titleCase(f.stage) ?? 'Foreclosure filing'}</strong>
                    <span>{[day(f.recorded) ? `Recorded ${day(f.recorded)}` : null, f.caseNumber ? `Case ${f.caseNumber}` : null].filter(Boolean).join(' · ')}</span>
                  </div>
                  {f.unpaidBalance ? <b>{money(f.unpaidBalance)}</b> : null}
                </header>
                <dl className="egd-facts is-tight">
                  <Fact label="Auction" value={[day(f.auctionDate), f.auctionTime].filter(Boolean).join(' · ') || null} strong />
                  <Fact label="Location" value={f.auctionLocation} />
                  <Fact label="Default date" value={day(f.defaultDate)} />
                  <Fact label="Minimum bid" value={money(f.minBid, { compact: false })} />
                  <Fact label="Lender" value={f.lender} />
                  <Fact label="Original loan" value={money(f.originalLoan, { compact: false })} />
                  <Fact label="Trustee" value={[f.trustee, f.trusteePhone].filter(Boolean).join(' · ') || null} />
                  <Fact label="Borrower" value={f.borrower} />
                </dl>
              </article>
            ))}
          </div>
        </Section>
      ) : null}

      {/* ── People & contact ── */}
      {people.length + phones.length + emails.length > 0 ? (
        <Section id="people" icon="users" label="People & contact" tone="owner" meta={`${people.length} people · ${phones.length + emails.length} contacts`}>
          <div className="egd-rows">
            {people.slice(0, 6).map((p) => (
              <button key={String(p.prospect_id)} type="button" className="egd-row" onClick={() => onOpenEntity('prospect', String(p.prospect_id))}>
                <span className="egd-row__icon is-person"><Icon name="user" /></span>
                <span className="egd-row__body">
                  <strong>{titleCase(text(p.full_name)) ?? 'Linked person'}</strong>
                  <small>{[p.likely_owner ? 'Likely owner' : null, text(p.language_preference), text(p.occupation_group)].filter(Boolean).join(' · ') || 'Linked person'}</small>
                </span>
                <Icon name="chevron-right" />
              </button>
            ))}
            {phones.slice(0, 5).map((e) => <ContactRow key={e.id} entry={e} onOpenEntity={onOpenEntity} />)}
            {emails.slice(0, 3).map((e) => <ContactRow key={e.id} entry={e} onOpenEntity={onOpenEntity} />)}
          </div>
        </Section>
      ) : null}

      {related.length > 0 ? (
        <Section id="related" icon="home" label="Same owner's other properties" meta={related.length}>
          <div className="egd-rows">
            {related.slice(0, 8).map((p) => (
              <button key={String(p.property_id)} type="button" className="egd-row" onClick={() => onOpenEntity('property', String(p.property_id))}>
                <span className="egd-row__icon"><Icon name="home" /></span>
                <span className="egd-row__body">
                  <strong>{text(p.property_address_full)?.split(',')[0] ?? String(p.property_id)}</strong>
                  <small>{[titleCase(text(p.property_address_city)), money(num(p.estimated_value)), num(p.equity_percent) !== null ? `${pct(num(p.equity_percent))} equity` : null].filter(Boolean).join(' · ')}</small>
                </span>
                <Icon name="chevron-right" />
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      {/* ── Every field ── */}
      {groups.length ? (
        <Section id="details" icon="grid" label="Property details" meta={`${groups.reduce((n, g) => n + g.fields.length, 0)} fields`}>
          <DetailGroups groups={groups} />
        </Section>
      ) : null}

      {secondary.length ? (
        <div className="egd-more">
          {secondary.map((a) => (
            <button key={a.key} type="button" className="egd-chipbtn" disabled={a.disabled} title={a.hint} onClick={() => onAction(a.key)}>
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" className="egd-graphlink" onClick={onOpenGraph}>
        <Icon name="layers" />
        <span>See this property's relationship graph</span>
        <Icon name="arrow-up-right" />
      </button>
    </div>
  )
}

/** The sticky primary bar — rendered as the sheet footer. */
export function PropertyDossierActionBar({
  actions,
  onAction,
  onOpenGraph,
}: {
  actions: EntityGraphActionItem[]
  onAction: (action: EntityGraphAction) => void
  onOpenGraph: () => void
}) {
  const campaign = actions.find((a) => a.key === 'add_to_campaign')
  const buyerMatch = actions.find((a) => a.key === 'open_buyer_match')
  return (
    <div className="egd-bar">
      <button type="button" className="egd-bar__primary" disabled={campaign?.disabled} title={campaign?.hint} onClick={() => onAction('add_to_campaign')}>
        <Icon name="send" />
        <span>Campaign</span>
      </button>
      <button type="button" className="egd-bar__btn" onClick={() => onAction('open_in_map')} aria-label="Open in Map">
        <Icon name="map" />
        <span>Map</span>
      </button>
      <button type="button" className="egd-bar__btn" disabled={buyerMatch?.disabled} onClick={() => onAction('open_buyer_match')} aria-label="Buyer Match">
        <Icon name="users" />
        <span>Buyers</span>
      </button>
      <button type="button" className="egd-bar__btn" onClick={onOpenGraph} aria-label="Relationship graph">
        <Icon name="layers" />
        <span>Graph</span>
      </button>
    </div>
  )
}
