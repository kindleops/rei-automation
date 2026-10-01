/**
 * Desktop read of /api/cockpit/deal-intelligence/decision.
 *
 * The shared DealDecision type (domain/deal-intelligence/deal-decision-api.ts)
 * is what the phone renders and stays untouched. The read model now also
 * projects gate thresholds, AOS composition, investor evidence, the
 * conversation's contact/automation state, classified recorded documents and
 * snapshot detail; those additions are typed here, all OPTIONAL, so this
 * surface keeps working against an API deployed before them.
 */
import type { DealComp, DealDecision, SellerFact } from '../../../domain/deal-intelligence/deal-decision-api'

type Available = Extract<DealDecision['decision'], { status: 'available' }>

export interface DiGate {
  key: string
  label: string
  pass: boolean
  canonicalKey?: string
  legacy?: boolean
  metric?: 'aos' | 'comps' | 'confidence' | 'valuationConfidence' | 'fee' | 'offer' | null
  current?: number | null
  threshold?: number | null
  comparator?: '>=' | '>' | null
  unit?: 'score' | 'count' | 'usd' | null
  source?: string
}

export interface DiAosComposition {
  score: number | null
  max: number
  components: Array<{ key: string; label: string; points: number; max: number; basis: string }>
  motivation: { score: number | null; reasons: Array<{ reason: string; points: number | null }> } | null
}

export interface DiInvestorEvidence {
  method: string | null
  eligible: number | null
  local: number | null
  recent: number | null
  distinctBuyers: number | null
  cashProxy: number | null
  demandScore: number | null
  liquidityScore: number | null
  confidence: number | null
}

export interface DiStrategyBasis {
  cashViable: boolean | null
  fee: number | null
  feeNeeded: number | null
  valuationConfidence: number | null
  creativeBest: string | null
  creativeBestScore: number | null
}

export type DiConfidenceBreakdown = NonNullable<Available['confidenceBreakdown']> & {
  subjectMissing?: string[]
  financeMissing?: string[]
  uncapped?: number | null
  cap?: number | null
  capReason?: string | null
}

export type DiAvailable = Omit<Available, 'gates' | 'confidenceBreakdown'> & {
  gates: DiGate[]
  confidenceBreakdown: DiConfidenceBreakdown | null
  aosComposition?: DiAosComposition | null
  investorEvidence?: DiInvestorEvidence | null
  strategyBasis?: DiStrategyBasis | null
}

export interface DiMortgage {
  slot?: string | null
  position: number | null
  lender: string | null
  type: string | null
  financing?: string | null
  amount: number | null
  estBalance: number | null
  rate: number | null
  payment: number | null
  termMonths?: number | null
  privateLender?: boolean
  recordedAt: string | null
  dueAt: string | null
  balanceKnown?: boolean
  kind?: 'prior' | 'purchase'
}

export type DiDocStatus = 'lien' | 'release' | 'document' | 'conflict'

export interface DiRecordedDocument {
  kind: string
  kindLabel: string
  status: DiDocStatus
  title: string
  typeCode: string | null
  typeDescription: string | null
  amount: number | null
  claimant: string | null
  parties: string[]
  at: string | null
  updatedAt: string | null
  taxPeriod: { from: string | null; to: string | null } | null
  enforcement: boolean
  conflict: { title: string | null; type: string | null } | null
}

export interface DiLienSummary {
  liens: number
  releases: number
  documents: number
  conflicts: number
  withStatedAmount: number
  statedAmount: number | null
  byKind: Record<string, number>
  estate: number
}

export interface DiContact {
  threadKey: string | null
  phone: string | null
  sellerName: string | null
  contactability: string | null
  suppressed: boolean
  temperature: string | null
  lifecycleStage: string | null
  operationalStatus: string | null
  conversationStatus: string | null
  disposition: string | null
  lastIntent: string | null
  lastInboundAt: string | null
  lastOutboundAt: string | null
  latestDirection: string | null
  messageCount: number | null
}

export interface DiAutomation {
  lane: { key: string; label: string; detail: string | null; since: string | null; reason: string | null } | null
  stall: { key: string; label: string } | null
  thread: {
    state: string | null
    status: string | null
    lane: string | null
    nextAction: string | null
    nextActionAt: string | null
    nextScheduledFor: string | null
    followUpAt: string | null
    pendingQueue: number
    failedQueue: number
    blockedQueue: number
    pausedReason: string | null
    snoozedUntil: string | null
  } | null
  execution: { status: string | null; reason: string | null; reasonLabel: string | null; stage: string | null; mode: string | null; at: string | null } | null
  negotiation: {
    nextMove: string | null
    nextMoveLabel: string | null
    nextActionDueAt: string | null
    lastAction: string | null
    strategy: string | null
    humanReviewReason: string | null
    contractReadiness: string | null
    unresolvedContractFields: Array<{ key: string; label: string }>
    sellerSentiment: string | null
    round: number | null
    minimumAssignmentMargin: number | null
  } | null
}

export interface DiFreshness {
  decision: string | null
  marketDataThrough: string | null
  latestCompSale: string | null
  lastSellerReply: string | null
  buyerMatchRun: string | null
  latestRecordedLoan: string | null
}

export type DiComp = DealComp & { lat?: number | null; lng?: number | null }

export type DiSellerFact = SellerFact & { sourceMessageId?: string | null; extractor?: string | null; basis?: string | null }

export type DiSnapshot = DealDecision['valuationHistory'][number] & {
  floor?: number | null
  confidence?: number | null
  snapshotId?: string | null
  engineVersion?: string | null
  policyVersion?: string | null
}

type BaseEconomics = DealDecision['economics']

export type DiEconomics = Omit<BaseEconomics, 'debt' | 'liens'> & {
  debt: Omit<BaseEconomics['debt'], 'mortgages'> & { mortgages: DiMortgage[]; priorMortgages?: DiMortgage[] }
  liens: Array<BaseEconomics['liens'][number] & { kind?: string; title?: string; parties?: string[]; updatedAt?: string | null }>
  recordedDocuments?: DiRecordedDocument[]
  lienSummary?: DiLienSummary
}

export type DiOffer = NonNullable<DealDecision['offer']> & { assignmentMarginFloor?: number | null; negotiableMargin?: number | null }

export type DiComps = Omit<NonNullable<DealDecision['comps']>, 'top'> & { top: DiComp[] }

export type DiDecision = Omit<DealDecision, 'decision' | 'offer' | 'economics' | 'comps' | 'valuationHistory' | 'sellerFacts'> & {
  decision: { status: 'not_run' } | DiAvailable
  offer: DiOffer | null
  economics: DiEconomics
  comps: DiComps | null
  valuationHistory: DiSnapshot[]
  sellerFacts: DiSellerFact[]
  contact?: DiContact | null
  automation?: DiAutomation | null
  freshness?: DiFreshness | null
}

export const isAvailable = (d: DiDecision['decision']): d is DiAvailable => d.status === 'available'

/** /api/cockpit/pipeline/command/story/:id — the deal's own beats (read-only). */
export interface DiStoryBeat { at: string; kind: string; title: string; detail: string | null; intent?: string | null; stage?: string | null; lane?: string }
export interface DiStory {
  story: DiStoryBeat[]
  conversation: {
    threadKey: string | null
    lastInbound: { at: string; body: string; intent: string | null } | null
    messages: number
    inbound: number
  } | null
}

export type DiMode = 'decision' | 'evidence' | 'record' | 'model' | 'scenario'
export const DI_MODES: ReadonlyArray<{ id: DiMode; label: string; key: string }> = [
  { id: 'decision', label: 'Decision', key: '1' },
  { id: 'evidence', label: 'Evidence', key: '2' },
  { id: 'record', label: 'Record', key: '3' },
  { id: 'model', label: 'Model', key: '4' },
  { id: 'scenario', label: 'Scenario', key: '5' },
]

/** What the contextual inspector is showing. */
export type DiSelection =
  | { type: 'marker'; key: string }
  | { type: 'gate'; key: string }
  | { type: 'confidence'; key: 'valuation' | 'subject' | 'buyer' | 'finance' }
  | { type: 'comp'; id: string }
  | { type: 'fact'; key: string }
  | { type: 'doc'; index: number }
  | { type: 'loan'; index: number; prior?: boolean }
  | { type: 'field'; group: string; label: string }
  | { type: 'snapshot'; index: number }
  | { type: 'strategy'; key: string }
  | { type: 'aos'; key: string }
  | { type: 'money'; key: string }
  | { type: 'event'; index: number; source: 'story' | 'history' }
  | { type: 'media' }
  | { type: 'gap'; key: string }
  | { type: 'system' }
