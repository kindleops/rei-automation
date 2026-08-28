import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  routeTitleCompanyForClosingCase,
  canonicalizeMarket,
  chooseRoute,
  isUsableRoute,
  TITLE_ROUTE_STATUS,
} from "@/lib/domain/title/route-title-company.js";
import {
  sendTitleIntroFromClosingCase,
  buildTitleIntroFromClosingCase,
} from "@/lib/domain/title/send-title-intro-from-closing-case.js";

// Supabase-native, market-based title routing:
//   property ZIP -> canonical market -> primary title company -> backup
// Deterministic, idempotent, fails closed. All external effects dormant.

const CASE = {
  closing_case_id: "closing:opp-1",
  opportunity_id: "opp-1",
  property_id: "prop-1",
  property_address: "123 Main St, Fort Worth TX",
  seller_contract_price: 250000,
  earnest_money: 5000,
  scheduled_closing_date: "2026-09-30T00:00:00.000Z",
  signer_name: "Jane Seller",
  contract_status: "fully_executed",
  title_company_key: null,
  title_company_email: null,
  title_intro_sent_at: null,
};

const PRIMARY = {
  title_company_key: "tc_primary",
  name: "Primary Title Co",
  new_order_email: "orders@primary.example",
  contact_manager: "Pat Primary",
  is_active: true,
};
const BACKUP = {
  title_company_key: "tc_backup",
  name: "Backup Title Co",
  new_order_email: "orders@backup.example",
  is_active: true,
};

function makeSupabase({ routes = [], property = { property_id: "prop-1", market: "Fort Worth, TX", property_address_zip: "76102" }, cases = [CASE], events = [] } = {}) {
  const state = { routes: [...routes], cases: cases.map((c) => ({ ...c })), events: [...events], property };
  function from(name) {
    const q = { f: {}, isNull: [] };
    const api = {
      select: () => api,
      eq(col, val) { q.f[col] = val; return api; },
      is(col, val) { if (val === null) q.isNull.push(col); return api; },
      order: () => api,
      limit: async () => ({ data: rows(), error: null }),
      async maybeSingle() { return { data: rows()[0] || null, error: null }; },
      insert(row) {
        if (name === "closing_activity_events") {
          if (state.events.some((e) => e.idempotency_key === row.idempotency_key)) {
            return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
          }
          state.events.push({ ...row });
        }
        return Promise.resolve({ error: null });
      },
      update(patch) {
        const u = {
          eq(col, val) { q.f[col] = val; return u; },
          is(col, val) { if (val === null) q.isNull.push(col); return u; },
          then(resolve) {
            const t = state.cases.find(
              (c) => Object.entries(q.f).every(([k, v]) => c[k] === v) && q.isNull.every((col) => c[col] == null)
            );
            if (t) Object.assign(t, patch);
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return u;
      },
    };
    function rows() {
      if (name === "properties") return state.property ? [state.property] : [];
      if (name === "acquisition_opportunities") return [];
      if (name === "title_company_market_routes") {
        return state.routes
          .filter((r) => Object.entries(q.f).every(([k, v]) => r[k] === v))
          .sort((a, b) => a.route_rank - b.route_rank);
      }
      if (name === "closing_cases") {
        return state.cases.filter((c) => Object.entries(q.f).every(([k, v]) => c[k] === v));
      }
      return [];
    }
    return api;
  }
  return { from, _state: state };
}

const route = (company, rank, extra = {}) => ({
  id: `r-${rank}`,
  market: "Dallas, TX",
  title_company_key: company.title_company_key,
  route_rank: rank,
  is_active: true,
  route_version: "v1",
  title_companies: company,
  ...extra,
});

// ── canonical market (reuses the existing registry/aliases) ──────────────────

test("ZIP-bearing property market canonicalizes through the EXISTING alias registry", () => {
  assert.equal(canonicalizeMarket("Fort Worth, TX"), "Dallas, TX", "alias applied");
  assert.equal(canonicalizeMarket("San Bernardino, CA"), "Riverside, CA");
  assert.equal(canonicalizeMarket("Miami, FL"), "Miami, FL", "canonical passes through");
  assert.equal(canonicalizeMarket("unmapped"), null, "unmapped is not a market");
  assert.equal(canonicalizeMarket(""), null);
});

// ── primary / backup precedence ──────────────────────────────────────────────

test("primary (rank 1) wins when usable", () => {
  const r = chooseRoute([route(BACKUP, 2), route(PRIMARY, 1)]);
  assert.equal(r.ok, true);
  assert.equal(r.route.title_company_key, "tc_primary");
  assert.equal(r.is_primary, true);
});

test("BACKUP is used when the primary lacks the required contact email", () => {
  const brokenPrimary = { ...PRIMARY, new_order_email: "" };
  const r = chooseRoute([route(brokenPrimary, 1), route(BACKUP, 2)]);
  assert.equal(r.ok, true);
  assert.equal(r.route.title_company_key, "tc_backup", "falls through to backup");
  assert.equal(r.is_primary, false);
});

test("BACKUP is used when the primary company is inactive", () => {
  const r = chooseRoute([route({ ...PRIMARY, is_active: false }, 1), route(BACKUP, 2)]);
  assert.equal(r.route.title_company_key, "tc_backup");
});

test("a route is only usable with an active company AND a contact email", () => {
  assert.equal(isUsableRoute(route(PRIMARY, 1)), true);
  assert.equal(isUsableRoute(route({ ...PRIMARY, new_order_email: null }, 1)), false);
  assert.equal(isUsableRoute(route(PRIMARY, 1, { is_active: false })), false);
});

test("no usable company -> fail closed, never fabricate", () => {
  assert.equal(chooseRoute([]).reason, "no_route_for_market");
  assert.equal(chooseRoute([route({ ...PRIMARY, new_order_email: "" }, 1)]).reason, "no_usable_title_company");
});

// ── routing a closing case end to end ────────────────────────────────────────

test("routing selects the primary and persists the full routing decision", async () => {
  const supabase = makeSupabase({ routes: [route(PRIMARY, 1), route(BACKUP, 2)] });
  const r = await routeTitleCompanyForClosingCase({ closing_case: { ...CASE }, supabase });

  assert.equal(r.ok, true);
  assert.equal(r.routed, true);
  assert.equal(r.title_company_key, "tc_primary");
  assert.equal(r.market, "Dallas, TX", "ZIP-bearing property market canonicalized");
  assert.equal(r.is_primary, true);

  const c = supabase._state.cases[0];
  assert.equal(c.title_company_key, "tc_primary", "selected title company ID");
  assert.equal(c.title_company_name, "Primary Title Co");
  assert.equal(c.title_company_email, "orders@primary.example", "contact email required for intro");
  assert.equal(c.title_route_market, "Dallas, TX", "routing market");
  assert.equal(c.title_route_rank, 1, "primary vs backup");
  assert.equal(c.title_route_source, "properties.market", "routing source");
  assert.equal(c.title_route_version, "v1", "routing version");
  assert.equal(c.title_route_status, TITLE_ROUTE_STATUS.ROUTED);
  assert.ok(c.title_company_selected_at, "selection timestamp");
});

test("routing is DETERMINISTIC and IDEMPOTENT: a replay does not re-route", async () => {
  const supabase = makeSupabase({ routes: [route(PRIMARY, 1), route(BACKUP, 2)] });
  const first = await routeTitleCompanyForClosingCase({ closing_case: { ...CASE }, supabase });
  const second = await routeTitleCompanyForClosingCase({
    closing_case: supabase._state.cases[0],
    supabase,
  });

  assert.equal(first.routed, true);
  assert.equal(second.routed, false);
  assert.equal(second.already_routed, true);
  assert.equal(second.title_company_key, first.title_company_key, "same company, deterministically");
  assert.equal(
    supabase._state.events.filter((e) => e.event_type === "title_route").length,
    1,
    "one routing event, not two"
  );
});

test("no route for the market -> durable title_route_unavailable, nothing fabricated", async () => {
  const supabase = makeSupabase({ routes: [] });
  const r = await routeTitleCompanyForClosingCase({ closing_case: { ...CASE }, supabase });

  assert.equal(r.ok, false);
  assert.equal(r.status, TITLE_ROUTE_STATUS.UNAVAILABLE);
  assert.equal(r.reason, "no_route_for_market");
  const c = supabase._state.cases[0];
  assert.equal(c.title_route_status, "title_route_unavailable", "durable condition persisted");
  assert.equal(c.title_company_key, null, "no company invented");
});

test("an unresolvable market fails closed too", async () => {
  const supabase = makeSupabase({ routes: [route(PRIMARY, 1)], property: { property_id: "prop-1", market: "unmapped" } });
  const r = await routeTitleCompanyForClosingCase({ closing_case: { ...CASE }, supabase });
  assert.equal(r.reason, "market_unresolved");
  assert.equal(supabase._state.cases[0].title_route_status, "title_route_unavailable");
});

// ── title intro email ────────────────────────────────────────────────────────

const ROUTED_CASE = {
  ...CASE,
  title_company_key: "tc_primary",
  title_company_email: "orders@primary.example",
  title_company_name: "Primary Title Co",
};

test("the intro email is composed from the SUPABASE closing case", () => {
  const { subject, body } = buildTitleIntroFromClosingCase(ROUTED_CASE);
  assert.match(subject, /123 Main St/);
  assert.match(body, /\$250,000/, "purchase price from the case");
  assert.match(body, /\$5,000/, "earnest money from the case");
  assert.match(body, /2026-09-30/, "closing date from the case");
  assert.match(body, /closing:opp-1/, "case reference");
});

test("DORMANT: the intro is composed but never sent while contained", async () => {
  const supabase = makeSupabase({ cases: [ROUTED_CASE] });
  let sends = 0;
  const r = await sendTitleIntroFromClosingCase({
    closing_case: ROUTED_CASE,
    allowExternalEffects: false,
    supabase,
    sendEmailImpl: async () => { sends += 1; return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.sent, false);
  assert.equal(r.reason, "closing_execution_dormant");
  assert.equal(sends, 0, "no email left the system");
  assert.ok(r.subject && r.body, "still fully composed for verification");
});

test("authorized send delivers once and marks the case", async () => {
  const supabase = makeSupabase({ cases: [ROUTED_CASE] });
  let sends = 0;
  const r = await sendTitleIntroFromClosingCase({
    closing_case: ROUTED_CASE,
    allowExternalEffects: true,
    dry_run: false,
    supabase,
    sendEmailImpl: async () => { sends += 1; return { ok: true }; },
  });
  assert.equal(r.sent, true);
  assert.equal(sends, 1);
  assert.ok(supabase._state.cases[0].title_intro_sent_at, "durable sent marker");
  assert.equal(supabase._state.cases[0].title_status, "ordered");
});

test("REPLAY does not send a duplicate title-intro email", async () => {
  const supabase = makeSupabase({ cases: [ROUTED_CASE] });
  let sends = 0;
  const send = () =>
    sendTitleIntroFromClosingCase({
      closing_case: supabase._state.cases[0],
      allowExternalEffects: true,
      dry_run: false,
      supabase,
      sendEmailImpl: async () => { sends += 1; return { ok: true }; },
    });

  const first = await send();
  const second = await send();
  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.reason, "already_sent");
  assert.equal(sends, 1, "exactly one email across the replay");
});

test("an unrouted case cannot send an intro (fails closed)", async () => {
  const supabase = makeSupabase({ cases: [CASE] });
  const r = await sendTitleIntroFromClosingCase({
    closing_case: CASE,
    allowExternalEffects: true,
    dry_run: false,
    supabase,
    sendEmailImpl: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "title_route_unavailable");
});

test("a routed case missing the contact email cannot send", async () => {
  const noEmail = { ...ROUTED_CASE, title_company_email: null };
  const supabase = makeSupabase({ cases: [noEmail] });
  const r = await sendTitleIntroFromClosingCase({
    closing_case: noEmail,
    allowExternalEffects: true,
    dry_run: false,
    supabase,
    sendEmailImpl: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_title_company_email");
});
