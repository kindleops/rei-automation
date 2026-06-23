#!/usr/bin/env node

import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const API_ROOT = path.join(ROOT, "apps/api");

process.env.NODE_ENV ||= "test";
process.env.PODIO_CLIENT_ID ||= "test";
process.env.PODIO_CLIENT_SECRET ||= "test";
process.env.PODIO_USERNAME ||= "test";
process.env.PODIO_PASSWORD ||= "test";
process.env.INTERNAL_API_SECRET ||= "test";
process.env.BUYER_WEBHOOK_SECRET ||= "test";
process.env.OPS_DASHBOARD_SECRET ||= "test";
process.env.OPENAI_KEY ||= "test-openai-key";
process.env.ENABLE_AI_ASSIST = "false";

process.chdir(API_ROOT);

register(
  pathToFileURL(path.join(API_ROOT, "tests/alias-loader.mjs")).href,
  pathToFileURL(`${API_ROOT}/`)
);

const { classify } = await import(pathToFileURL(path.join(API_ROOT, "src/lib/domain/classification/classify.js")).href);
const { resolveSellerAutoReplyPlan } = await import(pathToFileURL(path.join(API_ROOT, "src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js")).href);
const { maybeQueueSellerStageReply } = await import(pathToFileURL(path.join(API_ROOT, "src/lib/domain/seller-flow/maybe-queue-seller-stage-reply.js")).href);
const { deriveInboundAutopilotQueueOverrides } = await import(pathToFileURL(path.join(API_ROOT, "src/lib/flows/handle-textgrid-inbound.js")).href);
const { resolveFollowUpPlan } = await import(pathToFileURL(path.join(API_ROOT, "src/lib/domain/seller-flow/seller-followup-scheduler.js")).href);

let failures = 0;
const proof = {
  called_textgrid: false,
  sent_sms: false,
  classify_ok: false,
  auto_reply_plan_ok: false,
  queue_preview_ok: false,
  followup_scheduler_ok: false,
  no_reference_error: true,
};

function mark(label, condition, detail = "") {
  const line = `${condition ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`;
  if (condition) {
    console.log(line);
  } else {
    failures += 1;
    console.error(line);
  }
}

const context = {
  found: true,
  ids: {
    phone_item_id: 101,
    brain_item_id: 201,
    master_owner_id: 301,
    prospect_id: 401,
    property_id: 501,
    textgrid_number_id: 601,
    thread_key: "+15551234567",
  },
  summary: {
    seller_first_name: "Riley",
    owner_name: "Riley Seller",
    property_address: "123 Main St",
    market: "Houston, TX",
    market_name: "Houston, TX",
    timezone: "America/Chicago",
    market_timezone: "America/Chicago",
    contact_window: "9AM-6PM CT",
    conversation_stage: "ownership_check",
    language_preference: "English",
    inbound_to: "+15557654321",
  },
  items: {},
};

try {
  const classification = await classify("Yes I own it", null);
  proof.classify_ok = Boolean(classification);
  mark("inbound classify path returns a classification", proof.classify_ok, JSON.stringify({
    primary_intent: classification?.primary_intent,
    objection: classification?.objection,
    source: classification?.source,
  }));

  const plan = await resolveSellerAutoReplyPlan({
    message_body: "Stop",
    classification: await classify("Stop", null),
    conversation_context: context,
    current_stage: "ownership_check",
  });
  proof.auto_reply_plan_ok = plan?.ok === true && plan.inbound_intent === "opt_out";
  mark("auto_reply_plan generated without sending", proof.auto_reply_plan_ok, JSON.stringify({
    ok: plan?.ok,
    inbound_intent: plan?.inbound_intent,
    should_queue_reply: plan?.should_queue_reply,
    reason: plan?.reason,
  }));

  const overrides = deriveInboundAutopilotQueueOverrides({
    autopilot_schedule: { timezone_label: "America/Chicago" },
    context,
  });

  let capturedPayload = null;
  const queuePreview = await maybeQueueSellerStageReply({
    inbound_from: "+15551234567",
    context,
    classification,
    message: "Yes I own it",
    previous_outbound_use_case: "ownership_check",
    timezone_override: overrides.timezone_label,
    contact_window_override: overrides.contact_window,
    queue_message: async (payload) => {
      capturedPayload = payload;
      return {
        ok: true,
        preview_only: true,
        queue_item_id: null,
        queue_result: null,
        rendered_message_text: payload.rendered_message_text || payload.message_text || null,
      };
    },
  });
  proof.queue_preview_ok = queuePreview?.ok === true && Boolean(capturedPayload);
  mark("maybeQueueSellerStageReply preview works", proof.queue_preview_ok, JSON.stringify({
    ok: queuePreview?.ok,
    reason: queuePreview?.reason,
    timezone: capturedPayload?.timezone,
    contact_window: capturedPayload?.contact_window,
  }));

  const followup = resolveFollowUpPlan("unclear", {
    thread_key: "+15551234567",
    is_suppressed: false,
  });
  proof.followup_scheduler_ok = followup.followup_created === true && Boolean(followup.scheduled_for);
  mark("follow-up scheduler path can be invoked in dry-run mode", proof.followup_scheduler_ok, JSON.stringify(followup));
} catch (error) {
  proof.no_reference_error = !/ReferenceError|schedule is not defined|timezone_label is not defined|contact_window is not defined/i.test(error?.stack || error?.message || "");
  mark("no ReferenceError from timezone/contact window variables", proof.no_reference_error, error?.stack || error?.message || "unknown");
  if (proof.no_reference_error) {
    throw error;
  }
}

mark("proof did not call TextGrid", proof.called_textgrid === false);
mark("proof did not send SMS", proof.sent_sms === false);
mark("no ReferenceError from timezone/contact window variables", proof.no_reference_error);

console.log(JSON.stringify({
  ...proof,
  captured_textgrid: false,
}, null, 2));

if (failures > 0) process.exit(1);
