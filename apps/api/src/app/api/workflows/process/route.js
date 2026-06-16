import { NextResponse } from 'next/server.js';

import { corsHeaders, ensureMutationAuth } from '../../_shared.js';
import { processReadyEnrollments } from '@/lib/domain/workflow-v2/workflow-runner.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

// POST /api/workflows/process
// Runs all enrollments where status=active OR (status=waiting AND next_execution_at <= now()).
// Safe to call repeatedly — each enrollment is gated by its own due-time check.
// No cron integration yet; caller is responsible for scheduling.
export async function POST(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  let opts = {};
  try {
    const text = await request.text();
    if (text) opts = JSON.parse(text);
  } catch {
    // optional body — ignore parse errors
  }

  const limit = Math.min(Number(opts?.limit ?? 50), 200);

  try {
    const result = await processReadyEnrollments({ limit });
    return withCors(request, {
      ok: true,
      processed: result.processed,
      skipped: result.skipped,
      failed: result.failed,
      total: result.total,
      live_send_blocked: true,
      no_outbound_messages_sent: true,
      results: result.results,
    });
  } catch (error) {
    return withCors(
      request,
      { ok: false, error: 'wfv2_process_failed', message: error?.message ?? String(error) },
      500,
    );
  }
}
