import { describe, expect, it } from 'vitest'
import {
  buildAcquisitionOperationalView,
  presentEconomics,
  presentStage,
} from './acquisition-operational-view'

/**
 * These are the rules the whole frontend truth contract rests on. Each test names the
 * specific way the product got it wrong before, so a future change that reintroduces
 * the defect fails here rather than on a screen.
 */
describe('acquisition operational view', () => {
  describe('stage authority', () => {
    it('reads stage from acquisition_opportunities', () => {
      const view = buildAcquisitionOperationalView({
        opportunity: { id: 'o1', acquisition_stage: 'asking_price' },
      })
      expect(view.stage).toBe('asking_price')
      expect(view.stage_label).toBe('Asking Price')
      expect(view.stage_number).toBe(3)
      expect(presentStage(view).authoritative).toBe(true)
    })

    it('NEVER promotes the thread projection to stage', () => {
      // The exact shape that made a projection lead its own authority: an opportunity
      // with no canonical stage, next to a thread that has one.
      const view = buildAcquisitionOperationalView({
        opportunity: { id: 'o1', acquisition_stage: null },
        thread: { lifecycle_stage: 'offer', seller_stage: 'offer' },
      })
      expect(view.stage).toBeNull()
      expect(view.projected_stage).toBe('offer')
      expect(presentStage(view).label).toBe('Not staged')
      expect(presentStage(view).authoritative).toBe(false)
    })

    it('surfaces divergence rather than silently picking a winner', () => {
      const view = buildAcquisitionOperationalView({
        opportunity: { id: 'o1', acquisition_stage: 'ownership_confirmation' },
        thread: { lifecycle_stage: 'offer' },
      })
      expect(view.stage).toBe('ownership_confirmation')
      expect(view.stage_projection_diverges).toBe(true)
      expect(presentStage(view).note).toContain('Offer')
    })

    it('rejects a stage code that is not in the canonical registry', () => {
      const view = buildAcquisitionOperationalView({
        opportunity: { id: 'o1', acquisition_stage: 'interest_qualification' },
      })
      expect(view.stage).toBeNull()
    })
  })

  describe('economics authority', () => {
    it('fails closed when the decision engine has never run', () => {
      const view = buildAcquisitionOperationalView({
        opportunity: { id: 'o1' },
        // The legacy Podio columns are present and populated — the exact condition
        // under which they used to be rendered as the current offer.
        property: { cash_offer: 242000, final_acquisition_score: 88 },
        decision: null,
      })
      expect(view.decision_engine.state).toBe('never_run')
      expect(view.economics.recommended_offer.value).toBeNull()
      expect(view.economics.recommended_offer.source).toBe('absent')
      expect(view.economics.confidence.value).toBeNull()
      expect(presentEconomics(view).offer).toBeNull()
      expect(presentEconomics(view).label).toBe('Decision engine not run')
      expect(presentEconomics(view).action).toBe('run_decision_engine')
    })

    it('keeps legacy values visible but quarantined', () => {
      const view = buildAcquisitionOperationalView({
        property: { cash_offer: 242000, final_acquisition_score: 88 },
      })
      expect(view.legacy.cash_offer).toBe(242000)
      expect(view.legacy.acquisition_score).toBe(88)
      expect(view.legacy.provenance).toBe('podio_import_not_current_authority')
    })

    it('reports current economics from property_acquisition_scores', () => {
      const view = buildAcquisitionOperationalView({
        decision: {
          recommended_cash_offer: 185000,
          minimum_acceptable_offer: 160000,
          confidence: 0.82,
          best_strategy: 'cash',
          computed_at: '2026-09-12T10:00:00Z',
          evidence: { offer_calculation: { effective_authorized_ceiling: 210000 } },
          investor_ceiling_mid: 232000,
        },
      })
      expect(view.decision_engine.state).toBe('current')
      expect(view.economics.recommended_offer.value).toBe(185000)
      expect(view.economics.recommended_offer.source).toBe('property_acquisition_scores')
      // The authorized ceiling is NOT the buyer-behaviour leg.
      expect(view.economics.authorized_ceiling.value).toBe(210000)
      expect(view.economics.investor_ceiling_mid.value).toBe(232000)
    })

    it('treats a decision row with no offer as not run, not as a $0 decision', () => {
      const view = buildAcquisitionOperationalView({
        decision: { recommended_cash_offer: 0, confidence: 0.4 },
      })
      expect(view.decision_engine.state).toBe('never_run')
      expect(view.economics.confidence.value).toBeNull()
    })

    it('reports stale only when the backend says so', () => {
      const fresh = buildAcquisitionOperationalView({
        decision: { recommended_cash_offer: 100, computed_at: '2020-01-01T00:00:00Z' },
      })
      // An old timestamp is NOT staleness — only the backend knows what invalidates a run.
      expect(fresh.decision_engine.state).toBe('current')

      const stale = buildAcquisitionOperationalView({
        decision: { recommended_cash_offer: 100, requires_recompute: true },
      })
      expect(stale.decision_engine.state).toBe('stale')
      expect(stale.decision_engine.action).toBe('recompute_decision_engine')
    })
  })

  describe('offer authority', () => {
    it('never lets a buyer match candidate imply selection or commitment', () => {
      const view = buildAcquisitionOperationalView({
        opportunity: { id: 'o1', acquisition_stage: 'disposition' },
        buyerMatchCandidates: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      })
      expect(view.buyer_match_candidate_count).toBe(3)
      expect(view.buyer_offer_state.value).toBeNull()
      expect(view.buyer_offer_state.source).toBe('absent')
    })

    it('reads seller and buyer state from their own authorities', () => {
      const view = buildAcquisitionOperationalView({
        sellerOffer: { status: 'accepted' },
        buyerOffer: { status: 'committed' },
      })
      expect(view.seller_offer_state.value).toBe('accepted')
      expect(view.seller_offer_state.source).toBe('seller_offers')
      expect(view.buyer_offer_state.value).toBe('committed')
      expect(view.buyer_offer_state.source).toBe('buyer_offers')
    })
  })

  describe('communication availability', () => {
    it('blocks SMS on a suppressed contact and says why', () => {
      const view = buildAcquisitionOperationalView({
        thread: { thread_key: '+13055551234', is_suppressed: true, suppression_status: 'opted_out' },
      })
      expect(view.communication.sms).toBe(false)
      expect(view.communication.sms_blocked_reason).toBe('opted_out')
      expect(view.communication.channels).toEqual(['none'])
    })

    it('blocks SMS on a contactability code that blocks sends', () => {
      const view = buildAcquisitionOperationalView({
        thread: { thread_key: '+13055551234', contactability: 'dnc' },
      })
      expect(view.communication.sms).toBe(false)
    })

    it('offers both channels when both are eligible', () => {
      const view = buildAcquisitionOperationalView({
        thread: { thread_key: '+13055551234', email: 'seller@example.com' },
      })
      expect(view.communication.channels).toEqual(['sms', 'email'])
    })

    it('does not treat a mere address as email eligibility', () => {
      const view = buildAcquisitionOperationalView({
        thread: { email: 'seller@example.com', email_suppressed: true },
      })
      expect(view.communication.email).toBe(false)
      expect(view.communication.channels).toEqual(['none'])
    })
  })

  describe('temperature', () => {
    it('reports absent rather than inventing a temperature', () => {
      const view = buildAcquisitionOperationalView({ opportunity: { id: 'o1' } })
      expect(view.temperature).toBeNull()
      expect(view.temperature_source).toBe('absent')
    })

    it('keeps unscored as a real value distinct from absent', () => {
      const view = buildAcquisitionOperationalView({ opportunity: { id: 'o1', temperature: 'unscored' } })
      expect(view.temperature).toBe('unscored')
      expect(view.temperature_label).toBe('Unscored')
      expect(view.temperature_source).toBe('acquisition_opportunities')
    })
  })
})
