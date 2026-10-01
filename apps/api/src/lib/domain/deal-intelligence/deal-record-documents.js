/**
 * RECORDED DOCUMENTS — what the county record actually says about debt on a
 * property, classified so a release is never counted as a lien and an estate
 * filing is never counted as debt. Pure: rows in, shapes out.
 *
 * Why this exists (measured 2026-10-01 on seller.property_lien, 29,185 rows):
 *   · The table is every recorded instrument the provider attached to the
 *     parcel, not "liens": UCC financing statements (2,937), probate orders
 *     (1,298), affidavits of death (1,197), energy agreements (1,065),
 *     certificates of release (237), lien releases (350)… The read model
 *     counted every one of them as a lien.
 *   · The money is in `amount_due` (and `hoa_lien_amount` for HOA rows). The
 *     read model read `lien_amount` / `judgment_amount` / `lienholder_name`,
 *     which do not exist, so stated amounts never reached the screen.
 *   · Two descriptions travel on each row — `doc_title` and
 *     `doc_type`/`doc_type_description` — and they disagree on 60% of rows
 *     (17,564). `doc_category` disagrees with both (the same doc_type appears
 *     under up to 20 categories), so it is only a last-resort descriptor.
 *     When the two descriptions disagree about WHETHER the row is a lien or a
 *     release, the row is a CONFLICT and says so; it is not silently picked.
 *   · Party order: for lien-type documents the owner of record is party_1 in
 *     3,509 of 3,546 owner-matched rows (mechanics 721/739, tax 74/82), so
 *     party_2 is the claimant. For ORDER and JUDGMENT documents the owner is
 *     split ~50/50 between the slots, so no claimant is asserted there — both
 *     parties are shown as recorded.
 *   · recording_date is present on 474 rows (1.6%); `date_updated` is the
 *     provider's refresh date, not a recording date, and is labelled as such.
 *
 * Mortgages (seller.property_mortgage, 243,126 rows): slots mtg1–mtg4 are the
 * current loans, prev1 / concurrent1–2 are prior and purchase-money loans.
 * 33,119 rows are empty slots (no lender, $0, no date) and prev1 frequently
 * repeats mtg1. Empty slots are dropped and duplicates removed so "N loans
 * have no balance estimate" counts real loans only.
 */

const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null }
const arr = (v) => (Array.isArray(v) ? v : [])

/** A calendar date the record can stand behind, or null (1963-01-01 placeholders included). */
function recordDate(v, minYear = 1900) {
  const s = clean(v)
  if (!s) return null
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return null
  const y = new Date(t).getUTCFullYear()
  if (y < minYear || y > 2100) return null
  return s.slice(0, 10)
}

export const LIEN_KIND_LABELS = Object.freeze({
  federal_tax: 'Federal tax lien',
  state_tax: 'State tax lien',
  mechanic: 'Mechanic’s lien',
  judgment: 'Judgment',
  hoa: 'HOA lien',
  assessment: 'Assessment lien',
  municipal: 'Municipal lien',
  lis_pendens: 'Lis pendens',
  support: 'Support lien',
  levy: 'Levy',
  lien: 'Lien',
})

export const DOCUMENT_KIND_LABELS = Object.freeze({
  probate: 'Probate / estate',
  death: 'Affidavit of death',
  ucc: 'Financing statement (UCC)',
  rents: 'Assignment of rents',
  default_notice: 'Notice of default / sale',
  redemption: 'Notice of redemption',
  easement: 'Easement',
  lease: 'Lease',
  agreement: 'Agreement / contract',
  order: 'Court order',
  other: 'Recorded document',
})

const LIEN_KINDS = new Set(Object.keys(LIEN_KIND_LABELS))
export const isLienKind = (kind) => LIEN_KINDS.has(kind)
export const kindLabel = (kind) => LIEN_KIND_LABELS[kind] || DOCUMENT_KIND_LABELS[kind] || 'Recorded document'

/** Order matters: the first rule that matches wins. Text is lower-cased. */
const TEXT_RULES = [
  ['federal_tax', /federal tax/],
  ['state_tax', /(state|franchise|income|sales|withholding)\b[^a-z]*tax|tax lien|tax warrant/],
  ['mechanic', /mechanic|materialm[ae]n|construction lien/],
  ['support', /support (lien|judg)|child support/],
  ['hoa', /\bhoa\b|homeowner|association (lien|assessment)|condominium (lien|assessment)/],
  ['assessment', /assessment lien|community facilit|improvement district|special assessment|\bpace\b/],
  ['municipal', /code enforcement|city lien|county lien|town lien|municipal|utility|sewer|water lien|solid waste|garbage|nuisance|demolition|imposing (a )?(fine|penalty)|fine\/lien|penalty\/lien/],
  ['lis_pendens', /lis pendens|pendency/],
  ['levy', /\blevy\b/],
  ['judgment', /judg(e)?ment/],
  ['probate', /probate|heirship|letters (testamentary|of administration)|transfer on death|personal representative|estate of|guardianship/],
  ['death', /affidavit of death|death certificate/],
  ['ucc', /financing statement|\bucc\b/],
  ['rents', /assignment of rents/],
  ['default_notice', /notice of default|notice of (trustee'?s? )?sale|intent to sell/],
  ['redemption', /redemption/],
  ['easement', /easement/],
  ['lease', /\blease\b/],
  ['lien', /\blien\b/],
  ['agreement', /agreement|contract|promissory|\bnote\b/],
  ['order', /\border\b|decree/],
]

/** Provider doc-type codes (doc_type), checked after the release suffix is removed. */
const CODE_RULES = [
  [/^FLN/, 'federal_tax'], [/^SLN/, 'state_tax'], [/^(MLN|AFFMLN)/, 'mechanic'], [/^SUP/, 'support'],
  [/^LIS/, 'lis_pendens'], [/^LEV/, 'levy'], [/^(JDG|ABJ|ORDJDG)/, 'judgment'],
  [/^(ALN|LID)/, 'assessment'], [/^LEN(CTY|CNT|UTL|SWR|GRB|ENF|WTR)/, 'municipal'], [/^(LEN|ORDLEN|AFFLEN|AGRLEN)/, 'lien'],
  [/^HOA/, 'hoa'],
  [/^(PRO|AFFHEI|AFFTOD)/, 'probate'], [/^AFD/, 'death'], [/^UCC/, 'ucc'], [/^ASR/, 'rents'],
  [/^(NOTICE OF DEFAULT|NOD|NOTICE OF SALE|SLE)/, 'default_notice'], [/^RED/, 'redemption'], [/^EAS/, 'easement'], [/^LSE/, 'lease'],
  [/^(AGR|CTR|NTE)/, 'agreement'], [/^(ORD|DCR)/, 'order'],
]

const RELEASE_TEXT = /\b(release|satisf|cancel|terminat|discharg|withdraw|revoc)/
const RELEASE_CODE = /(REL|PRL|TER)$/

/** One descriptor → { kind, release } or null when it says nothing usable. */
export function describeText(text) {
  const t = clean(text).toLowerCase()
  if (!t || /^unknown/.test(t) || t === 'certification' || t === 'lien information') return null
  const release = RELEASE_TEXT.test(t)
  for (const [kind, re] of TEXT_RULES) if (re.test(t)) return { kind, release }
  return release ? { kind: 'other', release } : null
}

export function describeCode(code, description) {
  const c = clean(code).toUpperCase()
  const fromDescription = describeText(description)
  if (!c) return fromDescription
  const release = RELEASE_CODE.test(c) || Boolean(fromDescription?.release)
  const base = c.replace(RELEASE_CODE, '')
  for (const [re, kind] of CODE_RULES) if (re.test(base)) return { kind, release }
  if (fromDescription) return { ...fromDescription, release }
  return release ? { kind: 'other', release } : null
}

const HOA_TRANSACTION = Object.freeze({
  LN: 'HOA lien', LIS: 'HOA lis pendens', FCL: 'HOA foreclosure', NOD: 'HOA notice of default', NOS: 'HOA notice of sale',
})

const titleCase = (s) => clean(s).toLowerCase().replace(/(^|[\s/(-])([a-z])/g, (m, p, c) => `${p}${c.toUpperCase()}`)

/**
 * Classify one seller.property_lien row.
 *   status 'lien'      a recorded lien-type instrument, no release in this row
 *          'release'   releases / terminates something
 *          'document'  a recorded instrument that is not a lien (probate, UCC…)
 *          'conflict'  the row's two descriptions disagree on lien vs release /
 *                      document — shown with both, never counted as a lien
 */
export function classifyLienDocument(row) {
  const r = row && typeof row === 'object' ? row : {}
  const isHoa = clean(r.lien_type).toLowerCase() === 'hoa_lien' || /^hoa/i.test(clean(r.doc_type))
  const parties = [...new Set([clean(r.party_1_name), clean(r.party_2_name)].filter(Boolean))]
  const at = recordDate(r.recording_date) || recordDate(r.filing_date) || recordDate(r.nod_recording_date) || recordDate(r.hoa_original_recording_date)
  const updatedAt = recordDate(r.date_updated, 1980)
  const taxPeriod = recordDate(r.tax_period_begin) || recordDate(r.tax_period_end)
    ? { from: recordDate(r.tax_period_begin), to: recordDate(r.tax_period_end) } : null

  if (isHoa) {
    const tx = clean(r.transaction_type).toUpperCase()
    return {
      kind: 'hoa',
      kindLabel: kindLabel('hoa'),
      status: 'lien',
      title: HOA_TRANSACTION[tx] || 'HOA lien',
      typeCode: clean(r.doc_type) || null,
      typeDescription: null,
      amount: pos(r.hoa_lien_amount) ?? pos(r.amount_due) ?? pos(r.nod_default_amount),
      claimant: clean(r.hoa_lien_name) || null,
      parties: [...new Set([clean(r.hoa_lien_name), ...parties].filter(Boolean))],
      at,
      updatedAt,
      taxPeriod: null,
      enforcement: ['LIS', 'FCL', 'NOD', 'NOS'].includes(tx),
      conflict: null,
    }
  }

  const a = describeText(r.doc_title)
  const b = describeCode(r.doc_type, r.doc_type_description)
  const c = !a && !b ? describeText(r.doc_category) : null
  const primary = a ?? b ?? c
  const lienA = Boolean(a && isLienKind(a.kind))
  const lienB = Boolean(b && isLienKind(b.kind))

  let conflict = null
  if (a && b) {
    const releaseDisagrees = a.release !== b.release && (lienA || lienB)
    const natureDisagrees = !a.release && !b.release && lienA !== lienB
    if (releaseDisagrees || natureDisagrees) {
      // Both readings, verbatim, so the operator sees exactly what disagrees.
      conflict = {
        title: titleCase(r.doc_title) || null,
        type: titleCase(r.doc_type_description) || clean(r.doc_type) || null,
      }
    }
  }

  // Prefer the more specific lien kind when both descriptions name a lien.
  let kind = primary?.kind ?? 'other'
  if (lienA && lienB && a.kind === 'lien' && b.kind !== 'lien') kind = b.kind
  const release = Boolean(a?.release || b?.release || c?.release)
  const status = conflict ? 'conflict' : release ? 'release' : isLienKind(kind) ? 'lien' : 'document'

  // Claimant only where the record supports a role (see header): never for
  // orders / judgments, never for a release or a non-lien document.
  const roleAmbiguous = kind === 'judgment' || kind === 'order' || /order|judg/i.test(`${clean(r.doc_title)} ${clean(r.doc_type_description)}`)
  const claimant = (status === 'lien' || status === 'conflict') && !roleAmbiguous ? (clean(r.party_2_name) || null) : null

  return {
    kind,
    kindLabel: kindLabel(kind),
    status,
    title: titleCase(r.doc_title) || titleCase(r.doc_type_description) || titleCase(r.doc_category) || kindLabel(kind),
    typeCode: clean(r.doc_type) || null,
    typeDescription: titleCase(r.doc_type_description) || null,
    amount: pos(r.amount_due) ?? pos(r.nod_default_amount),
    claimant,
    parties,
    at,
    updatedAt,
    taxPeriod,
    enforcement: kind === 'lis_pendens' || kind === 'default_notice',
    conflict,
  }
}

const SEVERITY_ORDER = { lien: 0, conflict: 1, release: 2, document: 3 }

/** All rows, classified, most consequential first, then newest. */
export function classifyLienDocuments(rows) {
  return arr(rows)
    .map(classifyLienDocument)
    .sort((x, y) => (SEVERITY_ORDER[x.status] - SEVERITY_ORDER[y.status])
      || (Date.parse(y.at || y.updatedAt || 0) || 0) - (Date.parse(x.at || x.updatedAt || 0) || 0))
}

export function summarizeLienDocuments(docs) {
  const list = arr(docs)
  const liens = list.filter((d) => d.status === 'lien')
  const byKind = {}
  for (const d of liens) byKind[d.kind] = (byKind[d.kind] || 0) + 1
  const stated = liens.map((d) => d.amount).filter((v) => v !== null)
  return {
    liens: liens.length,
    releases: list.filter((d) => d.status === 'release').length,
    documents: list.filter((d) => d.status === 'document').length,
    conflicts: list.filter((d) => d.status === 'conflict').length,
    withStatedAmount: stated.length,
    statedAmount: stated.length ? Math.round(stated.reduce((s, v) => s + v, 0) * 100) / 100 : null,
    byKind,
    estate: list.filter((d) => d.kind === 'probate' || d.kind === 'death').length,
  }
}

/* ── mortgages ──────────────────────────────────────────────────────────── */

const lenderKey = (m) => `${clean(m.lender).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14)}|${m.amount ?? ''}|${m.recordedAt ?? ''}`

/**
 * seller.property_mortgage rows → current loans and prior loans.
 * Empty provider slots are dropped; a prior row that repeats a current loan
 * (same lender, amount and recording date) is dropped as a duplicate.
 * `estBalance` keeps the provider's 0, which means "unknown" (often a
 * modification), never "paid off".
 */
export function classifyMortgages(rows) {
  const shaped = arr(rows).map((m) => ({
    slot: clean(m.slot) || null,
    position: num(m.lien_position),
    lender: clean(m.lender_name) || null,
    type: clean(m.loan_type) || null,
    financing: clean(m.financing_type) || null,
    amount: pos(m.loan_amount),
    estBalance: num(m.est_balance),
    rate: pos(m.interest_rate),
    payment: pos(m.est_payment),
    termMonths: pos(m.term_months),
    privateLender: m.is_private_lender === true,
    recordedAt: recordDate(m.recording_date),
    dueAt: recordDate(m.due_date),
  }))
  const real = shaped.filter((m) => m.lender || m.amount || m.recordedAt)
  const isCurrent = (m) => !m.slot || /^mtg/i.test(m.slot)
  const current = real.filter(isCurrent).sort((x, y) => (x.position ?? 99) - (y.position ?? 99) || (Date.parse(y.recordedAt || 0) || 0) - (Date.parse(x.recordedAt || 0) || 0))
  const seen = new Set(current.map(lenderKey))
  const prior = []
  for (const m of real.filter((x) => !isCurrent(x))) {
    const k = lenderKey(m)
    if (seen.has(k)) continue
    seen.add(k)
    prior.push({ ...m, kind: /^concurrent/i.test(m.slot || '') ? 'purchase' : 'prior' })
  }
  prior.sort((x, y) => (Date.parse(y.recordedAt || 0) || 0) - (Date.parse(x.recordedAt || 0) || 0))
  return {
    current: current.map((m) => ({ ...m, balanceKnown: (m.estBalance ?? 0) > 0 })),
    prior,
    emptySlots: shaped.length - real.length,
  }
}
