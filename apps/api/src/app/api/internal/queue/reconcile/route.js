import { handleQueueReconcileRequest } from "@/lib/domain/queue/queue-reconcile-request.js";
import { child } from "@/lib/logging/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({
  module: "api.internal.queue.reconcile",
});

export async function GET(request) {
  return handleQueueReconcileRequest(request, "GET", { logger });
}

export async function POST(request) {
  return handleQueueReconcileRequest(request, "POST", { logger });
}