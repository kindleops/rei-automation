import { NextResponse } from "next/server";
import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { canSend } from "@/lib/domain/inbox/send-now-service.js";
import { child } from "@/lib/logging/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.internal.suppression.check" });

/**
 * POST /api/internal/suppression/check
 * Body: { phone: string }
 * Returns: { suppressed: boolean, reason: string | null }
 *
 * RISK-006: single server-side allow/deny endpoint — never returns the raw list.
 * The dashboard replaces its direct sms_suppression_list read with this endpoint.
 */
export async function POST(request) {
  const auth = requireOpsDashboardAuth(request);
  if (!auth.authorized) return auth.response;

  let phone;
  try {
    ({ phone } = await request.json());
  } catch {
    return NextResponse.json({ suppressed: false, reason: null }, { status: 200 });
  }

  if (!phone) {
    return NextResponse.json({ suppressed: false, reason: null }, { status: 200 });
  }

  try {
    const gate = await canSend({ to_phone_number: phone }, {});
    if (!gate.ok && gate.reason === "phone_suppressed") {
      logger.info("suppression_check.suppressed", { phone });
      return NextResponse.json({ suppressed: true, reason: "suppression_list" }, { status: 200 });
    }
    return NextResponse.json({ suppressed: false, reason: null }, { status: 200 });
  } catch (error) {
    logger.warn("suppression_check.degraded", { message: error?.message });
    return NextResponse.json(
      { suppressed: false, reason: null, degraded: true },
      { status: 200 }
    );
  }
}
