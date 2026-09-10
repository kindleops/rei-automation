/**
 * auto-reply-callback-and-coverage.test.mjs
 *
 * Operator directive 2026-09-09: this is an auto-responder, so every seller who
 * writes gets an answer, and every answer ends in a question that advances the
 * conversation. The only permitted silence is compliance silence.
 *
 * Three production misses drove this:
 *   1. "I call u but u not answering di phone" -> unclear/0.60 -> silence, from
 *      a real owner who was actively dialling the number. No detector modelled
 *      the seller reporting that THEY called US; every callback pattern was
 *      request-shaped ("call me").
 *   2. "Wrong  #" (double space) missed the wrong-number list, because the
 *      phrase lists are single-spaced and matching is literal. It stayed in the
 *      active conversation lane instead of being suppressed.
 *   3. A bare "Yes" confirming ownership scores 0.72 in some thread contexts,
 *      below the 0.82 autonomy gate, so the same message was answered on one
 *      thread and ignored on the next.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { detectInboundIntent } from "@/lib/domain/classification/classify.js";
import { CLARIFIER_INTENTS } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const intentOf = (body) => detectInboundIntent(body)?.primary_intent || null;

test("a seller reporting they called us routes to callback_requested", () => {
  for (const body of [
    "I call u but u not answering di phone",
    "I called you",
    "I'm trying to call you",
    "i been trying to call you",
    "I called and no one picked up",
    "pick up the phone",
    "you never answer",
  ]) {
    assert.equal(intentOf(body), "callback_requested", body);
  }
});

test("Spanish call reports route the same way", () => {
  for (const body of ["te llame", "no contestas", "llamame"]) {
    assert.equal(intentOf(body), "callback_requested", body);
  }
});

test("opt-out still wins over any call language", () => {
  // "don't call me" contains a call token but is a cessation request. Opt-out
  // is a terminal early return ~400 lines before the callback block.
  for (const body of ["don't call me", "stop calling me", "no me llames"]) {
    assert.equal(intentOf(body), "opt_out", body);
  }
});

test("call language about third parties is not a callback request", () => {
  assert.notEqual(intentOf("I called my agent about the roof"), "callback_requested");
  assert.notEqual(intentOf("I have a call at 3pm"), "callback_requested");
});

test("wrong-number matching survives irregular internal whitespace", () => {
  // The live miss. Both spellings must suppress, not start a conversation.
  assert.equal(intentOf("Wrong #"), "wrong_number");
  assert.equal(intentOf("Wrong  #"), "wrong_number");
  assert.equal(intentOf("wrong   number"), "wrong_number");
});

test("understood-but-low-confidence intents can still receive a clarifier", () => {
  // Below the 0.82 autonomy gate the intent-specific reply is declined. Before
  // this change that meant silence; now the clarifier covers it.
  for (const intent of [
    "ownership_confirmed",
    "seller_interested",
    "latent_interest",
    "asks_offer",
    "who_is_this",
    "callback_requested",
    "info_request",
    "need_time",
  ]) {
    assert.equal(CLARIFIER_INTENTS.has(intent), true, intent);
  }
});

test("compliance and human-only lanes are NEVER clarified", () => {
  // A cheerful clarifying question is the wrong answer for these, not a late
  // one. Opt-out and wrong-number silence is legally and practically required.
  for (const intent of [
    "opt_out",
    "wrong_number",
    "sold_property",
    "hostile_or_legal",
    "title_issue",
    "lien_tax_issue",
    "bankruptcy_disclosed",
  ]) {
    assert.equal(CLARIFIER_INTENTS.has(intent), false, intent);
  }
});
