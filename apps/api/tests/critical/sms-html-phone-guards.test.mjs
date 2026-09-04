import test from "node:test";
import assert from "node:assert/strict";

import { deriveContextSummary } from "@/lib/domain/context/derive-context-summary.js";
import { buildSendQueueItem } from "@/lib/domain/queue/build-send-queue-item.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { renderTemplate } from "@/lib/domain/templates/render-template.js";
import {
  normalizeUsPhoneToE164,
  prepareRenderedSmsForQueue,
  sanitizeSmsTextValue,
} from "@/lib/sms/sanitize.js";
import {
  appRefField,
  categoryField,
  createPodioItem,
  locationField,
  phoneField,
  textField,
} from "../helpers/test-helpers.js";

function makePhoneItem(overrides = {}) {
  return createPodioItem(401, {
    "phone-activity-status": categoryField("Active for 12 months or longer"),
    "phone-hidden": textField("2087034955"),
    "canonical-e164": textField("+12087034955"),
    phone: phoneField("(208) 703-4955"),
    "linked-master-owner": appRefField(201),
    "linked-contact": appRefField(301),
    ...overrides,
  });
}

function makeBuildQueueContext(phone_item = makePhoneItem()) {
  const property_item = createPodioItem(501, {
    "property-address": locationField({
      street_address: "5521 Laster Ln",
      city: "Dallas",
      state: "TX",
      postal_code: "75241",
    }),
    "property-type": categoryField("Single Family"),
    "owner-type-2": categoryField("Individual"),
  });

  const master_owner_item = createPodioItem(201, {
    "owner-full-name": textField("Jose Seller"),
    "best-contact-window": categoryField("8AM-9PM Local"),
  });

  return {
    found: true,
    items: {
      phone_item,
      brain_item: null,
      master_owner_item,
      property_item,
      agent_item: createPodioItem(701, {
        title: textField("Ricky Agent"),
        "agent-name": textField("Ricky Agent"),
        "first-name": textField("Ricky"),
      }),
      market_item: createPodioItem(801, {
        title: textField("Dallas"),
        timezone: textField("America/Chicago"),
        state: textField("TX"),
      }),
    },
    ids: {
      phone_item_id: 401,
      master_owner_id: 201,
      prospect_id: 301,
      property_id: 501,
      market_id: 801,
      assigned_agent_id: 701,
    },
    recent: { touch_count: 0 },
    summary: {
      total_messages_sent: 0,
      property_address: "5521 Laster Ln",
      property_type: "Single Family",
      owner_type: "Individual",
      contact_window: "8AM-9PM Local",
    },
  };
}

test("sanitizeSmsTextValue strips HTML wrappers from SMS values", () => {
  assert.equal(sanitizeSmsTextValue("<p>Jose</p>"), "Jose");
});

test("renderTemplate sanitizes SMS variables before render", () => {
  const result = renderTemplate({
    template_text: "Hi {{seller_first_name}}, this is {{agent_first_name}}.",
    context: {
      summary: {
        seller_first_name: "<p>Stephen</p>",
        agent_name: "<p>Nathan</p>",
      },
    },
    use_case: "ownership_check",
  });

  assert.equal(result.rendered_text, "Hi Stephen, this is Nathan.");
  assert.ok(!result.rendered_text.includes("<p>"));
});

test("buildSendQueueItem stores sanitized final queue message text", async () => {
  let captured_fields = null;

  const result = await buildSendQueueItem({
    context: makeBuildQueueContext(),
    rendered_message_text:
      "Hola <p>Jose</p>, <p>Ricky</p> aqui. Sigues siendo el dueno de 4216 Littlejohn Ave?",
    textgrid_number_item_id: 901,
    scheduled_for_local: "2026-04-20T09:00:00.000Z",
    create_item: async (_app_id, fields) => {
      captured_fields = fields;
      return { item_id: 9991 };
    },
    update_item: async () => ({}),
  });

  assert.equal(result.ok, true);
  assert.equal(
    captured_fields?.["message-text"],
    "Hola Jose, Ricky aqui. Sigues siendo el dueno de 4216 Littlejohn Ave?"
  );
});

test("prepareRenderedSmsForQueue blocks queue creation if the sanitizer misses HTML", () => {
  const guarded = prepareRenderedSmsForQueue({
    rendered_message_text: "Hi Jose",
    template_id: 77,
    template_source: "podio",
    sanitizer: () => "Hi <p>Jose</p>",
  });

  assert.equal(guarded.ok, false);
  assert.equal(guarded.reason, "rendered_sms_contains_html");
  assert.equal(guarded.diagnostics.template_id, 77);
  assert.equal(guarded.diagnostics.template_source, "podio");
  assert.equal(guarded.diagnostics.sanitized_rendered_message_text, "Hi <p>Jose</p>");
});

test("normalizeUsPhoneToE164 strips HTML and returns E.164", () => {
  assert.equal(normalizeUsPhoneToE164("<p>8175341269</p>"), "+18175341269");
});

test("deriveContextSummary backfills blank canonical_e164 from phone_hidden", () => {
  const summary = deriveContextSummary({
    phone_item: makePhoneItem({
      "phone-hidden": textField("<p>8175341269</p>"),
      "canonical-e164": textField(""),
    }),
  });

  assert.equal(summary.phone_hidden, "8175341269");
  assert.equal(summary.canonical_e164, "+18175341269");
});

test("processSendQueueItem skips TextGrid send when destination phone is invalid", async () => {
  let send_calls = 0;
  const updates = [];

  const queue_item = createPodioItem(5001, {
    "queue-status": categoryField("Queued"),
    "message-text": textField("Hello there"),
    from: textField("+16128060495"),
  });

  const result = await processSendQueueItem(queue_item, {
    getSystemValue: async (key) => {
      // Canonical send authority is fail-closed: a send fixture must state that
      // the control plane permits the send.
      if (key === "queue_processor_mode") return "live";
      if (key === "queue_execution_mode") return "normal";
      return null;
    },
    updateItem: async (item_id, payload) => {
      updates.push({ item_id, payload });
      return { item_id, payload };
    },
    sendTextgridSMS: async () => {
      send_calls += 1;
      return { sid: "SM-should-not-send" };
    },
  });

  // The safety property is unchanged and is what this test exists for: an
  // invalid destination must never reach the provider.
  assert.equal(send_calls, 0);

  // The REASON is now stronger. This fixture is a Podio-shaped item, and §11
  // hard-fences that path entirely rather than relying on the per-field phone
  // check that used to be the last thing standing between it and a send. A
  // Podio item carries none of the anchors an lck_v1 identity needs, so it
  // cannot be converged; it is refused before any provider work at all.
  assert.equal(result.reason, "legacy_podio_path_fenced_by_s11");
  assert.equal(result.sent, false);
});

test("processSendQueueItem never calls TextGrid with a blank destination when phone_hidden can be normalized", { skip: "legacy Podio dispatch path (processLegacyQueueItem) has zero production callers and is doubly blocked (missing_dispatch_claim_token + missing_recipient_phone); the live-path guard is pinned below" }, async () => {
  let send_args = null;

  const queue_item = createPodioItem(5002, {
    "queue-status": categoryField("Queued"),
    "message-text": textField("Hello there"),
    "phone-hidden": textField("<p>8175341269</p>"),
    from: textField("+16128060495"),
  });

  const result = await processSendQueueItem(queue_item, {
    getSystemValue: async (key) => {
      // Canonical send authority is fail-closed: a send fixture must state that
      // the control plane permits the send.
      if (key === "queue_processor_mode") return "live";
      if (key === "queue_execution_mode") return "normal";
      return null;
    },
    updateItem: async (item_id, payload) => ({ item_id, payload }),
    sendTextgridSMS: async (payload) => {
      send_args = payload;
      return { sid: "SM-live-send-1" };
    },
    logOutboundMessageEvent: async () => ({ item_id: 7001 }),
    updateBrainAfterSend: async () => ({}),
    updateMasterOwnerAfterSend: async () => ({}),
  });

  assert.equal(result.sent, true);
  assert.equal(send_args?.to, "+18175341269");
  assert.notEqual(send_args?.to, "");
});

// ── Live-path replacement for the retired legacy guard test above ───────────
// (closure pass 2026-08-26): the production dispatch path is
// processSupabaseQueueItem; its blank-destination protection is the preclaim
// eligibility gate — a row whose destination cannot resolve to a phone is
// refused BEFORE claim/dispatch, so TextGrid can never be called with a blank
// destination.
test("live path: a Supabase row with a blank/HTML-polluted destination is preclaim-refused (missing_to_phone_number)", async () => {
  const { shouldRunSendQueueRow, resolveQueueDestinationPhone } = await import(
    "../../src/lib/supabase/sms-engine.js"
  );
  for (const to of ["", null, "<p></p>", "   "]) {
    const row = {
      id: "sq-blank-dest",
      queue_status: "queued",
      message_body: "Hello there",
      to_phone_number: to,
      from_phone_number: "+16128060495",
      metadata: {},
    };
    const verdict = shouldRunSendQueueRow(row, "2026-05-01T12:00:00.000Z");
    assert.equal(verdict.ok, false, JSON.stringify(to));
    assert.equal(verdict.reason, "missing_to_phone_number", JSON.stringify(to));
  }
  // HTML-wrapped but normalizable numbers DO resolve — normalization, not loss.
  const normalized = resolveQueueDestinationPhone({ to_phone_number: "<p>8175341269</p>" });
  assert.ok(String(normalized.phone || "").includes("8175341269"));
});
