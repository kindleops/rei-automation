import type { ReactNode } from 'react'
import { cx, LCButton, LCInspector, LCInspectorSection, LCStatus } from '../../../../shared/lc'
import { InteractiveStreetViewPanorama } from '../../../../modules/deal-intelligence/InteractiveStreetViewPanorama'
import { staticStreetViewUrl } from '../../../../modules/entity-graph/mobile/EntityGraphPropertyVisual'
import { ago, dateShort, dateTime, humanize, int, usd } from '../di-format'
import type { DiLinks } from '../di-links'
import {
  availableOf, compStats, fieldNature, monthsSince, recordCategories, snapshotRows,
  type ConfidenceModel, type EvidenceGap, type GateView, type OfferFigures,
} from '../di-model'
import type { DiSubject } from '../di-subject'
import type { DiDecision, DiMode, DiSelection } from '../di-types'
import { Facts, Prov, Tag } from '../di-ui'
import { saleTypeOfDealComp } from '../../../../domain/comp-intelligence/comp-sale-type'
import { CompStreetView } from '../../../comp-intelligence/desktop/CompStreetView'
import { SaleTypeBadge, SaleTypeEvidence } from '../../../comp-intelligence/desktop/SaleType'

export interface DiInspectorProps {
  d: DiDecision
  mode: DiMode
  selection: DiSelection | null
  onSelect: (s: DiSelection) => void
  onClear: () => void
  open: boolean
  onClose: () => void
  dock: boolean
  /** what the inspector shows with nothing selected (Decision: Prospect Intelligence) */
  defaultContent: ReactNode
  defaultTitle: string
  figures: OfferFigures
  gates: GateView[]
  conf: ConfidenceModel | null
  gaps: EvidenceGap[]
  links: DiLinks | null
  now: number
  onOpenMode: (m: DiMode) => void
  onUnderwrite: (s: DiSubject) => void
}

interface View { eyebrow: string; title: ReactNode; label: string; subtitle?: ReactNode; status?: ReactNode; body: ReactNode; actions?: ReactNode }

/**
 * THE CONTEXTUAL INSPECTOR — the same spatial component for a marker, a
 * gate, a comp, a seller fact, a recorded document, a loan, a field, a
 * snapshot, a strategy… only the content changes. With nothing selected it
 * shows the mode's context (Decision: Prospect Intelligence) — never blank.
 */
export function DiInspector(p: DiInspectorProps) {
  const view = p.selection ? viewFor(p, p.selection) : null
  const fallback: View = view ?? defaultView(p)
  return (
    <LCInspector
      id="deal-intelligence"
      open={p.open}
      onClose={p.onClose}
      mode={p.dock ? 'dock' : 'float'}
      width={p.dock ? 420 : 400}
      minWidth={340}
      maxWidth={620}
      eyebrow={fallback.eyebrow}
      title={fallback.title}
      label={fallback.label}
      subtitle={fallback.subtitle}
      status={fallback.status}
      actions={fallback.actions}
      contentKey={p.selection ? JSON.stringify(p.selection) : `default-${p.mode}`}
      back={view && p.dock ? { label: p.defaultTitle, onBack: p.onClear } : undefined}
      className="dr-insp"
    >
      {fallback.body}
    </LCInspector>
  )
}

/* ── defaults per mode ─────────────────────────────────────────────────── */

function defaultView(p: DiInspectorProps): View {
  const d = p.d
  if (p.mode === 'decision') return { eyebrow: 'Context', title: p.defaultTitle, label: p.defaultTitle, body: p.defaultContent }
  if (p.mode === 'model' || p.mode === 'scenario') {
    const oc = d.offer
    const inp = d.scenario?.inputs
    const cur = d.scenario?.current
    return {
      eyebrow: p.mode === 'model' ? 'Model provenance' : 'How the lab computes',
      title: `${humanize(d.lineage.engine) ?? 'Decision engine'} ${d.lineage.engineVersion ?? ''}`.trim(),
      label: 'Model provenance',
      body: (
        <>
          <LCInspectorSection title="Lineage">
            <Facts rows={[
              ['Engine', `${d.lineage.engine} ${d.lineage.engineVersion ?? ''}`],
              ['Margin policy', d.lineage.policyVersion],
              ['Last analyzed', d.lineage.computedAt ? `${dateTime(d.lineage.computedAt)} · ${ago(d.lineage.computedAt, p.now)}` : 'never'],
              ['Snapshots', `${d.lineage.snapshotCount}${d.lineage.snapshotMatchesProjection === false ? ' · latest ≠ projection' : ''}`],
              ['Offer snapshot', oc?.lineage.snapshotId ? oc.lineage.snapshotId.slice(0, 8) : null],
              ['Negotiation uses', oc?.lineage.negotiationSnapshotId ? (oc.lineage.negotiationUsesLatest ? 'this analysis' : oc.lineage.negotiationSnapshotId.slice(0, 8)) : null],
              ['Method', humanize(oc?.method)],
            ]} />
          </LCInspectorSection>
          {inp && cur ? (
            <LCInspectorSection title="The offer arithmetic">
              <ol className="dr-steps">
                <li><span>Exit ceiling</span><code>{usd(inp.valuation_mid)} × {inp.max_arv_factor} − {usd(inp.repairs)}</code><b className="lc-num">{usd(cur.valuation_ceiling)}</b></li>
                <li><span>Buyer ceiling</span><code>{inp.buyer_ceiling_authoritative ? 'min(exit, observed buyers)' : 'exit, only reduced by modeled demand'}</code><b className="lc-num">{usd(cur.effective_ceiling)}</b></li>
                <li><span>Market terms</span><code>−{cur.terms.confidence_haircut_pct}% confidence · −{cur.terms.motivation_discount_pct}% motivation · +{cur.terms.demand_premium_pct}% demand</code><b /></li>
                <li><span>Margin</span><code>target {usd(cur.target_margin)} ({Math.round(cur.margin_pct * 100)}%) · protected {usd(cur.protected_margin)}</code><b /></li>
                <li className="is-key"><span>Offer</span><code>ceiling × terms − target, capped at ceiling − protected, to $100</code><b className="lc-num">{usd(cur.recommended_offer)}</b></li>
                <li><span>Floor</span><code>offer − max($5K, 3% of value)</code><b className="lc-num">{usd(cur.minimum_offer)}</b></li>
              </ol>
              <p className="dr-quiet">{d.scenario?.replayable ? 'Replaying these recorded inputs reproduces the stored offer.' : d.scenario?.reason === 'replay_differs_from_stored' ? `Replaying these inputs gives ${usd(cur.recommended_offer)}; the stored offer came from earlier arithmetic.` : 'Replay not verified.'}</p>
            </LCInspectorSection>
          ) : <p className="dr-none">No replayable offer calculation on record.</p>}
        </>
      ),
    }
  }
  if (p.mode === 'record') {
    const cats = recordCategories(d)
    return {
      eyebrow: 'Record provenance',
      title: 'Where the record comes from',
      label: 'Record provenance',
      body: (
        <>
          <LCInspectorSection title="Sources">
            <Facts rows={[
              ['Parcel record', `${cats.reduce((s, c) => s + (c.key === 'transactions' ? 0 : c.count), 0)} populated fields`],
              ['Owner record', d.record.owner ? d.record.owner.name ?? 'linked' : 'none linked'],
              ['People', d.record.prospects.length ? `${d.record.prospects.length} linked to the owner` : 'none linked'],
              ['Recorded instruments', d.economics.lienSummary ? `${d.economics.lienSummary.liens} liens · ${d.economics.lienSummary.releases} releases · ${d.economics.lienSummary.documents} other` : null],
              ['Latest recorded loan', dateShort(d.freshness?.latestRecordedLoan, p.now)],
            ]} />
          </LCInspectorSection>
          <p className="dr-quiet">Only populated fields are shown. A $0 money field is “not recorded”, not zero. Estimates (AVM, equity, balances, repairs) are marked est.; everything else is as recorded by the provider.</p>
        </>
      ),
    }
  }
  // evidence
  const f = d.freshness
  return {
    eyebrow: 'Evidence freshness',
    title: 'How current each family is',
    label: 'Evidence freshness',
    body: (
      <>
        <LCInspectorSection title="Freshness">
          <Facts rows={[
            ['Decision', f?.decision ? `${dateShort(f.decision, p.now)} · ${ago(f.decision, p.now)}` : 'never analyzed'],
            ['Latest comp sale', dateShort(f?.latestCompSale, p.now)],
            ['Market sales through', dateShort(f?.marketDataThrough, p.now)],
            ['Last seller reply', f?.lastSellerReply ? ago(f.lastSellerReply, p.now) : null],
            ['Buyer Match run', f?.buyerMatchRun ? dateShort(f.buyerMatchRun, p.now) : 'never run'],
            ['Latest recorded loan', dateShort(f?.latestRecordedLoan, p.now)],
          ]} />
        </LCInspectorSection>
        <p className="dr-quiet">Select a comp, a fact, a loan or a recorded document to see its source, date and confidence.</p>
      </>
    ),
  }
}

/* ── per-selection views ───────────────────────────────────────────────── */

function viewFor(p: DiInspectorProps, s: DiSelection): View | null {
  const d = p.d
  switch (s.type) {
    case 'marker': return markerView(p, s.key)
    case 'gate': {
      const g = p.gates.find((x) => x.key === s.key)
      if (!g) return null
      return {
        eyebrow: 'Hard-offer gate', title: g.label, label: g.label,
        status: <LCStatus label={g.pass ? 'Passes' : 'Not met'} tone={g.pass ? 'ok' : 'attn'} />,
        body: (
          <>
            <LCInspectorSection title="Definition"><p className="dr-p">{g.definition}</p></LCInspectorSection>
            <LCInspectorSection title="Evaluation">
              <Facts rows={[
                ['Current value', g.current !== null && g.current !== undefined ? (g.unit === 'usd' ? usd(g.current, { exact: true }) : int(g.current)) : null],
                ['Required', g.threshold !== null && g.threshold !== undefined ? `${g.comparator === '>' ? '>' : '≥'} ${g.unit === 'usd' ? usd(g.threshold, { exact: true }) : int(g.threshold)}` : null],
                ['Gap', g.gapText],
                ['Source', <code key="s" className="dr-code">{g.source}</code>],
                g.legacy ? ['Rule', 'Earlier engine rule (fee vs target margin)'] : null,
              ]} />
            </LCInspectorSection>
            {g.why ? <LCInspectorSection title="Why it matters"><p className="dr-p">{g.why}</p></LCInspectorSection> : null}
            {g.change ? <LCInspectorSection title="What could change it"><p className="dr-p">{g.change}</p></LCInspectorSection> : null}
          </>
        ),
      }
    }
    case 'confidence': {
      const r = p.conf?.rows.find((x) => x.key === s.key)
      if (!r || !p.conf) return null
      return {
        eyebrow: 'Confidence component', title: r.label, label: r.label,
        status: p.conf.largest?.key === r.key ? <LCStatus label="Largest uncertainty" tone="attn" /> : undefined,
        body: (
          <>
            <Facts rows={[
              ['Score', r.score !== null ? `${r.score} / 100` : null],
              ['Weight in overall', `${Math.round(r.weight * 100)}%`],
              ['Contributes', r.contribution !== null ? `${r.contribution} pts` : null],
              ['Costs', r.lost !== null ? `${r.lost} pts below a perfect score` : null],
              ['Overall', p.conf.overall !== null ? `${p.conf.overall}${p.conf.uncapped !== null ? ` (uncapped ${p.conf.uncapped})` : ''}` : null],
            ]} />
            {r.notes.length ? <LCInspectorSection title="Evidence behind it"><ul className="dr-list">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul></LCInspectorSection> : null}
            {r.missing.length ? <LCInspectorSection title="Inputs missing"><ul className="dr-list">{r.missing.map((n) => <li key={n}>{n}</li>)}</ul></LCInspectorSection> : null}
            {p.conf.formula ? <p className="dr-quiet">{p.conf.formula}</p> : null}
          </>
        ),
      }
    }
    case 'comp': return compView(p, s.id)
    case 'fact': {
      const fact = d.sellerFacts.find((x) => x.key === s.key)
      if (!fact) return null
      return {
        eyebrow: 'Seller fact', title: fact.label, label: fact.label, subtitle: fact.display,
        status: <Prov p={fact.provenance} />,
        body: (
          <>
            <Facts rows={[
              ['Value', fact.display],
              ['Provenance', fact.provenance === 'seller' ? 'The seller said it' : fact.provenance === 'record' ? 'County / provider record' : 'Derived by the system'],
              ['Source', fact.source],
              ['Captured', fact.at ? dateTime(fact.at) : null],
              ['Confidence', fact.confidence !== null && fact.confidence !== undefined ? (fact.confidence <= 1 ? `${Math.round(fact.confidence * 100)}%` : String(fact.confidence)) : null],
              fact.extractor ? ['Extractor', fact.extractor] : null,
              fact.basis ? ['Basis', fact.basis] : null,
            ]} />
            {fact.quote ? <figure className="dr-statement"><figcaption><span className="dr-eyebrow">In the seller’s words</span></figcaption><blockquote>“{fact.quote}”</blockquote></figure> : null}
            {d.sellerFacts.filter((x) => x.label === fact.label && x.key !== fact.key).length ? (
              <LCInspectorSection title="Other sources for this fact">
                <ul className="dr-list">{d.sellerFacts.filter((x) => x.label === fact.label && x.key !== fact.key).map((x) => <li key={x.key}><Prov p={x.provenance} /> {x.display} <em>{x.source}</em></li>)}</ul>
                <p className="dr-quiet">Sources are shown side by side; none is picked over the other.</p>
              </LCInspectorSection>
            ) : null}
          </>
        ),
        actions: p.links?.conversation && fact.provenance === 'seller' ? <LCButton size="sm" variant="quiet" icon="message" onClick={p.links.conversation}>Conversation</LCButton> : undefined,
      }
    }
    case 'doc': {
      const doc = (d.economics.recordedDocuments ?? [])[s.index]
      if (!doc) return null
      const statusText = doc.status === 'lien' ? 'Recorded lien — no release in this record' : doc.status === 'release' ? 'Release / termination — not a lien' : doc.status === 'conflict' ? 'Descriptions conflict — not counted as a lien' : 'Recorded document — not debt'
      return {
        eyebrow: doc.kindLabel, title: doc.title, label: doc.title,
        status: <LCStatus label={statusText} tone={doc.status === 'lien' ? 'attn' : doc.status === 'conflict' ? 'attn' : 'neutral'} quiet={doc.status !== 'lien'} />,
        body: (
          <>
            <Facts rows={[
              ['Amount stated', doc.amount ? usd(doc.amount, { exact: true }) : 'No amount on the record'],
              ['Claimant', doc.claimant ?? (doc.parties.length ? 'Not asserted — party order varies for this kind' : null)],
              ['Parties on record', doc.parties.length ? doc.parties.join(' · ') : null],
              ['Recorded', doc.at ? dateShort(doc.at, p.now) : 'Not dated on the record'],
              ['Provider updated', doc.updatedAt ? dateShort(doc.updatedAt, p.now) : null],
              ['Type code', doc.typeCode ? `${doc.typeCode}${doc.typeDescription ? ` · ${doc.typeDescription}` : ''}` : null],
              doc.taxPeriod ? ['Tax period', `${dateShort(doc.taxPeriod.from, p.now) ?? '—'} – ${dateShort(doc.taxPeriod.to, p.now) ?? '—'}`] : null,
            ]} />
            {doc.conflict ? (
              <LCInspectorSection title="The record disagrees with itself">
                <Facts rows={[['Title says', doc.conflict.title], ['Type says', doc.conflict.type]]} />
                <p className="dr-quiet">Both readings are shown; neither is picked without a canonical resolution.</p>
              </LCInspectorSection>
            ) : null}
            <p className="dr-quiet">Source: county record via the provider (seller.property_lien). Classification: {doc.kindLabel.toLowerCase()} by the document’s own title and type code.</p>
          </>
        ),
      }
    }
    case 'loan': {
      const m = s.prior ? (d.economics.debt.priorMortgages ?? [])[s.index] : d.economics.debt.mortgages[s.index]
      if (!m) return null
      return {
        eyebrow: s.prior ? (m.kind === 'purchase' ? 'Purchase loan · history' : 'Prior loan · history') : `Current loan${m.position ? ` · position ${m.position}` : ''}`,
        title: m.lender ?? 'Lender not recorded', label: 'Loan',
        body: (
          <>
            <Facts rows={[
              ['Type', [m.type, m.financing].filter(Boolean).join(' · ') || null],
              ['Original amount', m.amount ? <>{usd(m.amount, { exact: true })} <Tag kind="record" /></> : null],
              ['Balance', s.prior ? 'Not open debt' : (m.estBalance ?? 0) > 0 ? <>{usd(m.estBalance, { exact: true })} <Tag kind="estimated" /></> : 'Unknown — the provider has no estimate'],
              ['Rate', m.rate ? `${m.rate}%` : null],
              ['Payment', m.payment ? <>{usd(m.payment)}/mo <Tag kind="estimated" /></> : null],
              ['Term', m.termMonths ? `${m.termMonths} months` : null],
              ['Recorded', dateShort(m.recordedAt, p.now)],
              ['Due', dateShort(m.dueAt, p.now)],
              m.privateLender ? ['Lender type', 'Private lender'] : null,
            ]} />
            <p className="dr-quiet">Balances are provider estimates, not payoff letters. A $0 balance on a recorded modification means unknown, never paid off.</p>
          </>
        ),
      }
    }
    case 'field': {
      const cat = recordCategories(d).flatMap((c) => c.groups).find((g) => g.title === s.group)
      const field = cat?.fields.find((x) => x.label === s.label)
      if (!field) return null
      const nature = fieldNature(field.label)
      return {
        eyebrow: s.group, title: field.label, label: field.label, subtitle: field.value,
        status: <Tag kind={nature === 'estimated' ? 'estimated' : 'record'} />,
        body: (
          <>
            <Facts rows={[
              ['Value', field.value],
              ['Nature', nature === 'estimated' ? 'Provider estimate' : 'As recorded by the provider'],
              ['Group', s.group],
              ['Source', s.group.startsWith('Owner') ? 'Master owner record (master_owners)' : 'Provider parcel record (seller.property)'],
            ]} />
            <p className="dr-quiet">Recorded fields are shown exactly as held; nothing here is computed by Deal Intelligence.</p>
          </>
        ),
      }
    }
    case 'snapshot': {
      const rows = snapshotRows(d)
      const row = rows.find((r) => r.index === s.index)
      const snap = d.valuationHistory[s.index]
      if (!row || !snap) return null
      const cur = availableOf(d)
      const cmp = (a: number | null | undefined, b: number | null | undefined) => (typeof a === 'number' && typeof b === 'number' && a !== b ? usd(b - a, { signed: true }) : 'unchanged')
      return {
        eyebrow: 'Immutable snapshot', title: dateTime(snap.at) ?? 'Snapshot', label: 'Snapshot',
        subtitle: snap.snapshotId ? `id ${snap.snapshotId.slice(0, 8)}` : undefined,
        body: (
          <>
            <Facts rows={[
              ['Engine value', usd(snap.mid, { exact: true })],
              ['Supported', snap.low && snap.high ? `${usd(snap.low)} – ${usd(snap.high)}` : null],
              ['Engine offer', usd(snap.offer, { exact: true })],
              ['Floor', usd(snap.floor ?? null, { exact: true })],
              ['Confidence', snap.confidence ?? null],
              ['Comps', snap.comps],
              ['Decision', snap.tier],
              ['Engine', snap.engineVersion],
            ]} />
            <LCInspectorSection title="Compared with the current decision">
              <Facts rows={[
                ['Engine value', cmp(snap.mid, d.valuation?.mid)],
                ['Engine offer', cmp(snap.offer, d.offer?.recommended)],
                ['Confidence', typeof snap.confidence === 'number' && typeof cur?.confidence === 'number' && snap.confidence !== cur.confidence ? `${cur.confidence - snap.confidence > 0 ? '+' : ''}${cur.confidence - snap.confidence}` : 'unchanged'],
                ['Decision', snap.tier === cur?.tierLabel ? 'unchanged' : `${snap.tier ?? '—'} → ${cur?.tierLabel ?? '—'}`],
              ]} />
              <p className="dr-quiet">Snapshots record what the engine computed; why an input moved is not recorded with them.</p>
            </LCInspectorSection>
          </>
        ),
      }
    }
    case 'strategy': {
      const st = d.strategies.find((x) => x.key === s.key)
      if (!st) return null
      return {
        eyebrow: 'Strategy output', title: st.label, label: st.label,
        status: st.isBest ? <LCStatus label="Engine best" tone="flow" /> : undefined,
        body: (
          <>
            <Facts rows={[['Score', st.score !== null ? `${st.score} / 100` : null], ['Detail', st.detail]]} />
            {st.points.length ? (
              <LCInspectorSection title="Factor points">
                <ul className="dr-points">{st.points.map((pt) => <li key={pt.reason}><span>{pt.reason}</span><b className="lc-num">+{pt.points}</b></li>)}</ul>
              </LCInspectorSection>
            ) : <p className="dr-quiet">{st.key === 'CASH_ASSIGNMENT' ? 'Cash shows the engine’s cash-offer confidence; it has no factor breakdown.' : 'No factor breakdown recorded.'}</p>}
            <p className="dr-quiet">A strategy output, not a global deal-quality score.</p>
          </>
        ),
      }
    }
    case 'aos': {
      const aos = availableOf(d)?.aosComposition
      const c = aos?.components.find((x) => x.key === s.key)
      if (!c || !aos) return null
      return {
        eyebrow: 'AOS component', title: c.label, label: c.label,
        body: (
          <>
            <Facts rows={[
              ['Points', `${Math.round(c.points * 10) / 10} of ${c.max}`],
              ['Share of the score', aos.score ? `${Math.round((c.points / aos.score) * 100)}%` : null],
              ['Headroom', `${Math.round((c.max - c.points) * 10) / 10} pts`],
              ['How it is computed', c.basis],
            ]} />
            {c.key === 'distress_motivation' && aos.motivation?.reasons.length ? <LCInspectorSection title="Recorded distress factors"><ul className="dr-points">{aos.motivation.reasons.map((r) => <li key={r.reason}><span>{r.reason}</span><b className="lc-num">+{r.points}</b></li>)}</ul></LCInspectorSection> : null}
            <p className="dr-quiet">AOS ≥ 780 is one of the hard-offer gates.</p>
          </>
        ),
      }
    }
    case 'money': return moneyView(p, s.key)
    case 'event': {
      const h = s.source === 'history' ? d.history[s.index] : null
      if (!h) return null
      return {
        eyebrow: humanize(h.kind) ?? 'Event', title: h.title, label: h.title, subtitle: dateTime(h.at),
        body: (
          <>
            <Facts rows={[['Amount', h.amount ? usd(h.amount, { exact: true }) : null], ['Detail', h.detail], ['When', dateShort(h.at, p.now)]]} />
            <p className="dr-quiet">{h.kind === 'analysis' ? 'From the immutable snapshot ledger.' : h.kind === 'ask' ? 'From the seller conversation (asking price history).' : 'From the county record via the provider.'}</p>
          </>
        ),
      }
    }
    case 'media': {
      const url = staticStreetViewUrl(d.subject.address, d.subject.lat, d.subject.lng)
      return {
        eyebrow: 'Property imagery', title: d.subject.address?.split(',')[0] ?? 'Property', label: 'Property imagery',
        body: (
          <>
            <div className="dr-media"><InteractiveStreetViewPanorama address={d.subject.address} lat={d.subject.lat} lng={d.subject.lng} visible /></div>
            {url ? <img className="dr-media__still" src={url} alt={`Street View still of ${d.subject.address ?? 'the property'}`} /> : null}
            <p className="dr-quiet">Google Street View — imagery date varies by location. Drag to look around.</p>
          </>
        ),
        actions: p.links?.map ? <LCButton size="sm" variant="quiet" icon="map" onClick={p.links.map}>Map</LCButton> : undefined,
      }
    }
    case 'gap': {
      const g = p.gaps.find((x) => x.key === s.key)
      if (!g) return null
      return {
        eyebrow: g.kind === 'seller' ? 'Missing seller fact' : g.kind === 'contract' ? 'Contract facts' : g.kind === 'model' ? 'Missing engine input' : 'Evidence gap',
        title: g.label, label: g.label,
        body: (
          <>
            <p className="dr-p">{g.reason}</p>
            {g.key === 'contract' ? <ul className="dr-list">{(d.automation?.negotiation?.unresolvedContractFields ?? []).map((c) => <li key={c.key}>{c.label}</li>)}</ul> : null}
            <p className="dr-quiet">{g.kind === 'seller' ? 'Captured from the conversation by the seller-fact extractor when the seller states it.' : g.kind === 'contract' ? 'The contract workflow lists these as unresolved.' : g.kind === 'model' ? 'Reported missing by the engine’s confidence breakdown.' : 'From the comp evidence.'}</p>
          </>
        ),
        actions: g.kind === 'seller' && p.links?.conversation ? <LCButton size="sm" variant="quiet" icon="message" onClick={p.links.conversation}>Conversation</LCButton> : undefined,
      }
    }
    case 'system': return null
  }
  return null
}

function markerView(p: DiInspectorProps, key: string): View | null {
  const d = p.d
  const f = p.figures
  const v = d.valuation
  const dec = availableOf(d)
  const c = d.comps
  const openEvidence = <LCButton size="sm" variant="quiet" icon="stats" onClick={() => p.onOpenMode('evidence')}>Evidence</LCButton>
  switch (key) {
    case 'engine':
      return {
        eyebrow: 'Engine value', title: usd(v?.mid, { exact: true }) ?? '—', label: 'Engine value', status: <Tag kind="modeled" />,
        body: (
          <>
            <LCInspectorSection title="Derived from">
              <Facts rows={[
                ['Comp candidates', c?.raw ?? null],
                ['Eligible', c?.eligible ?? null],
                ['Qualified (priced)', c?.selected ?? null],
                ['Method', 'Weighted value of the qualified comps'],
                ['Valuation confidence', v?.confidence ?? null],
                ['Supported range', v?.low && v?.high ? `${usd(v.low)} – ${usd(v.high)}` : null],
                ['Median adjusted comp', usd(compStats(d).median)],
                ['AVM (for contrast)', v?.avm ? <>{usd(v.avm)} <Tag kind="record" /></> : null],
              ]} />
            </LCInspectorSection>
            <Facts rows={[['Last evaluated', dec?.computedAt ? `${dateTime(dec.computedAt)} · ${ago(dec.computedAt, p.now)}` : null], ['Engine', `${d.lineage.engineVersion ?? ''}`]]} />
          </>
        ),
        actions: openEvidence,
      }
    case 'supported':
      return {
        eyebrow: 'Supported value', title: v?.low && v?.high ? `${usd(v.low)} – ${usd(v.high)}` : '—', label: 'Supported value', status: <Tag kind="supported" />,
        body: <><p className="dr-p">The engine’s low–high range across the weighted qualified comps — the band of values the evidence supports, with the engine value inside it.</p><Facts rows={[['Low', usd(v?.low, { exact: true })], ['Engine value', usd(v?.mid, { exact: true })], ['High', usd(v?.high, { exact: true })], ['Comp spread', c?.dispersion !== null && c?.dispersion !== undefined ? `${Math.round(c.dispersion * 100)}%` : null]]} /></>,
        actions: openEvidence,
      }
    case 'comps':
      return {
        eyebrow: 'Comp range', title: v?.compLow && v?.compHigh ? `${usd(v.compLow)} – ${usd(v.compHigh)}` : '—', label: 'Comp range',
        body: <><p className="dr-p">The lowest and highest adjusted values among the {c?.selected ?? 0} qualified comps.</p><Facts rows={[['Lowest', usd(v?.compLow, { exact: true })], ['Highest', usd(v?.compHigh, { exact: true })], ['Qualified', c?.selected ?? null], ['Median age', c?.medianAgeMonths !== null && c?.medianAgeMonths !== undefined ? `${c.medianAgeMonths} months` : null]]} /></>,
        actions: openEvidence,
      }
    case 'avm':
      return {
        eyebrow: 'AVM', title: usd(v?.avm, { exact: true }) ?? '—', label: 'AVM', status: <Tag kind="record">Provider estimate</Tag>,
        body: (
          <>
            <Facts rows={[
              ['AVM range', d.economics.avmRange ? `${usd(d.economics.avmRange.low)} – ${usd(d.economics.avmRange.high)}` : null],
              ['AVM confidence', d.economics.avmRange?.confidence ?? null],
              ['Engine value', usd(v?.mid)],
              ['Engine ÷ AVM', v?.mid && v?.avm ? `${(v.mid / v.avm).toFixed(2)}×` : null],
            ]} />
            <p className="dr-quiet">The provider’s automated estimate (properties.estimated_value). It is shown for contrast; the decision prices from comps.</p>
          </>
        ),
      }
    case 'ask':
    case 'counter': {
      const fact = d.sellerFacts.find((x) => x.key === 'asking_price')
      const asks = d.history.filter((h) => h.kind === 'ask')
      return {
        eyebrow: key === 'counter' ? 'Seller counter' : 'Seller ask', title: usd(key === 'counter' ? f.counter : f.ask, { exact: true }) ?? 'Not captured', label: 'Seller ask', status: <Tag kind="seller" />,
        body: (
          <>
            <Facts rows={[
              ['Opening ask', usd(f.initialAsk, { exact: true })],
              ['Gap to engine offer', f.gapToRec !== null ? usd(f.gapToRec, { signed: true }) : null],
              ['Gap to authorized ceiling', f.gapToAuthCeiling !== null ? usd(f.gapToAuthCeiling, { signed: true }) : null],
              ['Captured', fact?.at ? dateTime(fact.at) : null],
              ['Extraction confidence', fact?.confidence !== null && fact?.confidence !== undefined ? (fact.confidence <= 1 ? `${Math.round(fact.confidence * 100)}%` : String(fact.confidence)) : null],
            ]} />
            {fact?.quote ? <figure className="dr-statement"><figcaption><span className="dr-eyebrow">In the seller’s words</span></figcaption><blockquote>“{fact.quote}”</blockquote></figure> : null}
            {asks.length > 1 ? <LCInspectorSection title="Ask history"><ul className="dr-list">{asks.map((h, i) => <li key={i}><b className="lc-num">{usd(h.amount)}</b> {h.title} <em>{dateShort(h.at, p.now)}</em></li>)}</ul></LCInspectorSection> : null}
          </>
        ),
        actions: p.links?.conversation ? <LCButton size="sm" variant="quiet" icon="message" onClick={p.links.conversation}>Conversation</LCButton> : undefined,
      }
    }
    case 'offer':
    case 'recommended':
    case 'floor': {
      const cur = d.scenario?.current
      return {
        eyebrow: 'Engine offer', title: f.engineFloor && f.engineRec ? `${usd(f.engineFloor)} – ${usd(f.engineRec)}` : usd(f.engineRec) ?? '—', label: 'Engine offer', status: <Tag kind="modeled" />,
        body: (
          <>
            <Facts rows={[
              ['Recommended', usd(f.engineRec, { exact: true })],
              ['Floor', usd(f.engineFloor, { exact: true })],
              ['Buyer ceiling', usd(f.buyerCeiling, { exact: true })],
              ['Modeled fee at recommended', usd(f.modeledFee, { exact: true })],
              ['Target margin', usd(f.targetMargin, { exact: true })],
              ['Minimum margin', usd(f.minMargin, { exact: true })],
              ['Protected margin enforced', d.offer?.protectedMarginEnforced ? 'Yes — the offer was capped' : 'No'],
              ['Binding offer out', d.offer?.binding ? 'Yes' : 'No — a recommendation only'],
            ]} />
            {cur ? <p className="dr-quiet">Offer = buyer ceiling × (1 − {cur.terms.confidence_haircut_pct}% − {cur.terms.motivation_discount_pct}% + {cur.terms.demand_premium_pct}%) − target margin, capped at ceiling − protected margin. Floor = offer − max($5K, 3% of value).</p> : null}
            <p className="dr-quiet">Offers are made by the seller workflow, never from this screen.</p>
          </>
        ),
      }
    }
    case 'authorized': {
      const a = dec?.authorization
      return {
        eyebrow: 'Negotiation authority', title: f.authFloor && f.authCeiling ? `${usd(f.authFloor)} – ${usd(f.authCeiling)}` : 'No authorized range', label: 'Authorized range', status: <Tag kind="authorized" />,
        body: (
          <>
            <Facts rows={[
              ['May present', a?.presentable === true ? 'Yes' : a?.presentable === false ? 'No — withheld' : 'Not evaluated'],
              ['Withheld because', a?.withheldText ?? null],
              ['Zone', a?.zone ?? null],
              ['Economic fit', a?.economicFit ?? null],
              ['Offer band', a?.band ?? null],
              ['Room left', a?.remainingMovement !== null && a?.remainingMovement !== undefined ? usd(a.remainingMovement, { exact: true }) : null],
              ['Next move', a?.nextMove ?? null],
              ['Strategy', a?.strategy ?? null],
            ]} />
            {f.maxForMinimum && f.authCeiling && f.authCeiling > f.maxForMinimum ? <p className="dr-warn">Above {usd(f.maxForMinimum)} the modeled spread falls below the {usd(f.minMargin)} minimum margin.</p> : null}
            <p className="dr-quiet">From the seller negotiation state (acquisition_opportunities.metadata.negotiation_state). Deal Intelligence renders it; it never changes it.</p>
          </>
        ),
      }
    }
    case 'ceiling': {
      const o = d.offer
      return {
        eyebrow: 'Buyer ceiling', title: usd(f.buyerCeiling, { exact: true }) ?? '—', label: 'Buyer ceiling', status: <Tag kind="modeled">Modeled exit</Tag>,
        body: (
          <>
            <Facts rows={[
              ['From value', o?.valuationCeiling ? `${usd(o.valuationCeiling, { exact: true })} = value × ${o.maxArvFactor ?? '—'} − repairs` : null],
              ['Observed buyers', f.behaviorBinds ? `Lower the ceiling to ${usd(f.buyerCeiling)}` : 'Did not lower it'],
              ['Behavior authoritative', o?.buyerCeilingAuthoritative ? 'Yes — enough defended nearby purchases' : 'No — modeled from value'],
              ['Basis', o?.ceilingBasis ?? null],
            ]} />
            <p className="dr-quiet">What an investor buyer would pay — the modeled exit. Assignment fee = buyer ceiling − purchase price.</p>
          </>
        ),
      }
    }
    case 'mls':
      return { eyebrow: 'MLS list price', title: usd(d.subject.mls?.listPrice, { exact: true }) ?? '—', label: 'MLS', body: <Facts rows={[['Status', d.subject.mls?.status ?? null], ['Sold price', usd(d.subject.mls?.soldPrice ?? null)], ['Sold', dateShort(d.subject.mls?.soldAt, p.now)]]} /> }
    case 'binding':
      return { eyebrow: 'Binding offer', title: usd(f.currentOffer, { exact: true }) ?? '—', label: 'Binding offer', body: <ul className="dr-list">{(d.offer?.offers ?? []).map((o) => <li key={o.id}><b className="lc-num">{usd(o.price)}</b> {o.direction === 'inbound' ? 'Seller' : 'Us'} · {o.status} <em>{o.snapshotId ? `snapshot ${o.snapshotId.slice(0, 8)}` : 'no engine lineage'}</em></li>)}</ul> }
    default:
      if (key.startsWith('zone:')) {
        const z = key.slice(5)
        const text = z === 'target' ? `At or below ${usd(f.maxForTarget)} the modeled spread keeps the ${usd(f.targetMargin)} target margin.` : z === 'minimum' ? `Between ${usd(f.maxForTarget)} and ${usd(f.maxForMinimum)} the spread clears the ${usd(f.minMargin)} minimum but misses the target.` : z === 'below' ? `Between ${usd(f.maxForMinimum)} and the ${usd(f.buyerCeiling)} buyer ceiling the spread is below the ${usd(f.minMargin)} minimum — the fee gate would fail.` : `Above the ${usd(f.buyerCeiling)} buyer ceiling there is no assignment spread at all.`
        return { eyebrow: 'Offer band', title: humanize(z === 'below' ? 'below minimum' : z === 'over' ? 'above ceiling' : z) ?? 'Zone', label: 'Offer band zone', body: <><p className="dr-p">{text}</p><p className="dr-quiet">Spread = buyer ceiling − price, the engine’s own definition of the assignment fee. Margins from the assignment margin policy.</p></> }
      }
      return null
  }
}

function compView(p: DiInspectorProps, id: string): View | null {
  const d = p.d
  const c = (d.comps?.top ?? []).find((x) => (x.id ?? x.address ?? '') === id)
  if (!c) return null
  const s = d.subject
  const adj = c.adjustedValue && c.salePrice ? c.adjustedValue - c.salePrice : null
  const sale = saleTypeOfDealComp(c)
  const row = (label: string, subj: ReactNode, comp: ReactNode, differs: boolean) => (
    <tr className={cx(differs && 'is-differ')}><th>{label}</th><td>{subj ?? '—'}</td><td>{comp ?? '—'}</td></tr>
  )
  return {
    eyebrow: c.assetMatch ? 'Qualified comp' : 'Qualified comp · different asset',
    title: c.address?.split(',')[0] ?? 'Comparable sale',
    label: 'Comparable sale',
    subtitle: c.address?.split(',').slice(1).join(',').trim() || undefined,
    status: <LCStatus label={c.weight !== null ? `${Math.round(c.weight * 100)}% weight` : 'weight not recorded'} tone="exec" />,
    body: (
      <>
        <div className="dr-comp__media">
          <CompStreetView size="hero" load="eager" photo={c.photo} lat={c.lat} lng={c.lng} address={c.address} />
          <div className="dr-comp__media-tags"><SaleTypeBadge v={sale} withBuyer /></div>
        </div>
        <Facts rows={[
          ['Sold', <span key="s">{usd(c.salePrice, { exact: true }) ?? '—'} · {dateShort(c.saleDate, p.now) ?? '—'}</span>],
          ['Adjusted value', c.adjustedValue ? <span key="a">{usd(c.adjustedValue, { exact: true })}{adj ? <em className="dr-delta"> {usd(adj, { signed: true })} adj.</em> : null}</span> : null],
          ['Distance', c.distanceMiles !== null ? `${c.distanceMiles.toFixed(2)} mi` : null],
          ['Age', monthsSince(c.saleDate, p.now) !== null ? `${monthsSince(c.saleDate, p.now)} months` : null],
          ['Match score', c.score !== null ? `${Math.round(c.score)} / 100` : null],
          ['Comp confidence', c.confidence !== null ? Math.round(c.confidence) : null],
          ['Data completeness', c.completeness !== null ? `${Math.round(c.completeness)}%` : null],
          ['Buyer', c.buyerKind === 'company' ? c.buyerLabel : c.buyerKind === 'individual' ? 'Individual (not named)' : 'Not recorded'],
          ['AVM at sale', usd(c.avmAtSale)],
        ]} />
        <LCInspectorSection title="How it sold">
          <SaleTypeEvidence v={sale} engineSource={c.source} weighted />
        </LCInspectorSection>
        <LCInspectorSection title="Against the subject">
          <table className="dr-vs">
            <thead><tr><th /><th>Subject</th><th>Comp</th></tr></thead>
            <tbody>
              {row('Type', s.propertyType, c.propertyType, Boolean(s.propertyType && c.propertyType && s.propertyType !== c.propertyType))}
              {row('Beds', s.beds, c.beds, Boolean(s.beds && c.beds && s.beds !== c.beds))}
              {row('Baths', s.baths, c.baths, Boolean(s.baths && c.baths && s.baths !== c.baths))}
              {row('Sq ft', int(s.sqft), int(c.sqft), Boolean(s.sqft && c.sqft && Math.abs(s.sqft - c.sqft) / s.sqft > 0.15))}
              {row('Year', s.yearBuilt, c.yearBuilt, Boolean(s.yearBuilt && c.yearBuilt && Math.abs(s.yearBuilt - c.yearBuilt) > 15))}
              {row('Units', s.units, c.units, Boolean(s.units && c.units && s.units !== c.units))}
              {row('$/sq ft', null, c.ppsf ? `$${Math.round(c.ppsf)}` : null, false)}
            </tbody>
          </table>
          {c.mismatches.length ? <p className="dr-quiet">Engine-flagged differences: {c.mismatches.map((m) => `${m.feature} ${String(m.comp)} vs ${String(m.subject)}`).join(' · ')}.</p> : null}
        </LCInspectorSection>
        <p className="dr-quiet">Why included: it survived the engine’s screens (asset family, distance, recency, arm’s-length, outlier) and ranks in its top {d.comps?.selected ?? ''} by match score; its weight is the engine’s.</p>
      </>
    ),
    actions: (
      <>
        <LCButton size="sm" variant="quiet" icon="stats" onClick={p.links?.comps}>Comps</LCButton>
        {c.propertyId ? <LCButton size="sm" variant="quiet" icon="target" onClick={() => p.onUnderwrite({ propertyId: c.propertyId, threadKey: null, opportunityId: null, prospectId: null, masterOwnerId: null, address: c.address })}>Underwrite</LCButton> : null}
      </>
    ),
  }
}

function moneyView(p: DiInspectorProps, key: string): View | null {
  const d = p.d
  const f = p.figures
  const o = d.offer
  const e = d.economics
  const copy: Record<string, { title: string; tag: 'modeled' | 'estimated' | 'policy'; text: string; rows: Array<[string, ReactNode] | null> }> = {
    value: { title: 'Engine value', tag: 'modeled', text: 'The weighted value of the qualified comps — where the chain starts.', rows: [['Value', usd(d.valuation?.mid, { exact: true })], ['Comps', d.comps?.selected ?? null]] },
    factor: { title: 'Buyer factor', tag: 'policy', text: 'The engine’s maximum-ARV factor for this asset: the share of value an investor buyer pays before repairs.', rows: [['Factor', o?.maxArvFactor ?? null], ['Deduction', usd(d.valuation?.mid && o?.maxArvFactor ? d.valuation.mid * (1 - o.maxArvFactor) : null, { exact: true })]] },
    repairs: { title: 'Repairs', tag: 'estimated', text: 'Deducted before the buyer ceiling. An estimate — the seller has not itemized condition unless the facts say so.', rows: [['Amount', usd(o?.repairs.amount, { exact: true })], ['Source', o?.repairs.source ?? null], ['Confidence', o?.repairs.confidence ?? null]] },
    behavior: { title: 'Observed buyers', tag: 'modeled', text: 'Nearby investor purchases lowered the ceiling below the value-based one.', rows: [['Value-based ceiling', usd(o?.valuationCeiling, { exact: true })], ['Buyer ceiling', usd(f.buyerCeiling, { exact: true })]] },
    ceiling: { title: 'Buyer ceiling', tag: 'modeled', text: 'What an investor buyer pays — the modeled exit price.', rows: [['Ceiling', usd(f.buyerCeiling, { exact: true })], ['Basis', o?.ceilingBasis ?? null]] },
    offer: { title: 'Engine offer', tag: 'modeled', text: 'The recommended purchase price.', rows: [['Recommended', usd(f.engineRec, { exact: true })], ['Floor', usd(f.engineFloor, { exact: true })]] },
    fee: { title: 'Modeled assignment fee', tag: 'modeled', text: 'Buyer ceiling − engine offer. A modeled spread, not profit: holding, closing and financing costs are not modeled.', rows: [['Fee', usd(f.modeledFee, { exact: true })], ['Target margin', usd(f.targetMargin, { exact: true })], ['Minimum margin', usd(f.minMargin, { exact: true })], ['Negotiable above minimum', usd(o?.negotiableMargin ?? null, { exact: true })]] },
    equity: { title: 'Equity', tag: 'estimated', text: 'The provider’s equity estimate: value on record minus estimated loan balances.', rows: [['Equity', e.equityPercent !== null ? `${Math.round(e.equityPercent)}%` : null], ['Amount', usd(e.equityEstimate, { exact: true })], ['Est. open debt', usd(e.debt.estOpenBalance, { exact: true })], ['Loans with unknown balance', e.debt.unknownBalances || null]] },
  }
  const m = copy[key]
  if (!m) return null
  return {
    eyebrow: 'Economics', title: m.title, label: m.title, status: <Tag kind={m.tag} />,
    body: <><p className="dr-p">{m.text}</p><Facts rows={m.rows} /></>,
  }
}
