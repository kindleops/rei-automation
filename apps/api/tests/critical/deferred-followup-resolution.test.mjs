import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDeferredQueueMessage,
  isDeferredQueueRow,
  nurtureIntentFromRow,
  NURTURE_TEMPLATE_CANDIDATES,
} from "@/lib/domain/queue/resolve-deferred-queue-message.js";

function fakeSupabase(templates = []) {
  return {
    from(table) {
      assert.equal(table, "sms_templates");
      const chain = {
        _filters: {},
        select() { return chain; },
        eq(col, val) { chain._filters[col] = val; return chain; },
        in(col, vals) { chain._filters[col] = vals; return chain; },
        limit() {
          const langs = chain._filters.language || [];
          const useCases = chain._filters.use_case || [];
          const rows = templates.filter(
            (t) =>
              t.is_active !== false &&
              t.safe_for_auto_reply === true &&
              langs.includes(t.language) &&
              useCases.includes(t.use_case)
          );
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
  };
}

function deferredRow(overrides = {}) {
  return {
    id: "q-1",
    to_phone_number: "+13125550100",
    use_case_template: "nurture_not_interested",
    seller_first_name: "Maria",
    property_address: "412 W Oak St",
    language: "English",
    message_body: "",
    metadata: { deferred_message_resolution: true, intent: "not_interested" },
    ...overrides,
  };
}

const FOLLOW_UP_TEMPLATE = {
  template_id: "tpl-cs-fu",
  use_case: "consider_selling_follow_up",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  template_body: "Hi {{seller_first_name}}, circling back about {{property_address}} — any change of plans?",
};

test("isDeferredQueueRow requires the flag and an empty body", () => {
  assert.equal(isDeferredQueueRow(deferredRow()), true);
  assert.equal(isDeferredQueueRow(deferredRow({ message_body: "already rendered" })), false);
  assert.equal(isDeferredQueueRow({ metadata: {} }), false);
});

test("nurture intent resolves from metadata first, then use_case_template", () => {
  assert.equal(nurtureIntentFromRow(deferredRow()), "not_interested");
  assert.equal(
    nurtureIntentFromRow({ use_case_template: "nurture_listed_or_unavailable", metadata: {} }),
    "listed_or_unavailable"
  );
  assert.equal(nurtureIntentFromRow({ metadata: {} }), "unclear");
});

test("every scheduler nurture intent has template candidates", () => {
  for (const intent of [
    "not_interested",
    "listed_or_unavailable",
    "tenant_or_occupancy",
    "condition_signal",
    "asking_price_value",
    "unclear",
    "conditional_interest",
    "maybe_depends_on_price",
  ]) {
    assert.ok(
      Array.isArray(NURTURE_TEMPLATE_CANDIDATES[intent]) && NURTURE_TEMPLATE_CANDIDATES[intent].length > 0,
      `missing candidates for ${intent}`
    );
  }
});

test("deferred not_interested row resolves to a rendered follow-up", async () => {
  const result = await resolveDeferredQueueMessage(deferredRow(), {
    supabase: fakeSupabase([FOLLOW_UP_TEMPLATE]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolved, true);
  assert.equal(result.template_id, "tpl-cs-fu");
  assert.equal(result.use_case, "consider_selling_follow_up");
  assert.match(result.message_body, /Maria/);
  assert.match(result.message_body, /412 W Oak St/);
  assert.doesNotMatch(result.message_body, /\{\{/);
});

test("row with a body is passed through untouched", async () => {
  const result = await resolveDeferredQueueMessage(deferredRow({ message_body: "hello" }), {
    supabase: fakeSupabase([FOLLOW_UP_TEMPLATE]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolved, false);
});

test("unresolvable deferred row reports no_renderable_followup_template", async () => {
  const result = await resolveDeferredQueueMessage(deferredRow(), {
    supabase: fakeSupabase([]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "no_renderable_followup_template");
});

test("template with unfillable placeholders is skipped, next candidate wins", async () => {
  const needsCity = {
    ...FOLLOW_UP_TEMPLATE,
    template_id: "tpl-needs-city",
    template_body: "Hi {{seller_first_name}}, still in {{property_city}}?",
  };
  const fallback = {
    template_id: "tpl-not-ready",
    use_case: "not_ready",
    language: "English",
    is_active: true,
    safe_for_auto_reply: true,
    template_body: "Hi {{seller_first_name}}, no rush — want me to check back later this year?",
  };
  const row = deferredRow(); // has no property_city
  const result = await resolveDeferredQueueMessage(row, {
    supabase: fakeSupabase([needsCity, fallback]),
  });
  assert.equal(result.ok, true);
  // consider_selling_follow_up candidate fails render (missing city) → not_ready wins
  assert.equal(result.template_id, "tpl-not-ready");
});

test("non-English rows fall back to English templates", async () => {
  const row = deferredRow({ language: "Spanish" });
  const result = await resolveDeferredQueueMessage(row, {
    supabase: fakeSupabase([FOLLOW_UP_TEMPLATE]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.language, "English");
});
