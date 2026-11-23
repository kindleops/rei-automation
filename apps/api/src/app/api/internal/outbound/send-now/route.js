import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { handleSendNowRequestData } from "@/lib/domain/outbound/send-now-request.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({
  module: "api.internal.outbound.send_now",
});

// FOUNDER P0 2026-11-23 item 6: there is no GET handler. Sending via URL
// parameters put the destination phone and the message text into the query
// string (access logs, proxies, browser history). Only an authenticated POST
// with the message in the request body can send; Next.js answers any other
// method on this route with 405 Method Not Allowed.

export async function POST(request) {
  const { status, payload, headers } = await handleSendNowRequestData(request, "POST", {
    logger,
  });
  return NextResponse.json(payload, { status, ...(headers ? { headers } : {}) });
}
