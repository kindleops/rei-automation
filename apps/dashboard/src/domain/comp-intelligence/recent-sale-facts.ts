/**
 * RECENT MARKET SALE FACTS — what one canonical recorded sale near the subject
 * says, as the row shows it (display only; never priced, never scored).
 *
 *   channel   MLS / Off market (+ Foreclosure / auction, REO) — comp-sale-type
 *   buyer     ONE buyer chip — comp-buyer-type (MV buyer_kind / buyer_class /
 *             is_investor first, then the shared owner-of-record resolver)
 *   flags     only when the record says so:
 *               Cash               is_cash_purchase = true
 *               Flip · +N% in M mo the same property sold earlier IN THIS READ within
 *                                  12 months for ≥ 15% less (both priced)
 *               Resale · M mo      the same property sold earlier in this read within 24 months
 *               Portfolio of N     a multi-property deed (its price is for N doors)
 *               Non-arm’s-length   is_arms_length = false
 *             Distress is the channel chip's qualifier, never repeated as a flag.
 *
 * Why the rows used to show only "Public record": the row printed the source
 * string and flags only for fields that were set — and ~85% of canonical sales
 * carry no buyer class (buyer_class = 'unknown', is_cash_purchase NULL), so
 * every row read the same. The buyer now also comes from the shared
 * owner-of-record resolver, and the channel / spec / price facts always show.
 */
import type { RecentSale } from './comps-evidence-api'
import type { SaleOwnerRow } from '../../modules/market-intelligence/sale-owner/sale-owner-client'
import { compBuyerType, type CompBuyerType } from './comp-buyer-type'
import { saleTypeOfRecentSale, type SaleTypeVerdict } from './comp-sale-type'

export interface RecentSaleFlag { key: 'cash' | 'flip' | 'resale' | 'portfolio' | 'non_arms_length'; label: string; hint: string }
export interface RecentSaleView { channel: SaleTypeVerdict; buyer: CompBuyerType; flags: RecentSaleFlag[] }

const DAY = 86_400_000
const monthsBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / (30.44 * DAY)

/** The comp id the shared sale_owner resolver takes for a recent sale ("m:t:123" → "t:123"). */
export function recentSaleOwnerKey(s: Pick<RecentSale, 'key'>): string | null {
  const k = String(s.key ?? '')
  const id = k.startsWith('m:') ? k.slice(2) : k
  return /^[a-z]:[A-Za-z0-9_.:-]{1,80}$/.test(id) ? id : null
}

/** Earlier sale of the same property in the same read (rows are any order). */
function priorSale(s: RecentSale, rows: readonly RecentSale[]): RecentSale | null {
  if (!s.propertyId || !s.soldOn) return null
  let best: RecentSale | null = null
  for (const r of rows) {
    if (r === s || r.propertyId !== s.propertyId || !r.soldOn || r.soldOn >= s.soldOn) continue
    if (!best || (best.soldOn ?? '') < r.soldOn) best = r
  }
  return best
}

export function recentSaleFlags(s: RecentSale, rows: readonly RecentSale[]): RecentSaleFlag[] {
  const out: RecentSaleFlag[] = []
  if (s.cash === true) out.push({ key: 'cash', label: 'Cash', hint: 'Recorded as a cash purchase (no purchase-money loan)' })
  const prior = priorSale(s, rows)
  if (prior?.soldOn && s.soldOn) {
    const mo = monthsBetween(s.soldOn, prior.soldOn)
    const gain = s.priced && prior.priced && s.price && prior.price ? (s.price - prior.price) / prior.price : null
    if (mo <= 12 && gain !== null && gain >= 0.15) {
      out.push({ key: 'flip', label: `Flip · +${Math.round(gain * 100)}% in ${Math.max(1, Math.round(mo))} mo`, hint: `The same property sold ${Math.max(1, Math.round(mo))} months earlier for $${Math.round(prior.price!).toLocaleString('en-US')} (recorded sales in this search)` })
    } else if (mo <= 24) {
      out.push({ key: 'resale', label: `Resale · ${Math.max(1, Math.round(mo))} mo`, hint: `The same property also sold ${Math.max(1, Math.round(mo))} months earlier (recorded sales in this search)` })
    }
  }
  if (s.portfolioSize && s.portfolioSize >= 2) out.push({ key: 'portfolio', label: `Portfolio of ${s.portfolioSize}`, hint: 'One deed for several properties — its price is for all of them, so no $/sf' })
  if (s.armsLength === false) out.push({ key: 'non_arms_length', label: 'Non-arm’s-length', hint: 'Recorded as a non-arm’s-length transfer (related parties, quit claim …)' })
  return out
}

export function recentSaleBuyer(s: RecentSale, owner: SaleOwnerRow | null = null): CompBuyerType {
  return compBuyerType({
    buyerKind: s.buyerKind ?? null,
    buyerCompany: s.buyerCompany,
    buyerClass: s.buyerClass,
    investorFlag: s.investor ? true : null,
    owner,
  })
}

export function recentSaleView(s: RecentSale, rows: readonly RecentSale[], owner: SaleOwnerRow | null = null): RecentSaleView {
  return { channel: saleTypeOfRecentSale(s), buyer: recentSaleBuyer(s, owner), flags: recentSaleFlags(s, rows) }
}
