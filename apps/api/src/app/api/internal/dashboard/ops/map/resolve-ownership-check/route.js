import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { resolveMapOwnershipCheckIdentity } from "@/lib/domain/map/resolve-map-ownership-check.js";
import { supabase, hasSupabaseConfig } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(value) {
  return String(value ?? "").trim();
}

function sanitizeHints(raw) {
  const hints = raw && typeof raw === "object" ? raw : {};
  const smsEligible = hints.smsEligible === false || hints.sms_eligible === false
    ? false
    : hints.smsEligible === true || hints.sms_eligible === true
      ? true
      : null;

  return {
    masterOwnerId: clean(hints.masterOwnerId || hints.master_owner_id) || null,
    prospectId: clean(hints.prospectId || hints.prospect_id) || null,
    phoneId: clean(hints.phoneId || hints.phone_id || hints.resolved_phone_id) || null,
    recipientPhone: clean(hints.recipientPhone || hints.recipient_phone || hints.canonical_e164) || null,
    prospectFirstName: clean(hints.prospectFirstName || hints.prospect_first_name) || null,
    prospectFullName: clean(hints.prospectFullName || hints.prospect_full_name || hints.prospect_name) || null,
    ownerDisplayName: clean(hints.ownerDisplayName || hints.owner_display_name) || null,
    agentPersona: clean(hints.agentPersona || hints.agent_persona) || null,
    agentFamily: clean(hints.agentFamily || hints.agent_family) || null,
    smsEligible,
  };
}

export async function POST(request) {
  const auth = requireOpsDashboardAuth(request);
  if (!auth.authorized) return auth.response;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const propertyId = clean(body.property_id || body.propertyId);
  if (!propertyId) {
    return NextResponse.json(
      { ok: false, error: "property_id is required" },
      { status: 400 },
    );
  }

  if (!hasSupabaseConfig()) {
    return NextResponse.json(
      { ok: false, error: "supabase_unavailable" },
      { status: 503 },
    );
  }

  try {
    const result = await resolveMapOwnershipCheckIdentity(propertyId, {
      supabase,
      hints: sanitizeHints(body.hints),
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch {
    return NextResponse.json(
      { ok: false, error: "resolve_ownership_check_failed" },
      { status: 500 },
    );
  }
}