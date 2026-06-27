import { recoverUnprocessedInboundMessages } from "@/lib/domain/seller-flow/recover-unprocessed-inbound-messages.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const limit = Number(body.limit) || 25;
    const dryRun = body.dry_run !== false;
    const autoReplyMode = body.auto_reply_mode || null;

    const result = await recoverUnprocessedInboundMessages({
      supabaseClient: getDefaultSupabaseClient(),
      limit,
      dryRun,
      autoReplyMode,
    });

    return Response.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    return Response.json(
      { ok: false, reason: "recovery_failed", error: error?.message || "recovery_failed" },
      { status: 500 }
    );
  }
}

export default POST;