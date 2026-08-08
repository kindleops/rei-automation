import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { requireSharedSecretAuth } from "@/lib/security/shared-secret.js";
import { handleSendNowRequestData } from "@/lib/domain/outbound/send-now-request.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({
  module: "api.internal.outbound.send_now",
});

export async function GET(request) {
  const auth = requireSharedSecretAuth(request, logger, {
    env_name: "INTERNAL_API_SECRET",
    header_names: ["x-internal-api-secret"],
  });
  if (!auth.authorized) return auth.response;

  const { status, payload } = await handleSendNowRequestData(request, "GET", {
    logger,
  });
  return NextResponse.json(payload, { status });
}

export async function POST(request) {
  const auth = requireSharedSecretAuth(request, logger, {
    env_name: "INTERNAL_API_SECRET",
    header_names: ["x-internal-api-secret"],
  });
  if (!auth.authorized) return auth.response;

  const { status, payload } = await handleSendNowRequestData(request, "POST", {
    logger,
  });
  return NextResponse.json(payload, { status });
}
