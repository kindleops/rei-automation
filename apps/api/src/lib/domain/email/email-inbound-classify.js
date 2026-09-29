/**
 * INBOUND UNDERSTANDING for transaction counterparties (title / buyer / lender).
 *
 * Deterministic. It extracts ASSERTIONS ("title says the file is clear to
 * close", "commitment expected Thursday") with the sentence that supports
 * each one. It does not change any business state: assertions go to the
 * owning authority (Closing Authority), which decides. Seller email is NOT
 * classified here — it goes through the seller brain shared with SMS.
 *
 * Hard rules, not heuristics:
 *   - Anything that looks like wire / payment instructions is NEVER parsed
 *     into data. It always goes to the operator (wire fraud).
 *   - Legal threats, amendment / price / extension requests always need a
 *     human. Email Command never agrees to terms.
 */

const clean = (v) => String(v ?? '').trim()

const WIRE = /\b(wire (instructions|info|details|transfer)|wiring instructions|routing (number|#|no)|account (number|#|no)|aba\b|swift|iban|bank (details|info|account)|new (bank|account)|updated? (bank|wire|payment) (details|info|instructions)|remit(tance)? (to|instructions))/i
const LEGAL = /\b(lawsuit|sue\b|suing|attorney general|legal action|cease and desist|lis pendens|breach of contract|my (attorney|lawyer)|our (attorney|counsel)|litigation)\b/i
const AMEND = /\b(amend(ment|ed)?|addendum|extension|extend (the )?(closing|contract|deadline)|reduce (the )?price|price (reduction|change)|lower (the )?price|renegotiat|change (the )?(terms|price)|credit (at|for) closing|terminate|termination|cancel (the )?contract|back out|walk away)\b/i

const CTC = /\b(clear(ed)? to close|file is clear|\bctc\b|ready to close|good to close)\b/i
const NOT_CTC = /\b(not (yet )?(clear|ready)|isn'?t (clear|ready)|once (we are|it'?s) clear|before (we can|it can) (be )?clear)/i
const ACK = /\b(order (received|confirmed|opened)|received (the|your) (order|contract)|(we have|we've) (opened|received)|file (has been )?opened|opened (the|a) file|file (number|#|no\.?)\s*[:#]?\s*[A-Z0-9-]{3,})/i
const FILE_NO = /\bfile\s*(?:number|#|no\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,24})/i
const COMMIT_WORD = /\b(title )?commitment\b/i
const COMMIT_RECEIVED = /\b(attached (is |please find )?(the )?(title )?commitment|commitment (is )?attached|here is the (title )?commitment|sending (over )?the commitment)\b/i
const SETTLEMENT = /\b(settlement statement|closing statement|alta|hud-?1|closing disclosure|\bcd\b attached)\b/i
const ISSUES = [
  { type: 'open_lien', re: /\b(unreleased (mortgage|lien|deed of trust)|open (mortgage|lien)|prior (mortgage|lien)|mechanic'?s lien|lien (found|on (the )?property)|outstanding lien)\b/i },
  { type: 'tax', re: /\b(tax lien|delinquent taxes|back taxes|taxes (are )?(owed|delinquent|past due))\b/i },
  { type: 'judgment', re: /\b(judgment|judgement|abstract of judgment)\b/i },
  { type: 'probate', re: /\b(probate|estate (needs|must)|heirs?|deceased owner|letters testamentary)\b/i },
  { type: 'name_discrepancy', re: /\b(name (discrepancy|mismatch|doesn'?t match)|vesting (issue|discrepancy))\b/i },
  { type: 'hoa_balance', re: /\b(hoa (balance|dues|lien)|association (dues|lien))\b/i },
  { type: 'missing_release', re: /\b(missing release|release (not )?(recorded|missing))\b/i },
  { type: 'easement', re: /\beasement\b/i },
  { type: 'survey', re: /\b(survey (issue|problem|shows)|encroach(ment|es))\b/i },
]
const NEED_DIRECTION = /\b(need (your )?direction|how (would you like|do you want) (us )?to proceed|please advise|need (a )?decision|let us know how to proceed)\b/i

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function sentenceWith(text, re) {
  const parts = String(text).split(/(?<=[.!?])\s+|\n+/)
  return clean(parts.find((p) => re.test(p)) || '').slice(0, 280)
}

/** "Thursday" / "10/2" / "Oct 2" / "October 2nd" relative to the email's date → YYYY-MM-DD. */
export function parseDateMention(text, receivedAt) {
  const base = new Date(receivedAt || Date.now())
  const s = String(text).toLowerCase()
  let m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s)
  if (m) {
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : base.getUTCFullYear()
    const d = new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2])))
    if (!m[3] && d < new Date(base.getTime() - 30 * 864e5)) d.setUTCFullYear(y + 1)
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null
  }
  m = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`).exec(s)
  if (m) {
    const y = m[3] ? Number(m[3]) : base.getUTCFullYear()
    const d = new Date(Date.UTC(y, MONTHS.indexOf(m[1]), Number(m[2])))
    if (!m[3] && d < new Date(base.getTime() - 30 * 864e5)) d.setUTCFullYear(y + 1)
    return d.toISOString().slice(0, 10)
  }
  if (/\btomorrow\b/.test(s)) return new Date(base.getTime() + 864e5).toISOString().slice(0, 10)
  if (/\btoday\b/.test(s)) return base.toISOString().slice(0, 10)
  m = new RegExp(`\\b(next\\s+)?(${DAYS.join('|')})\\b`).exec(s)
  if (m) {
    const target = DAYS.indexOf(m[2])
    // "Thursday" = the next Thursday after the email was written (never the same day).
    let delta = (target - base.getUTCDay() + 7) % 7
    if (delta === 0) delta = 7
    return new Date(base.getTime() + delta * 864e5).toISOString().slice(0, 10)
  }
  return null
}

/**
 * @returns {{ assertions: Array<{type:string, value?:any, excerpt:string, confidence:number}>, flags: string[], needs: {code:string, reason:string}|null, understood: boolean }}
 */
export function classifyCounterpartyEmail({ text = '', subject = '', role = 'title', receivedAt = null, attachments = [] } = {}) {
  const body = `${clean(subject)}\n${clean(text)}`
  const assertions = []
  const flags = []

  if (WIRE.test(body)) flags.push('wire_instructions')
  if (LEGAL.test(body)) flags.push('legal_language')
  if (AMEND.test(body)) flags.push('terms_change_requested')

  if (role === 'title') {
    if (CTC.test(body) && !NOT_CTC.test(body)) assertions.push({ type: 'clear_to_close', excerpt: sentenceWith(body, CTC), confidence: 0.9 })
    if (ACK.test(body)) {
      const file = FILE_NO.exec(body)
      assertions.push({ type: 'title_acknowledged', value: file ? file[1] : null, excerpt: sentenceWith(body, ACK), confidence: 0.85 })
    }
    if (COMMIT_WORD.test(body)) {
      const sentence = sentenceWith(body, COMMIT_WORD)
      const date = parseDateMention(sentence, receivedAt)
      if (COMMIT_RECEIVED.test(body) && attachments.length) assertions.push({ type: 'commitment_delivered', excerpt: sentenceWith(body, COMMIT_RECEIVED), confidence: 0.8 })
      else if (date && /\b(by|on|expect|expected|should|will|eta|due|ready)\b/i.test(sentence)) assertions.push({ type: 'commitment_due', value: date, excerpt: sentence, confidence: 0.8 })
    }
    for (const issue of ISSUES) {
      if (issue.re.test(body)) assertions.push({ type: 'title_issue', value: issue.type, excerpt: sentenceWith(body, issue.re), confidence: 0.8 })
    }
    if (SETTLEMENT.test(body)) assertions.push({ type: 'settlement_statement_mentioned', excerpt: sentenceWith(body, SETTLEMENT), confidence: 0.7 })
    if (/\bclosing\b/i.test(body)) {
      const sentence = sentenceWith(body, /\bclos(e|ing)\b.*\b(on|for|set|scheduled)\b/i)
      const date = sentence ? parseDateMention(sentence, receivedAt) : null
      if (date) assertions.push({ type: 'closing_date_proposed', value: date, excerpt: sentence, confidence: 0.6 })
    }
  }
  if (role === 'buyer') {
    if (/\b(signed|executed|docusign(ed)? (is )?complete)\b/i.test(body)) assertions.push({ type: 'buyer_agreement_signed_claim', excerpt: sentenceWith(body, /\b(signed|executed)\b/i), confidence: 0.6 })
    if (/\b(emd|earnest money|deposit)\b.*\b(sent|wired|deposited|delivered)\b/i.test(body)) assertions.push({ type: 'buyer_emd_sent_claim', excerpt: sentenceWith(body, /\b(emd|earnest money|deposit)\b/i), confidence: 0.6 })
    if (/\b(proof of funds|pof)\b/i.test(body)) assertions.push({ type: 'proof_of_funds_mentioned', excerpt: sentenceWith(body, /\b(proof of funds|pof)\b/i), confidence: 0.7 })
  }

  // What needs a human, in priority order.
  let needs = null
  if (flags.includes('wire_instructions')) needs = { code: 'wire_instructions_received', reason: 'Email mentions wire or banking instructions — verify by phone with a known number. Never act on emailed wire details.' }
  else if (flags.includes('legal_language')) needs = { code: 'legal_language', reason: 'Email contains legal language — review before anything else is sent' }
  else if (assertions.some((a) => a.type === 'title_issue')) {
    const a = assertions.find((x) => x.type === 'title_issue')
    needs = { code: 'title_issue', reason: `Title reports ${a.value.replace(/_/g, ' ')}${NEED_DIRECTION.test(body) ? ' and needs direction' : ''}: "${a.excerpt}"` }
  } else if (flags.includes('terms_change_requested')) needs = { code: 'approval_required', reason: 'Counterparty is asking to change terms — your decision' }
  else if (assertions.some((a) => a.type === 'closing_date_proposed')) needs = { code: 'closing_date_proposed', reason: 'Title proposed a closing date — confirm it to update the closing' }
  else if (NEED_DIRECTION.test(body)) needs = { code: 'direction_requested', reason: `Counterparty needs direction: "${sentenceWith(body, NEED_DIRECTION)}"` }

  const understood = assertions.length > 0 || flags.length > 0
  if (!needs && !understood && clean(text).length > 0) needs = { code: 'reply_needs_review', reason: 'Reply received that automation did not understand' }
  return { assertions, flags, needs, understood }
}

/** Attachment → document type. Financial/legal documents are never auto-trusted. */
const DOC_RULES = [
  { type: 'title_commitment', re: /commit(ment)?|title[ _-]?(policy|binder|report)|\bprelim/i, financial: false },
  { type: 'settlement_statement', re: /settlement|closing[ _-]?(statement|disclosure)|\balta\b|hud|\bcd\b/i, financial: true },
  { type: 'seller_contract', re: /purchase[ _-]?(agreement|contract)|\bpsa\b|sales?[ _-]?contract/i, financial: true },
  { type: 'buyer_agreement', re: /assignment|jv[ _-]?agreement/i, financial: true },
  { type: 'emd_receipt', re: /\bemd\b|earnest|escrow[ _-]?receipt|deposit[ _-]?receipt/i, financial: true },
  { type: 'proof_of_funds', re: /proof[ _-]?of[ _-]?funds|\bpof\b|bank[ _-]?statement/i, financial: true },
  { type: 'funding_letter', re: /funding|payoff/i, financial: true },
  { type: 'invoice', re: /invoice|bill\b/i, financial: true },
]
const BLOCKED = /\.(exe|bat|cmd|com|scr|js|jse|vbs|vbe|ps1|msi|jar|app|dmg|iso|lnk|html?)$/i
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export function classifyAttachment({ filename = '', contentType = '', sizeBytes = null, senderVerified = false, role = null } = {}) {
  if (BLOCKED.test(filename)) return { fetch: 'blocked', review_state: 'rejected', doc_type: null, confidence: null }
  if (sizeBytes && sizeBytes > MAX_ATTACHMENT_BYTES) return { fetch: 'too_large', review_state: 'needs_review', doc_type: null, confidence: null }
  if (/^image\//.test(contentType) && (sizeBytes ?? 0) < 20 * 1024) return { fetch: 'skip_inline', review_state: 'unclassified', doc_type: 'inline_image', confidence: 0.9 }
  const rule = DOC_RULES.find((r) => r.re.test(filename))
  if (!rule) return { fetch: 'store', review_state: 'needs_review', doc_type: null, confidence: null }
  const pdf = /pdf/.test(contentType) || /\.pdf$/i.test(filename)
  // Only a non-financial document, from the verified counterparty that issues it, may be auto-classified.
  const trusted = !rule.financial && senderVerified && pdf && (rule.type !== 'title_commitment' || role === 'title')
  return { fetch: 'store', review_state: trusted ? 'auto_classified' : 'needs_review', doc_type: rule.type, confidence: trusted ? 0.9 : 0.6, financial: rule.financial }
}
