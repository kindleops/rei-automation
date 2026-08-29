/**
 * Internal admin/debug surface for W8C shadow buyer intelligence.
 *
 * READ-ONLY and OBSERVATIONAL. This endpoint exists so an operator can inspect
 * what W8C believes; nothing it returns feeds MAO, offer pricing, campaign
 * targeting, outreach, send_queue, suppressions or seller priority.
 *
 * Access is gated by requireInternalSecret. That gate is load-bearing rather
 * than routine: `property_historical_buyers` is a service-role-only view, and a
 * per-property buyer roster is re-identifying — it is deliberately withheld
 * from both anon and authenticated roles by the serving layer.
 *
 *   GET ?mode=version
 *   GET ?mode=property&property_id=<id>     full shadow envelope
 *   GET ?mode=compare&property_id=<id>      REI vs W8C, namespaces kept separate
 *   GET ?mode=buyer&buyer_entity_id=<id>    summary + behavior + buybox
 */

import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import { createW8cClient, redactShadowEnvelope, scrubPersonIds, W8C_SOURCE } from "@/lib/intel/w8c-buyer-intelligence.js";
import { compareBuyerIntelligenceForProperty } from "@/lib/intel/w8c-shadow-comparison.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.internal.intel.w8c" });

const clean = (v) => String(v ?? "").trim();

export async function GET(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error || "unauthorized" }, { status: auth.status || 401 });
  }

  const url = new URL(request.url);
  const mode = clean(url.searchParams.get("mode")) || "version";
  const propertyId = clean(url.searchParams.get("property_id"));
  const buyerEntityId = clean(url.searchParams.get("buyer_entity_id"));

  // W8C person entity IDs are `person:{individual_key}`, so they are redacted
  // unconditionally. There is deliberately NO override — no query parameter, no
  // header, no environment flag. Every response leaves through shield().
  const shield = (payload) => redactShadowEnvelope(payload);

  const envelope = {
    ok: true, source: W8C_SOURCE, observational_only: true, mode,
    person_ids_redacted: true,
  };

  try {
    const w8c = createW8cClient();

    if (mode === "version") {
      return NextResponse.json(shield({ ...envelope, version: await w8c.getVersion() }));
    }

    if (mode === "property") {
      if (!propertyId) return NextResponse.json({ ok: false, error: "missing_property_id" }, { status: 400 });
      return NextResponse.json(shield({ ...envelope, property: await w8c.getShadowIntelligenceForProperty(propertyId) }));
    }

    if (mode === "compare") {
      if (!propertyId) return NextResponse.json({ ok: false, error: "missing_property_id" }, { status: 400 });
      return NextResponse.json(shield({ ...envelope, comparison: await compareBuyerIntelligenceForProperty(propertyId) }));
    }

    if (mode === "buyer") {
      if (!buyerEntityId) return NextResponse.json({ ok: false, error: "missing_buyer_entity_id" }, { status: 400 });
      const [summary, behavior, buybox] = await Promise.all([
        w8c.getBuyerSummary(buyerEntityId),
        w8c.getBuyerBehavior(buyerEntityId),
        w8c.getBuyerBuybox(buyerEntityId),
      ]);
      // buyerEntityId is echoed from the query string, so it is shielded too:
      // a caller supplying a raw person ID must not get it reflected back.
      return NextResponse.json(shield({ ...envelope, buyer: { buyer_entity_id: buyerEntityId, summary, behavior, buybox } }));
    }

    return NextResponse.json({ ok: false, error: "unknown_mode", allowed: ["version", "property", "compare", "buyer"] }, { status: 400 });
  } catch (error) {
    // W8C is shadow-only: a failure here is reported, never propagated.
    // Postgres errors can echo bound parameters, so the message is scrubbed
    // before it reaches the log, and the response carries no error detail.
    logger.warn({ err: scrubPersonIds(error?.message ?? ""), mode }, "w8c_debug_endpoint_failed");
    return NextResponse.json(shield({ ...envelope, ok: false, error: "w8c_unavailable" }), { status: 200 });
  }
}
