/**
 * CLOSING EXECUTION SCENARIOS — raw canonical rows (closing_cases +
 * buyer_offers + buyer_agreements + emd_receipts + settlement_records +
 * closing_milestones + closing_title_issues + closing_email_requests +
 * email_threads + closing_activity_events) for every execution state the desk
 * must render, in the exact shape the closing authority writes (clear to close
 * with source/evidence/actor, confirmed dates, audited deposits, the
 * automation's own request history).
 *
 * Production holds no live closings (1 voided case), so these are the only
 * populated examples. They are RAW ROWS, run through the real derivation —
 * the tests pin truth rules against them and scripts/gen-closing-demo.mjs
 * turns them into the dashboard's clearly-labelled ?demo=1 data. They are
 * never served by the API.
 *
 * The world's clock: Wed Sep 30 2026, 11:46 AM Central (16:46Z).
 */
const M = 60_000
const H = 60 * M
const D = 24 * H

export const SCENARIO_NOW = Date.parse('2026-09-30T16:46:00Z')

/** The automation runtime of the demo world (production's own is read live). */
export const scenarioRuntime = (now = SCENARIO_NOW) => ({ automationEnabled: true, heartbeatAt: new Date(now - 3 * M).toISOString(), emailSendEnabled: true })

export function closingScenarios(now = SCENARIO_NOW) {
  const at = (ms) => new Date(now + ms).toISOString()
  const day = (days) => new Date(now + days * D).toISOString().slice(0, 10)
  const date = (days) => `${day(days)}T00:00:00+00:00`
  // 2:00 PM CT (19:00Z during CDT) on day +n
  const ct2pm = (days) => `${day(days)}T19:00:00+00:00`
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const caseId = (n) => `closing:${id(n)}`
  const runtime = scenarioRuntime(now)
  const property = (n, full) => ({ property_id: `demo-property-${n}`, property_address_full: full, market: 'Minneapolis, MN' })
  const opportunity = (n, stage, seller) => ({ id: id(n), acquisition_stage: stage, opportunity_status: 'active', primary_thread_key: `+161255501${String(n).padStart(2, '0')}`, seller_display_name: seller, market: 'Minneapolis, MN' })
  const base = (n, over = {}) => ({
    id: `row-${id(n)}`,
    closing_case_id: caseId(n),
    opportunity_id: id(n),
    property_id: `demo-property-${n}`,
    master_owner_id: `demo-owner-${n}`,
    thread_key: `+161255501${String(n).padStart(2, '0')}`,
    universal_stage: 'formal_contract',
    closing_status: 'not_scheduled',
    contract_status: 'draft',
    readiness: {},
    provenance: {},
    automation_state: {},
    closing_tz: 'America/Chicago',
    created_at: at(-12 * D),
    updated_at: at(-2 * H),
    ...over,
  })
  const BUYERS = ['Northline Capital LLC', 'Acme Investments LLC', 'Cobalt Homes Inc', 'Ridgeway Holdings LLC', 'Summit Street Properties LLC', 'Lakeside Equity Group LLC', 'Ironwood Partners LLC', 'Harbor & Vine LLC', 'Meridian Residential LLC', 'Northstar Home Buyers LLC', 'Granite Row Capital LLC', 'Bluewater Holdings LLC', 'Cedarline Homes LLC']
  const offer = (n, over = {}) => ({
    buyer_offer_id: `offer:demo-${n}`, offer_version: 1, opportunity_id: id(n),
    buyer_id: `buyer:demo-${n}`, status: 'selected', commitment_status: 'agreement_required', strategy: 'assignment',
    emd_status: 'required', submitted_at: at(-7 * D), selected_at: at(-6 * D), selected_by: 'operator',
    metadata: { buyer_name: BUYERS[n - 1], buyer_email: `dispo@buyer-${n}.example` },
    updated_at: at(-D),
    ...over,
  })
  const agreement = (n, over = {}) => ({
    agreement_id: `agreement:demo-${n}`, agreement_version: 1, agreement_type: 'assignment_agreement',
    opportunity_id: id(n), buyer_offer_id: `offer:demo-${n}`, buyer_id: `buyer:demo-${n}`,
    provider: 'DocuSign', provider_envelope_id: `env-buyer-${n}`, status: 'sent', sent_at: at(-5 * D), created_at: at(-5 * D),
    ...over,
  })
  const receipt = (n, over = {}) => ({
    receipt_id: `emd:${caseId(n)}:wire-${n}`, closing_case_id: caseId(n),
    buyer_id: `buyer:demo-${n}`, buyer_offer_id: `offer:demo-${n}`, amount: 5000, currency: 'USD',
    escrow_destination: 'Westline Title escrow', status: 'verified', received_at: at(-4 * D), verified_at: at(-4 * D + 2 * H),
    verified_by: 'operator', verification_method: 'title_provider', evidence_reference: `Westline EMD confirmation #482${n}`,
    external_reference: `Wire ${n}0231`, source: 'title_provider',
    ...over,
  })
  const request = (n, category, sequence, over = {}) => ({
    id: `req-${n}-${category}-${sequence}`, request_key: `closing_email:${caseId(n)}:${category}:${sequence}`, closing_case_id: caseId(n),
    action: { title_open: 'title_open', title_ack: 'title_followup', title_commitment: 'title_commitment_reminder', clear_to_close: 'clear_to_close_followup', settlement: 'settlement_request', buyer_emd: 'buyer_emd_reminder', buyer_agreement: 'buyer_agreement_followup' }[category.split(':')[0]] || 'closing_confirmation',
    category, sequence, recipient_role: category.startsWith('buyer') ? 'buyer' : 'title', status: 'sent', status_reason: null,
    ...over,
  })
  const sentAt = (iso, lagMin = 2) => ({ requested_at: iso, due_at: iso, claimed_at: new Date(Date.parse(iso) + M).toISOString(), sent_at: new Date(Date.parse(iso) + lagMin * M).toISOString(), delivery_status: 'delivered' })
  const titleThread = (n, over = {}) => ({ id: `thread-${n}-title`, closing_case_id: caseId(n), thread_key: `closing:${caseId(n)}:title`, category: 'title', counterparty_email: 'orders@westline-title.example', counterparty_name: 'Marisol Vega · Westline Title', automation_state: 'active', ...over })
  const buyerThread = (n, over = {}) => ({ id: `thread-${n}-buyer`, closing_case_id: caseId(n), thread_key: `closing:${caseId(n)}:buyer`, category: 'buyer', counterparty_email: `dispo@buyer-${n}.example`, counterparty_name: BUYERS[n - 1], automation_state: 'active', ...over })
  const deposit = (n, amount, evidence) => ({ event_type: 'contract_emd_deposited', actor: 'operator', source: 'operator', detail: { amount, deposited_at: at(-10 * D), evidence, escrow: 'Westline Title escrow' }, idempotency_key: `contract_emd_deposited:${caseId(n)}`, created_at: at(-10 * D) })
  const titled = {
    title_company_key: 'westline_title__minneapolis', title_company_name: 'Westline Title', title_company_email: 'orders@westline-title.example',
    title_route_market: 'Minneapolis, MN', title_route_status: 'routed', title_company_selected_at: at(-8 * D), title_intro_sent_at: at(-8 * D + H),
  }
  const executed = { contract_status: 'fully_executed', universal_stage: 'disposition', closing_status: 'title_pending', accepted_at: at(-11 * D), envelope_sent_at: at(-10 * D), contract_signed_date: at(-9 * D), docusign_envelope_id: 'env-seller', docusign_status: 'completed' }
  const ack = (whenIso) => ({ title_status: 'opened', title_opened_date: whenIso, title_acknowledged_at: whenIso, title_acknowledged_source: 'title_email' })
  const ctc = (n, whenIso) => ({ clear_to_close_at: whenIso, clear_to_close_source: 'title_email', clear_to_close_evidence: `Clear-to-close email · Westline Title · file WT-26-118${String(n).padStart(2, '0')}`, clear_to_close_actor: 'email_command', readiness: { clear_to_close: true } })
  const confirmedOn = (whenIso) => ({ closing_status: 'scheduled', closing_date_confirmed_at: whenIso, closing_date_source: 'title_email' })
  const titleOpenSent = (n) => request(n, 'title_open', 1, { ...sentAt(at(-8 * D + H)) })
  const committedBuyer = (n, over = {}) => offer(n, { status: 'committed', commitment_status: 'committed', committed_at: at(-5 * D), commitment_type: 'assignment_agreement', ...over })

  // Scenario 3's title commitment cadence: title opened Fri 10:47 PM CT, so the
  // fallback reminder loop starts 120h later (Tue 10:47 PM CT) and repeats daily.
  const opened3 = '2026-09-25T03:47:00Z'
  const first3 = '2026-09-30T03:47:00Z'
  const shift = (iso) => new Date(Date.parse(iso) - SCENARIO_NOW + now).toISOString()

  return [
    {
      scenario: 'contract_out_for_signature',
      closingCase: base(1, { property_address: '4418 Colfax Ave N, Minneapolis, MN 55412', contract_status: 'sent_for_signature', docusign_envelope_id: 'env-seller-1', docusign_status: 'sent', envelope_sent_at: at(-20 * H), accepted_at: at(-2 * D), seller_contract_price: 182000, earnest_money: 1000, emd_due_date: date(4), signer_name: 'Denise Carter', scheduled_closing_date: date(24), created_at: at(-2 * D) }),
      opportunity: opportunity(1, 'formal_contract', 'Denise Carter'),
      property: property(1, '4418 Colfax Ave N, Minneapolis, MN 55412'),
      runtime,
    },
    {
      scenario: 'buyer_selected_agreement_sent',
      closingCase: base(2, { ...executed, ...titled, ...ack(at(-7 * D)), title_commitment_received_at: at(-2 * D), title_commitment_evidence: 'Commitment WT-26-11877 v1', escrow_file_number: 'WT-26-11877', property_address: '3315 Aldrich Ave N, Minneapolis, MN 55412', seller_contract_price: 150000, earnest_money: 1000, emd_due_date: date(-7), scheduled_closing_date: date(16), signer_name: 'Marcus Webb' }),
      opportunity: opportunity(2, 'disposition', 'Marcus Webb'),
      property: property(2, '3315 Aldrich Ave N, Minneapolis, MN 55412'),
      activity: [deposit(2, 1000, 'Seller-contract EMD wire #10231')],
      offers: [offer(2, { offer_price: 171000, emd_amount: 5000, emd_due_date: day(3), commitment_status: 'agreement_sent' })],
      agreements: [agreement(2, { sent_at: at(-10 * H), created_at: at(-10 * H) })],
      emdReceipts: [],
      emailRequests: [titleOpenSent(2)],
      emailThreads: [titleThread(2, { last_message_at: at(-2 * D), last_message_direction: 'inbound', last_message_preview: 'Commitment for 3315 Aldrich attached — WT-26-11877.', last_inbound_at: at(-2 * D), last_outbound_at: at(-8 * D + H) }), buyerThread(2, { last_message_at: at(-10 * H), last_message_direction: 'outbound', last_message_preview: 'Assignment agreement for 3315 Aldrich Ave N is out for signature (DocuSign).', last_outbound_at: at(-10 * H) })],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-9 * D), actor: 'docusign' }],
      runtime,
    },
    {
      scenario: 'committed_waiting_on_title',
      closingCase: base(3, { ...executed, ...titled, ...ack(shift(opened3)), universal_stage: 'under_contract', closing_status: 'in_title', property_address: '2718 Emerson Ave S, Minneapolis, MN 55408', seller_contract_price: 238000, earnest_money: 2500, scheduled_closing_date: date(9), escrow_file_number: 'WT-26-11842', signer_name: 'Loretta Nguyen' }),
      opportunity: opportunity(3, 'under_contract', 'Loretta Nguyen'),
      property: property(3, '2718 Emerson Ave S, Minneapolis, MN 55408'),
      activity: [deposit(3, 2500, 'Seller-contract EMD wire #10388')],
      offers: [committedBuyer(3, { offer_price: 262000, emd_amount: 5000, emd_due_date: day(-3), pof_status: 'verified', pof_reference: 'POF — bank letter 09/22', pof_verified_at: at(-6 * D), pof_verified_by: 'operator' })],
      agreements: [agreement(3, { status: 'fully_executed', executed_at: at(-5 * D) })],
      emdReceipts: [receipt(3)],
      emailRequests: [titleOpenSent(3), request(3, 'title_commitment', 1, { ...sentAt(shift(first3)) })],
      emailThreads: [titleThread(3, { last_message_at: shift('2026-09-30T03:49:00Z'), last_message_direction: 'outbound', last_message_preview: 'Checking in on the title commitment for 2718 Emerson Ave S (WT-26-11842).', last_inbound_at: shift(opened3), last_outbound_at: shift('2026-09-30T03:49:00Z') })],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-9 * D), actor: 'docusign' }, { milestone_type: 'title_opened', occurred_at: shift(opened3), actor: 'title' }, { milestone_type: 'buyer_committed', occurred_at: at(-5 * D), actor: 'operator' }],
      runtime,
    },
    {
      scenario: 'ready_to_close_today',
      closingCase: base(4, { ...executed, ...titled, ...ack(at(-7 * D)), ...ctc(4, at(-D)), ...confirmedOn(at(-3 * D)), universal_stage: 'prepared_to_close', title_commitment_received_at: at(-4 * D), title_commitment_evidence: 'Commitment WT-26-11790 v1', property_address: '1204 Penn Ave N, Minneapolis, MN 55411', seller_contract_price: 196000, earnest_money: 2000, assignment_fee: 21500, scheduled_closing_date: ct2pm(0), escrow_file_number: 'WT-26-11790', signer_name: 'Harold Jensen' }),
      opportunity: opportunity(4, 'prepared_to_close', 'Harold Jensen'),
      property: property(4, '1204 Penn Ave N, Minneapolis, MN 55411'),
      activity: [deposit(4, 2000, 'Seller-contract EMD wire #10301'), { event_type: 'closing_date_changed', actor: 'email_command', source: 'title_email', detail: { before: { at: date(2), confirmed: false, tz: 'America/Chicago' }, after: { at: ct2pm(0), confirmed: true, tz: 'America/Chicago' }, reason: 'Title scheduled the closing for Wed 2:00 PM' }, idempotency_key: 'closing_date:4', created_at: at(-3 * D) }],
      offers: [committedBuyer(4, { committed_at: at(-6 * D), offer_price: 217500, emd_amount: 5000, emd_due_date: day(-5) })],
      agreements: [agreement(4, { status: 'fully_executed', executed_at: at(-6 * D) })],
      emdReceipts: [receipt(4)],
      settlements: [{ settlement_id: `settlement:${caseId(4)}:single`, closing_case_id: caseId(4), leg: 'single', strategy: 'assignment', settlement_status: 'pending', funding_status: 'expected', settlement_statement_type: 'alta', settlement_statement_reference: 'ALTA draft v2 — Westline Title WT-26-11790', closing_provider: 'Westline Title', created_at: at(-20 * H) }],
      emailRequests: [titleOpenSent(4), request(4, `closing_confirmation:${new Date(Date.parse(ct2pm(0))).toISOString()}`, 1, { ...sentAt(at(-3 * D + 10 * M)) }), request(4, 'settlement', 1, { ...sentAt(new Date(Date.parse(ct2pm(0)) - 36 * H).toISOString()) })],
      emailThreads: [titleThread(4, { last_message_at: at(-20 * H), last_message_direction: 'inbound', last_message_preview: 'Draft ALTA attached. See you Wednesday at 2:00 PM.', last_inbound_at: at(-20 * H), last_outbound_at: at(-D - 2 * H) }), buyerThread(4, { last_message_at: at(-D), last_message_direction: 'inbound', last_message_preview: 'Funds will be wired Wednesday morning.', last_inbound_at: at(-D) })],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-9 * D) }, { milestone_type: 'title_opened', occurred_at: at(-7 * D) }, { milestone_type: 'buyer_committed', occurred_at: at(-6 * D) }, { milestone_type: 'closing_scheduled', occurred_at: at(-3 * D) }, { milestone_type: 'clear_to_close', occurred_at: at(-D), actor: 'email_command' }],
      runtime,
    },
    {
      scenario: 'closing_tomorrow_emd_overdue',
      closingCase: base(5, { ...executed, ...titled, ...ack(at(-6 * D)), ...confirmedOn(at(-5 * D)), universal_stage: 'under_contract', title_commitment_date: date(-1), property_address: '3847 Bloomington Ave, Minneapolis, MN 55407', seller_contract_price: 171000, earnest_money: 1500, scheduled_closing_date: ct2pm(1), escrow_file_number: 'WT-26-11805', signer_name: 'Gloria Ramirez' }),
      opportunity: opportunity(5, 'under_contract', 'Gloria Ramirez'),
      property: property(5, '3847 Bloomington Ave, Minneapolis, MN 55407'),
      activity: [deposit(5, 1500, 'Seller-contract EMD wire #10412')],
      offers: [committedBuyer(5, { committed_at: at(-4 * D), offer_price: 189000, emd_amount: 5000, emd_due_date: day(-1), emd_status: 'received', emd_received_at: at(-D) /* proposal fields — must NOT count */ })],
      agreements: [agreement(5, { status: 'fully_executed', executed_at: at(-4 * D) })],
      emdReceipts: [],
      emailRequests: [
        titleOpenSent(5),
        request(5, 'buyer_emd', 1, { ...sentAt(`${day(-2)}T00:00:00.000Z`) }), request(5, 'buyer_emd', 2, { ...sentAt(`${day(-1)}T00:00:00.000Z`) }), request(5, 'buyer_emd', 3, { ...sentAt(`${day(0)}T00:00:00.000Z`) }),
        request(5, 'title_commitment', 1, { ...sentAt(`${day(-2)}T00:00:00.000Z`) }), request(5, 'title_commitment', 2, { ...sentAt(`${day(-1)}T00:00:00.000Z`) }), request(5, 'title_commitment', 3, { ...sentAt(`${day(0)}T00:00:00.000Z`) }),
        request(5, `closing_confirmation:${new Date(Date.parse(ct2pm(1))).toISOString()}`, 1, { ...sentAt(at(-5 * D + 10 * M)) }),
      ],
      emailThreads: [titleThread(5, { last_message_at: at(-2 * H - 36 * M), last_message_direction: 'inbound', last_message_preview: 'Still waiting on the payoff from the seller’s lender — commitment tomorrow morning.', last_inbound_at: at(-2 * H - 36 * M), last_outbound_at: `${day(0)}T00:02:00.000Z` }), buyerThread(5, { last_message_at: `${day(0)}T00:02:00.000Z`, last_message_direction: 'outbound', last_message_preview: 'Reminder: $5,000 earnest money for 3847 Bloomington Ave was due Sep 29.', last_outbound_at: `${day(0)}T00:02:00.000Z` })],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-9 * D) }, { milestone_type: 'buyer_committed', occurred_at: at(-4 * D) }, { milestone_type: 'closing_scheduled', occurred_at: at(-5 * D) }],
      runtime,
    },
    {
      scenario: 'closed_settled',
      closingCase: base(6, { ...executed, ...titled, ...ack(at(-20 * D)), ...ctc(6, at(-4 * D)), ...confirmedOn(at(-9 * D)), universal_stage: 'closed', closing_status: 'closed', closed_at: at(-2 * D + 3 * H), closed_by: 'operator', title_commitment_received_at: at(-12 * D), title_commitment_evidence: 'Commitment WT-26-11355 v1', property_address: '5021 34th Ave S, Minneapolis, MN 55417', seller_contract_price: 205000, earnest_money: 2000, assignment_fee: 18000, scheduled_closing_date: ct2pm(-2), recording_date: at(-D), escrow_file_number: 'WT-26-11355', signer_name: 'Walter Price', updated_at: at(-D), created_at: at(-24 * D) }),
      opportunity: { ...opportunity(6, 'closed', 'Walter Price'), opportunity_status: 'won' },
      property: property(6, '5021 34th Ave S, Minneapolis, MN 55417'),
      offers: [committedBuyer(6, { committed_at: at(-15 * D), offer_price: 223000, emd_amount: 5000, emd_due_date: day(-14) })],
      agreements: [agreement(6, { status: 'fully_executed', sent_at: at(-16 * D), executed_at: at(-15 * D) })],
      emdReceipts: [receipt(6, { received_at: at(-14 * D), verified_at: at(-14 * D + H) })],
      settlements: [{ settlement_id: `settlement:${caseId(6)}:single`, closing_case_id: caseId(6), leg: 'single', strategy: 'assignment', settlement_status: 'settled', funding_status: 'disbursed', funded_amount: 223000, disbursed_amount: 17480, funded_at: at(-2 * D + 2 * H), disbursed_at: at(-2 * D + 4 * H), closed_at: at(-2 * D + 3 * H), closing_provider: 'Westline Title', verified_by: 'operator', verified_at: at(-2 * D + 5 * H), verification_method: 'title_provider', evidence_reference: 'Final ALTA — WT-26-11355 (signed)', settlement_statement_type: 'alta', settlement_statement_reference: 'Final ALTA — WT-26-11355', actual_seller_amount: 205000, actual_buyer_amount: 223000, actual_assignment_fee: 17480, actual_closing_costs: 520, actual_other_costs: 0, actual_net_proceeds: 17480, recording_status: 'recorded', recording_instrument_id: 'Doc #A11398420', recorded_at: at(-D), recording_jurisdiction: 'Hennepin County, MN' }],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-18 * D) }, { milestone_type: 'title_opened', occurred_at: at(-20 * D) }, { milestone_type: 'buyer_committed', occurred_at: at(-15 * D) }, { milestone_type: 'closing_scheduled', occurred_at: at(-9 * D) }, { milestone_type: 'clear_to_close', occurred_at: at(-4 * D) }, { milestone_type: 'closed', occurred_at: at(-2 * D + 3 * H), actor: 'operator' }],
      runtime,
    },
    {
      scenario: 'emd_received_unverified',
      closingCase: base(7, { ...executed, ...titled, ...ack(at(-4 * D)), universal_stage: 'under_contract', closing_status: 'in_title', title_commitment_received_at: at(-D), title_commitment_evidence: 'Commitment WT-26-11903 v1', property_address: '918 Cedar Lake Rd S, Minneapolis, MN 55416', seller_contract_price: 312000, earnest_money: 3000, scheduled_closing_date: date(12), escrow_file_number: 'WT-26-11903', signer_name: 'Evelyn Brooks' }),
      opportunity: opportunity(7, 'under_contract', 'Evelyn Brooks'),
      property: property(7, '918 Cedar Lake Rd S, Minneapolis, MN 55416'),
      activity: [deposit(7, 3000, 'Seller-contract EMD wire #10477')],
      offers: [committedBuyer(7, { committed_at: at(-5 * D), offer_price: 339000, emd_amount: 10000, emd_due_date: day(1) })],
      agreements: [agreement(7, { status: 'fully_executed', executed_at: at(-5 * D) })],
      emdReceipts: [receipt(7, { status: 'received_unverified', amount: 10000, received_at: at(-6 * H), verified_at: null, verified_by: null, verification_method: null, evidence_reference: null, source: 'manual_operator' })],
      emailRequests: [titleOpenSent(7)],
      emailThreads: [titleThread(7, { last_message_at: at(-D), last_message_direction: 'inbound', last_message_preview: 'Commitment attached for 918 Cedar Lake Rd S.', last_inbound_at: at(-D) })],
      runtime,
    },
    {
      scenario: 'date_passed_not_closed',
      closingCase: base(8, { ...executed, ...titled, ...ack(at(-9 * D)), ...ctc(8, at(-3 * D)), ...confirmedOn(at(-6 * D)), universal_stage: 'prepared_to_close', title_commitment_received_at: at(-5 * D), title_commitment_evidence: 'Commitment WT-26-11761 v1', property_address: '2600 Lyndale Ave N, Minneapolis, MN 55411', seller_contract_price: 158000, scheduled_closing_date: ct2pm(-1), escrow_file_number: 'WT-26-11761', signer_name: 'Dwayne Carter' }),
      opportunity: opportunity(8, 'prepared_to_close', 'Dwayne Carter'),
      property: property(8, '2600 Lyndale Ave N, Minneapolis, MN 55411'),
      offers: [committedBuyer(8, { committed_at: at(-9 * D), offer_price: 176000, emd_amount: 5000 })],
      agreements: [agreement(8, { status: 'fully_executed', executed_at: at(-9 * D) })],
      emdReceipts: [receipt(8)],
      emailRequests: [titleOpenSent(8), request(8, 'settlement', 1, { ...sentAt(new Date(Date.parse(ct2pm(-1)) - 36 * H).toISOString()) }), request(8, 'settlement', 2, { ...sentAt(new Date(Date.parse(ct2pm(-1)) - 24 * H).toISOString()) }), request(8, 'settlement', 3, { ...sentAt(new Date(Date.parse(ct2pm(-1)) - 12 * H).toISOString()) })],
      emailThreads: [titleThread(8, { last_message_at: at(-D - 4 * H), last_message_direction: 'inbound', last_message_preview: 'Buyer’s funds did not arrive; we are rescheduling — will confirm a new date.', last_inbound_at: at(-D - 4 * H) })],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-9 * D) }, { milestone_type: 'closing_scheduled', occurred_at: at(-6 * D) }],
      runtime,
    },
    {
      scenario: 'cancelled',
      closingCase: base(9, { ...executed, ...titled, title_company_selected_at: at(-19 * D), title_intro_sent_at: at(-19 * D + H), ...ack(at(-18 * D)), accepted_at: at(-22 * D), envelope_sent_at: at(-21 * D), contract_signed_date: at(-20 * D), universal_stage: 'under_contract', closing_status: 'in_title', property_address: '1719 E 38th St, Minneapolis, MN 55407', seller_contract_price: 144000, terminal_outcome: 'cancelled', terminal_reason: 'Seller cannot deliver clear title — estate in probate; mutual release signed', terminal_at: at(-3 * D), terminal_actor: 'Ryan K. (operator)', signer_name: 'Estate of R. Olson', updated_at: at(-3 * D), created_at: at(-22 * D) }),
      opportunity: { ...opportunity(9, 'under_contract', 'Estate of R. Olson'), opportunity_status: 'lost' },
      property: property(9, '1719 E 38th St, Minneapolis, MN 55407'),
      titleIssues: [{ issue_id: `title_issue:${caseId(9)}:probate`, closing_case_id: caseId(9), issue_type: 'probate', status: 'open', description: 'Owner deceased; no personal representative appointed', owner: 'seller', source: 'title_commitment', evidence_reference: 'Commitment WT-26-11620 Sch. B-I #3', opened_at: at(-10 * D), opened_by: 'email_command' }],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-20 * D) }, { milestone_type: 'title_opened', occurred_at: at(-18 * D) }],
      runtime,
    },
    {
      scenario: 'title_issue_automation_paused',
      closingCase: base(10, { ...executed, ...titled, ...ack(at(-6 * D)), ...confirmedOn(at(-4 * D)), universal_stage: 'under_contract', title_commitment_received_at: at(-2 * D), title_commitment_evidence: 'Commitment WT-26-11901 v1', property_address: '1532 Fremont Ave N, Minneapolis, MN 55411', seller_contract_price: 167000, earnest_money: 1500, scheduled_closing_date: ct2pm(6), escrow_file_number: 'WT-26-11901', signer_name: 'Beatrice Lund', automation_paused_at: at(-D), automation_paused_reason: 'Unreleased mortgage — needs operator direction', automation_paused_by: 'Ryan K. (operator)' }),
      opportunity: opportunity(10, 'under_contract', 'Beatrice Lund'),
      property: property(10, '1532 Fremont Ave N, Minneapolis, MN 55411'),
      activity: [deposit(10, 1500, 'Seller-contract EMD wire #10455'), { event_type: 'automation_paused', actor: 'Ryan K. (operator)', source: 'operator', detail: { reason: 'Unreleased mortgage — needs operator direction' }, idempotency_key: 'automation_paused:10', created_at: at(-D) }],
      offers: [committedBuyer(10, { committed_at: at(-5 * D), offer_price: 186000, emd_amount: 5000, emd_due_date: day(-4) })],
      agreements: [agreement(10, { status: 'fully_executed', executed_at: at(-5 * D) })],
      emdReceipts: [receipt(10)],
      titleIssues: [{ issue_id: `title_issue:${caseId(10)}:missing_release`, closing_case_id: caseId(10), issue_type: 'missing_release', status: 'open', description: 'Unreleased 2019 mortgage — First Federal S&L; payoff letter requested', owner: 'you', source: 'title_commitment', evidence_reference: 'Commitment WT-26-11901 Sch. B-I #6', opened_at: at(-2 * D), opened_by: 'email_command' }],
      emailRequests: [titleOpenSent(10), request(10, `closing_confirmation:${new Date(Date.parse(ct2pm(6))).toISOString()}`, 1, { ...sentAt(at(-4 * D + 10 * M)) })],
      emailThreads: [titleThread(10, { last_message_at: at(-2 * D), last_message_direction: 'inbound', last_message_preview: 'Schedule B-I #6: 2019 mortgage to First Federal is unreleased — we need a payoff or release.', last_inbound_at: at(-2 * D) })],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-9 * D) }, { milestone_type: 'title_opened', occurred_at: at(-6 * D) }, { milestone_type: 'buyer_committed', occurred_at: at(-5 * D) }, { milestone_type: 'closing_scheduled', occurred_at: at(-4 * D) }],
      runtime,
    },
    {
      scenario: 'closed_no_settlement',
      closingCase: base(11, { ...executed, universal_stage: 'closed', closing_status: 'closed', closed_at: at(-40 * D), closed_by: 'legacy closing workflow', property_address: '4127 Upton Ave S, Minneapolis, MN 55410', seller_contract_price: 229000, assignment_fee: 16500, scheduled_closing_date: ct2pm(-40), provenance: { source: 'legacy_closing_workflow' }, signer_name: 'Janet Holm', updated_at: at(-40 * D), created_at: at(-70 * D), contract_signed_date: at(-60 * D), accepted_at: at(-62 * D), envelope_sent_at: at(-61 * D) }),
      opportunity: { ...opportunity(11, 'closed', 'Janet Holm'), opportunity_status: 'won' },
      property: property(11, '4127 Upton Ave S, Minneapolis, MN 55410'),
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-60 * D) }, { milestone_type: 'closed', occurred_at: at(-40 * D), actor: 'legacy closing workflow' }],
      runtime,
    },
    {
      scenario: 'closing_soon_waiting_title',
      closingCase: base(12, { ...executed, ...titled, ...ack(at(-8 * D)), ...confirmedOn(at(-2 * D)), universal_stage: 'under_contract', title_commitment_received_at: at(-20 * H), title_commitment_evidence: 'Commitment WT-26-11915 v1 (email attachment)', property_address: '2931 Girard Ave N, Minneapolis, MN 55411', seller_contract_price: 174000, earnest_money: 1500, scheduled_closing_date: ct2pm(4), escrow_file_number: 'WT-26-11915', signer_name: 'Curtis Bell' }),
      opportunity: opportunity(12, 'under_contract', 'Curtis Bell'),
      property: property(12, '2931 Girard Ave N, Minneapolis, MN 55411'),
      activity: [deposit(12, 1500, 'Seller-contract EMD wire #10466')],
      offers: [committedBuyer(12, { committed_at: at(-6 * D), offer_price: 195000, emd_amount: 5000, emd_due_date: day(-4) })],
      agreements: [agreement(12, { status: 'fully_executed', executed_at: at(-6 * D) })],
      emdReceipts: [receipt(12)],
      emailRequests: [
        titleOpenSent(12),
        request(12, 'title_commitment', 1, { ...sentAt(at(-3 * D)) }),
        // Planned, then voided at dispatch: title replied before it went out (email-send-safety: counterparty_replied).
        request(12, 'title_commitment', 2, { requested_at: at(-2 * D), due_at: at(-2 * D), claimed_at: at(-2 * D + M), sent_at: null, status: 'cancelled', status_reason: 'counterparty_replied', delivery_status: null, updated_at: at(-2 * D + 40 * M) }),
        request(12, `closing_confirmation:${new Date(Date.parse(ct2pm(4))).toISOString()}`, 1, { ...sentAt(at(-2 * D + 10 * M)) }),
      ],
      emailThreads: [titleThread(12, { last_message_at: at(-20 * H), last_message_direction: 'inbound', last_message_preview: 'Attached: title commitment for 2931 Girard Ave N (WT-26-11915). Clear to close expected Friday.', last_inbound_at: at(-20 * H), last_outbound_at: at(-2 * D + 10 * M) })],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-9 * D) }, { milestone_type: 'buyer_committed', occurred_at: at(-6 * D) }, { milestone_type: 'closing_scheduled', occurred_at: at(-2 * D) }],
      runtime,
    },
    {
      scenario: 'title_order_awaiting_ack',
      closingCase: base(13, { ...executed, ...titled, title_company_selected_at: at(-11 * H), title_intro_sent_at: at(-10 * H), universal_stage: 'under_contract', closing_status: 'title_pending', property_address: '3530 Humboldt Ave N, Minneapolis, MN 55412', seller_contract_price: 139000, earnest_money: 1000, scheduled_closing_date: date(21), signer_name: 'Ronald Fisk', contract_signed_date: at(-2 * D), accepted_at: at(-4 * D), envelope_sent_at: at(-3 * D) }),
      opportunity: opportunity(13, 'under_contract', 'Ronald Fisk'),
      property: property(13, '3530 Humboldt Ave N, Minneapolis, MN 55412'),
      activity: [deposit(13, 1000, 'Seller-contract EMD wire #10491')],
      offers: [committedBuyer(13, { committed_at: at(-D), offer_price: 158000, emd_amount: 4000, emd_due_date: day(-1) })],
      agreements: [agreement(13, { status: 'fully_executed', sent_at: at(-2 * D), executed_at: at(-D) })],
      emdReceipts: [receipt(13, { amount: 4000, received_at: at(-20 * H), verified_at: at(-18 * H) })],
      emailRequests: [request(13, 'title_open', 1, { ...sentAt(at(-10 * H)) })],
      emailThreads: [titleThread(13, { last_message_at: at(-10 * H + 2 * M), last_message_direction: 'outbound', last_message_preview: 'New order: 3530 Humboldt Ave N — assignment, target close Oct 21.', last_outbound_at: at(-10 * H + 2 * M) })],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-2 * D) }, { milestone_type: 'buyer_committed', occurred_at: at(-D) }],
      runtime,
    },
  ]
}
