/**
 * CLOSING EXECUTION SCENARIOS — raw canonical rows (closing_cases +
 * buyer_offers + buyer_agreements + emd_receipts + settlement_records +
 * closing_milestones) for every execution state the desk must render.
 *
 * Production holds no live closings (1 voided case), so these are the only
 * populated examples. They are RAW ROWS, run through the real derivation —
 * the tests pin truth rules against them and scripts/gen-closing-demo.mjs
 * turns them into the dashboard's clearly-labelled ?demo=1 data. They are
 * never served by the API.
 */
const H = 3_600_000
const D = 24 * H

export function closingScenarios(now = Date.parse('2026-09-29T15:00:00Z')) {
  const at = (ms) => new Date(now + ms).toISOString()
  const date = (days) => `${new Date(now + days * D).toISOString().slice(0, 10)}T00:00:00+00:00`
  // 2:00 PM CT (19:00Z during CDT) on day +n
  const ct2pm = (days) => `${new Date(now + days * D).toISOString().slice(0, 10)}T19:00:00+00:00`
  const base = (n, over = {}) => ({
    closing_case_id: `closing:00000000-0000-4000-8000-00000000000${n}`,
    opportunity_id: `00000000-0000-4000-8000-00000000000${n}`,
    property_id: `demo-property-${n}`,
    master_owner_id: `demo-owner-${n}`,
    thread_key: `+1612555010${n}`,
    universal_stage: 'formal_contract',
    closing_status: 'not_scheduled',
    contract_status: 'draft',
    readiness: {},
    provenance: {},
    created_at: at(-12 * D),
    updated_at: at(-2 * H),
    ...over,
  })
  const offer = (n, over = {}) => ({
    buyer_offer_id: `offer:demo-${n}`, offer_version: 1, opportunity_id: `00000000-0000-4000-8000-00000000000${n}`,
    buyer_id: `buyer:demo-${n}`, status: 'selected', commitment_status: 'agreement_required', strategy: 'assignment',
    emd_status: 'required', submitted_at: at(-6 * D), selected_at: at(-5 * D), selected_by: 'operator',
    metadata: { buyer_name: ['Northline Capital LLC', 'Acme Investments LLC', 'Cobalt Homes Inc', 'Ridgeway Holdings LLC', 'Summit Street Properties LLC', 'Lakeside Equity Group LLC', 'Ironwood Partners LLC', 'Harbor & Vine LLC', 'Meridian Residential LLC'][n - 1] },
    updated_at: at(-D),
    ...over,
  })
  const agreement = (n, over = {}) => ({
    agreement_id: `agreement:demo-${n}`, agreement_version: 1, agreement_type: 'assignment_agreement',
    opportunity_id: `00000000-0000-4000-8000-00000000000${n}`, buyer_offer_id: `offer:demo-${n}`, buyer_id: `buyer:demo-${n}`,
    provider: 'DocuSign', provider_envelope_id: `env-demo-${n}`, status: 'sent', sent_at: at(-4 * D), created_at: at(-4 * D),
    ...over,
  })
  const receipt = (n, over = {}) => ({
    receipt_id: `emd:demo-${n}`, closing_case_id: `closing:00000000-0000-4000-8000-00000000000${n}`,
    buyer_id: `buyer:demo-${n}`, buyer_offer_id: `offer:demo-${n}`, amount: 5000, currency: 'USD',
    escrow_destination: 'Title escrow', status: 'verified', received_at: at(-3 * D), verified_at: at(-3 * D + 2 * H),
    verified_by: 'operator', verification_method: 'title_provider', evidence_reference: 'EMD wire confirmation #48213',
    source: 'title_provider',
    ...over,
  })
  const titled = {
    title_company_key: 'westline_title__minneapolis', title_company_name: 'Westline Title', title_company_email: 'orders@westline-title.example',
    title_route_market: 'Minneapolis, MN', title_route_status: 'routed', title_company_selected_at: at(-7 * D), title_intro_sent_at: at(-7 * D + H),
  }
  const executed = { contract_status: 'fully_executed', universal_stage: 'disposition', closing_status: 'title_pending', accepted_at: at(-10 * D), envelope_sent_at: at(-9 * D), contract_signed_date: at(-8 * D), docusign_envelope_id: 'env-seller' }

  return [
    {
      scenario: 'contract_out_for_signature',
      closingCase: base(1, { property_address: '4418 Colfax Ave N, Minneapolis, MN 55412', contract_status: 'sent_for_signature', docusign_envelope_id: 'env-1', envelope_sent_at: at(-D), accepted_at: at(-2 * D), seller_contract_price: 182000, earnest_money: 1000, emd_due_date: date(4), signer_name: 'Denise Carter', scheduled_closing_date: date(24) }),
    },
    {
      scenario: 'buyer_selected_agreement_sent',
      closingCase: base(2, { ...executed, ...titled, title_status: 'ordered', property_address: '3315 Aldrich Ave N, Minneapolis, MN 55412', seller_contract_price: 150000, earnest_money: 1000, emd_due_date: date(-6), scheduled_closing_date: date(16) }),
      activity: [{ event_type: 'contract_emd_deposited', actor: 'operator', source: 'operator', detail: { amount: 1000, deposited_at: at(-9 * D), evidence: 'Seller-contract EMD wire #10231', escrow: 'Title escrow' }, idempotency_key: 'contract_emd_deposited:closing:2', created_at: at(-9 * D) }],
      offers: [offer(2, { offer_price: 171000, emd_amount: 5000, emd_due_date: date(2).slice(0, 10), commitment_status: 'agreement_sent' })],
      agreements: [agreement(2)],
      emdReceipts: [],
    },
    {
      scenario: 'committed_waiting_on_title',
      closingCase: base(3, { ...executed, ...titled, universal_stage: 'under_contract', closing_status: 'in_title', title_status: 'opened', title_opened_date: at(-3 * D), title_commitment_date: date(1), property_address: '2718 Emerson Ave S, Minneapolis, MN 55408', seller_contract_price: 238000, earnest_money: 2500, scheduled_closing_date: date(9), escrow_file_number: 'WT-26-11842' }),
      activity: [{ event_type: 'contract_emd_deposited', actor: 'operator', source: 'operator', detail: { amount: 2500, deposited_at: at(-9 * D), evidence: 'Seller-contract EMD wire #10388', escrow: 'Title escrow' }, idempotency_key: 'contract_emd_deposited:closing:3', created_at: at(-9 * D) }],
      offers: [offer(3, { status: 'committed', commitment_status: 'committed', committed_at: at(-3 * D), offer_price: 262000, emd_amount: 5000, emd_due_date: date(-3).slice(0, 10), pof_status: 'verified', pof_reference: 'POF — bank letter 09/22', pof_verified_at: at(-5 * D), pof_verified_by: 'operator' })],
      agreements: [agreement(3, { status: 'fully_executed', executed_at: at(-3 * D) })],
      emdReceipts: [receipt(3)],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-8 * D), actor: 'docusign' }, { milestone_type: 'title_opened', occurred_at: at(-3 * D), actor: 'title' }],
    },
    {
      scenario: 'ready_to_close_tomorrow',
      closingCase: base(4, { ...executed, ...titled, universal_stage: 'prepared_to_close', closing_status: 'scheduled', title_status: 'opened', title_opened_date: at(-6 * D), readiness: { clear_to_close: true }, property_address: '1204 Penn Ave N, Minneapolis, MN 55411', seller_contract_price: 196000, earnest_money: 2000, assignment_fee: 21500, scheduled_closing_date: ct2pm(1), escrow_file_number: 'WT-26-11790' }),
      activity: [{ event_type: 'contract_emd_deposited', actor: 'operator', source: 'operator', detail: { amount: 2000, deposited_at: at(-9 * D), evidence: 'Seller-contract EMD wire #10301', escrow: 'Title escrow' }, idempotency_key: 'contract_emd_deposited:closing:4', created_at: at(-9 * D) }],
      offers: [offer(4, { status: 'committed', commitment_status: 'committed', committed_at: at(-6 * D), offer_price: 217500, emd_amount: 5000, emd_due_date: date(-5).slice(0, 10) })],
      agreements: [agreement(4, { status: 'fully_executed', executed_at: at(-6 * D) })],
      emdReceipts: [receipt(4)],
      settlements: [{ settlement_id: 'settlement:demo-4', closing_case_id: 'closing:00000000-0000-4000-8000-000000000004', leg: 'single', strategy: 'assignment', settlement_status: 'pending', funding_status: 'expected', settlement_statement_type: 'alta', settlement_statement_reference: 'ALTA draft v2 — Westline Title', closing_provider: 'Westline Title' }],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-8 * D) }, { milestone_type: 'title_opened', occurred_at: at(-6 * D) }, { milestone_type: 'closing_scheduled', occurred_at: at(-2 * D) }],
    },
    {
      scenario: 'closing_tomorrow_emd_overdue',
      closingCase: base(5, { ...executed, ...titled, universal_stage: 'prepared_to_close', closing_status: 'scheduled', title_status: 'opened', title_opened_date: at(-5 * D), title_commitment_date: date(-1), property_address: '3847 Bloomington Ave, Minneapolis, MN 55407', seller_contract_price: 171000, earnest_money: 1500, scheduled_closing_date: ct2pm(1) }),
      activity: [{ event_type: 'contract_emd_deposited', actor: 'operator', source: 'operator', detail: { amount: 1500, deposited_at: at(-9 * D), evidence: 'Seller-contract EMD wire #10412', escrow: 'Title escrow' }, idempotency_key: 'contract_emd_deposited:closing:5', created_at: at(-9 * D) }],
      offers: [offer(5, { status: 'committed', commitment_status: 'committed', committed_at: at(-4 * D), offer_price: 189000, emd_amount: 5000, emd_due_date: date(-1).slice(0, 10), emd_status: 'received', emd_received_at: at(-D) /* proposal field — must NOT count */ })],
      agreements: [agreement(5, { status: 'fully_executed', executed_at: at(-4 * D) })],
      emdReceipts: [],
    },
    {
      scenario: 'closed_settled',
      closingCase: base(6, { ...executed, ...titled, universal_stage: 'closed', closing_status: 'closed', title_status: 'opened', readiness: { clear_to_close: true }, title_opened_date: at(-20 * D), property_address: '5021 34th Ave S, Minneapolis, MN 55417', seller_contract_price: 205000, earnest_money: 2000, assignment_fee: 18000, scheduled_closing_date: ct2pm(-2), recording_date: at(-D), updated_at: at(-D) }),
      offers: [offer(6, { status: 'committed', commitment_status: 'committed', committed_at: at(-15 * D), offer_price: 223000, emd_amount: 5000, emd_due_date: date(-14).slice(0, 10) })],
      agreements: [agreement(6, { status: 'fully_executed', executed_at: at(-15 * D) })],
      emdReceipts: [receipt(6, { received_at: at(-14 * D), verified_at: at(-14 * D + H) })],
      settlements: [{ settlement_id: 'settlement:demo-6', closing_case_id: 'closing:00000000-0000-4000-8000-000000000006', leg: 'single', strategy: 'assignment', settlement_status: 'settled', funding_status: 'disbursed', funded_amount: 223000, disbursed_amount: 17480, funded_at: at(-2 * D + 2 * H), closed_at: at(-2 * D + 3 * H), closing_provider: 'Westline Title', verified_by: 'operator', verified_at: at(-2 * D + 5 * H), verification_method: 'title_provider', evidence_reference: 'Final ALTA — WT-26-11355', settlement_statement_type: 'alta', settlement_statement_reference: 'Final ALTA — WT-26-11355', actual_seller_amount: 205000, actual_buyer_amount: 223000, actual_assignment_fee: 17480, actual_closing_costs: 520, actual_other_costs: 0, actual_net_proceeds: 17480, recording_status: 'recorded', recording_instrument_id: 'Doc #A11398420', recorded_at: at(-D), recording_jurisdiction: 'Hennepin County, MN' }],
      milestones: [{ milestone_type: 'contract_fully_executed', occurred_at: at(-18 * D) }, { milestone_type: 'title_opened', occurred_at: at(-20 * D) }, { milestone_type: 'closing_scheduled', occurred_at: at(-8 * D) }, { milestone_type: 'closed', occurred_at: at(-2 * D + 3 * H) }],
    },
    {
      scenario: 'prepared_no_date',
      closingCase: base(7, { ...executed, ...titled, universal_stage: 'prepared_to_close', closing_status: 'in_title', title_status: 'opened', title_opened_date: at(-4 * D), property_address: '918 Cedar Lake Rd S, Minneapolis, MN 55416', seller_contract_price: 312000, earnest_money: 3000 }),
      offers: [offer(7, { status: 'committed', commitment_status: 'committed', committed_at: at(-5 * D), offer_price: 339000, emd_amount: 10000, emd_due_date: date(-4).slice(0, 10) })],
      agreements: [agreement(7, { status: 'fully_executed', executed_at: at(-5 * D) })],
      emdReceipts: [receipt(7, { status: 'received_unverified', verified_at: null, verified_by: null, verification_method: null, amount: 10000 })],
    },
    {
      scenario: 'date_passed_not_closed',
      closingCase: base(8, { ...executed, ...titled, universal_stage: 'prepared_to_close', closing_status: 'scheduled', title_status: 'opened', readiness: { clear_to_close: true }, property_address: '2600 Lyndale Ave N, Minneapolis, MN 55411', seller_contract_price: 158000, scheduled_closing_date: ct2pm(-1) }),
      offers: [offer(8, { status: 'committed', commitment_status: 'committed', committed_at: at(-9 * D), offer_price: 176000, emd_amount: 5000 })],
      agreements: [agreement(8, { status: 'fully_executed', executed_at: at(-9 * D) })],
      emdReceipts: [receipt(8)],
    },
    {
      scenario: 'cancelled',
      closingCase: base(9, { contract_status: 'cancelled', property_address: '1719 E 38th St, Minneapolis, MN 55407', provenance: { voided: true }, updated_at: at(-3 * D) }),
    },
  ]
}
