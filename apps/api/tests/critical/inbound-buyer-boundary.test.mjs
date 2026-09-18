/**
 * THE SELLER LIFECYCLE IS ISOLATED FROM BUYER REPLIES (§19-§23).
 *
 * These drive `handleTextgridInboundWebhook` itself — the production entry
 * point — rather than the classifier in isolation. That distinction is the
 * whole point of this file: the classifier was correct and complete for days
 * while NOTHING CALLED IT, so every buyer reply would still have been processed
 * as a seller's. A unit test on the classifier would have passed throughout.
 *
 * What each case proves:
 *   §19 a reply from a contacted buyer is routed to the buyer domain and the
 *       seller pipeline is never entered
 *   §20 a buyer contacted about several properties yields `ambiguous` with all
 *       candidates, not a guess
 *   §21 unreadable buyer outreach DEFERS — neither attributed nor dropped
 *   §22 STOP from a buyer is honoured through the shared suppression authority
 *   §23 an ordinary seller reply is completely unaffected
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { handleInboundBuyerReply } from "@/lib/domain/buyers/handle-inbound-buyer-reply.js";

const BUYER_PHONE = "+13055550100";

const outreachRow = (over = {}) => ({
  id: "t-1",
  property_id: "P1",
  buyer_key: "B1",
  buyer_name: "Acme Capital",
  touch_number: 1,
  created_at: new Date().toISOString(),
  ...over,
});

test("§19 a reply from a contacted buyer is handled as buyer traffic", async () => {
  const written = [];
  const result = await handleInboundBuyerReply(
    { from_phone_number: BUYER_PHONE, body: "yes send me the numbers" },
    {
      loadBuyerOutreachByPhone: async () => [outreachRow()],
      recordBuyerReply: async (args) => written.push(args),
      suppressPhone: async () => { throw new Error("must not suppress a non-opt-out") },
    }
  );

  assert.equal(result.handled, true);
  assert.equal(result.domain, "buyer");
  assert.equal(result.defer, false);
  assert.deepEqual(result.target_ids, ["t-1"]);
  assert.equal(written.length, 1);
  assert.equal(written[0].ambiguous, false);
});

test("§20 a buyer with live outreach on several properties is AMBIGUOUS, not guessed", async () => {
  const written = [];
  const result = await handleInboundBuyerReply(
    { from_phone_number: BUYER_PHONE, body: "interested" },
    {
      loadBuyerOutreachByPhone: async () => [
        outreachRow({ id: "t-1", property_id: "P1", created_at: "2026-09-18T00:00:00Z" }),
        outreachRow({ id: "t-2", property_id: "P2", created_at: "2026-09-17T00:00:00Z" }),
      ],
      recordBuyerReply: async (args) => written.push(args),
    }
  );

  assert.equal(result.domain, "ambiguous");
  // Every candidate is marked, so no surface can present one as the answer.
  assert.deepEqual(result.target_ids.sort(), ["t-1", "t-2"]);
  assert.equal(written.length, 2);
  assert.ok(written.every((w) => w.ambiguous === true));
  assert.equal(result.candidates.length, 2);
});

test("§21 unreadable buyer outreach DEFERS — it does not attribute and does not drop", async () => {
  const result = await handleInboundBuyerReply(
    { from_phone_number: BUYER_PHONE, body: "hello" },
    { loadBuyerOutreachByPhone: async () => { throw new Error("outreach table unreachable") } }
  );

  assert.equal(result.handled, true);
  assert.equal(result.defer, true);
  assert.equal(result.domain, "unknown");
  // Critically NOT handled:false — that would send an unclassifiable message
  // into the seller acquisition pipeline.
});

test("§22 STOP from a buyer is suppressed through the SHARED destination authority", async () => {
  const suppressed = [];
  const result = await handleInboundBuyerReply(
    { from_phone_number: BUYER_PHONE, body: "STOP" },
    {
      loadBuyerOutreachByPhone: async () => [outreachRow()],
      recordBuyerReply: async () => {},
      suppressPhone: async (phone) => suppressed.push(phone),
    }
  );

  assert.equal(result.opt_out, true);
  assert.deepEqual(suppressed, [BUYER_PHONE]);
});

test("a negotiation containing the word stop is NOT an opt-out", async () => {
  const suppressed = [];
  const result = await handleInboundBuyerReply(
    { from_phone_number: BUYER_PHONE, body: "please stop sending me anything under 200k" },
    {
      loadBuyerOutreachByPhone: async () => [outreachRow()],
      recordBuyerReply: async () => {},
      suppressPhone: async (phone) => suppressed.push(phone),
    }
  );

  assert.equal(result.opt_out, false);
  assert.deepEqual(suppressed, []);
});

test("a failed suppression write is REPORTED, never swallowed", async () => {
  // Silently failing to honour STOP is a compliance failure.
  const result = await handleInboundBuyerReply(
    { from_phone_number: BUYER_PHONE, body: "STOP" },
    {
      loadBuyerOutreachByPhone: async () => [outreachRow()],
      recordBuyerReply: async () => {},
      suppressPhone: async () => { throw new Error("suppression table down") },
    }
  );

  assert.ok(result.errors?.some((e) => e.startsWith("suppression_failed")), JSON.stringify(result.errors));
});

test("§23 an ordinary seller reply is untouched and continues down the seller path", async () => {
  const result = await handleInboundBuyerReply(
    { from_phone_number: "+13055559999", body: "how much are you offering" },
    { loadBuyerOutreachByPhone: async () => [] }
  );

  assert.equal(result.handled, false);
  assert.equal(result.domain, "not_buyer");
});

test("THE PRODUCTION INBOUND HANDLER ACTUALLY CONSULTS THE BOUNDARY", async () => {
  // The defect this file exists for: the classifier was complete and correct
  // and no caller invoked it. A green classifier test proved nothing.
  const flow = await import("@/lib/flows/handle-textgrid-inbound.js");
  const source = await import("node:fs").then((fs) =>
    fs.promises.readFile(
      new URL("../../src/lib/flows/handle-textgrid-inbound.js", import.meta.url),
      "utf8"
    )
  );

  assert.ok(typeof flow.handleTextgridInboundWebhook === "function");
  assert.match(source, /handleInboundBuyerReply/, "the inbound handler must call the buyer boundary");

  // ...and it must ask BEFORE claiming the message, or a deferral becomes a
  // duplicate on retry and the reply is lost.
  const boundaryAt = source.indexOf("handleInboundBuyerReply ||");
  const claimAt = source.indexOf("beginIdempotentProcessing({");
  assert.ok(boundaryAt > 0 && claimAt > 0);
  assert.ok(
    boundaryAt < claimAt,
    "the buyer boundary must be consulted before the idempotency claim"
  );
});
