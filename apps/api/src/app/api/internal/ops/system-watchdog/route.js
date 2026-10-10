// 24/7 system watchdog (owner P0 2026-10-10). READ-ONLY: one snapshot query,
// pure rules, alerts through the launch-safety alert path. Never sends a
// seller message, never writes business state.
// Flag SYSTEM_WATCHDOG_MODE = off (default) | observe | alert.
// Auth: internal secret / cron, same contract as the other internal scanners.
// Schedule: call every 5 minutes from the existing cron (*/5) once the flag is on.

import { NextResponse } from "next/server";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import { getSystemValue } from "@/lib/system-control.js";
import { runSystemWatchdog } from "@/lib/domain/ops/system-watchdog.js";

export const dynamic = "force-dynamic";

const LIVE_QUEUE_MODES = new Set(["live", "live_limited", "full_live"]);

export async function readOutboundEnabled() {
  const mode = String((await getSystemValue("queue_processor_mode")) ?? "").trim().toLowerCase();
  if (!mode) return null;
  return LIVE_QUEUE_MODES.has(mode);
}

export async function handleSystemWatchdogRequest(request, deps = {}) {
  const auth = (deps.requireInternalSecret || requireInternalSecret)(request);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const result = await (deps.runSystemWatchdog || runSystemWatchdog)({ readOutboundEnabled: deps.readOutboundEnabled || readOutboundEnabled });
  return NextResponse.json(result, { status: 200 });
}

export async function GET(request) {
  return handleSystemWatchdogRequest(request);
}
