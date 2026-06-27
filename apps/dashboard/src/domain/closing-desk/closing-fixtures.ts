/**
 * DEMO / STORYBOOK FIXTURES ONLY.
 *
 * These cases are synthetic and exist solely so the Closing Desk UI can be
 * exercised without live data. They are flagged `mode: 'fixture'` and every
 * fixture case sets `provenance.fields.identity = 'fixture'`, so the UI can
 * render an unmistakable "DEMO DATA" banner. NEVER use these in live mode and
 * NEVER create proof rows against real contacts from them.
 */
import type { ClosingCase, ClosingDeskModel } from './closing-desk.types'
import { computeClosingHealth } from './closing-health'
import { boardColumnForCase } from './closing-board'
import { createMilestone, dedupeMilestones } from './closing-milestones'
import { computeClosingSummary } from './closing-summary'

const DAY = 86_400_000

function iso(offsetDays: number, base: number): string {
  return new Date(base + offsetDays * DAY).toISOString()
}

function buildFixtureCase(seed: {
  id: string
  address: string
  market: string
  seller: string
  stage: ClosingCase['universalStage']
  closingInDays: number | null
  clearToClose: boolean | null
  emdReceived: boolean | null
  emdDueInDays: number | null
  titleStatus: ClosingCase['titleStatus']
  blocker?: { title: string; category: ClosingCase['issues'][number]['category']; severity: ClosingCase['issues'][number]['severity'] }
  sellerPrice: number
  buyerPrice: number | null
  now: number
}): ClosingCase {
  const { now } = seed
  const issues: ClosingCase['issues'] = seed.blocker
    ? [
        {
          issueId: `${seed.id}:1`,
          closingCaseId: seed.id,
          category: seed.blocker.category,
          title: seed.blocker.title,
          severity: seed.blocker.severity,
          status: 'open',
          owner: 'TC — Demo',
          openedAt: iso(-3, now),
          dueAt: iso(2, now),
          slaHours: 96,
          resolutionRequirements: ['Obtain payoff statement', 'Confirm wiring instructions'],
          evidence: [],
          dependencies: [],
          blockingMilestones: ['clear_to_close'],
          resolvedAt: null,
          resolutionNote: null,
          source: 'fixture',
        },
      ]
    : []

  const milestones = dedupeMilestones([
    createMilestone({ closingCaseId: seed.id, type: 'accepted_offer_locked', sourceSystem: 'fixture', sourceEntityId: seed.id, occurredAt: iso(-21, now) }),
    createMilestone({ closingCaseId: seed.id, type: 'contract_fully_executed', sourceSystem: 'fixture', sourceEntityId: seed.id, occurredAt: iso(-18, now) }),
    createMilestone({ closingCaseId: seed.id, type: 'closing_case_created', sourceSystem: 'fixture', sourceEntityId: seed.id, occurredAt: iso(-18, now) }),
    ...(seed.titleStatus !== 'not_opened'
      ? [createMilestone({ closingCaseId: seed.id, type: 'title_opened', sourceSystem: 'fixture', sourceEntityId: seed.id, occurredAt: iso(-14, now) })]
      : []),
    ...(seed.closingInDays !== null
      ? [createMilestone({ closingCaseId: seed.id, type: 'closing_scheduled', sourceSystem: 'fixture', sourceEntityId: seed.id, occurredAt: iso(-7, now) })]
      : []),
  ])

  const dates: ClosingCase['dates'] = {
    contractSignedDate: iso(-18, now),
    effectiveDate: iso(-18, now),
    emdDueDate: seed.emdDueInDays !== null ? iso(seed.emdDueInDays, now) : null,
    inspectionDeadline: null,
    titleOpenedDate: seed.titleStatus !== 'not_opened' ? iso(-14, now) : null,
    titleCommitmentDate: null,
    cureDeadline: null,
    scheduledClosingDate: seed.closingInDays !== null ? iso(seed.closingInDays, now) : null,
    signingDate: null,
    fundingDate: null,
    recordingDate: null,
    revenueConfirmedDate: null,
  }

  const readiness: ClosingCase['readiness'] = {
    contractComplete: true,
    allSignersVerified: true,
    ownershipVerified: true,
    authorityVerified: true,
    emdReceived: seed.emdReceived,
    buyerSecured: seed.buyerPrice !== null,
    buyerFundsVerified: seed.buyerPrice !== null ? true : null,
    titleOpened: seed.titleStatus !== 'not_opened',
    titleCommitmentReceived: seed.titleStatus === 'cleared',
    liensResolved: seed.blocker ? false : true,
    probateResolved: true,
    payoffReceived: seed.blocker?.category === 'mortgage_payoff' ? false : true,
    municipalIssuesResolved: true,
    settlementStatementApproved: seed.clearToClose === true,
    sellerReady: true,
    buyerReady: seed.buyerPrice !== null,
    signingScheduled: seed.closingInDays !== null,
    clearToClose: seed.clearToClose,
    funded: false,
    recorded: false,
    closed: false,
  }

  const financials: ClosingCase['financials'] = {
    sellerContractPrice: seed.sellerPrice,
    buyerPrice: seed.buyerPrice,
    assignmentFee: seed.buyerPrice !== null ? seed.buyerPrice - seed.sellerPrice : null,
    doubleCloseSpread: null,
    buyerEmd: seed.buyerPrice !== null ? 5000 : null,
    sellerCredits: null,
    closingCosts: null,
    titleFees: 1200,
    expectedGrossRevenue: seed.buyerPrice !== null ? seed.buyerPrice - seed.sellerPrice : null,
    confirmedGrossRevenue: null,
    netRevenue: null,
    fundingSource: 'Assignment',
    revenueStatus: 'expected_soon',
  }

  const health = computeClosingHealth({ universalStage: seed.stage, dates, readiness, issues, milestones, now })

  const base: ClosingCase = {
    identity: {
      closingCaseId: seed.id,
      primaryThreadKey: `phone:fixture-${seed.id}`,
      propertyId: `prop-${seed.id}`,
      masterOwnerId: `owner-${seed.id}`,
      prospectId: null,
      opportunityId: seed.id,
      offerId: `offer-${seed.id}`,
      contractId: `ctr-${seed.id}`,
      buyerId: seed.buyerPrice !== null ? `buyer-${seed.id}` : null,
      assignmentId: seed.buyerPrice !== null ? `asg-${seed.id}` : null,
      titleCompanyId: 'title-demo',
      escrowFileNumber: `ESC-${seed.id}`,
    },
    displayName: seed.address,
    propertyAddress: seed.address,
    market: seed.market,
    sellerName: seed.seller,
    universalStage: seed.stage,
    boardColumn: 'contract_intake',
    closingStatus: seed.closingInDays !== null ? 'scheduled' : 'not_scheduled',
    contractStatus: 'fully_executed',
    dispositionStatus: seed.buyerPrice !== null ? 'assignment_signed' : 'matching',
    titleStatus: seed.titleStatus,
    escrowStatus: 'opened',
    fundingStatus: 'not_funded',
    riskLevel: 'low',
    dates,
    financials,
    parties: [
      { role: 'seller', name: seed.seller, authorityType: 'individual', verified: true, source: 'fixture' },
      { role: 'transaction_coordinator', name: 'TC — Demo', authorityType: null, verified: null, source: 'fixture' },
    ],
    readiness,
    milestones,
    issues,
    tasks: [],
    documents: [],
    health,
    provenance: {
      fullyBacked: false,
      fields: { identity: 'fixture' },
      degraded: ['DEMO DATA — synthetic fixture, not backed by any live source.'],
    },
    lastActivityAt: iso(-1, now),
  }
  return { ...base, boardColumn: boardColumnForCase(base) }
}

export function buildClosingDeskFixtureModel(now: number = Date.now()): ClosingDeskModel {
  const cases: ClosingCase[] = [
    buildFixtureCase({ id: 'demo-1', address: '4821 Maple Grove Dr, Memphis, TN', market: 'Memphis', seller: 'Estate of R. Holloway', stage: 'under_contract', closingInDays: null, clearToClose: null, emdReceived: true, emdDueInDays: null, titleStatus: 'issues_open', blocker: { title: 'Open mortgage payoff pending lender statement', category: 'mortgage_payoff', severity: 'high' }, sellerPrice: 142000, buyerPrice: 168000, now }),
    buildFixtureCase({ id: 'demo-2', address: '1190 Sycamore St, Dallas, TX', market: 'Dallas', seller: 'M. & L. Tran', stage: 'prepared_to_close', closingInDays: 2, clearToClose: false, emdReceived: false, emdDueInDays: -1, titleStatus: 'commitment_received', blocker: { title: 'Buyer EMD not yet received', category: 'buyer_emd', severity: 'blocker' }, sellerPrice: 210000, buyerPrice: 239000, now }),
    buildFixtureCase({ id: 'demo-3', address: '77 Birchwood Ln, Atlanta, GA', market: 'Atlanta', seller: 'D. Okafor', stage: 'prepared_to_close', closingInDays: 5, clearToClose: true, emdReceived: true, emdDueInDays: -10, titleStatus: 'cleared', sellerPrice: 305000, buyerPrice: 341000, now }),
    buildFixtureCase({ id: 'demo-4', address: '2204 Canyon Rd, Phoenix, AZ', market: 'Phoenix', seller: 'B. Castillo', stage: 'disposition', closingInDays: null, clearToClose: null, emdReceived: null, emdDueInDays: null, titleStatus: 'opened', sellerPrice: 188000, buyerPrice: null, now }),
  ]
  return {
    mode: 'fixture',
    summary: computeClosingSummary(cases, now),
    cases,
    total: cases.length,
    provenance: { fullyBacked: false, fields: { identity: 'fixture' }, degraded: ['DEMO MODE — all cases are synthetic fixtures.'] },
    diagnostics: ['Closing Desk is rendering demo fixtures because live data was unavailable or fixture mode was explicitly requested.'],
    generatedAt: new Date(now).toISOString(),
  }
}
