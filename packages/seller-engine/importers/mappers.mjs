// Canonical mappers per file set. Raw source values preserved (raw field +
// source_records payload); normalized views added beside them; deterministic
// identities; no destructive merges (every observation is a row keyed by batch).
import { parseBool, parseNumber, parseCategorical, priceQualifierClass, blanketLoanGuard, RULES, STATES } from '../lib/sentinels.mjs';

const propId = (ctx, vendorId) => ctx.id('prop', vendorId);

// ---------- properties ----------
export function mapProperty(rec, ctx) {
  const pid = propId(ctx, rec.property_id);
  const value = parseNumber(rec.estimated_value).value;
  ctx.emit('properties', {
    id: pid, vendor_property_id: rec.property_id, apn_parcel_id: rec.apn_parcel_id || null,
    fips: rec.fips || null,
    situs_address_full: rec.property_address_full || null,
    situs_state: rec.property_address_state || null, situs_zip: String(rec.property_address_zip ?? '') || null,
    situs_county: rec.property_address_county_name || null,
    latitude: parseNumber(rec.latitude).value, longitude: parseNumber(rec.longitude).value,
    property_use_standardized: rec.property_use_standardized || null,
    property_use_raw: rec.property_use || null,
    asset_class: assetClass(rec.property_use_standardized, rec.property_type),
    year_built: parseNumber(rec.year_built, RULES.year_built).value,
    effective_year_built: parseNumber(rec.EffectiveYearBuilt, RULES.year_built).value,
    building_square_feet: parseNumber(rec.building_square_feet).value,
    lot_square_feet: parseNumber(rec.lot_square_feet).value,
    units_count: parseNumber(rec.units_count).value,
    condition_raw: rec.building_condition || null,
    condition_state: parseCategorical(rec.building_condition).state,
    quality_raw: rec.BuildingQuality || null,
    import_batch_id: ctx.batchId,
    raw_keep: pick(rec, ['estimated_value', 'estimated_equity', 'equity_percent', 'TaxDelinquent',
      'TaxDelinquentYear', 'TaxAmt', 'is_vacant', 'is_trust', 'corp_owner', 'is_corporate_owner',
      'owner_status', 'owner_location', 'property_flags', 'lien_doc_categories', 'sale_date',
      'sale_price', 'CurrentSalesPriceCode', 'CurrentSaleDocumentType', 'PrevSaleDocumentType',
      'PrevSalesPrice', 'PrevSalesPriceCode', 'PrevSaleContractDate', 'saledate',
      'owner_name', 'owner_hash', 'owner_address_full', 'owner_address_state', 'owner_address_zip',
      'Owner1OwnershipRights', 'AuctionDate', 'preforeclosure_type', 'preforeclosure_status',
      'foreclosure_data.DocumentType', 'foreclosure_data.AuctionDate', 'foreclosure_data.DefaultDate',
      'foreclosure_data.UnpaidBalance', 'foreclosure_data.AuctionMinimumBidAmount', 'foreclosure_data.foreclosure_id',
      'foreclosure_data.RecordingDate', 'mls.days_on_market', 'is_mls_active', 'order_score',
      // Phase 3.5 feature-completion fields
      'HeatingType', 'HeatingFuelType', 'AirConditioning', 'RoofCover', 'RoofType',
      'ConstructionType', 'Basement', 'estimated_repair_cost', 'estimated_repair_cost_per_sqft_number',
      'owner_2_name', 'MailingCOName', 'owner_address_line_1', 'owner_address_city',
      'lender_name', 'TotalOpenLienNbr', 'owner_has_multiple_properties']),
  });

  // valuation snapshot essentials
  const equityPct = parseNumber(rec.equity_percent, RULES.equity_percent);
  ctx.emit('property_valuation_tax_snapshots', {
    id: ctx.id('val', pid, ctx.batchId),
    property_id: pid, as_of: rec.scraped_at ?? null,
    estimated_value: value,
    estimated_equity: parseNumber(rec.estimated_equity).value,
    equity_percent: equityPct.value, equity_percent_state: equityPct.state,
    tax_amount: parseNumber(rec.TaxAmt).value,
    tax_delinquent: parseBool(rec.TaxDelinquent).value,
    tax_delinquent_year: parseNumber(rec.TaxDelinquentYear).value,
    import_batch_id: ctx.batchId,
  });

  // ownership
  ctx.emit('property_ownerships', {
    id: ctx.id('own', pid, rec.owner_hash ?? rec.owner_name ?? '', ctx.batchId),
    property_id: pid, owner_slot: 1,
    owner_name_raw: rec.owner_name || null, owner_hash: rec.owner_hash || null,
    mailing_address_full: rec.owner_address_full || null,
    mailing_state: rec.owner_address_state || null,
    vesting_raw: rec.Owner1OwnershipRights || null,
    occupancy_raw: rec.owner_status || rec.owner_location || null,
    import_batch_id: ctx.batchId,
  });
  // OD-2 multi-state classifications from independent evidence
  const clsEmit = (classification, source, confidence) => ctx.emit('ownership_classifications', {
    id: ctx.id('ocl', pid, classification, source, ctx.batchId),
    ownership_id: ctx.id('own', pid, rec.owner_hash ?? rec.owner_name ?? '', ctx.batchId),
    classification, evidence_source: source, confidence,
    effective_at: rec.scraped_at ?? null, import_batch_id: ctx.batchId,
  });
  if (String(rec.owner_status).includes('Corporate')) clsEmit('corporate', 'owner_status', 'high');
  if (parseBool(rec.is_corporate_owner).value === true) clsEmit('corporate', 'is_corporate_owner', 'medium');
  if (parseBool(rec.is_trust).value === true) clsEmit('trust', 'is_trust', 'high');
  if (/trust/i.test(rec.Owner1OwnershipRights ?? '')) clsEmit('trust', 'vesting', 'medium');
  if (/estate|executor|administrator|surviving/i.test(rec.Owner1OwnershipRights ?? '')) clsEmit('estate', 'vesting', 'medium');
  const co = parseBool(rec.corp_owner).value;
  if (co === true) clsEmit('corporate', 'corp_owner', 'medium');
  // conflict feature source (F-104): corp definitions disagree
  const icorp = parseBool(rec.is_corporate_owner).value;
  if (co !== null && icorp !== null && co !== icorp) {
    ctx.conflict('corp_class_conflict', { property_id: pid, corp_owner: co, is_corporate_owner: icorp });
  }

  // loans: slots -> child rows; flattened copies -> checksums (OD-12)
  const slots = [
    ['current_recorded', 1, 'Mtg1LoanAmt', 'Mtg1EstLoanBalance', 'Mtg1EstInterestRate', 'Mtg1Term', 'Mtg1RecordingDate', 'Mtg1LoanDueDate', 'Mtg1LoanType', 'Mtg1TypeFinancing', 'Mtg1Lender', 'Mtg1LienPosition'],
    ['current_recorded', 2, 'Mtg2LoanAmt', 'Mtg2EstLoanBalance', 'Mtg2EstInterestRate', 'Mtg2Term', 'Mtg2RecordingDate', 'Mtg2LoanDueDate', 'Mtg2LoanType', 'Mtg2TypeFinancing', 'Mtg2Lender', 'Mtg2LienPosition'],
    ['current_recorded', 3, 'Mtg3LoanAmt', 'Mtg3EstLoanBalance', 'Mtg3EstInterestRate', 'Mtg3Term', 'Mtg3RecordingDate', 'Mtg3LoanDueDate', 'Mtg3LoanType', 'Mtg3TypeFinancing', 'Mtg3Lender', 'Mtg3LienPosition'],
    ['current_recorded', 4, 'Mtg4LoanAmt', 'Mtg4EstLoanBalance', 'Mtg4EstInterestRate', 'Mtg4Term', 'Mtg4RecordingDate', 'Mtg4LoanDueDate', 'Mtg4LoanType', 'Mtg4TypeFinancing', 'Mtg4Lender', 'Mtg4LienPosition'],
    ['concurrent', 1, 'ConcurrentMtg1LoanAmt', null, 'ConcurrentMtg1InterestRate', 'ConcurrentMtg1Term', 'ConcurrentMtg1RecordingDate', 'ConcurrentMtg1LoanDueDate', 'ConcurrentMtg1LoanType', 'ConcurrentMtg1TypeFinancing', 'ConcurrentMtg1Lender', null],
    ['concurrent', 2, 'ConcurrentMtg2LoanAmt', null, 'ConcurrentMtg2InterestRate', 'ConcurrentMtg2Term', 'ConcurrentMtg2RecordingDate', 'ConcurrentMtg2LoanDueDate', 'ConcurrentMtg2LoanType', 'ConcurrentMtg2Typefinancing', 'ConcurrentMtg2Lender', null],
    ['previous', 1, 'PrevMtg1LoanAmt', null, 'PrevMtg1InterestRate', 'PrevMtg1Term', 'PrevMtg1RecordingDate', 'PrevMtg1LoanDueDate', 'PrevMtg1LoanType', 'PrevMtg1TypeFinancing', 'PrevMtg1Lender', null],
  ];
  let slotCount = 0;
  for (const [cls, ord, amt, bal, rate, term, recDate, due, ltype, ftype, lender, pos] of slots) {
    const amount = parseNumber(rec[amt]).value;
    const balance = bal ? parseNumber(rec[bal], RULES.loan_balance) : { value: null, state: STATES.NOT_APPLICABLE };
    const hasLoan = (amount !== null && amount > 0) || (balance.value !== null && balance.value > 0)
      || (rec[recDate] ?? '') !== '' || (rec[ltype] ?? '') !== '';
    if (!hasLoan) continue;
    slotCount += (cls === 'current_recorded' && amount > 0) ? 1 : 0;
    const termP = parseNumber(rec[term], RULES.loan_term_months);
    const rateP = parseNumber(rec[rate], RULES.interest_rate);
    ctx.emit('property_loans', {
      id: ctx.id('loan', pid, cls, ord, ctx.batchId),
      property_id: pid, slot_class: cls, slot_ordinal: ord,
      lien_position: pos ? parseNumber(rec[pos]).value : null,
      original_loan_amount: amount,
      estimated_balance: balance.value, estimated_balance_state: balance.state,
      estimated_interest_rate: rateP.value, interest_rate_state: rateP.state,
      term_months: termP.value, term_state: termP.state,
      recording_date: rec[recDate] || null, due_date: rec[due] || null,
      loan_type_raw: rec[ltype] || null, financing_type_raw: rec[ftype] || null,
      lender_name: rec[lender] || null,
      blanket_loan_flag: blanketLoanGuard(balance.value ?? amount, value),
      import_batch_id: ctx.batchId,
    });
  }
  const numMtg = parseNumber(rec.NumOfMortgages).value;
  ctx.emit('loan_checksums', {
    property_id: pid,
    total_loan_amount: parseNumber(rec.TotalLoanAmt).value,
    total_loan_balance: parseNumber(rec.TotalLoanBalance).value,
    total_loan_payment: parseNumber(rec.TotalLoanPayment).value,
    num_of_mortgages: numMtg,
    total_open_lien_nbr: parseNumber(rec.TotalOpenLienNbr).value,
    owner_has_multiple_properties: parseBool(rec.owner_has_multiple_properties).value,
    conflict_flags: numMtg !== null && numMtg !== slotCount && !(numMtg === 0 && slotCount === 0)
      ? ['num_of_mortgages_vs_slots'] : [],
    import_batch_id: ctx.batchId,
  });
  if (numMtg !== null && numMtg !== slotCount) {
    ctx.conflict('agg_conflict_loan_count', { property_id: pid, vendor: numMtg, slots: slotCount });
  }

  // transactions (current + previous), qualifier-gated
  for (const [role, dateF, priceF, qualF, docF, txnF] of [
    ['current', rec.sale_date || rec.saledate, rec.sale_price ?? rec.saleprice, rec.CurrentSalesPriceCode, rec.CurrentSaleDocumentType, rec.CurrentSaleTransactionID],
    ['previous', rec.PrevSaleContractDate || rec.PrevSaleRecordingDate, rec.PrevSalesPrice, rec.PrevSalesPriceCode, rec.PrevSaleDocumentType, rec.PrevSaleTransactionID],
  ]) {
    if (!dateF && !priceF && !docF) continue;
    ctx.emit('property_transactions', {
      id: ctx.id('txn', pid, role, txnF ?? dateF ?? '', ctx.batchId),
      property_id: pid, vendor_transaction_id: txnF || null, event_role: role,
      sale_date: dateF || null, sale_price: parseNumber(priceF).value,
      price_qualifier_raw: qualF || null, price_qualifier_class: priceQualifierClass(qualF),
      document_type_raw: docF || null, document_type_group: deedGroup(docF),
      import_batch_id: ctx.batchId,
    });
  }

  // foreclosure event snapshot (episode header derived at feature time)
  if (rec['foreclosure_data.foreclosure_id'] || rec.preforeclosure_type) {
    ctx.emit('property_foreclosure_events', {
      id: ctx.id('fce', pid, rec['foreclosure_data.foreclosure_id'] ?? 'pfc', ctx.batchId),
      property_id: pid, foreclosure_id: rec['foreclosure_data.foreclosure_id'] || null,
      stage: fcStage(rec),
      document_type_raw: rec['foreclosure_data.DocumentType'] || null,
      default_date: rec['foreclosure_data.DefaultDate'] || null,
      auction_date: rec['foreclosure_data.AuctionDate'] || rec.AuctionDate || null,
      recording_date: rec['foreclosure_data.RecordingDate'] || null,
      unpaid_balance: parseNumber(rec['foreclosure_data.UnpaidBalance']).value,
      auction_minimum_bid: parseNumber(rec['foreclosure_data.AuctionMinimumBidAmount']).value,
      import_batch_id: ctx.batchId,
    });
  }
}

function pick(rec, keys) {
  const o = {};
  for (const k of keys) if (rec[k] !== undefined && rec[k] !== '') o[k] = rec[k];
  return o;
}

export function assetClass(useStd, propertyType) {
  const code = String(useStd ?? '');
  if (code.startsWith('80') || /vacant/i.test(propertyType ?? '')) return 'vacant_land';
  if (code === '1001' || code === '1000' || code === '1002' || code === '1013' || code === '1999') return 'single_family';
  if (code === '1101' || code === '1102' || code === '1103') return 'two_to_four';
  if (code === '1110' || code === '1100' || code === '1108') return 'multifamily_5plus';
  if (code === '1112' || code === '1107') return 'apartments';
  if (code.startsWith('2') || code.startsWith('5')) return 'specialty_commercial';
  return 'single_family';
}

const DEED_DISTRESS = /sheriff|foreclosure|deed in lieu|redemption|public action|distress|commissioner|receiver/i;
const DEED_ESTATE = /executor|administrator|personal representative|beneficiary|transfer on death|affidavit of death|fiduciary|distribution|guardian|conservator|survivorship/i;
const DEED_FAMILY = /quit claim|intrafamily|joint tenancy|exchange/i;
const DEED_LEASE = /lease/i;
export function deedGroup(doc) {
  const d = String(doc ?? '');
  if (d === '') return null;
  if (DEED_DISTRESS.test(d)) return 'distress_transfer';
  if (DEED_ESTATE.test(d)) return 'death_or_estate_transfer';
  if (DEED_FAMILY.test(d)) return 'non_arms_length_transfer';
  if (DEED_LEASE.test(d)) return 'leasehold_not_ownership';
  if (/land contract|contract of sale|agreement of sale/i.test(d)) return 'seller_financed_or_contract';
  if (/legal action|court order/i.test(d)) return 'legal_action_transfer';
  if (/re-recorded|correction|affidavit$/i.test(d)) return 'administrative_recording';
  return 'market_or_standard_transfer';
}

function fcStage(rec) {
  const t = String(rec.preforeclosure_type ?? '').toLowerCase();
  if (t === 'bank_owned') return 'reo';
  const doc = String(rec['foreclosure_data.DocumentType'] ?? '');
  if (/trustee sale|foreclosure sale/i.test(doc)) return 'nos_nts';
  if (/default/i.test(doc)) return 'nod';
  if (/lis pendens/i.test(doc)) return 'lis_pendens';
  if (t === 'foreclosure') return 'nod';
  if (t === 'preforeclosure') return 'lis_pendens';
  return null;
}

// ---------- liens ----------
const DOC_BASE = { LEN: 'lien', LIS: 'lis_pendens', UCC: 'ucc', CER: 'certificate', ORD: 'order', RED: 'redemption_notice', AFD: 'affidavit_of_death', AFF: 'affidavit', ASR: 'assignment_of_rents', JDG: 'judgment', PRO: 'probate', AGR: 'agreement', MLN: 'mechanics_lien', CTR: 'contract', DCL: 'declaration', LSE: 'lease', POA: 'power_of_attorney', SUP: 'support', SLE: 'sale_notice', EAS: 'easement', FLN: 'federal_tax_lien', NTE: 'note', REL: 'release', SBT: 'substitution', SLN: 'state_tax_lien', LEV: 'levy', 'HOA LIEN': 'hoa_lien' };
const SUFFIX = [['REL', 'release'], ['TER', 'termination'], ['PRL', 'partial_release'], ['ASN', 'assignment'], ['AMD', 'amendment'], ['CON', 'continuation'], ['QUI', 'quiet_title'], ['DIV', 'divorce'], ['DST', 'distribution'], ['HEI', 'heirship'], ['TOD', 'transfer_on_death'], ['ERR', 'error'], ['LOS', 'lost'], ['ENF', 'enforcement'], ['NOI', 'notice_of_intent'], ['DOJ', 'doj'], ['STR', 'trustee'], ['CTY', 'city'], ['CNT', 'county'], ['UTL', 'utility'], ['SWR', 'sewer'], ['FOR', 'forfeiture'], ['PUR', 'purchase'], ['DED', 'deed'], ['SLE', 'sale'], ['MTG', 'mortgage'], ['HLN', 'hoa'], ['MLN', 'mechanics'], ['LEN', 'lien'], ['ASP', 'assumption'], ['ASM', 'assumption'], ['JDG', 'judgment']];

export function parseLienDocType(code) {
  const v = String(code ?? '').trim();
  if (v === '') return { base: null, modifier: null, lifecycle: 'ambiguous' };
  if (DOC_BASE[v]) return { base: DOC_BASE[v], modifier: null, lifecycle: lifecycleOf(DOC_BASE[v], null, v) };
  for (const [suf, name] of SUFFIX) {
    if (v.endsWith(suf) && DOC_BASE[v.slice(0, -suf.length)]) {
      const base = DOC_BASE[v.slice(0, -suf.length)];
      return { base, modifier: name, lifecycle: lifecycleOf(base, name, v) };
    }
  }
  // double suffix (e.g. ORDJDGAMD)
  for (const [s1, n1] of SUFFIX) {
    if (!v.endsWith(s1)) continue;
    const rest = v.slice(0, -s1.length);
    for (const [s2, n2] of SUFFIX) {
      if (rest.endsWith(s2) && DOC_BASE[rest.slice(0, -s2.length)]) {
        const base = DOC_BASE[rest.slice(0, -s2.length)];
        return { base, modifier: `${n2}_${n1}`, lifecycle: lifecycleOf(base, n1, v) };
      }
    }
  }
  return { base: null, modifier: null, lifecycle: 'ambiguous' };
}

function lifecycleOf(base, modifier, code) {
  if (modifier && /release|termination|partial_release/.test(modifier)) return 'release';
  if (modifier === 'assignment') return 'assignment';
  if (modifier === 'continuation') return 'continuation';
  if (modifier === 'amendment') return 'modification';
  if (modifier === 'quiet_title') return 'neutral';
  if (['redemption_notice', 'sale_notice'].includes(base) || code === 'CERFOR' || code === 'CERPUR') return 'foreclosure_related';
  if (['affidavit_of_death', 'probate'].includes(base) || (modifier && /heirship|transfer_on_death|distribution|divorce/.test(modifier))) return 'probate_life_event';
  if (base === 'judgment' || (modifier === 'judgment')) return 'judgment';
  if (base === 'lis_pendens') return 'litigation';
  if (base === 'ucc') return 'ucc_context';
  if (['lien', 'mechanics_lien', 'federal_tax_lien', 'state_tax_lien', 'hoa_lien', 'levy', 'support'].includes(base)
      || (modifier && /city|county|utility|sewer|lien|mechanics|hoa|doj|enforcement/.test(modifier))) return 'creation';
  if (base === 'order') return 'ambiguous';
  return 'neutral';
}

export function mapLien(rec, ctx, rowNumber) {
  const pid = propId(ctx, rec.property_id);
  const parsed = parseLienDocType(rec.doc_type);
  const lid = ctx.id('lien', pid, rec.doc_type ?? '', rec.doc_filing_date ?? rec.recording_date ?? '', rec.lien_index ?? rowNumber, ctx.batchId);
  ctx.emit('property_liens', {
    id: lid, property_id: pid,
    doc_number: rec.doc_number || null,
    recording_date: rec.recording_date || null, filing_date: rec.doc_filing_date || null,
    lien_type_raw: rec.lien_type || null,
    doc_category_code: rec.doc_category_code || null, doc_type_raw: rec.doc_type || null,
    base_type: parsed.base, action_modifier: parsed.modifier, lifecycle_class: parsed.lifecycle,
    amount_due: parseNumber(rec.amount_due).value,
    previous_amount_due: parseNumber(rec.previous_amount_due).value,
    county: rec.county || null, state: rec.state || null,
    date_of_death: rec.date_of_death || null, date_of_divorce: rec.date_of_divorce || null,
    import_batch_id: ctx.batchId,
  });
  if (parsed.lifecycle === 'ambiguous' && rec.doc_type) ctx.unmapped('lien_doc_type', rec.doc_type);
  for (let p = 1; p <= 4; p += 1) {
    for (let n = 1; n <= 4; n += 1) {
      const name = rec[`Party${p}_Name${n}_FullName`];
      if (!name) continue;
      ctx.emit('lien_parties', {
        id: ctx.id('lp', lid, p, n),
        lien_id: lid, party_ordinal: p, name_ordinal: n, full_name: name,
        role_raw: rec[`DocTypeInfo.Roll${p}`] || null,
        owner_side: ownerSideRole(rec[`DocTypeInfo.Roll${p}`]),
      });
    }
  }
}

const OWNER_ROLES = /debtor|defendant|deceased|borrower|owner|seller|grantor|trustor|principal|lessor|transferor|declarant|petitioner/i;
const COUNTER_ROLES = /claimant|plaintiff|lender|buyer|grantee|assignee|affiant|creditor|respondent|lessee/i;
export function ownerSideRole(role) {
  if (!role) return null;
  if (OWNER_ROLES.test(role)) return true;
  if (COUNTER_ROLES.test(role)) return false;
  return null;
}

// ---------- companies ----------
export function mapCompany(rec, ctx) {
  const cid = ctx.id('co', rec.jurisdiction_code ?? '', rec.company_number && rec.company_number !== '0' ? rec.company_number : rec.company_name ?? '');
  ctx.emit('companies', {
    id: cid, jurisdiction_code: rec.jurisdiction_code || null,
    company_number: rec.company_number && rec.company_number !== '0' ? String(rec.company_number) : null,
    company_name: rec.company_name || null,
    status_raw: rec.current_status || null,
    existence_norm: /dissol|cancel|terminat|inactive|dead|expired|forfeit|withdraw|merged|revoked/i.test(rec.current_status ?? '') ? 'inactive' : (/activ|good|exist|incorporat|registered|reinstat/i.test(rec.current_status ?? '') ? 'active' : 'unknown'),
    incorporation_date: rec.incorporation_date || null,
    dissolution_date: rec.dissolution_date || null,
    import_batch_id: ctx.batchId,
  });
  if (rec.property_id) {
    ctx.emit('property_company_links', {
      id: ctx.id('pcl', rec.property_id, cid, ctx.batchId),
      property_id: propId(ctx, rec.property_id), company_id: cid,
      matched_party: rec.matched_party || null,
      matching_type_code: rec.matching_type || null,  // opaque '21' (OD-3)
      import_batch_id: ctx.batchId,
    });
  }
}

// ---------- contact_info ----------
export function mapContact(rec, ctx) {
  const personId = rec.individual_key && /^\d+$/.test(rec.individual_key)
    ? ctx.id('per', 'key', rec.individual_key)
    : ctx.id('per', 'fallback', rec.full_name ?? '', rec.property_id ?? '');
  ctx.emit('people', {
    id: personId, individual_key: rec.individual_key || null,
    identity_tier: rec.individual_key && /^\d+$/.test(rec.individual_key) ? 'key' : 'name_address',
    full_name: rec.full_name || null, import_batch_id: ctx.batchId,
  });
  for (let r = 1; r <= 5; r += 1) {
    const phone = rec[`phone_${r}`];
    if (phone && !/=/.test(phone)) {  // encrypted placeholders excluded
      const e164 = normalizePhone(phone);
      ctx.emit('contact_phones', {
        id: ctx.id('ph', personId, e164 ?? phone, ctx.batchId),
        person_id: personId, property_id: propId(ctx, rec.property_id),
        phone_e164: e164, phone_raw: phone, rank: r,
        line_type: rec[`phone_${r}_type`] === 'W' ? 'wireless' : rec[`phone_${r}_type`] === 'L' ? 'landline' : 'unknown',
        carrier_raw: rec[`phone_${r}_carrier`] || null,
        do_not_call: parseBool(rec[`phone_${r}_do_not_call`]).value,
        never_call: parseBool(rec[`phone_${r}_never_call`]).value,
        import_batch_id: ctx.batchId,
      });
      if (e164 === null) ctx.conflict('phone_unparseable', { person_id: personId, raw: String(phone).slice(0, 24) });
    }
    if (r <= 5 && rec[`email_${r}`] && !/=/.test(rec[`email_${r}`])) {
      ctx.emit('contact_emails', {
        id: ctx.id('em', personId, rec[`email_${r}`].toLowerCase(), ctx.batchId),
        person_id: personId, property_id: propId(ctx, rec.property_id),
        email_normalized: rec[`email_${r}`].trim().toLowerCase(), email_raw: rec[`email_${r}`],
        rank: r, blocked: parseBool(rec[`email_${r}_blocked`]).value,
        linkage_score: parseNumber(rec[`email_${r}_linkage_score`]).value,
        import_batch_id: ctx.batchId,
      });
    }
  }
}

export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// ---------- prospects ----------
export function mapProspect(rec, ctx) {
  const keyed = rec.individual_key && /^\d+$/.test(rec.individual_key);
  const personId = keyed ? ctx.id('per', 'key', rec.individual_key)
    : ctx.id('per', 'fallback', rec.full_name ?? '', rec.property_id ?? '');
  ctx.emit('people', {
    id: personId, individual_key: rec.individual_key || null,
    identity_tier: keyed ? 'key' : 'name_address',
    full_name: rec.full_name || null, given_name: rec.given_name || null,
    surname: rec.surname || null, generational_suffix: rec.generational_suffix || null,
    household_id: rec.household_id || null, import_batch_id: ctx.batchId,
  });

  const tokens = String(rec.matching_flags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const pfRaw = String(rec.person_flags ?? '');
  const renter = /renter/.test(pfRaw) || rec.homeowner_combined_homeownerrenter === 'R';
  const imo = parseBool(rec.is_matching_property_as_owner).value;
  const scalarOwner = parseBool(rec.likely_owner).value;
  // tier ladder from OD-13 QA
  let tier = 'none';
  if (tokens.includes('Likely Owner') || tokens.includes('Potential Owner')) tier = 'medium';
  if (tokens.includes('Likely Owner') && /auto_match/.test(rec.matching_type ?? '')) tier = 'high';
  else if (tokens.includes('Likely Owner') && /address/.test(rec.matching_type ?? '')) tier = 'high';
  if (/tiebreaker/.test(rec.matching_type ?? '')) tier = 'low';
  if (imo === false && !tokens.includes('Likely Owner')) tier = tier === 'none' ? 'none' : 'low';

  ctx.emit('property_person_links', {
    id: ctx.id('ppl', rec.property_id ?? '', personId, ctx.batchId),
    property_id: propId(ctx, rec.property_id), person_id: personId,
    matching_type: rec.matching_type || null, matching_flags: tokens,
    likely_owner_scalar: scalarOwner, is_matching_property_as_owner: imo,
    renter_flag: renter, link_tier: tier,
    scalar_corroborated: false,   // set at feature time only when batch liveness confirmed (F-111)
    person_flags_raw: pfRaw.slice(0, 4000),
    profile: {
      est_household_income_code: rec.est_household_income_code || null,
      net_asset_value: rec.net_asset_value || null,
      buying_power: rec.buying_power || null,
      agg_credit_tier: rec.agg_credit_tier || null,
      investments: parseBool(rec.investments).value,
      business_owner: parseBool(rec.business_owner).value,
      length_of_residence: parseNumber(rec.length_of_residence).value,
      portfolio_total_properties_owned: parseNumber(rec.portfolio_total_properties_owned, RULES.portfolio_amount).value,
      portfolio_total_equity: parseNumber(rec.portfolio_total_equity, RULES.portfolio_amount).value,
      portfolio_total_mortgage_balance: parseNumber(rec.portfolio_total_mortgage_balance, RULES.portfolio_amount).value,
      order_score: parseNumber(rec.order_score).value,       // V12 artifact (baseline only)
      ready_to_call: parseBool(rec.ready_to_call).value,     // V12 artifact (baseline only)
      is_in_rnd: parseBool(rec.is_in_rnd).value,
      known_litigator: parseBool(rec.known_litigator).value,
      language_preference: rec.language_preference || null,
      primary_decision_maker: /primary_decision_maker/.test(pfRaw),
      linked_properties_count: parseNumber(rec.portfolio_other_property_count, RULES.portfolio_amount).value,
    },
    import_batch_id: ctx.batchId,
  });
  if (renter && tokens.includes('Likely Owner')) {
    ctx.conflict('renter_owner_collision', { person_id: personId, property_id: rec.property_id });
  }
}
