// 2026-10-08 nurture revalidation defect: 30-day not-interested nurture rows
// were written with no seller first name / property address / sender /
// language / agent, so at send time they rendered the S1 "Thanks for
// confirming…" copy (template 400065) or blocked on missing_seller_first_name.
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNurtureRenderContext,
  loadNurtureRenderContext,
  missingNurtureContextFields,
  singleSentFirstName,
  NURTURE_TEMPLATE_FAMILIES,
} from "@/lib/domain/seller-flow/nurture-render-context.js";
import { scheduleFollowUp } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import {
  resolveDeferredQueueMessage,
  NURTURE_TEMPLATE_CANDIDATES,
} from "@/lib/domain/queue/resolve-deferred-queue-message.js";

const SELLER = "+13125550100";
const OUR_NUMBER = "+16125550199";

// ── pure resolution ────────────────────────────────────────────────────────

test("first name: the single confident name on sent rows; ambiguous, phone-like or entity ⇒ none", () => {
  assert.equal(singleSentFirstName([{ seller_first_name: "maria" }, { seller_first_name: "Maria" }]), "Maria");
  assert.equal(singleSentFirstName([{ seller_first_name: "Maria" }, { seller_first_name: "Jose" }]), null);
  assert.equal(singleSentFirstName([{ seller_first_name: "3125550100" }]), null);
  assert.equal(singleSentFirstName([{ seller_first_name: "Pegasus Land Co LLC" }]), null);
});

test("context builder: sticky sender, property-scoped address, reply language, agent", () => {
  const ctx = buildNurtureRenderContext({
    known: { property_id: "p1", inbound_to: "+16125550000" },
    sent_rows_newest_first: [
      { property_id: "p2", property_address: "9 Other St", from_phone_number: "+16125550001", agent_name: "Alex", seller_first_name: "Maria" },
      { property_id: "p1", property_address: "412 W Oak St", from_phone_number: OUR_NUMBER, textgrid_number_id: "tn-1", agent_name: "Alex", seller_first_name: "Maria", language: "English" },
    ],
    thread_state: { our_number: OUR_NUMBER },
    reply_text: "No estoy interesado en vender, gracias",
    intent: "not_interested",
  });
  assert.equal(ctx.seller_first_name, "Maria");
  assert.equal(ctx.property_address, "412 W Oak St");
  assert.equal(ctx.from_phone_number, OUR_NUMBER);
  assert.equal(ctx.textgrid_number_id, "tn-1");
  assert.equal(ctx.language, "Spanish");
  assert.equal(ctx.agent_name, "Alex");
  assert.equal(ctx.nurture_render_context.sender_source, "thread_sticky");
  assert.equal(ctx.nurture_render_context.language_source, "seller_reply");
  assert.equal(ctx.nurture_render_context.template_use_case, "consider_selling_follow_up");
});

test("context builder: unknown language stays unknown; property record fills the address", () => {
  const ctx = buildNurtureRenderContext({
    known: { property_id: "p1" },
    property: { property_address: "1 Elm St" },
    reply_text: "👍",
    intent: "not_interested",
  });
  assert.equal(ctx.language, null);
  assert.equal(ctx.nurture_render_context.language_source, "unknown");
  assert.equal(ctx.property_address, "1 Elm St");
  assert.equal(ctx.seller_first_name, null);
});

test("loader reads only the thread's own history and survives failed reads", async () => {
  const seen = [];
  const supabase = {
    from(table) {
      seen.push(table);
      const result = {
        send_queue: { data: [{ seller_first_name: "Maria", property_address: "412 W Oak St", property_id: "p1", from_phone_number: OUR_NUMBER, agent_name: "Alex", language: "English" }], error: null },
        inbox_thread_state: { data: { our_number: OUR_NUMBER }, error: null },
        properties: { data: null, error: { message: "boom" } },
        message_events: { data: { message_body: "Not for sale" }, error: null },
      }[table];
      const chain = {
        select: () => chain, eq: () => chain, not: () => chain, order: () => chain,
        limit: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result),
      };
      return chain;
    },
  };
  const ctx = await loadNurtureRenderContext(supabase, { thread_key: SELLER, property_id: "p1", inbound_message_event_id: "me-1", intent: "not_interested" });
  assert.deepEqual([...new Set(seen)].sort(), ["inbox_thread_state", "message_events", "properties", "send_queue"]);
  assert.equal(ctx.seller_first_name, "Maria");
  assert.equal(ctx.property_address, "412 W Oak St");
  assert.equal(ctx.language, "English");
  assert.equal(ctx.from_phone_number, OUR_NUMBER);
});

// ── schedule time: the not-interested row carries full context ──────────────

function captureSupabase(inserted) {
  const chain = () => {
    const c = {
      select: () => c, eq: () => c, in: () => c, or: () => c, not: () => c, order: () => c, limit: () => c,
      ilike: async () => ({ count: 0, data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve) => resolve({ data: [], count: 0, error: null }),
    };
    return c;
  };
  return {
    from(table) {
      const base = chain();
      if (table === "send_queue") {
        base.insert = (payload) => {
          inserted.push(payload);
          return { select: () => ({ maybeSingle: async () => ({ data: { id: 777, ...payload }, error: null }) }) };
        };
      }
      return base;
    },
  };
}

test("not-interested reply → nurture row persists name, address, sticky sender, language, agent and the nurture family", async () => {
  const inserted = [];
  const loaderCalls = [];
  const result = await scheduleFollowUp(
    "not_interested",
    SELLER,
    {
      source: "seller_inbound_orchestrator",
      master_owner_id: "mo_1",
      property_id: "p1",
      inbound_message_event_id: "me-1",
      inbound_to: OUR_NUMBER,
      reply_text: "No estoy interesado en vender, gracias",
      render_context_loader: async (_supabase, args) => {
        loaderCalls.push(args);
        return buildNurtureRenderContext({
          known: args.known,
          sent_rows_newest_first: [{ property_id: "p1", seller_first_name: "Maria", property_address: "412 W Oak St", from_phone_number: OUR_NUMBER, agent_name: "Alex" }],
          thread_state: { our_number: OUR_NUMBER },
          reply_text: args.reply_text,
          intent: args.intent,
        });
      },
    },
    captureSupabase(inserted)
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(loaderCalls.length, 1);
  assert.equal(loaderCalls[0].known.inbound_to, OUR_NUMBER);
  const row = inserted[0];
  assert.equal(row.use_case_template, "nurture_not_interested");
  assert.equal(row.seller_first_name, "Maria");
  assert.equal(row.property_address, "412 W Oak St");
  assert.equal(row.from_phone_number, OUR_NUMBER);
  assert.equal(row.agent_name, "Alex");
  assert.equal(row.metadata.language, "Spanish");
  assert.equal(row.metadata.nurture_render_context.template_use_case, "consider_selling_follow_up");
  assert.equal(row.metadata.followup_reason, "nurture_followup:not_interested");
  // The reply text and the hook are never persisted.
  assert.equal(row.metadata.reply_text, undefined);
  assert.equal(row.metadata.render_context_loader, undefined);
});

test("stage no-reply follow-ups are not touched by nurture hydration", async () => {
  const inserted = [];
  let called = false;
  await scheduleFollowUp(
    "stage_no_reply",
    SELLER,
    { stage: "s2_interest", stage_no_reply_hours: 24, followup_use_case: "s2_no_response_fu1", skip_email_lane: true, render_context_loader: async () => { called = true; return {}; } },
    captureSupabase(inserted)
  );
  assert.equal(called, false);
});

// ── send time: renders the nurture in the right language, never S1 copy ─────

function templatesSupabase(templates) {
  return {
    from(table) {
      const f = {};
      const c = {
        select: () => c,
        eq: (k, v) => { f[k] = v; return c; },
        in: (k, v) => { f[k] = v; return c; },
        maybeSingle: async () => ({ data: null, error: null }),
        limit: async () => ({
          data: table === "sms_templates"
            ? templates.filter((t) => (f.language || []).includes(t.language) && (f.use_case || []).includes(t.use_case))
            : [],
          error: null,
        }),
      };
      return c;
    },
  };
}

const TEMPLATES = [
  { template_id: "400065", use_case: "consider_selling", language: "English", is_active: true, safe_for_auto_reply: true, template_body: "Thanks for confirming. Would you consider a proposal for the property?" },
  { template_id: "521105", use_case: "consider_selling_follow_up", language: "English", is_active: true, safe_for_auto_reply: true, template_body: "{{seller_first_name}}, just checking back on {{property_address}}. Would you be open to a proposal?" },
  { template_id: "lc-consider-selling-follow-up-es-1", use_case: "consider_selling_follow_up", language: "Spanish", is_active: true, safe_for_auto_reply: true, template_body: "{{seller_first_name}}, le escribo de nuevo sobre {{property_address}}. ¿Consideraría una propuesta?" },
];

const bareRow = () => ({
  id: "q-9",
  to_phone_number: SELLER,
  property_id: "p1",
  use_case_template: "nurture_not_interested",
  message_body: "",
  metadata: { deferred_message_resolution: true, intent: "not_interested", inbound_message_event_id: "me-1" },
});

test("not_interested never falls back to the S1 consider_selling pool", () => {
  assert.ok(!NURTURE_TEMPLATE_CANDIDATES.not_interested.includes("consider_selling"));
  assert.deepEqual([...NURTURE_TEMPLATE_CANDIDATES.not_interested], [...NURTURE_TEMPLATE_FAMILIES.not_interested]);
});

test("send time: a context-less nurture row re-resolves from the thread and renders the Spanish nurture", async () => {
  assert.deepEqual(missingNurtureContextFields(bareRow()).sort(), ["agent_name", "from_phone_number", "language", "property_address", "seller_first_name"]);
  const result = await resolveDeferredQueueMessage(bareRow(), {
    supabase: templatesSupabase(TEMPLATES),
    loadNurtureRenderContext: async (_s, args) =>
      buildNurtureRenderContext({
        known: args.known,
        sent_rows_newest_first: [{ property_id: "p1", seller_first_name: "Maria", property_address: "412 W Oak St" }],
        reply_text: "No estoy interesado en vender",
        intent: args.intent,
      }),
  });
  assert.equal(result.resolved, true, JSON.stringify(result));
  assert.equal(result.template_id, "lc-consider-selling-follow-up-es-1");
  assert.equal(result.language, "Spanish");
  assert.match(result.message_body, /^Maria, le escribo de nuevo sobre 412 W Oak St/);
  assert.equal(result.render_context.seller_first_name, "Maria");
  assert.equal(result.render_context.property_address, "412 W Oak St");
  assert.equal(result.render_context.language, "Spanish");
});

test("send time: language persisted in metadata (the column is dropped by normalization) is honoured", async () => {
  const row = { ...bareRow(), seller_first_name: "Maria", property_address: "412 W Oak St", agent_name: "Alex", from_phone_number: OUR_NUMBER };
  row.metadata = { ...row.metadata, language: "Spanish" };
  const result = await resolveDeferredQueueMessage(row, {
    supabase: templatesSupabase(TEMPLATES),
    loadNurtureRenderContext: async () => { throw new Error("must not be called"); },
  });
  assert.equal(result.template_id, "lc-consider-selling-follow-up-es-1");
  assert.equal(result.render_context, null);
});

test("send time: no name anywhere ⇒ pause for review, never the 'Thanks for confirming' copy", async () => {
  const result = await resolveDeferredQueueMessage(bareRow(), {
    supabase: templatesSupabase(TEMPLATES),
    loadNurtureRenderContext: async (_s, args) => buildNurtureRenderContext({ known: args.known, property: { property_address: "412 W Oak St" }, intent: args.intent }),
  });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "no_renderable_followup_template");
});
