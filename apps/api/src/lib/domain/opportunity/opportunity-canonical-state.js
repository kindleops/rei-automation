/**
 * Canonical workflow hydration for Pipeline rows.
 *
 * `acquisition_opportunities` keeps its own `acquisition_stage`,
 * `opportunity_status` and `temperature` columns, but those drift from the
 * canonical workflow state the Inbox and Seller Detail write to
 * `inbox_thread_state`. Measured on the 258 active opportunities:
 *
 *   stage        144 agree · 51 differ · 63 null on the canonical side
 *   temperature  243 of 258 have a value ONLY on the canonical side
 *                (the opportunity column is null on ~96% of all rows)
 *
 * Pipeline therefore has to read workflow state from `inbox_thread_state`,
 * joined on `primary_thread_key`, and fall back to the opportunity's own
 * columns only where canonical has nothing. Otherwise the board shows a stage
 * the operator already moved away from, and no temperature at all.
 *
 * `seller_display_name` is null on the opportunity rows too, which is why every
 * Pipeline card read "Unknown Seller"; the name is resolved here from the same
 * hydrated thread view the rest of the app uses.
 */

const THREAD_STATE_SELECT =
  'thread_key, lifecycle_stage, operational_status, lead_temperature, ' +
  'is_archived, is_starred, is_pinned, snoozed_until, manual_stage_lock, manual_temperature_lock';

const clean = (value) => String(value ?? '').trim();

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function loadByKeys(client, table, column, select, keys) {
  if (!keys.length) return [];
  const out = [];
  for (const group of chunk(keys, 200)) {
    const { data, error } = await client.from(table).select(select).in(column, group);
    if (error) {
      // Degrade rather than fail the board, but say so — a silent empty result
      // here is what would put "Unknown Seller" on every card.
      console.warn('[PIPELINE_CANONICAL_HYDRATION]', table, error.message);
      return out;
    }
    out.push(...(data ?? []));
  }
  return out;
}

/**
 * @returns rows with canonical workflow state applied, plus a
 *   `canonical_state_source` marker so the UI can tell what it is looking at.
 */
export async function hydrateCanonicalWorkflowState(client, rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const threadKeys = [...new Set(rows.map((r) => clean(r.primary_thread_key)).filter(Boolean))];
  const stateRows = await loadByKeys(client, 'inbox_thread_state', 'thread_key', THREAD_STATE_SELECT, threadKeys);
  const stateByKey = new Map(stateRows.map((r) => [clean(r.thread_key), r]));

  // Seller identity comes from `prospects` keyed by the thread's phone, NOT from
  // `inbox_threads_hydrated`. That view costs ~1.2s per call (193 columns, CTEs
  // over the whole thread set); using it here pushed the opportunities request
  // from 1.2s to 3.4s, which is what tripped the client abort and produced a
  // phantom empty board. `prospects` answers the same question in ~100ms.
  const nameRows = await loadByKeys(
    client,
    'prospects',
    'best_phone',
    'best_phone, full_name, first_name',
    threadKeys,
  );
  const nameByKey = new Map(nameRows.map((r) => [clean(r.best_phone), r]));

  return rows.map((row) => {
    const key = clean(row.primary_thread_key);
    const state = key ? stateByKey.get(key) : null;
    const names = key ? nameByKey.get(key) : null;

    const sellerName =
      clean(row.seller_display_name)
      || clean(names?.full_name)
      || clean(names?.first_name)
      || null;

    if (!state) {
      return {
        ...row,
        seller_display_name: sellerName,
        canonical_state_source: 'opportunity_only',
      };
    }

    const lifecycleStage = clean(state.lifecycle_stage) || null;
    const operationalStatus = clean(state.operational_status) || null;
    const leadTemperature = clean(state.lead_temperature) || null;

    // Canonical overlay. The row-count trace confirms hydration preserves both
    // count and identity (100 -> 100, ids intact); the earlier 258 -> 0 was a
    // frontend abort during cold compile, not this merge.
    //
    // Canonical wins for stage/temperature so the value shown on a card and the
    // value a filter matches on are the same one. Identity and deal fields are
    // never touched.
    return {
      ...row,
      seller_display_name: sellerName,
      acquisition_stage: lifecycleStage || row.acquisition_stage,
      temperature: leadTemperature || row.temperature,
      canonical_lifecycle_stage: lifecycleStage,
      canonical_operational_status: operationalStatus,
      canonical_lead_temperature: leadTemperature,
      canonical_is_archived: state.is_archived ?? false,
      canonical_is_starred: state.is_starred ?? false,
      canonical_is_pinned: state.is_pinned ?? false,
      canonical_snoozed_until: state.snoozed_until ?? null,
      canonical_manual_stage_lock: state.manual_stage_lock ?? false,
      canonical_manual_temperature_lock: state.manual_temperature_lock ?? false,
      canonical_stage_matches_opportunity: Boolean(lifecycleStage) && lifecycleStage === row.acquisition_stage,
      canonical_state_source: lifecycleStage ? 'inbox_thread_state' : 'opportunity_fallback',
    };
  });
}

export default { hydrateCanonicalWorkflowState };
