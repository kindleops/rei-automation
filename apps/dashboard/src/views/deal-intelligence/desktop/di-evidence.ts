/**
 * THE EVIDENCE INDEX — every family of evidence on one page, and every fact
 * labelled by what KIND of fact it is. Pure.
 *
 * Basis (never mixed in one figure):
 *   recorded   county / provider record or MLS (a fact someone recorded)
 *   seller     the seller said it in the conversation
 *   modeled    the decision engine computed it (value, offer, selected comps)
 *   estimated  a provider estimate (AVM, equity, loan balances, repairs)
 *   inferred   derived by a rule from other facts (extractor inference,
 *              owner-of-record investor tier, no-later-transfer link)
 *
 * "Source evidence" = recorded + seller. "Inference" = modeled + estimated +
 * inferred. The index exists so the operator can see which half a number
 * stands on before trusting it.
 */
import { usd } from './di-format'
import type { DiDecision, DiMode } from './di-types'

export type EvidenceBasis = 'recorded' | 'seller' | 'modeled' | 'estimated' | 'inferred'
export const SOURCE_BASES: readonly EvidenceBasis[] = ['recorded', 'seller']
export const isSourceBasis = (b: EvidenceBasis) => b === 'recorded' || b === 'seller'

export const BASIS_LABEL: Record<EvidenceBasis, string> = {
  recorded: 'Recorded',
  seller: 'Seller said',
  modeled: 'Engine',
  estimated: 'Estimate',
  inferred: 'Inferred',
}

export interface LedgerRow {
  key: string
  label: string
  value: string
  basis: EvidenceBasis
  source: string
  mode: DiMode
}

const factBasis = (provenance: string, source: string): EvidenceBasis => {
  if (provenance === 'seller') return /inference|extract/i.test(source) && !/message\)?$/i.test(source) ? 'inferred' : 'seller'
  if (provenance === 'record' || provenance === 'mls') return 'recorded'
  return /estimate|avm/i.test(source) ? 'estimated' : 'inferred'
}

/** Every headline fact on the decision, labelled by its basis. */
export function evidenceLedger(d: DiDecision): LedgerRow[] {
  const rows: LedgerRow[] = []
  const add = (key: string, label: string, value: string | null, basis: EvidenceBasis, source: string, mode: DiMode) => {
    if (value) rows.push({ key, label, value, basis, source, mode })
  }
  const v = d.valuation
  const e = d.economics
  add('engine_value', 'Engine value', usd(v?.mid), 'modeled', 'Decision engine · weighted adjusted comps', 'model')
  add('offer', 'Recommended offer', usd(d.offer?.recommended), 'modeled', 'Decision engine · offer arithmetic', 'model')
  add('avm', 'AVM', usd(e.avm ?? v?.avm), 'estimated', 'Provider automated valuation', 'records')
  add('equity', 'Equity', e.equityPercent !== null ? `${Math.round(e.equityPercent)}%${e.equityEstimate !== null ? ` · ${usd(e.equityEstimate)}` : ''}` : null, 'estimated', 'Provider estimate (AVM − estimated balances)', 'debt')
  add('open_balance', 'Open loan balance', usd(e.debt.estOpenBalance), 'estimated', 'Provider balance estimate — not a payoff letter', 'debt')
  add('loans', 'Recorded loans', e.debt.mortgages.length ? `${e.debt.mortgages.length} current${e.debt.originalTotal ? ` · ${usd(e.debt.originalTotal)} original` : ''}` : null, 'recorded', 'County record · mortgages', 'debt')
  const liens = e.lienSummary?.liens ?? e.liens.length
  add('liens', 'Recorded liens', liens ? `${liens}${e.lienSummary?.statedAmount ? ` · ${usd(e.lienSummary.statedAmount)} stated` : ''}` : null, 'recorded', 'County record · classified instruments', 'debt')
  add('tax', 'Annual tax', e.tax.annual ? `${usd(e.tax.annual)}${e.tax.year ? ` (${e.tax.year})` : ''}${e.tax.delinquent ? ' · delinquent' : ''}` : null, 'recorded', 'Tax record', 'debt')
  const sale = d.history.find((h) => h.kind === 'sale')
  add('last_sale', 'Last recorded sale', sale ? `${usd(sale.amount) ?? 'price not recorded'} · ${sale.at.slice(0, 10)}` : null, 'recorded', 'County record · deed', 'market')
  if (d.comps) {
    add('comps_selected', 'Comps priced by the engine', `${d.comps.selected} of ${d.comps.raw ?? '—'} screened`, 'modeled', 'Engine selection over recorded sales', 'comps')
  }
  if (d.market?.ok) add('market', 'Nearby recorded sales', `${d.market.totals.sales} within ${d.market.radius.used} mi · median ${usd(d.market.overall.medianPrice) ?? '—'}`, 'recorded', 'Recorded sales, same asset family', 'market')
  for (const f of d.sellerFacts) add(`fact:${f.key}`, f.label, f.display, factBasis(f.provenance, f.source), f.source, 'seller')
  const primary = d.record.prospects.find((p) => p.primary) ?? d.record.prospects[0] ?? null
  if (primary) {
    add('age', 'Seller age', typeof primary.age === 'number' ? `${primary.age}` : null, 'recorded', 'Vendor person record (birth month) · display only, never priced', 'seller')
    add('language', 'Seller language', primary.language ?? null, 'recorded', 'Vendor person record', 'seller')
    const cs = primary.contactScore
    add('contact_score', 'Contact score', typeof cs === 'number' ? `${cs}/100` : null, 'estimated', 'Skip-trace vendor score (0–120, shown 0–100)', 'seller')
  }
  if (d.conversation) add('signal', 'Conversation signal', `${d.conversation.band.replace('_', ' ')} · ${d.conversation.score ?? '—'}/100`, 'inferred', 'Deterministic read of the messages', 'seller')
  return rows
}

export interface FamilyCard {
  mode: DiMode
  label: string
  headline: string
  count: number | null
  bases: EvidenceBasis[]
  /** the family has nothing to show */
  empty: boolean
}

/** One card per evidence family for the index (Comps · Seller · Debt · Market & transactions · Records). */
export function familyCards(d: DiDecision, fallbackComps: number | null = null): FamilyCard[] {
  const e = d.economics
  const ledger = evidenceLedger(d)
  const basesOf = (mode: DiMode, extra: EvidenceBasis[] = []) => [...new Set([...ledger.filter((r) => r.mode === mode).map((r) => r.basis), ...extra])]
  const sales = d.history.filter((h) => h.kind === 'sale' || h.kind === 'mortgage' || h.kind === 'lien' || h.kind === 'foreclosure').length
  const liens = e.lienSummary?.liens ?? e.liens.length
  const recordFields = d.record.sections.reduce((s, x) => s + x.fields.length, 0)
  const comps = d.comps
  return [
    {
      mode: 'comps', label: 'Comparable sales',
      headline: comps && comps.selected ? `${comps.selected} priced by the engine of ${comps.raw ?? '—'} screened` : fallbackComps ? `Not analyzed — ${fallbackComps} recorded nearby sales` : 'Not analyzed — no comps priced yet',
      count: comps?.selected ?? fallbackComps, bases: comps ? ['recorded', 'modeled'] : ['recorded'], empty: !comps?.selected && !fallbackComps,
    },
    {
      mode: 'seller', label: 'Seller',
      headline: d.sellerFacts.length ? `${d.sellerFacts.length} facts · ${d.sellerFacts.filter((f) => f.provenance === 'seller').length} said by the seller` : d.record.prospects.length ? `${d.record.prospects.length} people linked to the owner` : 'Nothing captured yet',
      count: d.sellerFacts.length, bases: basesOf('seller'), empty: !d.sellerFacts.length && !d.record.prospects.length && !d.conversation,
    },
    {
      mode: 'debt', label: 'Debt & liens',
      headline: [e.debt.estOpenBalance ? `${usd(e.debt.estOpenBalance)} est. open` : e.debt.mortgages.length ? `${e.debt.mortgages.length} current loan${e.debt.mortgages.length === 1 ? '' : 's'}` : 'No current loans recorded', liens ? `${liens} lien${liens === 1 ? '' : 's'}` : null, e.tax.delinquent ? 'tax delinquent' : null].filter(Boolean).join(' · '),
      count: e.debt.mortgages.length + liens, bases: basesOf('debt'), empty: false,
    },
    {
      mode: 'market', label: 'Market & transactions',
      headline: [
        d.market?.ok ? `${d.market.totals.sales} nearby sales within ${d.market.radius.used} mi · median ${usd(d.market.overall.medianPrice) ?? '—'}` : 'Nearby sales unavailable',
        sales ? `${sales} recorded event${sales === 1 ? '' : 's'} on this property` : 'no recorded events on this property',
      ].join(' · '),
      count: d.market?.ok ? d.market.totals.sales : sales || null, bases: ['recorded'], empty: !d.market?.ok && !sales,
    },
    {
      mode: 'records', label: 'Records',
      headline: recordFields ? `${recordFields} populated fields · parcel, owner, people` : 'No parcel record fields',
      count: recordFields, bases: ['recorded', 'estimated'], empty: !recordFields,
    },
  ]
}

/** The primary person's display-only identity facts (age is never a pricing input). */
export function sellerIdentityFacts(d: DiDecision): { age: number | null; language: string | null; contactScore: number | null } {
  const p = d.record.prospects.find((x) => x.primary) ?? d.record.prospects[0] ?? null
  return {
    age: typeof p?.age === 'number' ? p.age : null,
    language: p?.language ?? null,
    contactScore: typeof p?.contactScore === 'number' ? Math.max(0, Math.min(100, p.contactScore)) : null,
  }
}
