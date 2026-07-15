/**
 * Reusable Supabase layers for compliance send-time tests.
 * Defaults to healthy contactability unless explicitly overridden.
 */

function makeChainableQuery(terminal = async () => ({ data: [], error: null, count: 0 })) {
  const chain = {
    select() {
      return chain;
    },
    eq() {
      return chain;
    },
    in() {
      return chain;
    },
    or() {
      return chain;
    },
    gte() {
      return chain;
    },
    gt() {
      return chain;
    },
    order() {
      return chain;
    },
    ilike() {
      return chain;
    },
    contains() {
      return chain;
    },
    not() {
      return chain;
    },
    limit: terminal,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then(resolve, reject) {
      return terminal().then(resolve, reject);
    },
  };
  return chain;
}

export function extendSupabaseForHealthyCompliance(base = {}, options = {}) {
  const suppressed = options.suppressed === true;
  const thread_state = options.thread_state ?? { status: "active", metadata: {}, contactability_status: "contactable" };
  const message_events = options.message_events ?? [];

  const wrapFrom = (table, innerFrom) => {
    if (table === "sms_suppression_list") {
      return {
        select: () => ({
          eq: () => ({
            or: () => ({
              eq: () => ({
                limit: async () => ({
                  data: suppressed
                    ? [{ id: "sup-1", suppression_reason: "opt_out", is_active: true }]
                    : [],
                  error: null,
                  count: suppressed ? 1 : 0,
                }),
              }),
            }),
          }),
          or: () => ({
            eq: () => ({
              limit: async () => ({
                data: suppressed
                  ? [{ id: "sup-1", suppression_reason: "opt_out", is_active: true }]
                  : [],
                error: null,
                count: suppressed ? 1 : 0,
              }),
            }),
          }),
        }),
      };
    }

    if (table === "inbox_thread_state") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: thread_state, error: null }),
          }),
        }),
      };
    }

    if (table === "deal_thread_state") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    }

    if (table === "message_events") {
      return {
        select: () => {
          const chain = {
            eq() {
              return chain;
            },
            gte() {
              return chain;
            },
            order() {
              return chain;
            },
            limit: async () => ({ data: message_events, error: null }),
          };
          return chain;
        },
      };
    }

    if (table === "phones") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    }

    if (typeof innerFrom === "function") {
      const delegated = innerFrom(table);
      if (delegated && typeof delegated === "object") {
        return delegated;
      }
    }

    return {
      select: () => makeChainableQuery(),
      update: () => makeChainableQuery(async () => ({ data: [], error: null })),
      insert: () => ({
        select: () => ({
          maybeSingle: async () => ({ data: {}, error: null }),
        }),
      }),
    };
  };

  const baseFrom = base.from?.bind(base);
  return {
    ...base,
    from(table) {
      return wrapFrom(table, baseFrom);
    },
  };
}

export function makeHealthySendTimeSupabase(overrides = {}) {
  return extendSupabaseForHealthyCompliance(overrides.base || { rpc: overrides.rpc }, overrides);
}