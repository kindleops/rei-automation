// Feature snapshot engine. Consumes a staged property bundle + as-of timestamp
// (+ optional immutable comp snapshot) and emits feature results with the
// 9 required fields. Blocked features stay blocked — never synthesized (P2-2).
import { assertAsOfSafe, toMs } from '../lib/timeSafety.mjs';
import { blanketLoanGuard } from '../lib/sentinels.mjs';
import { computeExtendedFeatures } from './engineExtended.mjs';

export const FORMULA_VERSION = 'fe-2026.07.17-p3';

const DAY = 86_400_000;

function result(id, value, state, conf, evidence, asOf, missing = [], explanation = '') {
  return {
    feature_id: id, value, value_state: state, confidence: conf,
    source_evidence: evidence, as_of: asOf, formula_version: FORMULA_VERSION,
    missing_dependencies: missing, explanation_fragment: explanation,
  };
}

// value_state: known | unknown | blocked | not_applicable
export function computeFeatures(bundle, asOf, { compSnapshot = null } = {}) {
  const out = [];
  const { property: p = {}, valuation: v = {}, loans = [], checksums = null,
    liens = [], foreclosure = [], transactions = [], links = [], phones = [], emails = [],
    listing = [], batchScalarLiveness = null } = bundle;
  const asOfMs = toMs(asOf);
  let maxObserved = null;
  const seen = (ts, context) => {
    const ms = toMs(ts);
    if (ms !== null) {
      assertAsOfSafe(ms, asOfMs, { context });
      maxObserved = maxObserved === null || ms > maxObserved ? ms : maxObserved;
    }
  };

  // guard every dated input once
  for (const l of loans) seen(l.recording_date, `loan:${l.id}`);
  for (const li of liens) seen(li.filing_date ?? li.recording_date, `lien:${li.id}`);
  for (const t of transactions) seen(t.sale_date, `txn:${t.id}`);
  for (const f of foreclosure) { seen(f.recording_date, `fc:${f.id}`); seen(f.default_date, `fc:${f.id}`); }
  // listing snapshots are immutable, as-of-selected artifacts (like comp
  // snapshots): filtered by observed_at at read time, never leakage-thrown

  // ---- F-001 ownership_tenure_years
  const current = transactions.find((t) => t.event_role === 'current' && t.sale_date);
  if (current) {
    const yrs = (asOfMs - toMs(current.sale_date)) / (365.25 * DAY);
    out.push(result('F-001', Math.round(yrs * 10) / 10, 'known', 0.9,
      [{ kind: 'transaction', id: current.id, date: current.sale_date }], asOf, [],
      `Owned ${Math.round(yrs * 10) / 10} years (current-sale ${current.sale_date}).`));
  } else {
    out.push(result('F-001', null, 'unknown', 0, [], asOf, ['transactions.current.sale_date'],
      'Tenure unknown: no dated current-sale transaction.'));
  }

  // ---- F-005 recent_purchase_suppressor
  if (current) {
    const days = (asOfMs - toMs(current.sale_date)) / DAY;
    out.push(result('F-005', days < 365, 'known', 0.8,
      [{ kind: 'transaction', id: current.id }], asOf, [],
      days < 365 ? `Purchased ${Math.round(days)} days ago — suppressor active.` : 'No recent purchase.'));
  } else out.push(result('F-005', null, 'unknown', 0, [], asOf, ['transactions.current.sale_date'], ''));

  // ---- F-006 combined_ltv (+ blanket guard)
  const value = v.estimated_value ?? null;
  const balances = loans.filter((l) => l.slot_class === 'current_recorded' && l.estimated_balance !== null);
  const balSum = balances.reduce((s, l) => s + l.estimated_balance, 0);
  const blanket = balances.some((l) => l.blanket_loan_flag) || blanketLoanGuard(balSum, value);
  if (value === null) {
    out.push(result('F-006', null, 'unknown', 0, [], asOf, ['valuation.estimated_value'], 'LTV blocked: value unknown.'));
  } else if (blanket) {
    out.push(result('F-006', null, 'unknown', 0.2,
      balances.map((l) => ({ kind: 'loan', id: l.id })), asOf, [],
      'LTV withheld: blanket/package-loan guard tripped (balance implausible vs value).'));
  } else {
    const ltv = value > 0 ? balSum / value : null;
    out.push(result('F-006', ltv === null ? null : Math.round(ltv * 1000) / 1000,
      ltv === null ? 'unknown' : 'known', 0.85,
      balances.map((l) => ({ kind: 'loan', id: l.id, balance: l.estimated_balance })), asOf, [],
      ltv === null ? '' : `Combined LTV ${(ltv * 100).toFixed(1)}% ($${balSum.toLocaleString()} / $${value.toLocaleString()}).`));
  }

  // ---- F-007 negative_or_thin_equity
  const eqPct = v.equity_percent ?? null;
  out.push(eqPct === null
    ? result('F-007', null, v.equity_percent_state === 'unknown' ? 'unknown' : 'unknown', 0,
        [], asOf, ['valuation.equity_percent'], 'Equity unknown (sentinel or missing).')
    : result('F-007', eqPct, 'known', 0.85, [{ kind: 'valuation', equity_percent: eqPct }], asOf, [],
        `Equity ${eqPct.toFixed(1)}% of value.`));

  // ---- F-009 rate_reset_exposure
  const risky = loans.filter((l) => /adjustable|arm|balloon|negative amort|variable/i
    .test(`${l.loan_type_raw ?? ''} ${l.financing_type_raw ?? ''}`));
  out.push(result('F-009', risky.length > 0, risky.length || loans.length ? 'known' : 'unknown',
    risky.length ? 0.8 : 0.5, risky.map((l) => ({ kind: 'loan', id: l.id, type: l.loan_type_raw })), asOf,
    loans.length ? [] : ['property_loans'],
    risky.length ? `Rate-structure risk: ${risky.map((l) => l.loan_type_raw ?? l.financing_type_raw).join(', ')}.` : 'No adjustable/balloon structures recorded.'));

  // ---- F-011 reverse mortgage
  const reverse = loans.some((l) => /reverse/i.test(l.loan_type_raw ?? ''));
  out.push(result('F-011', reverse, 'known', reverse ? 0.9 : 0.6, [], asOf, [],
    reverse ? 'Reverse mortgage present.' : ''));

  // ---- F-013 open_lien_pressure (lifecycle-netted IX-03; severity-classed +
  // age-decayed IX-02; lis-pendens routed to stage when a foreclosure episode
  // exists so each document feeds exactly one of {stage, pressure})
  const episodes = netLienEpisodes(liens);
  const fcActive = foreclosure.some((f) => f.stage && f.stage !== 'none');
  const open = episodes.filter((e) => e.state === 'open' && e.pressureClass
    && !(fcActive && e.openBase === 'lis_pendens'));
  const lienEv = open.map((e) => ({ kind: 'lien_episode', base: e.base, opened: e.openedDate, docs: e.docs.length }));
  if (liens.length === 0) {
    out.push(result('F-013', 0, 'known', 0.5, [], asOf, [],
      'No lien documents observed (coverage-gated weak negative).'));
  } else {
    const decayW = (opened) => {
      const ms = toMs(opened);
      if (ms === null) return 0.7;
      const age = (asOfMs - ms) / DAY;
      return age <= 730 ? 1.0 : age <= 1825 ? 0.8 : age <= 3650 ? 0.55 : 0.3;
    };
    const classes = { senior_gov: 0, judgment_litigation: 0, municipal_hoa: 0, generic: 0 };
    for (const e of open) classes[e.severityClass] = Math.round((classes[e.severityClass] + decayW(e.openedDate)) * 100) / 100;
    const withAmt = open.filter((e) => e.amount !== null);
    const amtSum = withAmt.reduce((s, e) => s + e.amount, 0);
    const ratio = withAmt.length && value ? amtSum / value : null;
    const eqAmt2 = v.estimated_equity ?? null;
    const ratioEq = withAmt.length && eqAmt2 !== null && eqAmt2 > 0
      ? amtSum / Math.max(eqAmt2, 10_000) : null;
    out.push(result('F-013', {
      open_episodes: open.length,
      amount_to_value: ratio === null ? null : Math.round(ratio * 1000) / 1000,
      amount_to_equity: ratioEq === null ? null : Math.round(ratioEq * 1000) / 1000,
      classes,
    }, 'known', 0.8, lienEv, asOf, [],
    `${open.length} open lien episode(s) after release netting${ratio !== null ? `, ${(ratio * 100).toFixed(1)}% of value` : ''}${ratioEq !== null ? ` (${(ratioEq * 100).toFixed(0)}% of equity)` : ''}; ${episodes.filter((e) => e.state === 'closed').length} closed by release/satisfaction.`));
  }

  // ---- F-135 release_recency_positive
  const recentRelease = episodes.find((e) => e.state === 'closed' && e.closedDate
    && asOfMs - toMs(e.closedDate) < 730 * DAY);
  out.push(result('F-135', Boolean(recentRelease), 'known', recentRelease ? 0.7 : 0.4,
    recentRelease ? [{ kind: 'lien_episode', base: recentRelease.base, closed: recentRelease.closedDate }] : [],
    asOf, [], recentRelease ? `Lien satisfied ${recentRelease.closedDate} — recent title cleanup.` : ''));

  // ---- F-018/F-019 foreclosure stage & clock
  const stages = ['lis_pendens', 'nod', 'nos_nts', 'auction_scheduled', 'reo'];
  const fcs = foreclosure.filter((f) => f.stage);
  const top = fcs.sort((a, b) => stages.indexOf(b.stage) - stages.indexOf(a.stage))[0] ?? null;
  if (top) {
    const stageTs = toMs(top.recording_date ?? top.default_date);
    out.push(result('F-018', top.stage, 'known', 0.9,
      [{ kind: 'foreclosure', id: top.id, doc: top.document_type_raw,
        age_days: stageTs === null ? null : Math.round((asOfMs - stageTs) / DAY) }], asOf, [],
      `Foreclosure stage: ${top.stage}.`));
    const aDate = top.auction_date ? toMs(top.auction_date) : null;
    if (aDate !== null && aDate > asOfMs) {
      out.push(result('F-019', Math.round((aDate - asOfMs) / DAY), 'known', 0.9,
        [{ kind: 'foreclosure', auction_date: top.auction_date }], asOf, [],
        `Auction in ${Math.round((aDate - asOfMs) / DAY)} days.`));
    } else {
      out.push(result('F-019', null, aDate === null ? 'unknown' : 'unknown', 0.3, [], asOf,
        aDate === null ? ['foreclosure.auction_date'] : [],
        aDate !== null ? 'Auction date in the past — resolution check required.' : 'No auction scheduled.'));
    }
  } else {
    out.push(result('F-018', 'none', 'known', 0.7, [], asOf, [], 'No foreclosure episode observed.'));
    out.push(result('F-019', null, 'not_applicable', 0.7, [], asOf, [], ''));
  }

  // ---- F-023 tax_delinquency
  if (v.tax_delinquent === true) {
    const years = v.tax_delinquent_year ? Math.max(0, new Date(asOfMs).getUTCFullYear() - v.tax_delinquent_year) : null;
    out.push(result('F-023', { delinquent: true, years_deep: years }, 'known', 0.9,
      [{ kind: 'valuation', tax_delinquent_year: v.tax_delinquent_year }], asOf, [],
      `Tax delinquent${years !== null ? ` since ${v.tax_delinquent_year} (${years}y)` : ''}.`));
  } else if (v.tax_delinquent === false) {
    out.push(result('F-023', { delinquent: false }, 'known', 0.8, [], asOf, [], 'Taxes current.'));
  } else {
    out.push(result('F-023', null, 'unknown', 0, [], asOf, ['valuation.tax_delinquent'], ''));
  }

  // ---- F-026 effective_age
  const yb = p.effective_year_built ?? p.year_built ?? null;
  out.push(yb === null
    ? result('F-026', null, 'unknown', 0, [], asOf, ['year_built'], '')
    : result('F-026', new Date(asOfMs).getUTCFullYear() - yb, 'known', 0.8,
        [{ kind: 'property', year: yb }], asOf, [], `Effective age ${new Date(asOfMs).getUTCFullYear() - yb} years.`));

  // ---- F-025 condition_grade
  const condRank = { Excellent: 1, 'Very Good': 2, Good: 3, Average: 4, Fair: 5, Poor: 6, Unsound: 7 }[p.condition_raw] ?? null;
  out.push(condRank === null
    ? result('F-025', null, p.condition_state === 'unknown' ? 'unknown' : 'unknown', 0,
        [], asOf, ['building_condition'], 'Condition unknown (explicit Unknown is a separate state).')
    : result('F-025', condRank, 'known', 0.75, [{ kind: 'property', condition: p.condition_raw }], asOf, [],
        `Assessor condition ${p.condition_raw}.`));

  // ---- F-110/F-111/F-112 link evidence. Renter flags gate the PERSON, not
  // the property: a renter-flagged link never confers owner identity, and the
  // hard block applies only when no clean owner-tier link remains (OD-13
  // collisions are person-level; the owner may still be reachable via another
  // link or channel).
  const ownerLinks = links.filter((l) => l.link_tier && l.link_tier !== 'none' && !l.renter_flag);
  const best = ownerLinks.sort((a, b) => tierRank(b.link_tier) - tierRank(a.link_tier))[0] ?? null;
  const renterLinks = links.filter((l) => l.renter_flag);
  out.push(result('F-110', best ? best.link_tier : 'none', 'known', best ? 0.85 : 0.6,
    best ? [{ kind: 'link', id: best.id, matching_type: best.matching_type, tokens: best.matching_flags }] : [],
    asOf, [], best
      ? `Owner-link tier ${best.link_tier} via ${best.matching_type}${renterLinks.length ? ' (a separate renter-flagged contact was excluded from identity)' : ''}.`
      : 'No clean owner-link evidence.'));
  const scalarLive = batchScalarLiveness !== null && batchScalarLiveness > 0.01;
  const corro = scalarLive && best && best.likely_owner_scalar === true;
  out.push(result('F-111', corro, scalarLive ? 'known' : 'not_applicable', scalarLive ? 0.7 : 0.2,
    [], asOf, scalarLive ? [] : ['batch scalar liveness >1%'],
    corro ? 'Vendor scalar corroborates owner link (live batch) — tier upgraded.' :
      (scalarLive ? '' : 'Scalar column dead in this batch — no corroboration read (OD-13 QA).')));
  const renterBlocked = renterLinks.length > 0 && best === null;
  out.push(result('F-112', renterBlocked, 'known', 0.9, [], asOf, [],
    renterBlocked ? 'Only renter-flagged contact(s) linked — outreach-as-owner HARD BLOCKED for this property.'
      : renterLinks.length ? 'Renter-flagged contact present but excluded; clean owner link remains.' : ''));

  // ---- F-046 reachable_phone_stack (compliance first)
  const compliant = phones.filter((ph) => ph.do_not_call !== true && ph.never_call !== true && ph.phone_e164);
  const wireless = compliant.filter((ph) => ph.line_type === 'wireless');
  out.push(result('F-046', { compliant_phones: compliant.length, wireless: wireless.length },
    'known', phones.length ? 0.85 : 0.6,
    compliant.slice(0, 3).map((ph) => ({ kind: 'phone', rank: ph.rank, line: ph.line_type })), asOf, [],
    phones.length === 0 ? 'No phone channels.' :
      `${compliant.length}/${phones.length} phones compliant (${wireless.length} wireless); ${phones.length - compliant.length} blocked by DNC/never-call.`));

  // ---- F-047 deliverable_email_stack
  const okEmails = emails.filter((e) => e.blocked !== true);
  out.push(result('F-047', okEmails.length, 'known', emails.length ? 0.75 : 0.5, [], asOf, [],
    emails.length ? `${okEmails.length} deliverable email(s).` : 'No email channels.'));

  // ---- F-101 agg_conflict_loan_count (OD-12 quality feature)
  if (checksums && checksums.num_of_mortgages !== null) {
    const slotN = loans.filter((l) => l.slot_class === 'current_recorded' && (l.original_loan_amount ?? 0) > 0).length;
    const disagree = checksums.num_of_mortgages !== slotN;
    out.push(result('F-101', { vendor: checksums.num_of_mortgages, slots: slotN, disagree },
      'known', disagree ? 0.9 : 0.7, [{ kind: 'checksum' }], asOf, [],
      disagree ? `Vendor counts ${checksums.num_of_mortgages} open mortgages; slots show ${slotN} — routed to review.` : ''));
  } else {
    out.push(result('F-101', null, 'unknown', 0, [], asOf, ['loan_checksums.num_of_mortgages'], ''));
  }

  // ---- F-133 holding_period_appreciation (qualifier-gated; cohort-degraded without snapshot)
  if (current && current.price_qualifier_class === 'valuation' && current.sale_price > 0 && value) {
    const ratio = value / current.sale_price;
    out.push(result('F-133', Math.round(ratio * 100) / 100, 'known', compSnapshot ? 0.8 : 0.5,
      [{ kind: 'transaction', id: current.id, basis: current.sale_price }], asOf,
      compSnapshot ? [] : ['market_feature_snapshot (cohort appreciation)'],
      `Value/basis ${ratio.toFixed(2)}x since ${current.sale_date}${compSnapshot ? '' : ' (cohort-degraded: no comp snapshot)'}.`));
  } else {
    out.push(result('F-133', null, current && current.price_qualifier_class !== 'valuation' ? 'not_applicable' : 'unknown',
      0.2, [], asOf, ['valuation-eligible acquisition price'],
      current && current.price_qualifier_class !== 'valuation'
        ? `Basis excluded: price qualifier class ${current.price_qualifier_class}.` : ''));
  }

  // ---- snapshot-fed market features owned by the core (P2-2); F-057/F-060/
  // F-061/F-062 are owned by the extended module to avoid duplicate emission
  for (const [id, name] of [['F-056', 'local_dom_velocity'], ['F-058', 'investor_buyer_pressure'],
    ['F-130', 'value_percentile_in_cohort']]) {
    if (compSnapshot) {
      const val = { 'F-056': compSnapshot.sale_velocity, 'F-058': compSnapshot.buyer_velocity,
        'F-130': (compSnapshot.snapshot_interface_version ?? 1) >= 2 ? compSnapshot.subject_value_percentile : null }[id];
      if (val !== null && val !== undefined) {
        out.push(result(id, val, 'known', compSnapshot.valuation_confidence ?? 0.5,
          [{ kind: 'comp_snapshot', id: compSnapshot.id, as_of: compSnapshot.as_of }], asOf, [],
          `${name} from immutable comp snapshot ${compSnapshot.id}.`));
        continue;
      }
    }
    out.push(result(id, null, 'blocked', 0, [], asOf,
      ['market_feature_snapshot (P2-2: no valid immutable snapshot)'],
      `${name} blocked: no comp/market snapshot for as-of.`));
  }

  // ---- Phase 3.5 extended features (all remaining implementable contracts)
  const ext = computeExtendedFeatures(bundle, asOf, { compSnapshot, ownerIndex: bundle.ownerIndex ?? null });
  const seen2 = new Set(out.map((f) => f.feature_id));
  for (const f of ext) if (!seen2.has(f.feature_id)) out.push(f);

  return { features: out, inputs_max_observed_at: maxObserved === null ? null : new Date(maxObserved).toISOString() };
}

function tierRank(t) { return { exact: 4, high: 3, medium: 2, low: 1, none: 0 }[t] ?? 0; }

// Severity routing for the open-lien stack (IX-02: severity-weighted, never
// equal weights; each class carries a distinct creditor-rank hypothesis).
export function lienSeverityClass(doc) {
  const base = doc.base_type ?? '';
  const mod = doc.action_modifier ?? '';
  if (['federal_tax_lien', 'state_tax_lien', 'support', 'levy'].includes(base) || /doj/.test(mod)) return 'senior_gov';
  if (['judgment', 'lis_pendens'].includes(base) || ['judgment', 'litigation'].includes(doc.lifecycle_class)) return 'judgment_litigation';
  if (base === 'hoa_lien' || /city|county|utility|sewer|hoa/.test(mod)) return 'municipal_hoa';
  return 'generic';
}

// IX-03 release netting: group by base_type, order by date, releases close.
export function netLienEpisodes(liens) {
  const byBase = new Map();
  for (const li of liens) {
    const key = li.base_type ?? `raw:${li.doc_type_raw}`;
    (byBase.get(key) ?? byBase.set(key, []).get(key)).push(li);
  }
  const episodes = [];
  for (const [base, docs] of byBase) {
    const sorted = [...docs].sort((a, b) => String(a.filing_date ?? a.recording_date ?? '') < String(b.filing_date ?? b.recording_date ?? '') ? -1 : 1);
    let ep = null;
    for (const d of sorted) {
      const cls = d.lifecycle_class;
      if (cls === 'release') {
        if (ep && ep.state === 'open') {
          ep.state = 'closed'; ep.closedDate = d.filing_date ?? d.recording_date ?? null; ep.docs.push(d.id);
        } else {
          episodes.push({ base, state: 'review_unmatched_release', docs: [d.id], openedDate: null, closedDate: null, amount: null, pressureClass: false });
        }
      } else if (['creation', 'judgment', 'litigation'].includes(cls)) {
        ep = { base, state: 'open', docs: [d.id], openedDate: d.filing_date ?? d.recording_date ?? null,
          closedDate: null, amount: d.amount_due ?? null, pressureClass: true,
          openBase: d.base_type ?? null, severityClass: lienSeverityClass(d) };
        episodes.push(ep);
      } else if (ep && ['assignment', 'continuation', 'modification'].includes(cls)) {
        ep.docs.push(d.id);   // keeps episode open; creditor/terms change
      } else if (['probate_life_event', 'foreclosure_related'].includes(cls)) {
        episodes.push({ base: `${base}:${cls}`, state: 'context', docs: [d.id], openedDate: d.filing_date ?? d.recording_date ?? null, closedDate: null, amount: null, pressureClass: false });
      }
      // neutral/ucc_context/ambiguous: retained in staging, no episode effect
    }
  }
  return episodes;
}
