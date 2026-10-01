import type { BuyerProfile } from '../../../../domain/entity-graph/entity-graph-intel-api'
import type { InspectorModel, InspectorRenderer } from '../inspector-registry'
import type { EntityRef } from '../inspector-store'
import { count, enc, joinParts, money, pct, present, readInspector, text, when, words } from '../inspector-read'

/**
 * BUYER — GET /api/cockpit/entity-graph/buyer/:id (`company:<jur>:<number>` |
 * `person:<opaque>`). Observational intelligence from recorded deeds: the
 * inspector shows what was observed and never ranks a buyer for outreach.
 * Withheld identities stay withheld (the server already redacts them).
 */

type Profile = Pick<BuyerProfile, 'id' | 'kind' | 'name' | 'nameWithheld' | 'identity' | 'roles' | 'activity' | 'behavior'> & {
  geography?: { states?: Array<{ label: string }> } | null
  assets?: { dominant?: string | null } | null
  price?: { p10?: number | null; p50?: number | null; p90?: number | null; recentMedian?: number | null; recentCount?: number | null; cashShare?: number | null } | null
  purchases?: Array<{ date?: string | null; price?: number | null; docType?: string | null; city?: string | null; state?: string | null }> | null
}

const METHOD: Record<string, string> = {
  exact_registry_company_identity: 'Registry identity match',
  seller_transaction_registry_exact: 'Registry match on the deed',
  seller_transaction_company_corroboration: 'Corroborated by company records',
  transaction_linked_company_evidence: 'Company evidence on the transaction',
  transaction_linked_contact_evidence: 'Contact evidence on the transaction',
  property_linked_contact_tokenset: 'Name + property contact match',
  officer_operator_corroboration: 'Officer / operator corroboration',
}

const ASSET: Record<string, string> = { sfr: 'Single family', mf_small: 'Small multifamily', mf: 'Multifamily', condo: 'Condo', land: 'Land' }

export function shapeBuyer(p: Profile, ref: EntityRef): InspectorModel {
  const id = text(p.id) ?? ref.id
  const a = p.activity
  const lastBuy = a?.last ? joinParts([when(a.last), a.daysSinceLast != null ? `${a.daysSinceLast} days ago` : null]) : null
  const hold = joinParts([words(p.behavior?.holdFlip), p.behavior?.medianHoldDays != null ? `median hold ${p.behavior.medianHoldDays} days` : null])
  const states = (p.geography?.states ?? []).slice(0, 3).map((s) => s.label).join(', ') || null
  const range = p.price?.p10 != null && p.price?.p90 != null ? `${money(p.price.p10)} – ${money(p.price.p90)}` : null

  return {
    title: text(p.name) ?? text(ref.label) ?? 'Buyer',
    eyebrow: joinParts([p.kind === 'person' ? 'Individual' : 'Company', words(p.behavior?.archetype)]),
    status: a?.status ? { label: words(a.status) ?? a.status, tone: a.status === 'active' ? 'ok' : 'neutral' } : null,
    facts: present([
      { label: 'Identity', value: joinParts([words(p.identity?.grade), p.identity?.method ? METHOD[p.identity.method] ?? words(p.identity.method) : null]) },
      { label: 'Purchases', value: count(p.roles?.purchases) },
      { label: 'Resales', value: p.roles?.dispositions ? count(p.roles.dispositions) : null },
      { label: 'Owned now', value: p.roles?.owned ? count(p.roles.owned) : null },
      { label: 'Last purchase', value: lastBuy },
      { label: 'Last 12 months', value: a?.trailing365 != null ? count(a.trailing365, 'purchase') : null },
      { label: 'Hold style', value: hold },
      { label: 'Buys in', value: states },
      { label: 'Buys', value: p.assets?.dominant ? ASSET[p.assets.dominant] ?? words(p.assets.dominant) : null },
    ]),
    value: present([
      { label: 'Median price paid', value: money(p.price?.p50), hint: 'Recorded deeds' },
      { label: 'Recent median', value: p.price?.recentMedian != null ? joinParts([money(p.price.recentMedian), p.price.recentCount ? `${p.price.recentCount} recent` : null]) : null, hint: 'Recorded deeds' },
      { label: 'Typical range', value: range, hint: '10th–90th percentile' },
      { label: 'Cash purchases', value: pct(p.price?.cashShare, 1) },
    ]),
    activity: (p.purchases ?? []).filter((x) => x.date).slice(0, 6).map((x) => ({
      at: /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) ? `${x.date}T12:00:00Z` : String(x.date),
      text: joinParts([`Bought${x.price ? ` for ${money(x.price)}` : ''}`, text(x.docType), joinParts([text(x.city), text(x.state)], ', ')]) ?? 'Purchase',
    })),
    open: [{ label: 'Entity Graph', path: `/entity-graph?buyer=${enc(id)}` }],
    mission: null,
    replay: null,
    freshness: p.identity?.modelAsOf ? `Buyer model as of ${when(p.identity.modelAsOf)}` : null,
  }
}

export const buyerInspector: InspectorRenderer = {
  type: 'buyer',
  noun: 'Buyer',
  glyph: 'briefcase',
  load: async (ref, signal) => {
    const body = await readInspector<{ profile: Profile }>(`/api/cockpit/entity-graph/buyer/${enc(ref.id)}`, signal)
    return shapeBuyer(body.profile, ref)
  },
}
