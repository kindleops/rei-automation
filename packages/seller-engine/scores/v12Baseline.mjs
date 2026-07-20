// seller_engine_v12_baseline — EXACT PORT of the legacy Google Apps Script
// "MASTER OWNER PIPELINE — V12 DIRECT SUPABASE SYNC".
// Source of truth: docs/seller-engine/legacy/V12_DIRECT_SUPABASE_SYNC_SANITIZED.js
//   sha256 89adfaeb8d3ded32f84476d2a87e5df58568d9a26f9089dcebe15a9eb69ae8c8
// Ported 1:1 including deliberate preservation of legacy behavior that the
// deterministic V1 challenger explicitly rejects:
//   - tax delinquency counted in BOTH the count term and the tag term (double count)
//   - substring matching where 'potential but high risk' hits the 'high risk'
//     branch (+20) before its own (+15), and 2-month usage 'very heavy' hits 'heavy'
//   - hardcoded year 2026 in delinquency-depth and age math
//   - fixed portfolio-equity bonus (>=50% -> +20, >=30% -> +10)
//   - flat tag-string points, no release netting, absolute-dollar bands
//   - per-row distress_marker_count inflation on resumed/duplicate rows
// DO NOT "fix" anything here. Improvements belong in deterministic V1 only.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/hash.mjs';

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'v12_baseline.config.json');
export const V12_SOURCE_SHA256 = '89adfaeb8d3ded32f84476d2a87e5df58568d9a26f9089dcebe15a9eb69ae8c8';

export function loadV12Config() {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  return { cfg, versionId: `${cfg.engine}@${cfg.semver}+cfg.${sha256(raw).slice(0, 12)}` };
}

// ---------------- exact helper ports ----------------
export function asNumber_(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[$,%]/g, '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}
export const asText_ = (v) => String(v === null || v === undefined ? '' : v).trim();
export function boolish_(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}
export function normalizePhone_(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return d.length >= 10 ? '+' + d : '';
}
export function isActiveWirelessPhone_(phoneType, activityStatus) {
  const type = String(phoneType || '').trim().toUpperCase();
  const activity = String(activityStatus || '').toLowerCase();
  if (type !== 'W') return false;
  if (!activity) return false;
  if (activity.includes('inactive')) return false;
  return activity.includes('active');
}

// ---------------- exact scoring ports ----------------
export function scorePhoneFallback_(type, activity, u12, u2) {
  if (String(type || '').trim().toUpperCase() !== 'W') return -1;
  let s = 40;
  const u2s = String(u2 || '').toLowerCase();
  const u12s = String(u12 || '').toLowerCase();
  if (u2s.includes('heavy')) s += 40;            // NOTE: 'very heavy' also lands here (legacy)
  else if (u2s.includes('moderate')) s += 28;
  else if (u2s.includes('light')) s += 15;
  else if (u2s.includes('minimal')) s += 6;

  if (u12s.includes('very heavy')) s += 12;
  else if (u12s.includes('heavy')) s += 10;
  else if (u12s.includes('moderate')) s += 6;
  else if (u12s.includes('light')) s += 3;

  const a = String(activity || '').toLowerCase();
  if (a.includes('12 months or longer')) s += 20;
  else if (a.includes('active monthly')) s += 12;
  else if (a.includes('inactive')) s -= 8;

  return Math.max(0, Math.min(100, Math.round(s)));
}

export function scoreContactFallback_(slot) {
  const flags = String(slot.matching_flags || '').toLowerCase();
  const bp = String(slot.buying_power || '').toLowerCase();
  const likelyOwner = boolish_(slot.likely_owner);
  const likelyRenting = boolish_(slot.likely_renting);
  if (likelyRenting || flags.includes('renter') || flags.includes('tenant') || flags.includes('resident')) return -1;

  let s = 0;
  if (likelyOwner || flags.includes('likely owner')) s += 48;
  else if (flags.includes('family')) s += 20;

  if (bp.includes('very high risk')) s += 30;
  else if (bp.includes('caution')) s += 25;
  else if (bp.includes('high risk')) s += 20;   // legacy: 'potential but high risk' lands HERE
  else if (bp.includes('potential but high risk')) s += 15; // unreachable branch, ported as written
  else if (bp.includes('emerging with potential')) s += 10;
  else if (bp.includes('moderate')) s += 5;

  const pf = String(slot.person_flags_text || '').toLowerCase();
  if (pf.includes('primary decision maker')) s += 10;
  if (pf.includes('property owner')) s += 8;
  if (pf.includes('real estate investor')) s += 6;
  if (pf.includes('home business')) s += 4;

  return Math.max(0, Math.min(100, Math.round(s)));
}

export function normalizeLinkageScore_(rawLinkage) {
  const n = asNumber_(rawLinkage);
  if (n >= 90000) return 100;
  if (n >= 80000) return 96;
  if (n >= 70000) return 92;
  if (n >= 60000) return 88;
  if (n >= 50000) return 82;
  if (n >= 40000) return 76;
  if (n >= 30000) return 70;
  if (n >= 20000) return 62;
  if (n >= 10000) return 52;
  if (n > 0) return 40;
  return 0;
}

export function scoreEmailFinal_(rawLinkage, contactScore, slotRank) {
  let s = normalizeLinkageScore_(rawLinkage);
  s += Math.min(15, Math.round((asNumber_(contactScore) || 0) * 0.12));
  if (slotRank === 0) s += 6;
  else if (slotRank === 1) s += 3;
  return Math.max(0, Math.min(100, Math.round(s)));
}

export function calcFinancialPressure_(owner) {
  let s = 0;
  if (owner.tax_delinquent_count > 0) s += 35;
  const tdYears = owner.oldest_tax_delinquent_year ? (2026 - owner.oldest_tax_delinquent_year) : 0;
  if (tdYears >= 3) s += 15;
  else if (tdYears >= 2) s += 8;

  const value = owner.portfolio_total_value;
  const loan = owner.portfolio_total_loan_balance;
  const ltv = value > 0 ? loan / value : 0;
  if (ltv > 0.90) s += 25;
  else if (ltv > 0.75) s += 15;
  else if (ltv > 0.60) s += 8;

  const bp = String(owner.best_buying_power || '').toLowerCase();
  if (bp.includes('very high risk') || bp.includes('caution')) s += 20;
  else if (bp.includes('high risk')) s += 15;
  else if (bp.includes('potential but high risk')) s += 10;
  else if (bp.includes('emerging with potential') || bp.includes('moderate')) s += 5;

  const inc = String(owner.best_income || '').toLowerCase();
  if (inc.match(/\$0|\$15,000|\$20,000|\$24,999/)) s += 15;
  else if (inc.match(/\$25,000|\$30,000|\$35,000/)) s += 10;
  else if (inc.match(/\$40,000|\$45,000|\$50,000/)) s += 5;

  const nav = String(owner.best_net_asset || '').toLowerCase();
  if (nav.includes('$0-24') || nav.startsWith('$0')) s += 15;
  else if (nav.includes('$25,000-49')) s += 10;
  else if (nav.includes('$50,000-74')) s += 5;

  const tags = String(owner.seller_tags_text || '').toLowerCase();
  if (tags.includes('preforeclosure')) s += 40;
  if (tags.includes('probate')) s += 35;
  if (tags.includes('tax delinquent')) s += 30;  // legacy double count with the count term above
  if (tags.includes('tired landlord')) s += 25;
  if (tags.includes('vacant')) s += 20;
  if (tags.includes('major repairs')) s += 20;
  if (tags.includes('heavily dated')) s += 12;

  const deed = String(owner.last_sale_doc_type || '').toLowerCase();
  if (deed.includes('distress sale')) s += 40;
  else if (deed.includes('trustee')) s += 30;
  else if (deed.includes('administrator') || deed.includes('executor')) s += 28;
  else if (deed.includes('quit claim') || deed.includes('quitclaim')) s += 12;

  const oy = asNumber_(owner.max_ownership_years);
  if (oy >= 25) s += 15;
  else if (oy >= 20) s += 12;
  else if (oy >= 15) s += 10;
  else if (oy >= 10) s += 6;
  else if (oy <= 2) s -= 10;

  return Math.max(0, Math.min(100, Math.round(s)));
}

export function calcUrgency_(owner) {
  let s = 0;
  const tdYears = owner.oldest_tax_delinquent_year ? (2026 - owner.oldest_tax_delinquent_year) : 0;
  if (owner.tax_delinquent_count > 0 && tdYears >= 3) s += 40;
  else if (owner.tax_delinquent_count > 0 && tdYears >= 2) s += 25;
  else if (owner.tax_delinquent_count > 0) s += 15;

  s += Math.min(owner.distress_marker_count * 5, 30);
  if (owner.is_absentee) s += 10;
  if (owner.active_lien_count > 0) s += 12;
  if (owner.property_count >= 5) s += 10;
  else if (owner.property_count >= 3) s += 5;

  const tags = String(owner.seller_tags_text || '').toLowerCase();
  if (tags.includes('upcoming auction')) s += 45;
  if (tags.includes('foreclosure')) s += 40;   // legacy: 'preforeclosure' also matches this
  if (tags.includes('preforeclosure')) s += 35;
  if (tags.includes('probate')) s += 25;
  if (tags.includes('vacant')) s += 18;
  if (tags.includes('likely to move')) s += 12;
  if (tags.includes('long term owner')) s += 8;

  const oy = asNumber_(owner.max_ownership_years);
  if (oy >= 25) s += 20;
  else if (oy >= 20) s += 15;
  else if (oy >= 15) s += 10;
  else if (oy <= 2) s -= 10;

  return Math.max(0, Math.min(100, Math.round(s)));
}

export function contactabilityScore_(bestContactScore, bestPhoneScore) {
  return Math.max(0, Math.min(100, Math.round((asNumber_(bestContactScore) * 0.6) + (asNumber_(bestPhoneScore) * 0.4))));
}

export function equityBonus_(portfolioTotalEquity, portfolioTotalValue) {
  const equityRatio = portfolioTotalValue > 0 ? portfolioTotalEquity / portfolioTotalValue : 0;
  return equityRatio >= 0.5 ? 20 : equityRatio >= 0.3 ? 10 : 0;
}

export function priorityScore_(owner) {
  return Math.max(0, Math.min(100, Math.round(
    (owner.financial_pressure_score * 0.30)
    + (owner.urgency_score * 0.30)
    + (owner.contactability_score * 0.20)
    + equityBonus_(owner.portfolio_total_equity, owner.portfolio_total_value),
  )));
}

export const priorityTierFromScore_ = (score) => (score >= 70 ? 'TIER_1' : score >= 45 ? 'TIER_2' : 'TIER_3');
export const followUpCadence_ = (tier) => (tier === 'TIER_1' ? 'AGGRESSIVE' : tier === 'TIER_2' ? 'STANDARD' : 'PASSIVE');
export const phoneConfidenceBucket_ = (score) => (score >= 75 ? 'A' : score >= 50 ? 'B' : score >= 25 ? 'C' : 'D');

export function classifyOwnerType_(ownerName, ownerLoc, tags) {
  const n = String(ownerName || '').toLowerCase();
  const loc = String(ownerLoc || '').toLowerCase();
  const t = String(tags || '').toLowerCase();
  let occ = 'ABSENTEE';
  if (loc.includes('owner') && (loc.includes('occupied') || loc.includes('occup'))) occ = 'OWNER_OCC';
  else if (loc.includes('resident')) occ = 'OWNER_OCC';
  else if (loc.includes('absentee')) occ = 'ABSENTEE';
  let entity = 'INDIVIDUAL';
  if (t.includes('bank owned') || /\b(bank|mortgage|servicing|servicer|hud|fannie|freddie|fnma|fhlmc)\b/.test(n)) entity = 'BANK/INSTITUTION';
  else if (t.includes('probate') || /\b(trust|trustee|estate|heirs|executor|administrator|personal representative|irrevocable|revocable|family trust)\b/.test(n)) entity = 'TRUST/ESTATE';
  else if (/\b(llc|l\.l\.c|inc|corp|corporation|ltd|lp|llp|holdings|investments|properties|group|capital|ventures|realty|management|partners)\b/.test(n) || t.includes('corporate owner')) entity = 'LLC/CORP';
  return `${entity} | ${occ}`;
}

// ---------------- owner scoring (composition, exact) ----------------
export function scoreV12Owner(owner) {
  const o = { ...owner };
  o.contactability_score = contactabilityScore_(o.best_contact_score, o.best_phone_score);
  o.financial_pressure_score = calcFinancialPressure_(o);
  o.urgency_score = calcUrgency_(o);
  o.priority_score = priorityScore_({
    financial_pressure_score: o.financial_pressure_score,
    urgency_score: o.urgency_score,
    contactability_score: o.contactability_score,
    portfolio_total_equity: o.portfolio_total_equity,
    portfolio_total_value: o.portfolio_total_value,
  });
  o.priority_tier = priorityTierFromScore_(o.priority_score);
  o.follow_up_cadence = followUpCadence_(o.priority_tier);
  o.best_phone_confidence = phoneConfidenceBucket_(o.best_phone_score);
  return o;
}

// ---------------- staged-bundle adapter (comparison harness) ----------------
// Maps our staged canonical bundle onto the legacy owner shape using the same
// aggregation semantics the Apps Script applied to RAW_GRAPH rows. Documented
// approximations (missing legacy inputs) are listed in the fidelity report.
export function ownerFromBundle(bundle) {
  const raw = bundle.property?.raw_keep ?? {};
  const v = bundle.valuation ?? {};
  const flagsText = String(raw.property_flags ?? '')
    .replace(/"label"\s*:\s*"([^"]+)"/g, (_, l) => `|${l}|`);
  const links = bundle.links ?? [];
  const profile = links.map((l) => l.profile).find(Boolean) ?? {};
  const slot = {
    matching_flags: (links[0]?.matching_flags ?? []).join(', '),
    buying_power: profile.buying_power ?? '',
    likely_owner: links[0]?.likely_owner_scalar === true ? 'true' : '',
    likely_renting: '',
    person_flags_text: String(links[0]?.person_flags_raw ?? ''),
  };
  const contactScore = scoreContactFallback_(slot);
  const bestPhone = (bundle.phones ?? [])
    .map((p) => scorePhoneFallback_(p.line_type === 'wireless' ? 'W' : 'L', 'active', '', ''))
    .filter((s) => s >= 0).sort((a, b) => b - a)[0] ?? 0;
  const tdYear = v.tax_delinquent_year ?? asNumber_(raw.TaxDelinquentYear) ?? 0;
  const tenureYears = (() => {
    const cur = (bundle.transactions ?? []).find((t) => t.event_role === 'current' && t.sale_date);
    return cur ? Math.floor((Date.parse('2026-07-01') - Date.parse(cur.sale_date)) / (365.25 * 86400000)) : 0;
  })();
  const tags = flagsText.toLowerCase();
  return {
    portfolio_total_value: asNumber_(v.estimated_value ?? raw.estimated_value),
    portfolio_total_equity: asNumber_(v.estimated_equity ?? raw.estimated_equity),
    portfolio_total_loan_balance: (bundle.loans ?? []).filter((l) => l.slot_class === 'current_recorded')
      .reduce((s, l) => s + (l.estimated_balance ?? 0), 0),
    tax_delinquent_count: v.tax_delinquent === true || boolish_(raw.TaxDelinquent) ? 1 : 0,
    oldest_tax_delinquent_year: tdYear > 1900 ? tdYear : 0,
    active_lien_count: boolish_(raw.active_lien) || String(raw.active_lien ?? '').toLowerCase() === 'yes' ? 1 : 0,
    distress_marker_count: (flagsText.match(/\|/g) ?? []).length / 2,
    is_absentee: /absentee/i.test(String(raw.owner_status ?? raw.owner_location ?? '')) || tags.includes('absentee'),
    property_count: profile.portfolio_total_properties_owned ?? 1,
    seller_tags_text: flagsText,
    last_sale_doc_type: raw.CurrentSaleDocumentType ?? raw.last_sale_doc_type ?? '',
    best_buying_power: profile.buying_power ?? '',
    best_income: profile.est_household_income_code ? `$${profile.est_household_income_code},000` : '',
    best_net_asset: profile.net_asset_value ?? '',
    max_ownership_years: profile.length_of_residence ?? tenureYears,
    best_contact_score: contactScore > 0 ? contactScore : 0,
    best_phone_score: bestPhone,
  };
}

export function scoreV12Baseline(bundle) {
  const { cfg, versionId } = loadV12Config();
  const owner = scoreV12Owner(ownerFromBundle(bundle));
  return {
    engine_version_id: versionId,
    weight_class: cfg.weight_class,
    source_sha256: V12_SOURCE_SHA256,
    priority: owner.priority_score,
    tier: owner.priority_tier,
    cadence: owner.follow_up_cadence,
    components: [
      { component: 'financial_pressure_x0.30', contribution: owner.financial_pressure_score },
      { component: 'urgency_x0.30', contribution: owner.urgency_score },
      { component: 'contactability_x0.20', contribution: owner.contactability_score },
      { component: 'equity_bonus', contribution: equityBonus_(owner.portfolio_total_equity, owner.portfolio_total_value) },
    ],
  };
}

// rank agreement helper retained for reports
export function v12AgreementReport(scoredRows) {
  const paired = scoredRows.filter((r) => Number.isFinite(r.v12_artifact_order_score));
  if (paired.length < 10) return { pairs: paired.length, spearman: null, note: 'insufficient artifact coverage' };
  const rank = (arr) => {
    const idx = arr.map((v2, i) => [v2, i]).sort((a, b) => a[0] - b[0]);
    const rk = new Array(arr.length);
    idx.forEach(([, i], r) => { rk[i] = r; });
    return rk;
  };
  const a = rank(paired.map((r) => r.reconstruction_priority));
  const b = rank(paired.map((r) => r.v12_artifact_order_score));
  const n = a.length;
  const d2 = a.reduce((s, ai, i) => s + (ai - b[i]) ** 2, 0);
  return { pairs: n, spearman: Math.round((1 - (6 * d2) / (n * (n * n - 1))) * 1000) / 1000 };
}
