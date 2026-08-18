import assert from "node:assert/strict";
import test from "node:test";

import {
  TEMPLATE_PAGE_SIZE,
  fetchAllTemplates,
  loadTemplatePool,
} from "@/lib/domain/campaigns/template-pool-pagination.js";
import {
  GOVERNANCE_REASONS,
  applyGovernance,
  canonicalTemplateOrder,
  evaluateTemplateGovernance,
  governanceApplies,
  indexGovernance,
} from "@/lib/domain/campaigns/template-governance.js";
import {
  TEMPLATE_STATE,
  isTemplateSendReady,
  templateBlockReason,
  templateStatusForState,
} from "@/lib/domain/campaigns/template-status-semantics.js";

/**
 * Supabase double that reproduces the behaviour that caused the bug: a
 * server-side max-rows ceiling that silently clamps whatever .limit() asks for.
 * A client requesting 5,000 rows gets 1,000 and no error — exactly what
 * production does.
 */
function makeTemplateClient(rows, { maxRows = TEMPLATE_PAGE_SIZE } = {}) {
  const calls = [];

  const builder = (filters = {}) => {
    const api = {
      eq(column, value) {
        return builder({ ...filters, [column]: value });
      },
      order(column, opts) {
        return builder({ ...filters, __order: { column, ...opts } });
      },
      async range(from, to) {
        const order = filters.__order;
        let matched = rows.filter((row) =>
          Object.entries(filters).every(
            ([key, value]) => key.startsWith("__") || row[key] === value
          )
        );

        if (order) {
          matched = [...matched].sort((a, b) =>
            String(a[order.column]).localeCompare(String(b[order.column]))
          );
        }

        // The server clamps the requested window, it does not error.
        const requested = to - from + 1;
        const allowed = Math.min(requested, maxRows);
        const page = matched.slice(from, from + allowed);
        calls.push({ from, to, returned: page.length, ordered: Boolean(order) });
        return { data: page, error: null };
      },
    };
    return api;
  };

  return {
    calls,
    from() {
      return { select: () => builder() };
    },
  };
}

const template = (id, over = {}) => ({
  template_id: id,
  id,
  is_active: true,
  template_body: `body ${id}`,
  language: "English",
  stage_code: "S1",
  use_case: "ownership_check",
  ...over,
});

test("template pool larger than the 1,000-row cap loads completely", async () => {
  const rows = Array.from({ length: 4638 }, (_, i) =>
    template(String(200000 + i))
  );
  const client = makeTemplateClient(rows);

  const loaded = await loadTemplatePool(client, "ownership_check", "S1");

  // The exact production shape: 4,638 templates behind a 1,000-row ceiling.
  assert.equal(loaded.length, 4638);
  assert.equal(new Set(loaded.map((r) => r.template_id)).size, 4638);
});

test("every page request is ordered, so pages cannot overlap or skip", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => template(String(300000 + i)));
  const client = makeTemplateClient(rows);

  await loadTemplatePool(client, "ownership_check", "S1");

  assert.ok(client.calls.length >= 3);
  assert.ok(
    client.calls.every((call) => call.ordered),
    "unordered .range() pagination is unsound — rows can repeat or vanish"
  );
});

test("no duplicate rows are introduced across page boundaries", async () => {
  const rows = Array.from({ length: 3001 }, (_, i) => template(String(400000 + i)));
  const loaded = await loadTemplatePool(makeTemplateClient(rows), "ownership_check", "S1");

  assert.equal(loaded.length, 3001);
  assert.equal(new Set(loaded.map((r) => r.template_id)).size, 3001);
});

test("a pool that is an exact multiple of the page size terminates", async () => {
  const rows = Array.from({ length: TEMPLATE_PAGE_SIZE * 2 }, (_, i) =>
    template(String(500000 + i))
  );
  const client = makeTemplateClient(rows);

  const loaded = await loadTemplatePool(client, "ownership_check", "S1");

  assert.equal(loaded.length, TEMPLATE_PAGE_SIZE * 2);
  // Two full pages plus one empty page proving the end.
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls.at(-1).returned, 0);
});

test("an empty pool returns empty rather than looping", async () => {
  const client = makeTemplateClient([]);
  const loaded = await loadTemplatePool(client, "ownership_check", "S1");

  assert.deepEqual(loaded, []);
  assert.equal(client.calls.length, 1);
});

test("filters are honoured while paginating", async () => {
  const rows = [
    ...Array.from({ length: 1200 }, (_, i) => template(String(600000 + i))),
    ...Array.from({ length: 50 }, (_, i) =>
      template(String(700000 + i), { stage_code: "S2" })
    ),
  ];

  const loaded = await loadTemplatePool(makeTemplateClient(rows), "ownership_check", "S1");

  assert.equal(loaded.length, 1200);
  assert.ok(loaded.every((row) => row.stage_code === "S1"));
});

test("fetchAllTemplates surfaces a query error instead of returning short", async () => {
  const failing = {
    from: () => ({
      select: () => ({
        eq() {
          return this;
        },
        order() {
          return this;
        },
        async range() {
          return { data: null, error: new Error("boom") };
        },
      }),
    }),
  };

  await assert.rejects(() => fetchAllTemplates(failing, (q) => q), /boom/);
});

// ── governance ────────────────────────────────────────────────────────────

test("paused templates cannot be selected", () => {
  const verdict = evaluateTemplateGovernance(template("200033"), {
    template_id: "200033",
    rotation_status: "pause",
    daily_cap: 0,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, GOVERNANCE_REASONS.PAUSED);
});

test("a template absent from governance fails closed", () => {
  const verdict = evaluateTemplateGovernance(template("200017"), undefined);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, GOVERNANCE_REASONS.ABSENT);
});

test("daily_cap of zero blocks even when the status is sendable", () => {
  const verdict = evaluateTemplateGovernance(template("200500"), {
    template_id: "200500",
    rotation_status: "testing",
    daily_cap: 0,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, GOVERNANCE_REASONS.NO_CAP);
});

test("an unmeasurable daily_cap blocks rather than coercing to a number", () => {
  // Number(null) === 0 would read as "capped at zero" and Number(undefined) is
  // NaN. Neither is a measurement, so neither may be treated as one.
  for (const cap of [null, undefined, ""]) {
    const verdict = evaluateTemplateGovernance(template("200600"), {
      template_id: "200600",
      rotation_status: "testing",
      daily_cap: cap,
    });
    assert.equal(verdict.ok, false, `cap ${String(cap)} must not pass`);
    assert.equal(verdict.reason, GOVERNANCE_REASONS.UNMEASURABLE);
  }
});

test("a template over its cap blocks", () => {
  const verdict = evaluateTemplateGovernance(template("200700"), {
    template_id: "200700",
    rotation_status: "testing",
    daily_cap: 20,
    last_40d_total_sent: 20,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, GOVERNANCE_REASONS.CAP_EXHAUSTED);
});

test("an inactive template or one with no body can never send", () => {
  const inactive = evaluateTemplateGovernance(template("200800", { is_active: false }), {
    template_id: "200800",
    rotation_status: "testing",
    daily_cap: 20,
  });
  assert.equal(inactive.reason, GOVERNANCE_REASONS.INACTIVE);

  const bodyless = evaluateTemplateGovernance(template("200801", { template_body: "  " }), {
    template_id: "200801",
    rotation_status: "testing",
    daily_cap: 20,
  });
  assert.equal(bodyless.reason, GOVERNANCE_REASONS.NO_BODY);
});

test("an unrecognised rotation status is not a licence to send", () => {
  const verdict = evaluateTemplateGovernance(template("200900"), {
    template_id: "200900",
    rotation_status: "some_future_state",
    daily_cap: 50,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, GOVERNANCE_REASONS.PAUSED);
});

test("governance scope is explicit", () => {
  assert.equal(governanceApplies("ownership_check"), true);
  assert.equal(governanceApplies("some_other_use_case"), false);
});

test("applyGovernance keeps only sendable templates and reports the rest", () => {
  const pool = [template("200033"), template("200114"), template("200017")];
  const governance = indexGovernance([
    { template_id: "200033", rotation_status: "pause", daily_cap: 0 },
    { template_id: "200114", rotation_status: "testing", daily_cap: 20 },
    // 200017 deliberately absent
  ]);

  const { eligible, rejected, governed } = applyGovernance(pool, governance, "ownership_check");

  assert.equal(governed, true);
  assert.deepEqual(eligible.map((t) => t.template_id), ["200114"]);
  assert.deepEqual(
    rejected.map((r) => r.reason).sort(),
    [GOVERNANCE_REASONS.ABSENT, GOVERNANCE_REASONS.PAUSED].sort()
  );
});

// ── deterministic ordering ────────────────────────────────────────────────

test("canonical order is total and independent of input order", () => {
  const governance = indexGovernance([
    { template_id: "a", rotation_status: "testing", daily_cap: 5 },
    { template_id: "b", rotation_status: "active", daily_cap: 5 },
    { template_id: "c", rotation_status: "promote", daily_cap: 5 },
  ]);

  const pool = [template("a"), template("b"), template("c")];
  const forward = canonicalTemplateOrder(pool, governance).map((t) => t.template_id);
  const reversed = canonicalTemplateOrder([...pool].reverse(), governance).map(
    (t) => t.template_id
  );
  const shuffled = canonicalTemplateOrder([pool[1], pool[2], pool[0]], governance).map(
    (t) => t.template_id
  );

  // Governance rank leads: promote < active < testing.
  assert.deepEqual(forward, ["c", "b", "a"]);
  assert.deepEqual(reversed, forward);
  assert.deepEqual(shuffled, forward);
});

test("templates of equal rank fall back to a unique, stable tiebreak", () => {
  const governance = indexGovernance([
    { template_id: "200002", rotation_status: "testing", daily_cap: 5 },
    { template_id: "200001", rotation_status: "testing", daily_cap: 5 },
  ]);
  const pool = [template("200002"), template("200001")];

  const order = canonicalTemplateOrder(pool, governance).map((t) => t.template_id);
  assert.deepEqual(order, ["200001", "200002"]);
});

// ── status semantics ──────────────────────────────────────────────────────

test("only an assigned template maps to the ready status", () => {
  assert.equal(templateStatusForState(TEMPLATE_STATE.ASSIGNED), "ready");
  for (const state of [
    TEMPLATE_STATE.ELIGIBLE,
    TEMPLATE_STATE.MISSING_TEMPLATE,
    TEMPLATE_STATE.GOVERNANCE_BLOCKED,
    TEMPLATE_STATE.BLOCKED,
  ]) {
    assert.equal(templateStatusForState(state), "blocked", `${state} must not be ready`);
  }
});

test("the 763-Miami shape — ready with no template_id — is not send-ready", () => {
  const target = { template_status: "ready", metadata: {} };

  assert.equal(isTemplateSendReady(target), false);
  assert.equal(templateBlockReason(target), "status_ready_without_template_id");
});

test("a fully assigned target is send-ready", () => {
  const target = {
    template_status: "ready",
    metadata: { template_id: "200114", template_state: TEMPLATE_STATE.ASSIGNED },
  };

  assert.equal(isTemplateSendReady(target), true);
  assert.equal(templateBlockReason(target), null);
});

test("a governance-blocked target is not send-ready even with a template_id", () => {
  const target = {
    template_status: "blocked",
    metadata: { template_id: "200033", template_state: TEMPLATE_STATE.GOVERNANCE_BLOCKED },
  };

  assert.equal(isTemplateSendReady(target), false);
  assert.equal(templateBlockReason(target), TEMPLATE_STATE.GOVERNANCE_BLOCKED);
});
