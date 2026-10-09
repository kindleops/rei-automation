/**
 * ONE EQUITY RENDERING for the grid, the hover card, the inspector and the
 * property rows (owner, 2026-10-08: hover card "High (flag)" while the grid
 * said "$111M · 100%"; negative equity "-11%" with no amount while others read
 * "$X · Y%").
 *
 * Input is the server's equityTruth (entity-graph-truth.js) — the same rule
 * everywhere: known only with evidence (loan + value, vendor free & clear, a
 * recorded mortgage balance, or recorded documents with no open mortgage); a
 * vendor High/Low flag alone is a class with no %; else Unknown.
 */
export type EquityRule =
  | 'loan_and_value' | 'free_and_clear' | 'no_recorded_mortgage' | 'recorded_mortgage_balance'
  | 'vendor_high_equity_flag' | 'vendor_low_equity_flag' | 'unknown'

export type EquityFacts = { percent?: number | null; amount?: number | null; rule?: string | null }

export type EquityDisplay = {
  /** Grid cell / hover value: "$111M · 100%", "−$42K · −11%", "High (vendor flag)", "Unknown". */
  text: string
  /** Inspector figure: the amount (or the class when there is no amount). */
  figure: string
  /** Inspector hint: the % and the evidence it rests on. */
  hint: string
  known: boolean
  tone: 'ok' | 'bad' | 'crit' | ''
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** Signed compact money: −$42K, $1.2M, $0 — never null for a finite number. */
export function signedMoney(n: number): string {
  const a = Math.abs(n)
  const sign = n < 0 ? '−' : ''
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`
  return `${sign}$${Math.round(a)}`
}
const signedPct = (p: number) => `${p < 0 ? '−' : ''}${Math.abs(Math.round(p))}%`

const BASIS: Record<string, string> = {
  loan_and_value: 'value − loan balance on file',
  recorded_mortgage_balance: 'value − recorded mortgage balance',
  no_recorded_mortgage: 'no open mortgage recorded',
  free_and_clear: 'vendor free & clear, no loan on file',
}

export function equityDisplay(f: EquityFacts): EquityDisplay {
  const rule = f.rule ?? 'unknown'
  const amt = finite(f.amount) ? f.amount : null
  const pct = finite(f.percent) ? f.percent : null
  if (rule === 'loan_and_value' || rule === 'recorded_mortgage_balance' || rule === 'no_recorded_mortgage' || rule === 'free_and_clear') {
    const p = rule === 'no_recorded_mortgage' || rule === 'free_and_clear' ? (pct ?? 100) : pct
    const parts = [amt !== null ? signedMoney(amt) : null, p !== null ? signedPct(p) : null, rule === 'free_and_clear' ? 'free & clear' : null].filter(Boolean)
    if (!parts.length) return { text: 'Unknown', figure: 'Unknown', hint: 'no value to measure against', known: false, tone: '' }
    const tone: EquityDisplay['tone'] = p === null ? '' : p < 0 ? 'crit' : p < 15 ? 'crit' : p >= 40 ? 'ok' : ''
    return {
      text: parts.join(' · '),
      figure: amt !== null ? signedMoney(amt) : signedPct(p as number),
      hint: [p !== null && amt !== null ? signedPct(p) : null, p !== null && p < 0 ? 'underwater' : null, BASIS[rule]].filter(Boolean).join(' · '),
      known: true,
      tone,
    }
  }
  if (rule === 'vendor_high_equity_flag') return { text: 'High (vendor flag)', figure: 'High', hint: 'vendor class only · no loan or recorded-mortgage evidence', known: false, tone: 'ok' }
  if (rule === 'vendor_low_equity_flag') return { text: 'Low (vendor flag)', figure: 'Low', hint: 'vendor class only · no loan or recorded-mortgage evidence', known: false, tone: 'bad' }
  return { text: 'Unknown', figure: 'Unknown', hint: 'no loan, record or vendor evidence', known: false, tone: '' }
}
