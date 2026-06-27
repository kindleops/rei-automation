/**
 * Chainable PostgREST-style supabase mock for critical tests.
 * Supports .select().eq().in().lt().order().range().limit().maybeSingle() and `.then`.
 */
export function makeTerminalQuery({ data = null, error = null, count = null } = {}) {
  const result = { data, error, count };
  const terminal = {
    maybeSingle: async () => ({ data, error }),
    single: async () => ({ data, error }),
    limit: () => terminal,
    order: () => terminal,
    range: () => terminal,
    lt: () => terminal,
    lte: () => terminal,
    gt: () => terminal,
    gte: () => terminal,
    in: () => terminal,
    eq: () => terminal,
    not: () => terminal,
    or: () => terminal,
    contains: () => terminal,
    abortSignal: () => terminal,
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return terminal;
}

export function makeChainableSupabase(handlers = {}) {
  return {
    from(table) {
      if (typeof handlers[table] === "function") {
        return handlers[table]();
      }
      if (handlers[table]) {
        return handlers[table];
      }
      return {
        select: () => makeTerminalQuery({ data: [], error: null }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: "mock-insert" }, error: null }),
          }),
        }),
        update: () => ({
          eq: () => ({
            lt: () => ({
              select: async () => ({ data: [], error: null }),
            }),
            select: async () => ({ data: [], error: null }),
          }),
          select: async () => ({ data: [], error: null }),
        }),
      };
    },
  };
}

/** Default inbound webhook deps — avoids live Supabase via sms-engine second pass. */
export function makeInboundWebhookBaseDeps(overrides = {}) {
  return {
    logInboundMessageEventSupabase: async () => ({ ok: true, id: "evt-mock-1" }),
    getSupabaseClient: () => makeInboundLifecycleSupabase(),
    getSystemFlags: async () => ({
      auto_reply_enabled: true,
      followup_enabled: false,
      outbound_sms_enabled: true,
    }),
    getSystemValue: async (key) => (key === "auto_reply_mode" ? "live_limited" : null),
    resolveSellerAutoReplyPlan: async () => ({
      handled: true,
      should_queue_reply: true,
      selected_use_case: "ownership_check",
      detected_intent: "Ownership Confirmed",
      brain_stage: "ownership_check",
    }),
    executeInboundAutomationDecision: async () => ({
      ok: true,
      queued: true,
      queue_row_id: "queue-mock-1",
      seller_stage_reply: {
        ok: true,
        handled: true,
        queued: true,
        preview_result: { rendered_message_text: "Suggested review reply" },
        queue_result: { rendered_message_text: "Suggested review reply" },
        plan: { selected_use_case: "ownership_check", detected_intent: "Ownership Confirmed" },
      },
    }),
    runInboundIntelligencePhase: async (args = {}) => {
      const legacy = args.legacy_plan || {};
      const canonical_intent =
        legacy.inbound_intent || legacy.detected_intent || args.classification?.primary_intent || "unclear";
      const snapshot = {
        decision_version: "inbound_intelligence_v2_shadow",
        canonical_intent,
        universal_stage: args.route?.stage || args.context?.summary?.conversation_stage || null,
        granular_stage: legacy.selected_use_case || null,
        safety_status: legacy.safety_tier === "suppress" ? "suppressed" : "allowed",
        automation_execution_status: args.execution_allowed ? "execution_eligible" : "shadow_only",
        execution_blocked_reason: args.execution_allowed ? null : "auto_reply_mode_disabled",
        canonical_decision: {
          should_queue_reply: Boolean(legacy.should_queue_reply),
          should_mark_human_review: false,
          route_hint: legacy.selected_use_case || null,
        },
        follow_up_recommendation: { shadow_only: true, dispatchable: false },
        referral_detected: false,
        source_thread_key: args.threadKey || null,
      };
      return {
        ok: true,
        intelligence_snapshot: snapshot,
        seller_stage_reply: {
          ok: true,
          queued: false,
          handled: true,
          reason: snapshot.execution_blocked_reason || "intelligence_only",
          plan: legacy,
          brain_stage: legacy.selected_use_case || null,
          intelligence_snapshot: snapshot,
        },
      };
    },
    persistInboundIntelligenceSnapshot: async () => ({ ok: true, dry_run: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    ...overrides,
  };
}

function cleanInboxValue(value) {
  return String(value ?? "").trim();
}

function asInboxTime(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/** Map live inbox thread rows to authoritative inbox_thread_state rows. */
export function deriveInboxThreadStateRows(threadRows = []) {
  return threadRows.map((row) => {
    const threadKey = cleanInboxValue(row.thread_key || row.canonical_thread_key || row.canonical_e164);
    const direction = cleanInboxValue(row.latest_message_direction || row.direction).toLowerCase();
    const bucket = cleanInboxValue(row.inbox_bucket).toLowerCase();
    const latestAt = row.latest_message_at || row.last_message_at || null;
    return {
      thread_key: threadKey,
      inbox_bucket: bucket,
      automation_lane: row.automation_lane || (bucket === "cold" ? "cold_reactivation" : null),
      property_id: row.property_id ?? null,
      latest_message_direction: direction || null,
      last_outbound_at: direction === "outbound" ? latestAt : row.last_outbound_at || null,
      last_inbound_at: direction === "inbound" ? latestAt : row.last_inbound_at || null,
    };
  }).filter((row) => row.thread_key);
}

export function buildInboxCountRowFromThreads(threadRows = []) {
  const byBucket = (bucket) => threadRows.filter((row) => cleanInboxValue(row.inbox_bucket) === bucket).length;
  const waiting = threadRows.filter((row) => {
    const direction = cleanInboxValue(row.latest_message_direction || row.direction).toLowerCase();
    const bucket = cleanInboxValue(row.inbox_bucket);
    return direction === "outbound" && !["dead", "suppressed"].includes(bucket);
  }).length;
  return {
    all: threadRows.length,
    all_messages: threadRows.length,
    priority: byBucket("priority"),
    hot_leads: byBucket("priority"),
    new_replies: byBucket("new_replies"),
    new_inbound: byBucket("new_replies"),
    needs_reply: byBucket("new_replies"),
    needs_review: byBucket("needs_review"),
    manual_review: byBucket("needs_review"),
    automated: byBucket("needs_review"),
    follow_up: byBucket("follow_up"),
    outbound_active: byBucket("follow_up"),
    cold: byBucket("cold"),
    cold_no_response: byBucket("cold"),
    dead: byBucket("dead"),
    suppressed: byBucket("suppressed"),
    dnc_opt_out: byBucket("suppressed"),
    active: threadRows.filter((row) => ["priority", "new_replies", "needs_review", "follow_up"].includes(cleanInboxValue(row.inbox_bucket))).length,
    waiting,
    waiting_on_seller: waiting,
    unlinked: threadRows.filter((row) => row.property_id == null).length,
  };
}

/**
 * Chainable supabase stub for live inbox tests that query inbox_thread_state
 * for authoritative bucket filters and counts.
 */
function rowMatchesOrClause(row = {}, clause = "") {
  const text = String(clause || "").trim();
  if (!text) return true;

  const matchesEntry = (entry) => {
    const trimmed = String(entry || "").trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("and(") && trimmed.endsWith(")")) {
      const inner = trimmed.slice(4, -1);
      return inner.split(",").every((part) => matchesEntry(part));
    }
    const [column, operator, ...rest] = trimmed.split(".");
    const value = rest.join(".");
    if (operator === "eq") return cleanInboxValue(row?.[column]) === cleanInboxValue(value);
    if (operator === "neq") return cleanInboxValue(row?.[column]) !== cleanInboxValue(value);
    if (operator === "lt") return asInboxTime(row?.[column]) < asInboxTime(value);
    return false;
  };

  return text.split(",").some((entry) => matchesEntry(entry));
}

export function makeLiveInboxThreadSupabase(threadRows = [], options = {}) {
  const stateRows = options.stateRows || deriveInboxThreadStateRows(threadRows);
  const countRows = options.countRows || [buildInboxCountRowFromThreads(threadRows)];

  function rowsForTable(table) {
    if (table === "inbox_thread_state") return [...stateRows];
    if (table === "canonical_inbox_threads" || table === "v_inbox_threads_live_v2" || table === "inbox_threads_view") {
      return [...threadRows];
    }
    if (table === "canonical_inbox_counts" || table === "v_inbox_thread_counts_live_v2") {
      return [...countRows];
    }
    if (table === "message_events" || table === "send_queue") return [];
    return [];
  }

  return {
    threadRows,
    stateRows,
    from(table) {
      const queryState = {
        table,
        filters: [],
        orClause: null,
        orders: [],
        range: null,
        limit: null,
        headCount: false,
        updatePatch: null,
        updateEq: null,
      };

      const api = {
        select(_columns, options = {}) {
          queryState.headCount = options.count === "exact" && options.head === true;
          return api;
        },
        eq(column, value) {
          if (queryState.updatePatch) {
            queryState.updateEq = { column, value };
            return api;
          }
          queryState.filters.push((row) => cleanInboxValue(row?.[column]) === cleanInboxValue(value));
          return api;
        },
        in(column, values = []) {
          const allowed = new Set((values || []).map(cleanInboxValue));
          queryState.filters.push((row) => allowed.has(cleanInboxValue(row?.[column])));
          return api;
        },
        lt(column, value) {
          queryState.filters.push((row) => asInboxTime(row?.[column]) < asInboxTime(value));
          return api;
        },
        not(column, operator, value) {
          if (operator === "is" && value === null) {
            queryState.filters.push((row) => row?.[column] != null && cleanInboxValue(row?.[column]) !== "");
            return api;
          }
          if (operator === "in" && column === "inbox_bucket") {
            const blocked = new Set(
              String(value || "")
                .replace(/[()]/g, "")
                .split(",")
                .map((entry) => cleanInboxValue(entry))
                .filter(Boolean),
            );
            queryState.filters.push((row) => !blocked.has(cleanInboxValue(row?.[column])));
          }
          return api;
        },
        neq(column, value) {
          queryState.filters.push((row) => cleanInboxValue(row?.[column]) !== cleanInboxValue(value));
          return api;
        },
        is(column, value) {
          if (value === null) {
            queryState.filters.push((row) => row?.[column] == null);
          }
          return api;
        },
        or(clause) {
          queryState.orClause = clause;
          return api;
        },
        order(column, options = {}) {
          queryState.orders.push({ column, ascending: options.ascending !== false });
          return api;
        },
        range(start, end) {
          queryState.range = [start, end];
          return api;
        },
        limit(value) {
          queryState.limit = value;
          return api;
        },
        update(patch) {
          queryState.updatePatch = patch;
          return api;
        },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (queryState.updatePatch) {
              return { data: [], error: null };
            }

            let data = rowsForTable(queryState.table);
            for (const filter of queryState.filters) {
              data = data.filter((row) => filter(row));
            }
            if (queryState.orClause) {
              data = data.filter((row) => rowMatchesOrClause(row, queryState.orClause));
            }

            data.sort((left, right) => {
              for (const order of queryState.orders) {
                const leftValue = order.column.includes("_at")
                  ? asInboxTime(left?.[order.column])
                  : cleanInboxValue(left?.[order.column]);
                const rightValue = order.column.includes("_at")
                  ? asInboxTime(right?.[order.column])
                  : cleanInboxValue(right?.[order.column]);
                if (leftValue === rightValue) continue;
                if (typeof leftValue === "number" && typeof rightValue === "number") {
                  return order.ascending ? leftValue - rightValue : rightValue - leftValue;
                }
                return order.ascending
                  ? String(leftValue).localeCompare(String(rightValue))
                  : String(rightValue).localeCompare(String(leftValue));
              }
              return 0;
            });

            const count = queryState.headCount ? data.length : data.length;
            if (queryState.range) {
              data = data.slice(queryState.range[0], queryState.range[1] + 1);
            } else if (typeof queryState.limit === "number") {
              data = data.slice(0, queryState.limit);
            }

            if (queryState.headCount && queryState.table === "inbox_thread_state") {
              return {
                data: null,
                count: null,
                error: { message: "authoritative inbox_thread_state counts unavailable" },
              };
            }

            if (queryState.headCount) {
              return { data: null, count, error: null };
            }

            return { data, count, error: null };
          }).then(resolve, reject);
        },
      };

      return api;
    },
  };
}

export function makeInboundLifecycleSupabase() {
  return makeChainableSupabase({
    message_events: {
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: "evt-1" }, error: null }),
        }),
      }),
      select: () => makeTerminalQuery({ data: [], error: null }),
    },
    send_queue: {
      select: () => makeTerminalQuery({ data: null, error: null }),
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: "queue-1" }, error: null }),
        }),
      }),
    },
    inbound_autopilot_queue: {
      select: () => makeTerminalQuery({ data: null, error: null }),
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: "autopilot-1" }, error: null }),
        }),
      }),
      update: () => ({
        eq: () => makeTerminalQuery({ data: [{ id: "autopilot-1" }], error: null }),
      }),
    },
  });
}