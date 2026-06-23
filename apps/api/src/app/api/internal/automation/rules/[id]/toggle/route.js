import { NextResponse } from "next/server";

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(value) {
  return String(value ?? "").trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    clean(value)
  );
}

async function maybeSingle(query) {
  if (typeof query?.maybeSingle === "function") return query.maybeSingle();
  if (typeof query?.single === "function") return query.single();
  return query;
}

function ruleQuery(db, id) {
  const query = db.from("automation_rules").select("*");
  return isUuid(id) ? query.eq("id", id) : query.eq("rule_key", id);
}

export async function POST(request, { params } = {}) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error || "unauthorized" },
      { status: auth.status || 401 }
    );
  }

  const id = clean(params?.id);
  if (!id) {
    return NextResponse.json({ ok: false, error: "missing_rule_id" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const db = getDefaultSupabaseClient();

  const existing = await maybeSingle(ruleQuery(db, id));
  if (existing?.error || !existing?.data) {
    return NextResponse.json(
      { ok: false, error: "automation_rule_not_found" },
      { status: 404 }
    );
  }

  const next_active =
    typeof body.is_active === "boolean" ? body.is_active : !existing.data.is_active;
  const patch = {
    is_active: next_active,
    status: next_active ? "active" : "paused",
    updated_at: new Date().toISOString(),
  };

  const update_query = db.from("automation_rules").update(patch);
  const updated = await maybeSingle(
    (isUuid(id) ? update_query.eq("id", id) : update_query.eq("rule_key", id)).select()
  );

  if (updated?.error) {
    return NextResponse.json(
      { ok: false, error: updated.error.message || "automation_rule_toggle_failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    route: "internal/automation/rules/[id]/toggle",
    rule: updated?.data || { ...existing.data, ...patch },
  });
}
