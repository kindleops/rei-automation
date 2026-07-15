import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { requireCronAuth } from "@/lib/security/cron-auth.js";
import { reconcileStaleInboxBuckets } from "@/lib/domain/inbox/reconcile-inbox-thread-state.js";
import { supabase } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.internal.maintenance.reconcile-inbox-buckets" });

async function handle(request) {
  const auth = requireCronAuth(request, logger);
  if (!auth.authorized) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const batchSize = Math.min(
      Math.max(Number(searchParams.get("batch_size") || 500), 1),
      1000,
    );

    const result = await reconcileStaleInboxBuckets(supabase, { batchSize });
    logger.info("reconcile_inbox_buckets.completed", {
      ...result,
      batch_size: batchSize,
      is_vercel_cron: auth.auth.is_vercel_cron,
    });

    return NextResponse.json(
      {
        ok: true,
        route: "internal/maintenance/reconcile-inbox-buckets",
        ...result,
      },
      { status: 200 },
    );
  } catch (error) {
    const message = error?.message || String(error);
    logger.error("reconcile_inbox_buckets.exception", { error: message });
    return NextResponse.json(
      { ok: false, error: "reconcile_inbox_buckets_exception", message },
      { status: 500 },
    );
  }
}

export async function GET(request) {
  return handle(request);
}

export async function POST(request) {
  return handle(request);
}