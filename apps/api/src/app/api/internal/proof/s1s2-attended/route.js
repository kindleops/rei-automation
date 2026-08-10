// TEMPORARY proof-only route: one attended internal S1→S2 canary.
// All credential-bearing work runs here in the deployed runtime; secrets are
// never returned or logged. Deny-by-default; recipient is code-pinned.
import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { setSystemValues } from "@/lib/system-control.js";
import { SYSTEM_CONTROL_AUTHORITIES } from "@/lib/domain/queue/operator-brake-authority.js";
import { insertSupabaseSendQueueRow } from "@/lib/supabase/sms-engine.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { findRecentOutboundContextPair } from "@/lib/domain/context/find-recent-outbound-pair.js";
import {
  evaluateProofGate,
  runArmAndS1,
  runVerifyAndS2,
  runAbort,
} from "@/lib/domain/proof/s1s2-attended-proof.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.internal.proof.s1s2-attended" });

function headerBag(request) {
  const h = {};
  try { for (const [k, v] of request.headers.entries()) h[k.toLowerCase()] = v; } catch {}
  return h;
}

export async function POST(request) {
  const headers = headerBag(request);
  const gate = evaluateProofGate({
    env: process.env,
    headers,
    deployedSha: process.env.DEPLOY_GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null,
  });
  if (!gate.ok) {
    // Log only the reason category — never the provided/expected secret.
    logger.warn("proof.gate_denied", { reason: gate.reason });
    return NextResponse.json({ ok: false, error: gate.reason }, { status: gate.status });
  }

  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || "").toLowerCase();

  const supabase = getDefaultSupabaseClient();
  const deps = {
    supabase,
    setSystemValues,
    operatorOpts: { authority: SYSTEM_CONTROL_AUTHORITIES.OPERATOR, supabase },
    insertSendQueueRow: (payload) => insertSupabaseSendQueueRow(payload, { supabase }),
    fetchQueueRow: async (id) => {
      const { data } = await supabase.from("send_queue").select("*").eq("id", id).maybeSingle();
      return data || null;
    },
    dispatchQueueRow: (row) => processSendQueueItem(row, { supabase }),
    classify,
    findRecentOutboundContextPair,
  };

  try {
    let result;
    if (action === "arm_and_s1") result = await runArmAndS1(deps);
    else if (action === "verify_and_s2") result = await runVerifyAndS2(deps, { nonce: body?.nonce });
    else if (action === "abort") result = await runAbort(deps);
    else return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });

    const { status = result.ok ? 200 : 500, ...payload } = result;
    return NextResponse.json(payload, { status });
  } catch (err) {
    logger.error("proof.unhandled", { message: err?.message || "error" });
    // Best-effort containment on an unexpected throw.
    try { await runAbort(deps); } catch {}
    return NextResponse.json({ ok: false, error: "proof_unhandled_error" }, { status: 500 });
  }
}
