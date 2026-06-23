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