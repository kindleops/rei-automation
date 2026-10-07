import type { MiDossier, MiStatusPayload } from '../mi-types'

/**
 * ONE status line instead of a page of "Unavailable": each metric family that is not
 * available right now becomes one short, specific sentence (pure; unit-tested).
 * Order: inferred investor, sales change, seller universe.
 */
export interface HeadlineNote { id: 'inferred' | 'growth' | 'universe'; text: string }

const NIGHTLY = 'nightly 10:45–11:59 UTC'

export function inferredNote(status: Pick<MiStatusPayload, 'inferred_investor'> | null): string | null {
  const inf = status?.inferred_investor
  if (!inf || inf.available) return null
  switch (inf.reason) {
    case 'not_installed': return `Inferred investor: pending its summary extension, then the next build (${NIGHTLY})`
    case 'not_built': return `Inferred investor metrics arrive with tonight's build (${NIGHTLY})`
    case 'build_failed': return 'Inferred investor units failed in the last build; recorded figures are unaffected'
    default: return inf.message ?? 'Inferred investor metrics are not available for this build.'
  }
}

const monthName = (label: string | null | undefined) => {
  if (!label) return null
  const [y, m] = label.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function headlineNotes(d: Pick<MiDossier, 'values' | 'geography'>, status: Pick<MiStatusPayload, 'inferred_investor' | 'coverage'> | null): HeadlineNote[] {
  const out: HeadlineNote[] = []
  const inf = inferredNote(status)
  if (inf) out.push({ id: 'inferred', text: inf })
  const g = d.values.sales_growth
  if (g && g.status !== 'ok') {
    const start = monthName(status?.coverage?.coverage_start)
    out.push({ id: 'growth', text: /before sales coverage/i.test(g.reason ?? '') && start ? `Sales change: no prior-period baseline (coverage starts ${start}); try 90D or 6M` : 'Sales change: baseline too small here' })
  }
  const u = d.values.sms_eligible_count
  if (u && u.status === 'not_loaded') {
    out.push({ id: 'universe', text: d.geography.level === 'nation' ? 'Seller counts: open a state, market or ZIP' : `Seller universe for ${d.geography.state ?? 'this state'} is still loading` })
  }
  return out
}
