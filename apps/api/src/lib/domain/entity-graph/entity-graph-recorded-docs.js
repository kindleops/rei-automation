/**
 * ENTITY GRAPH · RECORDED DOCUMENT CLASSES (owner, 2026-10-08: "Liens column
 * showing 'Financing Statement'").
 *
 * ROOT CAUSE: seller.property_lien is not a lien table — it is every recorded
 * NON-mortgage, NON-sale document on the parcel. property_record_summary
 * (refresh_property_record_summary) counts all of them as `lien_count` and
 * lists all of them in `lien_categories`. Measured 2026-10-08 (all rows):
 * LIEN <GENERAL> 6,939 · FINANCING STATEMENT 3,848 · PROBATE 3,846 · LIS
 * PENDENS 2,373 · AFFIDAVIT OF DEATH 1,612 · AGREEMENT 1,536 · ORDER 1,458 ·
 * AFFIDAVIT 1,378 · ASSIGNMENT OF RENTS 898 · JUDGMENT 898 · CERTIFICATE 866 ·
 * MECHANICS LIEN 835 · ASSESSMENT LIEN 798 · HOA lien 474 · NOTICE OF
 * REDEMPTION 463 · CONTRACT 411 · … So "Liens" read UCC filings, affidavits,
 * probate and contracts as liens, and `lien_amount_due` sums amounts across
 * all of them (AGREEMENT rows average $278K).
 *
 * One classifier, used by the grid, inspector, hover card, network and
 * signals: only the `lien` and `judgment` classes are liens. Everything else
 * is a recorded filing with its own correct name.
 */

/** Recorded categories that ARE liens (an encumbrance securing a debt). */
export const LIEN_CATEGORIES = Object.freeze([
  'LIEN <GENERAL>', 'MECHANICS LIEN', 'ASSESSMENT LIEN', 'HOA LIEN', 'STATE TAX LIEN', 'FEDERAL TAX LIEN',
  'TAX LIEN', 'IMPROVEMENT DISTRICT LIEN', 'LEVY', 'SUPPORT',
])
/** Judgments attach as liens on real property; shown as their own kind. */
export const JUDGMENT_CATEGORIES = Object.freeze(['JUDGMENT', 'ABSTRACT', 'EXECUTION'])

const CLASS_OF = new Map([
  ...LIEN_CATEGORIES.map((c) => [c, 'lien']),
  ...JUDGMENT_CATEGORIES.map((c) => [c, 'judgment']),
  ['LIS PENDENS', 'lis_pendens'],
  ['NOTICE OF SALE <UNSPECIFIED>', 'foreclosure_notice'],
  ['NOTICE OF REDEMPTION', 'foreclosure_notice'],
  ['SUBSTITUTION', 'mortgage_related'],
  ['ASSIGNMENT OF RENTS', 'mortgage_related'],
  ['PROMISSORY NOTE', 'mortgage_related'],
  ['PROBATE', 'probate'],
  ['AFFIDAVIT OF DEATH', 'death'],
  ['FINANCING STATEMENT', 'ucc'],
  ['ORDER', 'court'],
  ['DECREE', 'court'],
  ['NOTICE OF CANCELLATION OR DISCHARGE OR RELEASE OR TERMINATION', 'release'],
])

export const DOCUMENT_CLASS_LABEL = Object.freeze({
  lien: 'Lien',
  judgment: 'Judgment',
  lis_pendens: 'Lis pendens',
  foreclosure_notice: 'Foreclosure notice',
  mortgage_related: 'Mortgage document',
  probate: 'Probate',
  death: 'Affidavit of death',
  ucc: 'UCC financing statement',
  court: 'Court order',
  release: 'Release',
  other: 'Recorded document',
})

const CATEGORY_LABEL = {
  'LIEN <GENERAL>': 'General lien',
  'MECHANICS LIEN': "Mechanic's lien",
  'ASSESSMENT LIEN': 'Assessment lien',
  'HOA LIEN': 'HOA lien',
  'STATE TAX LIEN': 'State tax lien',
  'FEDERAL TAX LIEN': 'Federal tax lien',
  'TAX LIEN': 'Tax lien',
  'IMPROVEMENT DISTRICT LIEN': 'Improvement district lien',
  LEVY: 'Tax levy',
  SUPPORT: 'Child support lien',
  JUDGMENT: 'Judgment',
  ABSTRACT: 'Abstract of judgment',
  EXECUTION: 'Writ of execution',
  'LIS PENDENS': 'Lis pendens',
  'NOTICE OF SALE <UNSPECIFIED>': 'Notice of sale',
  'NOTICE OF REDEMPTION': 'Notice of redemption',
  SUBSTITUTION: 'Substitution of trustee',
  'ASSIGNMENT OF RENTS': 'Assignment of rents',
  'PROMISSORY NOTE': 'Promissory note',
  PROBATE: 'Probate',
  'AFFIDAVIT OF DEATH': 'Affidavit of death',
  'FINANCING STATEMENT': 'UCC financing statement',
  ORDER: 'Court order',
  DECREE: 'Court decree',
  AFFIDAVIT: 'Affidavit',
  AGREEMENT: 'Agreement',
  CONTRACT: 'Contract',
  CERTIFICATE: 'Certificate',
  EASEMENT: 'Easement',
  LEASE: 'Lease',
  MAP: 'Map / plat',
  'POWER OF ATTORNEY': 'Power of attorney',
  'BILL OF SALE': 'Bill of sale',
  'NOTICE OF CANCELLATION OR DISCHARGE OR RELEASE OR TERMINATION': 'Release / termination',
}

const norm = (c) => String(c ?? '').trim().toUpperCase()

/** @returns {'lien'|'judgment'|'lis_pendens'|'foreclosure_notice'|'mortgage_related'|'probate'|'death'|'ucc'|'court'|'release'|'other'} */
export function classifyRecordedDocument(category, lienType = null) {
  const c = norm(category)
  if (!c && String(lienType ?? '').toLowerCase() === 'hoa_lien') return 'lien'
  if (CLASS_OF.has(c)) return CLASS_OF.get(c)
  if (/\bTAX LIEN\b/.test(c) || /\bLIEN\b/.test(c)) return 'lien'
  return 'other'
}

export function recordedDocumentLabel(category, lienType = null) {
  const c = norm(category)
  if (!c && String(lienType ?? '').toLowerCase() === 'hoa_lien') return 'HOA lien'
  if (CATEGORY_LABEL[c]) return CATEGORY_LABEL[c]
  if (!c) return 'Recorded document'
  return c.toLowerCase().replace(/<[^>]*>/g, '').trim().replace(/^\w/, (x) => x.toUpperCase())
}

export const isLienClass = (cls) => cls === 'lien' || cls === 'judgment'

/**
 * Split a property_record_summary category list into liens vs other filings.
 * `amountIsLiens` is true only when EVERY recorded document is a lien — the
 * summary's lien_amount_due sums all documents, so it is a lien amount only then.
 */
export function splitRecordedCategories(categories) {
  const list = (Array.isArray(categories) ? categories : []).map(norm).filter(Boolean)
  const liens = []
  const filings = []
  for (const c of [...new Set(list)]) {
    const cls = classifyRecordedDocument(c)
    const item = { category: c, class: cls, label: recordedDocumentLabel(c) }
    if (isLienClass(cls)) liens.push(item)
    else filings.push(item)
  }
  return { liens, filings, amountIsLiens: liens.length > 0 && filings.length === 0 }
}
