/**
 * apply-bulk-schedule-result.ts
 *
 * Turns a bulk-schedule server response into the Inbox's next state.
 *
 * WHY THIS IS NOT DONE OPTIMISTICALLY
 *   Tapping Schedule is a request, not an outcome. Only the server knows
 *   whether a canonical send_queue row was actually created -- routing can fail
 *   to resolve a sender, a contact window can refuse the requested time, a
 *   containment brake can decline. If the Inbox moved threads on tap, a refused
 *   recipient would silently vanish from the actionable list and the operator
 *   would believe a follow-up existed that does not. So a thread moves ONLY on
 *   a per-recipient success, and everything else stays exactly where it was,
 *   carrying its real failure reason.
 *
 *   13 selected, 11 scheduled, 2 refused => 11 move, 2 remain reviewable.
 */

export interface BulkScheduleRecipientResult {
  thread_key: string | null
  ok?: boolean
  reason?: string | null
  skipped?: boolean
  effective_send_at_utc?: string | null
  effective_local_label?: string | null
}

/**
 * `results` is typed as unknown[] on purpose. This is a network payload, and
 * asserting a shape it might not have is how a malformed entry turns into a
 * silently "scheduled" thread. Each entry is narrowed below instead.
 */
export interface BulkScheduleResponse {
  ok?: boolean
  scheduled_count?: number
  failed_count?: number
  blocked_reason?: string | null
  results?: unknown[]
}

export interface BulkScheduleOutcome {
  /** Threads confirmed scheduled by the server; safe to move to Scheduled. */
  scheduledThreadKeys: string[]
  /** Threads that did NOT schedule; they stay actionable, with a reason. */
  needsReviewThreadKeys: string[]
  /** thread_key -> operator-facing failure reason. */
  failureReasonByThreadKey: Record<string, string>
  /**
   * Field patches for the confirmed threads, mirroring what the server will
   * report on the next read. Applying them lets the list recompose immediately
   * without a refetch, and without inventing a time: the instant comes from the
   * server's own effective_send_at_utc.
   */
  patchByThreadKey: Record<string, {
    is_schedule_suppressed: true
    next_scheduled_send_at_utc: string | null
  }>
  /** "11 follow-ups scheduled · 2 need review" */
  summary: string
}

const clean = (value: unknown): string => String(value ?? '').trim()

export function applyBulkScheduleResult(response: BulkScheduleResponse | null | undefined): BulkScheduleOutcome {
  const rawResults: unknown[] = Array.isArray(response?.results) ? response!.results! : []
  const results: BulkScheduleRecipientResult[] = rawResults
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      thread_key: typeof entry.thread_key === 'string' ? entry.thread_key : null,
      ok: entry.ok === true,
      reason: typeof entry.reason === 'string' ? entry.reason : null,
      skipped: entry.skipped === true,
      effective_send_at_utc:
        typeof entry.effective_send_at_utc === 'string' ? entry.effective_send_at_utc : null,
      effective_local_label:
        typeof entry.effective_local_label === 'string' ? entry.effective_local_label : null,
    }))

  const scheduledThreadKeys: string[] = []
  const needsReviewThreadKeys: string[] = []
  const failureReasonByThreadKey: Record<string, string> = {}
  const patchByThreadKey: BulkScheduleOutcome['patchByThreadKey'] = {}

  for (const result of results) {
    const threadKey = clean(result?.thread_key)
    if (!threadKey) continue

    // Strictly `=== true`. A missing/undefined ok is NOT a success, and
    // treating it as one is precisely how a refused recipient would disappear.
    if (result?.ok === true) {
      scheduledThreadKeys.push(threadKey)
      patchByThreadKey[threadKey] = {
        is_schedule_suppressed: true,
        next_scheduled_send_at_utc: clean(result.effective_send_at_utc) || null,
      }
      continue
    }

    needsReviewThreadKeys.push(threadKey)
    failureReasonByThreadKey[threadKey] = clean(result?.reason) || 'needs_review'
  }

  const scheduled = scheduledThreadKeys.length
  const review = needsReviewThreadKeys.length
  const parts: string[] = []
  if (scheduled > 0) parts.push(`${scheduled} follow-up${scheduled === 1 ? '' : 's'} scheduled`)
  if (review > 0) parts.push(`${review} need${review === 1 ? 's' : ''} review`)

  return {
    scheduledThreadKeys,
    needsReviewThreadKeys,
    failureReasonByThreadKey,
    patchByThreadKey,
    summary: parts.join(' · ') || 'Nothing scheduled',
  }
}
