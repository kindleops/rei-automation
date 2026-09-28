const clean = (v) => String(v ?? '').trim()

/**
 * Lenders, servicers, GSEs and government agencies take title at foreclosure;
 * they are not disposition buyers. Measured 2026-09-28: Fannie Mae 49/52,
 * Wilmington Savings Fund 20/20, Lakeview 13/13 acquisitions on foreclosure
 * deeds — and the legacy engine ranked the Secretary of Veterans Affairs #1
 * ("A 91.4, institutional capital"). Name classes are only applied to
 * COMPANY entities and only to these institution types; a third-party
 * investor buying at auction is kept (and labelled) on deed evidence.
 */
const LENDER_CLASSES = [
  ['agency', /\b(secretary of|department of|dept\.? of|housing and urban|housing & urban|veterans? affairs|united states|state of|county of|city of|commonwealth of|government)\b/i],
  ['gse', /\b(federal national mortgage|fannie mae|federal home loan mortgage|freddie mac|federal home loan bank|ginnie mae)\b/i],
  ['servicer', /\b(loan servicing|mortgage servicing|servicing,? (llc|inc|corp)|lakeview loan|shellpoint|nationstar|mr\.? cooper|carrington mortgage|newrez|rushmore loan|specialized loan|selene finance|pennymac)\b/i],
  ['lender', /\b(mortgage,? (corp(oration)?|company|co\.?|llc|inc)|home loans?|lending(,? (llc|inc))?|bancorp|savings (bank|fund|and loan)|federal savings|fsb|credit union|national association|n\.a\.?$|, n\.a\.|\bbank(?!\s+(st|street|rd|road|ave|avenue)\b)\b)/i],
  ['reo_vehicle', /\breo\b|\basset (company|trust) \d/i],
]
export function lenderClass(name) {
  const n = clean(name)
  if (!n) return null
  for (const [cls, re] of LENDER_CLASSES) if (re.test(n)) return cls
  return null
}
export const LENDER_LABEL = { agency: 'Government agency', gse: 'Mortgage agency (GSE)', servicer: 'Loan servicer', lender: 'Lender', reo_vehicle: 'REO holding vehicle' }

/**
 * buyer_match_candidates holds every run ever made for a property; readers that
 * query by property_id must keep the newest run only, or a property matched
 * five times reports five times its buyers. Also drops persisted foreclosure
 * grantees from runs made before the engine excluded them.
 */
export function latestRunCandidates(rows = []) {
  const list = Array.isArray(rows) ? rows : []
  let latest = null
  for (const r of list) {
    if (!r?.buyer_match_run_id) continue
    if (!latest || String(r.created_at || '') > String(latest.created_at || '')) latest = r
  }
  const runId = latest?.buyer_match_run_id ?? null
  return list.filter((r) => (!runId || r.buyer_match_run_id === runId) && !lenderClass(r.buyer_display_name))
}
