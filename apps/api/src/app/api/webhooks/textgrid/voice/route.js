// POST /api/webhooks/textgrid/voice — TextGrid voice webhook (missed-call
// auto-text). All logic lives in lib/domain/calls/handle-voice-webhook.js.
// Default OFF: without MISSED_CALL_AUTOTEXT_ENABLED=true every authenticated
// call gets <Reject reason="busy"/> and nothing is written.

import { hasSupabaseConfig, supabase } from "@/lib/supabase/client.js";
import { getSystemValue } from "@/lib/system-control.js";
import { handleVoiceWebhook } from "@/lib/domain/calls/handle-voice-webhook.js";
import { TWIML_CONTENT_TYPE } from "@/lib/domain/calls/voice-twiml.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Voice webhooks are small form posts; refuse anything far larger.
const MAX_VOICE_REQUEST_BYTES = 64 * 1024;

export async function POST(request) {
  const raw_body = await request.text().catch(() => "");
  if (raw_body.length > MAX_VOICE_REQUEST_BYTES) {
    return new Response("payload_too_large", { status: 413 });
  }
  const configured = hasSupabaseConfig();
  const out = await handleVoiceWebhook(
    {
      url: request.url,
      raw_body,
      content_type: request.headers.get("content-type"),
      headers: request.headers,
    },
    {
      supabase: configured ? supabase : null,
      getSystemValue: configured ? getSystemValue : async () => null,
    },
  );
  return new Response(out.body, {
    status: out.status,
    headers: {
      "Content-Type": out.kind === "twiml" ? TWIML_CONTENT_TYPE : "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
