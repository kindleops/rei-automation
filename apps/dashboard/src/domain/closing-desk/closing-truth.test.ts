import { describe, expect, it } from 'vitest'
import {
  isTerminalCase,
  isVoidedCase,
  projectClosingCaseFromCase,
  type RawClosingCaseRow,
} from './closing-projection'
import { resolveDisplaySummary, unavailableSummary } from '../../views/closing-desk/closing-desk-utils'
import { resolveClosingDeskSurfaceState } from '../../views/closing-desk/closing-desk-state'
import type { ClosingDeskModel } from './closing-desk.types'

/**
 * CLOSING-DESK-MOBILE-LOCK-1 §49.
 *
 * Every test pins a defect actually found on 2026-09-16, not a hypothetical.
 *
 * The primary fixture is production's ONLY closing case, reproduced field for
 * field: the voided $4,100 rent-as-contract-price record. It is read-only here
 * — nothing in this suite mutates a live closing (§43).
 */

/** Verbatim shape of public.closing_cases row closing:2b3c261d-… in production. */
const PROD_VOIDED_CASE: RawClosingCaseRow = {
  closing_case_id: 'closing:2b3c261d-f3dd-494a-a60c-3437cbdf39b8',
  opportunity_id: '2b3c261d-f3dd-494a-a60c-3437cbdf39b8',
  property_id: '227876842',
  property_address: null,
  universal_stage: 'formal_contract',
  closing_status: 'not_scheduled',
  contract_status: 'cancelled',
  disposition_status: null,
  title_status: null,
  escrow_status: null,
  funding_status: null,
  revenue_status: null,
  readiness: {},
  seller_contract_price: null,
  buyer_price: null,
  expected_gross_revenue: null,
  confirmed_gross_revenue: null,
  last_activity_at: '2026-09-10T11:59:17.221+00:00',
  provenance: {
    source: 'finalize_seller_acceptance',
    voided: true,
    monetary_correction: {
      truth: '4100 is a MONTHLY RENT. No asking price was ever stated by this seller.',
      applied_at: '2026-09-10T23:51:34.501127+00:00',
      authorized_by: 'operator: underwriting integrity mission, phase 2',
      containment: 'Zero SMS were ever sent on this thread, no DocuSign envelope existed.',
    },
  },
}

const live = (model: Partial<ClosingDeskModel>): ClosingDeskModel => ({
  mode: 'live',
  summary: unavailableSummary('n/a'),
  cases: [],
  total: 0,
  provenance: { fullyBacked: true, fields: {}, degraded: [] },
  diagnostics: [],
  generatedAt: new Date().toISOString(),
  ...model,
})

describe('§31 — a terminal case is history, never live work', () => {
  it('recognises the production voided case as terminal', () => {
    expect(isVoidedCase(PROD_VOIDED_CASE)).toBe(true)
    expect(isTerminalCase(PROD_VOIDED_CASE)).toBe(true)
  })

  it('routes a cancelled case to the Cancelled lane, not a live lane', () => {
    // universal_stage is still `formal_contract` (its CHECK permits only
    // post-contract values), so a stage-driven lane derivation would have put
    // this voided deal in Contract Intake and counted it as active work.
    const projected = projectClosingCaseFromCase(PROD_VOIDED_CASE)
    expect(projected.universalStage).toBe('formal_contract')
    expect(projected.boardColumn).toBe('cancelled')
  })

  it('treats a declined contract as terminal even after real progress', () => {
    const declined: RawClosingCaseRow = {
      ...PROD_VOIDED_CASE,
      provenance: { source: 'docusign' },
      contract_status: 'declined',
      universal_stage: 'prepared_to_close',
    }
    expect(isTerminalCase(declined)).toBe(true)
    expect(projectClosingCaseFromCase(declined).boardColumn).toBe('cancelled')
  })

  it('does not treat an in-flight contract as terminal', () => {
    const live: RawClosingCaseRow = {
      ...PROD_VOIDED_CASE,
      provenance: { source: 'docusign' },
      contract_status: 'sent_for_signature',
    }
    expect(isTerminalCase(live)).toBe(false)
    expect(projectClosingCaseFromCase(live).boardColumn).not.toBe('cancelled')
  })
})

describe('§37/§48 — absent is not zero', () => {
  it('leaves revenue null when no revenue column is set', () => {
    const c = projectClosingCaseFromCase(PROD_VOIDED_CASE)
    expect(c.financials.expectedGrossRevenue).toBeNull()
    expect(c.financials.confirmedGrossRevenue).toBeNull()
    expect(c.financials.sellerContractPrice).toBeNull()
  })

  it('never coerces null/empty/array into 0 — the Number() trap', () => {
    // Number(null) === 0, Number('') === 0, Number([]) === 0, Number(true) === 1,
    // and Number.isFinite(0) is true, so a bare Number() read reports a
    // confident zero for every one of these.
    const c = projectClosingCaseFromCase({
      ...PROD_VOIDED_CASE,
      expected_gross_revenue: null,
      seller_contract_price: '' as unknown as string,
      buyer_price: [] as unknown as number,
      assignment_fee: true as unknown as number,
    })
    expect(c.financials.expectedGrossRevenue).toBeNull()
    expect(c.financials.sellerContractPrice).toBeNull()
    expect(c.financials.buyerPrice).toBeNull()
    expect(c.financials.assignmentFee).toBeNull()
  })

  it('reads numeric columns that PostgREST serializes as strings', () => {
    const c = projectClosingCaseFromCase({ ...PROD_VOIDED_CASE, expected_gross_revenue: '12500.50' })
    expect(c.financials.expectedGrossRevenue).toBe(12500.5)
  })

  it('marks an unset column absent and a set column closing_cases', () => {
    const c = projectClosingCaseFromCase(PROD_VOIDED_CASE)
    expect(c.provenance.fields.title_status).toBe('absent')
    expect(c.provenance.fields.universal_stage).toBe('closing_cases')
    expect(c.provenance.fields.expected_gross_revenue).toBe('absent')
  })

  it('keeps an unchecked readiness gate null, never false', () => {
    // false asserts the gate was CHECKED and FAILED, which changes the lane.
    const c = projectClosingCaseFromCase(PROD_VOIDED_CASE)
    expect(c.readiness.clearToClose).toBeNull()
    expect(c.readiness.emdReceived).toBeNull()
    expect(c.readiness.titleOpened).toBeNull()
  })
})

describe('§4 — one metric, one calculation', () => {
  it('uses the server summary on a live route, not a page-derived recount', () => {
    // The client recount described only the loaded page and the active filter,
    // so the header shrank as soon as the corpus outgrew one page.
    const serverSummary = { ...unavailableSummary('x'), expectedRevenue: 250_000 }
    const out = resolveDisplaySummary([projectClosingCaseFromCase(PROD_VOIDED_CASE)], serverSummary, {
      fixtureQuery: false,
      modelMode: 'live',
    })
    expect(out.expectedRevenue).toBe(250_000)
  })

  it('reports every metric as unanswerable when the summary read failed', () => {
    const out = resolveDisplaySummary([], null, { fixtureQuery: false, modelMode: 'live' })
    expect(out.expectedRevenue).toBeNull()
    expect(out.underContract).toBeNull()
    expect(out.metricSources.expectedRevenue).toBe('absent')
  })
})

describe('§48 — a failed read is an error surface, never a zero-state', () => {
  it('distinguishes error mode from a genuinely empty desk', () => {
    const failed = resolveClosingDeskSurfaceState(
      live({ mode: 'error', diagnostics: ['Closing cases could not be read: boom'] }),
      { fixtureQuery: false, loading: false, error: null },
    )
    expect(failed).toBe('error')

    const empty = resolveClosingDeskSurfaceState(live({ mode: 'live' }), {
      fixtureQuery: false,
      loading: false,
      error: null,
    })
    expect(empty).toBe('zero')
  })

  it('renders zero cases in error mode — never synthetic transactions', () => {
    const out = resolveDisplaySummary([], null, { fixtureQuery: false, modelMode: 'error' })
    expect(out.expectedRevenue).toBeNull()
  })
})

describe('canonical vocabulary', () => {
  it('accepts the DocuSign statuses the server actually writes', () => {
    for (const status of ['draft', 'sent_for_signature', 'viewed', 'seller_signed', 'buyer_signed', 'fully_executed']) {
      const c = projectClosingCaseFromCase({ ...PROD_VOIDED_CASE, provenance: {}, contract_status: status })
      expect(c.contractStatus).toBe(status)
    }
  })

  it('falls back to unknown for a value no writer produces', () => {
    const c = projectClosingCaseFromCase({ ...PROD_VOIDED_CASE, provenance: {}, contract_status: 'partially_signed' })
    expect(c.contractStatus).toBe('unknown')
  })

  it('accepts the closing_status values advance-closing-workflow writes', () => {
    for (const status of ['not_scheduled', 'title_pending', 'in_title', 'scheduled', 'closed']) {
      const c = projectClosingCaseFromCase({ ...PROD_VOIDED_CASE, provenance: {}, closing_status: status })
      expect(c.closingStatus).toBe(status)
    }
  })
})

describe('§5 — identity survives the projection', () => {
  it('carries the subject ids the rest of the product joins on', () => {
    const c = projectClosingCaseFromCase(PROD_VOIDED_CASE)
    expect(c.identity.closingCaseId).toBe('closing:2b3c261d-f3dd-494a-a60c-3437cbdf39b8')
    expect(c.identity.opportunityId).toBe('2b3c261d-f3dd-494a-a60c-3437cbdf39b8')
    expect(c.identity.propertyId).toBe('227876842')
  })

  it('states the void rather than hiding it', () => {
    const c = projectClosingCaseFromCase(PROD_VOIDED_CASE)
    expect(c.provenance.degraded.join(' ')).toMatch(/VOIDED/)
    expect(c.issues).toHaveLength(1)
    expect(c.issues[0].title).toMatch(/MONTHLY RENT/)
    expect(c.issues[0].status).toBe('resolved')
  })
})
