/**
 * Signal-based negotiation opening + concession ladder (SHADOW ONLY) — guards.
 * never above MAO · never below the fair floor · excluded fields never read ·
 * per-state marital switch · age zero-weight by default · ladder monotonicity ·
 * explainability completeness · SFR only · flag default off.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveSignalOpeningMode,
  collectSignalInputs,
  computeSignalOpening,
  planConcessionLadder,
  nextConcession,
  resolveFieldMode,
  LADDER_ACTIONS,
  HOLD_REASONS,
} from "../../src/lib/domain/seller-flow/negotiation-signal-opening.js";
import {
  SIGNALS,
  EXCLUDED_PRICING_FIELDS,
  SIGNAL_OPENING_CONFIG_VERSION,
  LADDER,
  MARITAL_COVERED_STATES,
  FIELD_MODES,
} from "../../src/lib/domain/seller-flow/negotiation-signal-opening-config.js";
import { evaluateShadowOpening, buildShadowRow, SHADOW_SUBJECTS } from "../../src/lib/domain/seller-flow/negotiation-signal-shadow.js";
import { PROPERTY_COLS, OWNER_COLS, PROSPECT_COLS, SCORE_COLS } from "../../scripts/ops/negotiation-signal-opening-shadow.mjs";

const NOW = "2026-10-06T12:00:00.000Z";

function fixture(over = {}) {
  return {
    property: {
      property_id: "p1",
      master_owner_id: "o1",
      property_state: "TX",
      canonical_market_id: "dallas-tx",
      property_type: "Single Family",
      units_count: 1,
      building_condition: "Average",
      rehab_level: "Full Rehab",
      year_built: 1962,
      flood_zone: "X",
      property_flags_text: "High Equity; Absentee Owner; Tired Landlord",
      equity_percent: 80,
      total_loan_balance: 20000,
      active_lien: false,
      tax_delinquent: false,
      ownership_years: 18,
      out_of_state_owner: false,
      // Protected / excluded fields present on the record — must never be read.
      gender: "Female",
      language_preference: "Spanish",
      best_language: "Spanish",
      agent_persona: "Maria",
      owner_name: "JANE DOE",
      situs_census_tract: "123.04",
      ai_score: 99,
      final_acquisition_score: 99,
      ...(over.property || {}),
    },
    owner: { master_owner_id: "o1", property_count: 2, seller_tags_text: "", best_language: "Spanish", agent_persona: "Maria", ...(over.owner || {}) },
    prospect: {
      prospect_id: "pr1",
      mob: "195001",
      marital_status: "Married - Likely",
      est_household_income: "$55,000-$59,999",
      net_asset_value: "$100,000-249,999",
      buying_power: "Moderate and Emerging Buyers",
      gender: "Male",
      language_preference: "Spanish",
      full_name: "Jane Doe",
      first_name: "Jane",
      ...(over.prospect || {}),
    },
    score: {
      id: "s1",
      property_id: "p1",
      valuation_mid: 327900,
      estimated_repairs: 64900,
      recommended_cash_offer: 147000,
      decision_tier: "AUTO_RANGE_OFFER",
      computed_at: "2026-10-01T12:58:05.986Z",
      evidence: {
        offer_calculation: { effective_authorized_ceiling: 164600, assignment_margin_floor: 15000 },
        subject: { normalized_features: { vacant: false, probate: false, condition: "Average", phone_type: "x", buyer_type: null } },
      },
      ...(over.score || {}),
    },
    conversation: over.conversation || null,
  };
}

function evaluate(f, opts = {}) {
  const inputs = collectSignalInputs({ ...f, now: NOW });
  return computeSignalOpening(inputs, { now: NOW, ...opts });
}

// Deterministic PRNG for sweeps.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function randomFixture(rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const mao = 40_000 + Math.round(rand() * 600_000);
  const val = mao * (1.2 + rand() * 1.2);
  const rep = rand() < 0.2 ? null : Math.round(val * rand() * 0.45);
  return fixture({
    property: {
      property_state: pick(["TX", "MN", "IL", "FL", "CA", "GA", null]),
      rehab_level: pick(["Structural", "Full Rehab", "Moderate", "Light", "None", null]),
      building_condition: pick(["Poor", "Fair", "Average", "Good", "Excellent", "Unknown"]),
      flood_zone: pick(["AE", "X", "VE", null]),
      year_built: pick([1900, 1950, 1990, 2015, null]),
      property_flags_text: pick(["", "Vacant Home; Probate; Tax Delinquent; Preforeclosure; Tired Landlord; Out Of State Owner", "High Equity", "Senior Owner; Empty Nester"]),
      equity_percent: pick([5, 30, 55, 90, null]),
      total_loan_balance: pick([0, mao * 0.95, mao * 0.5, null]),
      tax_delinquent: rand() < 0.3,
      tax_delinquent_year: pick([2019, 2025, null]),
      ownership_years: pick([1, 8, 25, null]),
      mls_market_status: pick(["Active", "Expired", null]),
    },
    owner: { property_count: pick([1, 4, 20, null]) },
    prospect: { mob: pick(["194001", "199001", null]), est_household_income: pick(["$20,000-$24,999", "$200,000+", null]) },
    score: {
      valuation_mid: val,
      estimated_repairs: rep,
      recommended_cash_offer: Math.round(mao * 0.89),
      evidence: { offer_calculation: { effective_authorized_ceiling: mao, assignment_margin_floor: 15000 }, subject: { normalized_features: {} } },
    },
    conversation: rand() < 0.5 ? { messages: [{ direction: "outbound", body: "What price are you looking to get?", at: "2026-10-01T10:00:00Z" }, { direction: "inbound", body: pick(["I need to sell fast, behind on payments", "make me an offer", "250k", "going through a divorce, asap"]), at: "2026-10-01T10:05:00Z" }] } : null,
  });
}

test("flag: default OFF; any truthy value is shadow (there is no live mode)", () => {
  assert.equal(resolveSignalOpeningMode({}), "off");
  assert.equal(resolveSignalOpeningMode({ NEGOTIATION_SIGNAL_OPENING: "false" }), "off");
  assert.equal(resolveSignalOpeningMode({ NEGOTIATION_SIGNAL_OPENING: "true" }), "shadow");
  assert.equal(resolveSignalOpeningMode({ NEGOTIATION_SIGNAL_OPENING: "live" }), "shadow");
});

test("baseline TX SFR: opening below recommended, ≥ floor, ≤ MAO", () => {
  const ev = evaluate(fixture());
  assert.equal(ev.status, "ok");
  assert.ok(ev.opening <= 164600);
  assert.ok(ev.opening >= ev.floor);
  assert.ok(ev.opening < 147000, `opening ${ev.opening} should sit below the recommended offer`);
  assert.equal(ev.floor, Math.round(0.5 * (327900 - 64900)));
  assert.equal(ev.config_version, SIGNAL_OPENING_CONFIG_VERSION);
});

test("never above MAO and never below the fair floor (2,000-case sweep, opening + every ladder rung)", () => {
  const rand = lcg(42);
  let ok = 0;
  for (let i = 0; i < 2000; i += 1) {
    const ev = evaluate(randomFixture(rand));
    if (ev.status !== "ok") {
      assert.ok(Object.values(HOLD_REASONS).includes(ev.reason), ev.reason);
      assert.equal(ev.opening, null);
      continue;
    }
    ok += 1;
    assert.ok(ev.opening <= ev.walk_away && ev.walk_away <= ev.mao, `opening ${ev.opening} walk ${ev.walk_away} mao ${ev.mao}`);
    assert.ok(ev.opening >= ev.floor, `opening ${ev.opening} below floor ${ev.floor}`);
    for (const rung of ev.ladder) assert.ok(rung.amount <= ev.mao && rung.amount >= ev.floor);
    // Owner goal: below the offer range unless the fair floor (or max spread) forces it up.
    if (!ev.floor_applied && ev.recommended_cash_offer < ev.mao && 1 - ev.recommended_cash_offer / ev.mao <= 0.22) {
      assert.ok(ev.opening <= ev.recommended_cash_offer, `opening ${ev.opening} inside the offer range (rec ${ev.recommended_cash_offer})`);
    }
  }
  assert.ok(ok > 500, `sweep exercised ${ok} openings`);
});

test("fair floor binds on extreme distress; floor above MAO holds for a human", () => {
  const distressed = fixture({
    property: { property_flags_text: "Vacant Home; Probate; Tax Delinquent; Preforeclosure; Tired Landlord; Out Of State Owner; Active Lien", rehab_level: "Structural", flood_zone: "AE", tax_delinquent: true, tax_delinquent_year: 2020, equity_percent: 100, total_loan_balance: 0 },
    conversation: { messages: [{ direction: "outbound", body: "what price?", at: "2026-10-01T10:00:00Z" }, { direction: "inbound", body: "make me an offer, need to sell fast asap, behind on payments", at: "2026-10-01T10:02:00Z" }] },
    score: { estimated_repairs: 20000 },
  });
  const ev = evaluate(distressed);
  assert.equal(ev.status, "ok");
  assert.equal(ev.spread, 0.22, "clamped at max_spread");
  assert.equal(ev.floor_applied, true);
  assert.ok(ev.opening >= ev.floor && ev.opening <= ev.mao);

  const noRoom = evaluate(fixture({ score: { valuation_mid: 400000, estimated_repairs: 0 } }));
  assert.equal(noRoom.status, "hold");
  assert.equal(noRoom.reason, HOLD_REASONS.FLOOR_ABOVE_WALK_AWAY);
  assert.equal(noRoom.opening, null);
});

// ── excluded fields ─────────────────────────────────────────────────────────
function recorder(target, log) {
  if (!target || typeof target !== "object") return target;
  return new Proxy(target, {
    get(t, key, recv) {
      if (typeof key === "string") log.add(key);
      return recorder(Reflect.get(t, key, recv), log);
    },
    has(t, key) {
      if (typeof key === "string") log.add(key);
      return Reflect.has(t, key);
    },
    ownKeys(t) {
      log.add("__enumerated__");
      return Reflect.ownKeys(t);
    },
  });
}

test("excluded fields are NEVER read by the pricing module (Proxy-instrumented sources)", () => {
  const f = fixture({
    conversation: {
      messages: [
        { direction: "outbound", body: "What price?", at: "2026-10-01T10:00:00Z", language: "Spanish", thread_language: "Spanish" },
        { direction: "inbound", body: "Necesito vender rápido, 200k", at: "2026-10-01T10:03:00Z", language: "Spanish", seller_language: "Spanish" },
      ],
      language: "Spanish",
      thread_language: "Spanish",
    },
  });
  const log = new Set();
  const inputs = collectSignalInputs({
    property: recorder(f.property, log),
    owner: recorder(f.owner, log),
    prospect: recorder(f.prospect, log),
    score: recorder(f.score, log),
    conversation: recorder(f.conversation, log),
    now: NOW,
  });
  computeSignalOpening(inputs, { now: NOW });
  assert.ok(!log.has("__enumerated__"), "sources must not be enumerated (a spread/Object.keys would read every field)");
  const violations = EXCLUDED_PRICING_FIELDS.filter((k) => log.has(k));
  assert.deepEqual(violations, [], `pricing module read excluded field(s): ${violations.join(", ")}`);
});

test("excluded fields and protected-class tags cannot change the number (invariance)", () => {
  const a = evaluate(fixture());
  const b = evaluate(
    fixture({
      property: { gender: "Male", language_preference: "English", best_language: "Vietnamese", situs_census_tract: "999", property_flags_text: "High Equity; Absentee Owner; Tired Landlord; Empty Nester" },
      prospect: { gender: "Female", language_preference: "Chinese", full_name: "X Y" },
    }),
  );
  assert.equal(a.opening, b.opening);
  assert.equal(a.spread, b.spread);
  assert.deepEqual(a.signals, b.signals);
});

test("static scan: the pricing modules contain no excluded identifier; the shadow script never selects one", () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const rel of ["../../src/lib/domain/seller-flow/negotiation-signal-opening.js", "../../src/lib/domain/seller-flow/negotiation-signal-shadow.js"]) {
    const code = strip(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
    for (const field of EXCLUDED_PRICING_FIELDS) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${field}(?![A-Za-z0-9_])`);
      assert.ok(!re.test(code), `${rel} references excluded field "${field}"`);
    }
  }
  const selected = [...PROPERTY_COLS, ...OWNER_COLS, ...PROSPECT_COLS, ...SCORE_COLS.map((c) => c.split(":=")[0])];
  assert.deepEqual(selected.filter((c) => EXCLUDED_PRICING_FIELDS.includes(c)), []);
});

test("health / disability language is not read as urgency", () => {
  const ev = evaluate(fixture({ conversation: { messages: [{ direction: "inbound", body: "I have medical bills and a disability, health issues", at: "2026-10-01T10:00:00Z" }] } }));
  const u = ev.signals.find((s) => s.key === "urgency_language");
  assert.equal(u.value, 0);
  assert.equal(u.contribution, 0);
});

// ── marital status per-state switch ────────────────────────────────────────
const divorceConvo = { messages: [{ direction: "inbound", body: "We are going through a divorce", at: "2026-10-01T10:00:00Z" }] };
const maritalOf = (ev) => ev.signals.find((s) => s.key === "marital_status");

test("marital status: enabled in TX, OFF (not computed, withheld) in MN / IL / covered states, local-ordinance markets and unknown state", () => {
  const tx = maritalOf(evaluate(fixture({ conversation: divorceConvo })));
  assert.equal(tx.mode, FIELD_MODES.ENABLED);
  assert.equal(tx.value, "divorce_or_separation");
  assert.ok(tx.contribution > 0);

  for (const st of ["MN", "IL", "CA", "NY", "WI", "MI", "WA"]) {
    assert.ok(MARITAL_COVERED_STATES.includes(st), `${st} must be a covered state`);
    const m = maritalOf(evaluate(fixture({ property: { property_state: st, canonical_market_id: null }, conversation: divorceConvo })));
    assert.equal(m.mode, FIELD_MODES.OFF, st);
    assert.equal(m.value, null, `${st} value withheld`);
    assert.equal(m.contribution, 0);
    assert.equal(m.shadow_contribution, 0);
  }
  const austin = maritalOf(evaluate(fixture({ property: { canonical_market_id: "austin-tx" }, conversation: divorceConvo })));
  assert.equal(austin.mode, FIELD_MODES.OFF);
  assert.equal(austin.mode_basis, "local_ordinance:austin-tx");
  const unknown = maritalOf(evaluate(fixture({ property: { property_state: null }, conversation: divorceConvo })));
  assert.equal(unknown.mode, FIELD_MODES.OFF);
});

test("marital status OFF state: the field is not even read (MN, Proxy)", () => {
  const f = fixture({ property: { property_state: "MN", canonical_market_id: "minneapolis-mn" }, conversation: { ...divorceConvo, facts: { divorce: true } } });
  const log = new Set();
  collectSignalInputs({ property: f.property, prospect: recorder(f.prospect, log), score: f.score, conversation: recorder(f.conversation, log), now: NOW });
  assert.ok(!log.has("marital_status"), "prospects.marital_status read in MN");
  assert.ok(!log.has("divorce"), "stated divorce fact read in MN");
  const tx = new Set();
  collectSignalInputs({ property: fixture().property, prospect: recorder(f.prospect, tx), score: f.score, now: NOW });
  assert.ok(tx.has("marital_status"), "TX reads it (control)");
});

test("marital status: MN opening is unaffected by a stated divorce; owner per-state overrides work both ways", () => {
  const mnA = evaluate(fixture({ property: { property_state: "MN", canonical_market_id: "minneapolis-mn" } }));
  const mnB = evaluate(fixture({ property: { property_state: "MN", canonical_market_id: "minneapolis-mn" }, conversation: divorceConvo }));
  assert.equal(maritalOf(mnB).contribution, 0);
  assert.equal(mnA.signals.filter((s) => s.key !== "marital_status" && s.key !== "urgency_language").map((s) => s.contribution).join(), mnB.signals.filter((s) => s.key !== "marital_status" && s.key !== "urgency_language").map((s) => s.contribution).join());
  assert.equal(resolveFieldMode("marital_status", { state: "TX", owner_overrides: { marital_status: { TX: "off" } } }).mode, "off");
  assert.equal(resolveFieldMode("marital_status", { state: "MN", owner_overrides: { marital_status: { MN: "enabled" } } }).mode, "enabled");
  // A blanket owner default never unlocks a covered state.
  assert.equal(resolveFieldMode("marital_status", { state: "MN", owner_overrides: { marital_status: { default: "enabled" } } }).mode, "off");
});

// ── age ─────────────────────────────────────────────────────────────────────
test("age: computed + logged but ZERO weight by default, everywhere", () => {
  for (const st of ["TX", "FL", "MN", "IL", null]) {
    const old = evaluate(fixture({ property: { property_state: st, canonical_market_id: null }, prospect: { mob: "194501" } }));
    const young = evaluate(fixture({ property: { property_state: st, canonical_market_id: null }, prospect: { mob: "199001" } }));
    const age = old.signals.find((s) => s.key === "age");
    assert.equal(age.mode, FIELD_MODES.SHADOW_ONLY, String(st));
    assert.equal(age.effective_weight, 0);
    assert.equal(age.contribution, 0);
    assert.equal(age.value, 81, "computed and logged");
    assert.ok(age.shadow_contribution > 0, "what it would contribute is visible for review");
    if (old.status === "ok") assert.equal(old.opening, young.opening, "age never moves the number by default");
  }
  // Senior-owner tag is an age proxy: routed to the guarded age signal only.
  const tag = evaluate(fixture({ property: { property_flags_text: "Senior Owner" }, prospect: { mob: null } }));
  assert.equal(tag.signals.find((s) => s.key === "age").value, "senior_tag");
  assert.equal(tag.signals.find((s) => s.key === "age").contribution, 0);
  // Owner default flip enables uncovered states only; covered states stay shadow.
  const ov = { age: { default: "enabled" } };
  assert.equal(resolveFieldMode("age", { state: "TX", owner_overrides: ov }).mode, "enabled");
  assert.equal(resolveFieldMode("age", { state: "IL", owner_overrides: ov }).mode, "shadow_only");
  assert.equal(resolveFieldMode("age", { state: "TX", market: "austin-tx", owner_overrides: ov }).mode, "shadow_only");
});

// ── ladder ──────────────────────────────────────────────────────────────────
test("planned ladder: monotone, decreasing steps, ends at walk-away, never above it", () => {
  const rungs = planConcessionLadder({ opening: 130000, walk_away: 164600 });
  assert.equal(rungs.length, LADDER.max_rounds + 1);
  assert.equal(rungs[0].amount, 130000);
  assert.equal(rungs.at(-1).amount, 164600);
  for (let i = 1; i < rungs.length; i += 1) {
    assert.ok(rungs[i].amount >= rungs[i - 1].amount);
    assert.ok(rungs[i].amount <= 164600);
  }
  const steps = rungs.slice(1, -1).map((r) => r.step);
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i] <= steps[i - 1], `steps shrink ${steps}`);
});

test("nextConcession: monotone, ≤ walk-away, ≤ seller counter, never a step larger than the remaining gap (sweep)", () => {
  const rand = lcg(7);
  for (let run = 0; run < 500; run += 1) {
    const opening = 50000 + Math.round(rand() * 300000);
    const walk = opening + 5000 + Math.round(rand() * 80000);
    const offers = [opening];
    const positions = [];
    let ask = walk * (1 + rand() * 0.5);
    let holds = 0;
    for (let turn = 0; turn < 10; turn += 1) {
      ask = Math.max(opening * 0.9, ask * (1 - rand() * 0.12));
      positions.push(Math.round(ask));
      const current = Math.max(...offers);
      const mv = nextConcession({ opening, walk_away: walk, our_offers: offers, seller_positions: positions, holds });
      if (mv.action === LADDER_ACTIONS.HOLD) {
        holds += 1;
        continue;
      }
      holds = 0;
      if (mv.action === LADDER_ACTIONS.ESCALATE) break;
      assert.ok(mv.amount <= walk, "never above walk-away");
      if (mv.action === LADDER_ACTIONS.ACCEPT_COUNTER) {
        assert.equal(mv.amount, positions.at(-1));
        break;
      }
      assert.ok(mv.amount > current, "monotone increasing");
      assert.ok(mv.amount - current <= walk - current, "step ≤ remaining gap");
      assert.ok(mv.amount < positions.at(-1), "never above the seller's own counter");
      offers.push(mv.amount);
      if (mv.action === LADDER_ACTIONS.FINAL) break;
    }
    assert.ok(offers.length - 1 <= LADDER.max_rounds, "max rounds respected");
  }
});

test("nextConcession: firm when flexible, faster when closing, hold then escalate when not moving, escalate at max rounds", () => {
  const base = { opening: 130000, walk_away: 164600 };
  const flexible = nextConcession({ ...base, our_offers: [130000], seller_positions: [220000, 190000] });
  const first = nextConcession({ ...base, our_offers: [130000], seller_positions: [190000] });
  assert.equal(flexible.behaviour, "flexible");
  assert.ok(flexible.step < first.step, "flexible seller → we stay firm");
  const closing = nextConcession({ ...base, our_offers: [130000, 144000], seller_positions: [190000, 160000, 150000] });
  assert.equal(closing.behaviour, "closing");
  assert.equal(closing.action, LADDER_ACTIONS.ACCEPT_COUNTER, "closing within the step meets the seller's counter");
  const stuck = nextConcession({ ...base, our_offers: [130000], seller_positions: [190000, 190000] });
  assert.equal(stuck.action, LADDER_ACTIONS.HOLD);
  assert.equal(nextConcession({ ...base, our_offers: [130000], seller_positions: [190000, 190000], holds: 1 }).action, LADDER_ACTIONS.ESCALATE);
  assert.equal(nextConcession({ ...base, our_offers: [130000, 140000, 147000, 154000, 158000], seller_positions: [200000, 190000] }).reason, "max_rounds_reached");
  assert.equal(nextConcession({ ...base, our_offers: [164600], seller_positions: [200000, 190000] }).reason, "walk_away_reached");
  assert.equal(nextConcession({ ...base, floor: 120000, our_offers: [130000], seller_positions: [100000] }).reason, "seller_counter_below_fair_floor");
});

// ── explainability ──────────────────────────────────────────────────────────
test("explainability: every configured signal recorded with value, contribution, mode and the config version; spread reconciles", () => {
  const ev = evaluate(fixture({ conversation: divorceConvo }));
  assert.equal(ev.signals.length, SIGNALS.length);
  for (const def of SIGNALS) {
    const s = ev.signals.find((x) => x.key === def.key);
    assert.ok(s, `signal ${def.key} recorded`);
    for (const field of ["group", "direction", "mode", "mode_basis", "captured", "value", "score", "weight", "effective_weight", "contribution", "shadow_contribution"]) {
      assert.ok(field in s, `${def.key}.${field}`);
    }
    assert.equal(s.weight, def.weight);
  }
  const sum = ev.signals.reduce((a, s) => a + s.contribution, 0);
  assert.ok(Math.abs(ev.base_spread + sum - ev.raw_spread) < 1e-3, "base + Σ contribution = raw spread");
  assert.ok(ev.config_version && ev.engine_version);
  const row = buildShadowRow({ subject_kind: SHADOW_SUBJECTS.CONVERSATION, thread_key: "t", property_id: "p1", result: evaluateShadowOpening({ ...fixture({ conversation: divorceConvo }), now: NOW }), evaluated_at: NOW });
  assert.equal(row.quote_type, "shadow_opening");
  assert.equal(row.would_send, false);
  assert.equal(row.config_version, SIGNAL_OPENING_CONFIG_VERSION);
  assert.equal(row.signals.length, SIGNALS.length);
});

test("deterministic: same inputs → identical output", () => {
  assert.deepEqual(evaluate(fixture()), evaluate(fixture()));
});

// ── SFR only ────────────────────────────────────────────────────────────────
test("SFR only: multifamily / land / commercial hold for a human; condo / townhouse are SFR", () => {
  for (const [property_type, units_count] of [["Duplex", 2], ["Multifamily", 4], ["Apartment", 12], ["Single Family", 3], ["Vacant Land", null], ["Commercial", null]]) {
    const ev = evaluate(fixture({ property: { property_type, units_count } }));
    assert.equal(ev.status, "hold", property_type);
    assert.equal(ev.reason, HOLD_REASONS.NOT_SFR);
    assert.equal(ev.opening, null);
  }
  for (const property_type of ["Condo", "Townhouse"]) assert.equal(evaluate(fixture({ property: { property_type, units_count: 1 } })).status, "ok");
});

test("shadow row contract refuses an opening above MAO or below the floor", () => {
  const bad = { evaluation: { status: "ok", opening: 200000, mao: 164600, walk_away: 164600, floor: 100000 } };
  assert.throws(() => buildShadowRow({ subject_kind: SHADOW_SUBJECTS.OFFER_READY, property_id: "p", result: bad, evaluated_at: NOW }), /above_mao/);
  const low = { evaluation: { status: "ok", opening: 90000, mao: 164600, walk_away: 164600, floor: 100000 } };
  assert.throws(() => buildShadowRow({ subject_kind: SHADOW_SUBJECTS.OFFER_READY, property_id: "p", result: low, evaluated_at: NOW }), /below_floor/);
});
