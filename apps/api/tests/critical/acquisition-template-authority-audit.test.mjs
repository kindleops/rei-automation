/**
 * TEMPLATE AUTHORITY: every reachable route resolves inside its own
 * communication purpose, or it fails closed.
 *
 * The rule being enforced:
 *
 *     missing approved template  ->  HOLD / REVIEW / template-gap reason
 *     missing approved template  ->  NEVER another stage's generic fallback
 *
 * A seller who just named $500,000 must never receive "are you the owner?"
 * because the nurture template was absent. That is the failure mode this file
 * exists to make impossible, and it is checked per route rather than once.
 *
 * Production counts quoted in comments were read from lcppdrmrdfblstpcbgpf on
 * 2026-09-11. The tests themselves never touch the network - they drive the
 * real resolver against explicit pools, so they assert BEHAVIOUR, not a
 * snapshot of the catalog.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveTemplateFromPool } from "@/lib/domain/templates/template-runtime-resolver.js";
import { STAGE3_ROUTES, routeForBand, STAGE3_OFFER_BANDS } from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";
import { LIFECYCLE_STAGE_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

/** A minimally valid, sendable catalog row. */
function row({ id, use_case, language = "English", stage_code = null, body = "Hi {{first_name}}, quick question." }) {
  return {
    id,
    template_id: id,
    use_case,
    language,
    stage_code,
    template_body: body,
    is_active: true,
    safe_for_auto_reply: true,
  };
}

const ASK = (use_case, language = "English") => ({
  use_case,
  language,
  thread_key: "+13125550123",
  merge_variables: { first_name: "Sam" },
});

// Every purpose a Stage-3 route can ask for.
const ROUTE_PURPOSES = Object.entries(STAGE3_ROUTES).map(([key, route]) => ({
  key,
  route_id: route.route_id,
  use_case: route.template_use_case,
  lifecycle_stage_code: route.lifecycle_stage_code,
}));

// Purposes belonging to OTHER stages. If a fallback can cross, it crosses to
// one of these - they are the messages that actually embarrassed us.
const FOREIGN_PURPOSES = [
  "ownership_check",
  "ownership_check_follow_up",
  "consider_selling",
  "consider_selling_follow_up",
  "reengagement",
  "condition_probe",
  "vacancy_probe",
  "occupancy_probe",
  "asks_contract",
  "accept_terms",
  "close_handoff",
];

// ══════════════════════════════════════════════════════════════════════════
// 1. CROSS-PURPOSE FALLBACK IS IMPOSSIBLE
// ══════════════════════════════════════════════════════════════════════════

test("every Stage-3 route fails closed when only foreign-purpose templates exist", () => {
  // The pool is deliberately rich: every other stage's template is present and
  // sendable. A resolver willing to cross purposes would find plenty.
  const pool = FOREIGN_PURPOSES.map((uc, i) => row({ id: `foreign-${i}`, use_case: uc }));

  for (const purpose of ROUTE_PURPOSES) {
    const resolved = resolveTemplateFromPool(ASK(purpose.use_case), pool);

    assert.equal(
      resolved.ok,
      false,
      `${purpose.route_id}: wanted "${purpose.use_case}", must NOT settle for a foreign purpose`,
    );
    assert.ok(resolved.reason, `${purpose.route_id} must report WHY it held`);

    // And every rejection must be an explicit purpose/stage mismatch, not an
    // accident of ranking that a future change could reverse.
    for (const excluded of resolved.excluded_candidates || []) {
      assert.ok(
        ["use_case_mismatch", "stage_mismatch"].includes(excluded.reason),
        `${purpose.route_id}: unexpected exclusion reason ${excluded.reason}`,
      );
    }
  }
});

test("a template of the RIGHT purpose is selected, so failing closed is not just failing", () => {
  for (const purpose of ROUTE_PURPOSES) {
    const pool = [
      ...FOREIGN_PURPOSES.map((uc, i) => row({ id: `foreign-${i}`, use_case: uc })),
      row({ id: `right-${purpose.use_case}`, use_case: purpose.use_case }),
    ];
    const resolved = resolveTemplateFromPool(ASK(purpose.use_case), pool);

    assert.equal(resolved.ok, true, `${purpose.route_id} should resolve when its own template exists`);
    assert.equal(resolved.template.use_case, purpose.use_case, "and it must be the right purpose");
  }
});

test("an EMPTY catalog holds rather than inventing a message", () => {
  for (const purpose of ROUTE_PURPOSES) {
    const resolved = resolveTemplateFromPool(ASK(purpose.use_case), []);
    assert.equal(resolved.ok, false, `${purpose.route_id} must hold on an empty catalog`);
    assert.equal(resolved.template ?? null, null, "no template may be conjured");
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2. THE DEAD MESSAGE FAMILIES
// ══════════════════════════════════════════════════════════════════════════

/**
 * The vacancy/occupancy probe fired immediately after a price was captured -
 * asking a seller who had just named a number whether the house was empty.
 *
 * Production still holds 2 active vacancy_probe and 2 active occupancy_probe
 * rows, BOTH marked safe_for_auto_reply. They are not disabled, so the only
 * thing standing between them and a seller is route selection. This pins that.
 */
test("no Stage-3 route can ever ask for a vacancy or occupancy probe", () => {
  const KILLED = ["vacancy_probe", "occupancy_probe", "condition_probe"];
  for (const purpose of ROUTE_PURPOSES) {
    assert.ok(
      !KILLED.includes(purpose.use_case),
      `${purpose.route_id} must not route to the killed probe "${purpose.use_case}"`,
    );
  }
});

test("even with a price captured, no band routes to a probe family", () => {
  // Every band, both creative postures. None may yield a killed purpose.
  const KILLED = new Set(["vacancy_probe", "occupancy_probe", "condition_probe"]);
  for (const band of Object.values(STAGE3_OFFER_BANDS)) {
    for (const creative_allowed of [false, true]) {
      const route = routeForBand(band, { creative_allowed });
      assert.ok(
        !KILLED.has(route.template_use_case),
        `band ${band} (creative=${creative_allowed}) routed to killed "${route.template_use_case}"`,
      );
    }
  }
});

test("the killed fallback copy is absent from the safe-fallback module", async () => {
  const mod = await import("@/lib/domain/seller-flow/coverage-net/safe-fallback.js");
  const serialized = JSON.stringify(mod, (_k, v) => (typeof v === "function" ? String(v) : v));

  // "would you rather I not reach out?" and "or is it not something you'd part
  // with?" both handed the seller a scripted way to end the conversation.
  for (const phrase of ["rather I not reach out", "part with"]) {
    const live = serialized
      .split("\n")
      .filter((line) => line.includes(phrase) && !line.trimStart().startsWith("//"));
    assert.equal(live.length, 0, `killed phrase "${phrase}" is reachable again`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3. CREATIVE ROUTE — reachable, never autonomous
// ══════════════════════════════════════════════════════════════════════════

/**
 * Production: creative_probe has 10 active templates and ZERO with
 * safe_for_auto_reply. Creative messaging is therefore reachable but must
 * always stop at review. Good behaviour until creative copy is deliberately
 * approved - this test exists so nobody flips it by accident.
 */
test("the creative route is review-only: an auto-reply-unsafe pool yields nothing", () => {
  const route = STAGE3_ROUTES.WIDE_GAP_CREATIVE;
  assert.equal(route.template_use_case, "creative_probe");
  assert.equal(route.inbox_bucket, "needs_review", "creative must land in review");

  // Mirror production: active, correct purpose, but not auto-reply safe.
  const pool = [
    { ...row({ id: "creative-1", use_case: "creative_probe" }), safe_for_auto_reply: false },
    { ...row({ id: "creative-2", use_case: "creative_probe" }), safe_for_auto_reply: false },
  ];
  const resolved = resolveTemplateFromPool(
    { ...ASK("creative_probe"), require_auto_reply_safe: true },
    pool.filter((t) => t.safe_for_auto_reply),
  );
  assert.equal(resolved.ok, false, "no auto-safe creative template exists, so no autonomous send");
});

// ══════════════════════════════════════════════════════════════════════════
// 4. OFFER ROUTE — uses offer copy, never contract copy
// ══════════════════════════════════════════════════════════════════════════

test("the offer route selects offer copy and can never reach contract copy", () => {
  const route = STAGE3_ROUTES.AUTO_ACCEPT_OFFER;
  assert.equal(route.template_use_case, "offer_reveal_cash");
  assert.equal(route.lifecycle_stage_code, LIFECYCLE_STAGE_CODES.OFFER);

  // A pool containing BOTH. The contract templates must be excluded by purpose.
  const pool = [
    row({ id: "offer-1", use_case: "offer_reveal_cash" }),
    row({ id: "contract-1", use_case: "asks_contract" }),
    row({ id: "accept-1", use_case: "accept_terms" }),
    row({ id: "handoff-1", use_case: "close_handoff" }),
  ];
  const resolved = resolveTemplateFromPool(ASK("offer_reveal_cash"), pool);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.template.use_case, "offer_reveal_cash");
  assert.notEqual(resolved.template.use_case, "asks_contract");
  assert.notEqual(resolved.template.use_case, "accept_terms");

  // And with the offer template removed it HOLDS rather than reaching for the
  // contract - which is the Ruling-1 defect expressed at the template layer.
  const without = resolveTemplateFromPool(ASK("offer_reveal_cash"), pool.slice(1));
  assert.equal(without.ok, false, "no offer template means hold, not escalate to contract");
});

// ══════════════════════════════════════════════════════════════════════════
// 5. VERY-WIDE-GAP NURTURE — nothing but nurture is eligible
// ══════════════════════════════════════════════════════════════════════════

test("the nurture route excludes condition, offer, creative and contract copy", () => {
  const route = STAGE3_ROUTES.VERY_WIDE_GAP_NURTURE;
  assert.equal(route.template_use_case, "asking_price_follow_up");
  assert.equal(route.lifecycle_stage_code, LIFECYCLE_STAGE_CODES.ASKING_PRICE);

  const INELIGIBLE = [
    "price_high_condition_probe",
    "condition_probe",
    "vacancy_probe",
    "occupancy_probe",
    "offer_reveal_cash",
    "creative_probe",
    "asks_contract",
    "accept_terms",
  ];

  // Every ineligible purpose present and sendable; the nurture one absent.
  const pool = INELIGIBLE.map((uc, i) => row({ id: `x-${i}`, use_case: uc }));
  const resolved = resolveTemplateFromPool(ASK("asking_price_follow_up"), pool);
  assert.equal(resolved.ok, false, "a James/Lorrie seller gets silence, not a condition probe");

  // With its own template present it resolves - and only to that one.
  const withNurture = resolveTemplateFromPool(ASK("asking_price_follow_up"), [
    ...pool,
    row({ id: "nurture-1", use_case: "asking_price_follow_up" }),
  ]);
  assert.equal(withNurture.ok, true);
  assert.equal(withNurture.template.use_case, "asking_price_follow_up");
});

// ══════════════════════════════════════════════════════════════════════════
// 6. TRANSLATED VARIANTS CANNOT SIDESTEP THE PURPOSE FENCE
// ══════════════════════════════════════════════════════════════════════════

test("a Spanish pool cannot satisfy an English request, and vice versa", () => {
  const spanishOnly = [row({ id: "es-1", use_case: "asking_price_follow_up", language: "Spanish" })];
  const en = resolveTemplateFromPool(ASK("asking_price_follow_up", "English"), spanishOnly);
  assert.equal(en.ok, false, "language is a fence too");
  assert.ok((en.excluded_candidates || []).some((x) => x.reason === "language_mismatch"));

  const es = resolveTemplateFromPool(ASK("asking_price_follow_up", "Spanish"), spanishOnly);
  assert.equal(es.ok, true, "the Spanish request resolves to the Spanish template");
});

test("a translated FOREIGN purpose is still a foreign purpose", () => {
  // The Spanish consider_selling family contains "te desprenderias de la
  // propiedad" - the Spanish form of the killed "would you part with it?".
  // It must not be reachable from a Stage-3 purpose in any language.
  const pool = [
    row({ id: "es-consider", use_case: "consider_selling", language: "Spanish" }),
    row({ id: "es-ownership", use_case: "ownership_check", language: "Spanish" }),
  ];
  for (const purpose of ROUTE_PURPOSES) {
    const resolved = resolveTemplateFromPool(ASK(purpose.use_case, "Spanish"), pool);
    assert.equal(resolved.ok, false, `${purpose.route_id} must not cross into Spanish S1/S2 copy`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 7. THE REENGAGEMENT LADDER IS FENCED OUT OF THE ACQUISITION PATH
// ══════════════════════════════════════════════════════════════════════════

/**
 * load-template.js carries a CROSS-PURPOSE fallback ladder. When exact + alias
 * matching yields nothing on a FOLLOW_UP touch it retries with:
 *
 *     "reengagement"                (gated on hasReengagementEvidence)
 *     "ownership_check_follow_up"   <- S1
 *     "consider_selling_follow_up"  <- S2, and production has THREE of these
 *                                      marked safe_for_auto_reply
 *
 * Reached from a Stage-3 follow-up, that is exactly the message class the
 * operator rejected: a seller who already gave us a price being asked whether
 * they own the house or would consider selling.
 *
 * It is not reachable from acquisition today, and the reason is structural
 * rather than lucky: NO seller-flow module imports load-template.js. The
 * acquisition reply path goes through selectApprovedTemplateForAutoReply,
 * which filters `.eq('use_case', ...)` and then excludes on both
 * use_case_mismatch and stage_mismatch.
 *
 * This test is the fence. If someone wires load-template into seller-flow, the
 * ladder becomes reachable from acquisition and this fails first.
 */
test("no seller-flow module imports the template loader that owns the ladder", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const dir = "src/lib/domain/seller-flow";
  const offenders = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const source = readFileSync(full, "utf8");
      if (/from\s+["'][^"']*templates\/load-template\.js["']/.test(source)) offenders.push(full);
    }
  };
  walk(dir);

  assert.deepEqual(
    offenders,
    [],
    "seller-flow must not reach the cross-purpose reengagement ladder in load-template.js",
  );
});

test("the acquisition reply path resolves through the purpose-fenced selector", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/lib/domain/seller-flow/autonomous-seller-reply.js", "utf8");
  assert.match(
    source,
    /selectApprovedTemplateForAutoReply/,
    "the autonomous reply must use the fenced selector",
  );

  // And that selector's fence is a hard equality filter, not a ranking preference.
  const selector = readFileSync("src/lib/domain/templates/template-auto-reply-selector.js", "utf8");
  assert.match(selector, /\.eq\('use_case', use_case\)/, "use_case must be an equality filter");
  assert.match(selector, /\.eq\('is_active', true\)/, "disabled templates must never enter the pool");
});

// ══════════════════════════════════════════════════════════════════════════
// 8. THE SECOND ROUTER, AND THE ownership_check DEFAULT
// ══════════════════════════════════════════════════════════════════════════

/**
 * queue-outbound-message.js resolves a use case by precedence:
 *
 *     use_case                 <- caller's explicit value (canonical path)
 *     || flow.use_case         <- sms/flow_map.js, a SECOND router
 *     || route?.use_case
 *     || "ownership_check"     <- a literal cross-stage default
 *
 * Both tail entries are cross-purpose hazards:
 *
 *  - flow_map maps asking_price + price_given + price_works ->
 *    "price_works_confirm_basics", whose auto-reply-safe English template 540001
 *    reads "Got it. That may work on our end. Is the property vacant right
 *    now?" - the vacancy-probe-immediately-after-price-capture the operator
 *    killed, alive under a different key.
 *
 *  - the terminal default sends an S1 ownership check to a seller at any stage.
 *
 * Neither is reachable from acquisition TODAY, because the canonical path
 * always supplies plan.selected_use_case and the first term wins. That
 * guarantee is what these tests hold in place.
 */
test("the acquisition queue path always supplies an explicit use case", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/lib/domain/seller-flow/maybe-queue-seller-stage-reply.js", "utf8");

  // The queueOutboundMessage call must pass the plan's use case, which takes
  // precedence over flow_map and over the ownership_check default.
  assert.match(
    source,
    /use_case:\s*plan\.selected_use_case/,
    "the canonical route's use case must be passed explicitly, or flow_map decides instead",
  );
});

test("the canonical routes never adopt the retired vacancy alias", () => {
  // Previously this test recorded flow_map's price_works branch as a live
  // hazard. That branch is retired now (see test 9), so all that remains to
  // hold is that no canonical route ever adopts the alias itself.
  for (const purpose of ROUTE_PURPOSES) {
    assert.notEqual(
      purpose.use_case,
      "price_works_confirm_basics",
      `${purpose.route_id} must not adopt the vacancy-probe alias`,
    );
  }
});

test("price_works_confirm_basics cannot be reached from a Stage-3 purpose request", () => {
  // Even if the whole family is sitting in the pool, sendable and auto-safe.
  const pool = [
    row({ id: "540001", use_case: "price_works_confirm_basics", body: "Got it. Is the property vacant right now?" }),
    row({ id: "540002", use_case: "price_works_confirm_basics", body: "Is it vacant, rented, or owner occupied?" }),
  ];
  for (const purpose of ROUTE_PURPOSES) {
    const resolved = resolveTemplateFromPool(ASK(purpose.use_case), pool);
    assert.equal(
      resolved.ok,
      false,
      `${purpose.route_id} must not resolve to the vacancy probe`,
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 9. THE RETIRED VACANCY FAMILY IS UNREACHABLE FROM EVERY BAND
// ══════════════════════════════════════════════════════════════════════════

/**
 * Operator ruling 2026-09-11: kill the price_works -> vacancy shortcut rather
 * than merely fence it.
 *
 *   - flow_map.js price_works branch: removed
 *   - intentMap.js asking_price_provided: now price_high_condition_probe
 *   - production: the 6 auto-reply-safe rows across price_works_confirm_basics,
 *     vacancy_probe and occupancy_probe had safe_for_auto_reply set false, with
 *     the previous values stamped into metadata. All 58 rows preserved.
 *
 * Condition is still askable - under the canonical purpose, when the economic
 * route says condition information is useful. What is gone is the independent
 * shortcut that said "price seems workable, therefore ask about vacancy".
 */
const RETIRED_USE_CASES = ["price_works_confirm_basics", "vacancy_probe", "occupancy_probe"];

test("no band, in any negotiation or creative posture, routes to a retired family", () => {
  for (const band of Object.values(STAGE3_OFFER_BANDS)) {
    for (const creative_allowed of [false, true]) {
      for (const offer_revealed of [false, true]) {
        const route = routeForBand(band, { creative_allowed, offer_revealed });
        assert.ok(
          !RETIRED_USE_CASES.includes(route.template_use_case),
          `band ${band} (creative=${creative_allowed}, revealed=${offer_revealed}) -> retired ${route.template_use_case}`,
        );
      }
    }
  }
});

test("no fallback can resurrect a retired family for any Stage-3 purpose", () => {
  // Every retired template present, active and auto-safe in the pool.
  const pool = RETIRED_USE_CASES.map((uc, i) => row({ id: `retired-${i}`, use_case: uc }));
  for (const purpose of ROUTE_PURPOSES) {
    const resolved = resolveTemplateFromPool(ASK(purpose.use_case), pool);
    assert.equal(resolved.ok, false, `${purpose.route_id} resurrected a retired family`);
  }
});

test("the legacy routers no longer name the vacancy shortcut", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["src/lib/sms/flow_map.js", "src/lib/automation/intentMap.js"]) {
    const live = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    assert.ok(
      !live.includes("price_works_confirm_basics"),
      `${file} can still select the retired vacancy probe`,
    );
  }
});

test("close_range now resolves inside approved offer families, both cases", () => {
  const first = routeForBand(STAGE3_OFFER_BANDS.CLOSE_RANGE, { offer_revealed: false });
  const counter = routeForBand(STAGE3_OFFER_BANDS.CLOSE_RANGE, { offer_revealed: true });

  assert.equal(first.template_use_case, "offer_reveal_cash");
  assert.equal(counter.template_use_case, "counter_offer");
  assert.equal(first.lifecycle_stage_code, counter.lifecycle_stage_code, "both are S5 offer");

  // Both purposes have approved production copy, so neither is a new gap.
  for (const route of [first, counter]) {
    const resolved = resolveTemplateFromPool(ASK(route.template_use_case), [
      row({ id: `ok-${route.route_id}`, use_case: route.template_use_case }),
    ]);
    assert.equal(resolved.ok, true, `${route.route_id} must resolve within its own purpose`);
  }
});
