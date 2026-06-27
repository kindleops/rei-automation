import { NextResponse } from "next/server.js";

import { recoverUnprocessedInboundMessages } from "@/lib/domain/seller-flow/recover-unprocessed-inbound-messages.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { requireSharedSecretAuth } from "@/lib/security/shared-secret.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireAuth(request) {
  return requireSharedSecretAuth(request, null, {
    env_name: "INTERNAL_API_SECRET",
    header_names: ["x-internal-api-secret"],
  });
}

export async function POST(request) {
  const auth = requireAuth(request);
  if (!auth.authorized) return auth.response;

  try {
    const body = await request.json().catch(() => ({}));
    const limit = Number(body.limit) || 25;
    const dryRun = body.dry_run !== false;
    const autoReplyMode = body.auto_reply_mode || null;
    const proofCases = Array.isArray(body.proof_cases) ? body.proof_cases : null;

    const result = await recoverUnprocessedInboundMessages({
      supabaseClient: getDefaultSupabaseClient(),
      limit,
      dryRun,
      autoReplyMode,
      proofCases,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: "recovery_failed", error: error?.message || "recovery_failed" },
      { status: 500 }
    );
  }
}

export default POST;