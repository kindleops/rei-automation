export function degradedLiveResponse({
  timeoutMode,
  error,
  reason,
  dataMode,
  countsSource,
}) {
  return {
    ok: true,
    degraded: true,
    dataMode,
    timeoutMode,
    error,
    threads: [],
    messages: [],
    counts: {},
    countsDegraded: true,
    countsApproximate: false,
    diagnostics: {
      source: null,
      live_source: null,
      countsSource,
      countsDegraded: true,
      countsApproximate: false,
      count_preserved_reason: reason,
      refresh_skipped_reason: null,
    },
    mapPins: [],
    pagination: { limit: 0, returned: 0, has_more: false, next_cursor: null },
  };
}

export function degradedThreadMessagesPayload({
  error,
  thread_key,
  canonical_e164,
  offset,
  limit,
}) {
  const pagination = {
    offset,
    limit,
    total: 0,
    has_more: false,
    next_offset: null,
  };
  const message = error?.message || "Unknown thread messages error";
  return {
    ok: true,
    action: "thread-messages",
    degraded: true,
    error: "thread_messages_degraded",
    message,
    thread_key,
    messages: [],
    pagination,
    diagnostics: {
      thread_key,
      canonical_e164: canonical_e164 || null,
      canonical_thread_key: thread_key,
      message_count: 0,
      degraded: true,
      error: message,
      messages: [],
      pagination,
    },
  };
}
