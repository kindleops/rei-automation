import { makeChainableSupabase, makeTerminalQuery } from "./chainable-supabase.mjs";

const CONSIDER_SELLING_TEMPLATE = {
  id: "tpl-consider-selling",
  template_id: "tpl-consider-selling",
  use_case: "consider_selling",
  stage_code: "consider_selling",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  reply_mode: "auto_reply",
  template_body:
    "Hi {{seller_first_name}}, are you open to selling {{property_address}}? Reply STOP to opt out.",
  property_type_scope: "any",
};

export function makeSellerOrchestrationSupabase({
  templates = [CONSIDER_SELLING_TEMPLATE],
  sendQueueRows = [],
  insertedQueueRows = [],
} = {}) {
  return makeChainableSupabase({
    sms_templates: {
      select: () => ({
        eq: () => ({
          eq: () => ({
            in: () => ({
              limit: () =>
                makeTerminalQuery({
                  data: templates,
                  error: null,
                }),
            }),
          }),
        }),
      }),
    },
    send_queue: {
      select: () => ({
        eq: () => ({
          in: () => ({
            limit: () =>
              makeTerminalQuery({
                data: sendQueueRows.filter((row) => row.source_event_id),
                error: null,
              }),
          }),
          eq: () => ({
            in: () => ({
              gte: () => ({
                limit: () =>
                  makeTerminalQuery({
                    data: sendQueueRows.filter((row) => row.type === "auto_reply"),
                    error: null,
                  }),
              }),
            }),
          }),
        }),
      }),
      insert: (row) => ({
        select: () => ({
          single: async () => {
            const inserted = {
              id: `queue-${insertedQueueRows.length + 1}`,
              ...row,
              queue_status: "queued",
            };
            insertedQueueRows.push(inserted);
            return { data: inserted, error: null };
          },
        }),
      }),
    },
    message_events: {
      select: () => makeTerminalQuery({ data: [], error: null }),
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: "evt-1" }, error: null }),
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
    },
    phones: {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    },
    phone_suppressions: {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    },
  });
}