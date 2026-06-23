import { normalizeSendQueueRow, shouldRunSendQueueRow } from '@/lib/supabase/sms-engine.js'

export function buildSupabaseQueueRow(id, overrides = {}) {
  return normalizeSendQueueRow({
    id,
    queue_key: `queue-${id}`,
    queue_id: `queue-${id}`,
    queue_status: 'queued',
    scheduled_for: '2026-04-04T12:00:00.000Z',
    scheduled_for_utc: '2026-04-04T12:00:00.000Z',
    retry_count: 0,
    max_retries: 3,
    message_body: 'Hello John, test message body for queue run.',
    message_text: 'Hello John, test message body for queue run.',
    to_phone_number: '+15005550006',
    from_phone_number: '+15005550001',
    seller_first_name: 'John',
    template_id: '200194',
    master_owner_id: 'mo_test',
    touch_number: 1,
    metadata: {
      selected_template_id: '200194',
      candidate_snapshot: {
        master_owner_id: 'mo_test',
        property_id: 'prop_test',
        seller_first_name: 'John',
        phone_id: 'ph_test',
        best_phone_id: 'ph_test',
        touch_number: 1,
      },
    },
    ...overrides,
  })
}

export function makeRunnableRowsLoader(allRows = [], now = new Date().toISOString()) {
  return async (limit = 50, deps = {}) => {
    const evaluate = deps.shouldRunSendQueueRow
    const skipped = []
    const runnable = []

    for (const raw of allRows) {
      const row = normalizeSendQueueRow(raw)
      const decision = evaluate
        ? evaluate(row, deps.now || now)
        : shouldRunSendQueueRow(row, deps.now || now)

      if (!decision.ok) {
        skipped.push({
          id: row.id,
          reason: decision.reason,
          row,
        })
        continue
      }
      runnable.push(row)
      if (runnable.length >= limit) break
    }

    return {
      rows: runnable,
      raw_rows: allRows.map((r) => normalizeSendQueueRow(r)),
      skipped,
      now: deps.now || now,
      preclaim_outside_window_excluded_count: 0,
      preclaim_retry_pending_excluded_count: skipped.filter((s) => s.reason === 'next_retry_pending').length,
      preclaim_paused_name_missing_count: 0,
      preclaim_paused_invalid_count: 0,
      preclaim_paused_max_retries_count: 0,
      preclaim_scanned_count: allRows.length,
      skipped_invalid_phone_count: 0,
      skipped_missing_body_count: 0,
      eligible_claim_count: runnable.length,
      preclaim_scan_limit: Math.max(limit * 20, 250),
    }
  }
}

export function makeSelectSupabase(rows = []) {
  return {
    from() {
      const query = {
        select() { return query },
        in() { return query },
        not() { return query },
        order() { return query },
        limit() {
          return Promise.resolve({ data: rows, error: null })
        },
        update() {
          return {
            eq() {
              return {
                lt() {
                  return { select: async () => ({ data: [], error: null }) }
                },
                or() {
                  return {
                    eq() {
                      return {
                        lt() {
                          return { select: async () => ({ data: [], error: null }) }
                        },
                      }
                    },
                  }
                },
              }
            },
            or() {
              return {
                eq() {
                  return {
                    lt() {
                      return { select: async () => ({ data: [], error: null }) }
                    },
                  }
                },
              }
            },
          }
        },
      }
      return query
    },
  }
}

export function makeCampaignsSupabase(liveIds = []) {
  return {
    from(table) {
      if (table !== 'campaigns') {
        return {
          select() {
            return this
          },
          update() {
            return { eq() { return { lt() { return { select: async () => ({ data: [], error: null }) } } } } }
          },
        }
      }
      return {
        select() {
          return {
            in() {
              return Promise.resolve({
                data: liveIds.map((id) => ({ id, status: 'active' })),
                error: null,
              })
            },
          }
        },
        update() {
          return {
            eq() {
              return {
                lt() {
                  return { select: async () => ({ data: [], error: null }) }
                },
              }
            },
          }
        },
      }
    },
  }
}

export function makeLiveQueueSystemValue(overrides = {}) {
  const values = {
    queue_processor_mode: 'live',
    campaign_mode: 'live_limited',
    queue_hard_cap: '50',
    queue_max_batch_size: '50',
    queue_daily_send_cap: '100',
    queue_market_cap: '50',
    queue_per_number_cap: '25',
    queue_all_market_ack: 'true',
    queue_emergency_stop_at: '',
    ...overrides,
  }
  return async (key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null)
}

export function makeRunSendQueueDeps({
  rows = [],
  now = '2026-04-04T15:00:00.000Z',
  processResult = { ok: true, sent: true, provider_message_id: 'msg-ok' },
  processImpl = null,
  liveCampaignIds = [],
} = {}) {
  const info_calls = []
  const warn_calls = []
  const processed = []

  const deps = {
    getSystemFlag: async () => true,
    getSystemValue: async () => null,
    reconcileCanonicalQueueLifecycle: async () => ({ ok: true, reconciled: 0 }),
    loadRunnableSendQueueRows: makeRunnableRowsLoader(rows, now),
    supabaseClient: makeCampaignsSupabase(liveCampaignIds),
    processSendQueueItem: processImpl || (async (row) => {
      processed.push(row)
      return processResult
    }),
    info: (event, meta) => info_calls.push({ event, meta }),
    warn: (event, meta) => warn_calls.push({ event, meta }),
  }

  return { deps, info_calls, warn_calls, processed }
}