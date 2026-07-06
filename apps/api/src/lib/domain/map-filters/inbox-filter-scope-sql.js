/**
 * Build a static SQL boolean fragment for inbox_hydrated_scoped row matching.
 * Mirrors public.inbox_filter_apply_conditions() — values are parameterized.
 */

const ALLOWED_COLUMNS = new Set([
  "thread_key", "market", "city", "state", "zip", "property_type", "property_class",
  "owner_type_guess", "stage", "status", "ui_intent", "latest_direction", "best_language",
  "building_condition", "priority_bucket", "est_household_income", "net_asset_value",
  "occupation_group", "gender", "marital_status", "education_model", "occupation",
  "owner_priority_tier", "phone_carrier", "property_county_name", "market_region",
  "units_count", "total_bedrooms", "total_baths", "building_square_feet", "year_built",
  "effective_year_built", "estimated_value", "equity_percent", "equity_amount",
  "total_loan_balance", "total_loan_amt", "total_loan_payment", "tax_amt", "past_due_amount",
  "estimated_repair_cost", "ai_score", "final_acquisition_score", "deal_strength_score",
  "priority_score", "ownership_years", "prospect_age", "buying_power", "contactability_score",
  "financial_pressure_score", "urgency_score", "owner_priority_score", "portfolio_total_value",
  "portfolio_total_equity", "portfolio_total_loan_balance", "portfolio_total_units",
  "property_count", "message_count", "inbound_count", "outbound_count", "pending_queue_count",
  "cash_offer", "assd_total_value", "calculated_total_value", "sale_price", "lot_square_feet",
  "lot_acreage", "latest_message_at", "last_inbound_at", "last_outbound_at", "sale_date",
  "follow_up_at", "owner_display_name", "best_phone", "seller_phone", "property_address_full",
  "event_property_address", "is_read", "is_starred", "is_pinned", "is_archived", "is_suppressed",
  "property_tax_delinquent", "property_active_lien", "is_corporate_owner", "out_of_state_owner",
  "likely_owner", "likely_renting", "sms_eligible", "email_eligible", "prospect_best_email",
  "property_flags_text", "property_flags_json", "person_flags_text", "person_flags_json",
  "inbox_category",
]);

function quoteIdent(col) {
  if (!ALLOWED_COLUMNS.has(col)) {
    throw new Error(`inbox_filter_invalid_column:${col}`);
  }
  return `"${col}"`;
}

function addParam(ctx, value) {
  ctx.params.push(value);
  return `$${ctx.params.length}`;
}

function compileCondition(cond, ctx) {
  const op = String(cond?.op || "").trim();
  const col = String(cond?.column || "").trim();

  if (op === "inbox_category_eq") {
    const val = cond?.value;
    if (val == null || val === "") return null;
    const p = addParam(ctx, String(val));
    return `ih.inbox_category = ${p}`;
  }

  if (["eq", "gte", "lte", "gt", "ilike", "is", "not_is"].includes(op)) {
    if (!ALLOWED_COLUMNS.has(col)) return null;
    const ident = quoteIdent(col);
    const val = cond?.value;
    if (op === "is") return `ih.${ident} IS NULL`;
    if (op === "not_is") return `ih.${ident} IS NOT NULL`;
    if (val == null || val === "") return null;
    const p = addParam(ctx, val);
    if (op === "eq") return `ih.${ident} = ${p}`;
    if (op === "gte") return `ih.${ident} >= ${p}`;
    if (op === "lte") return `ih.${ident} <= ${p}`;
    if (op === "gt") return `ih.${ident} > ${p}`;
    if (op === "ilike") {
      const p2 = addParam(ctx, `%${String(val)}%`);
      return `ih.${ident} ILIKE ${p2}`;
    }
  }

  if (op === "or_ilike") {
    const cols = Array.isArray(cond?.columns) ? cond.columns : [];
    const val = cond?.value;
    if (!val) return null;
    const parts = [];
    for (const c of cols) {
      if (!ALLOWED_COLUMNS.has(c)) continue;
      const p = addParam(ctx, `%${String(val)}%`);
      parts.push(`ih.${quoteIdent(c)} ILIKE ${p}`);
    }
    return parts.length ? `(${parts.join(" OR ")})` : null;
  }

  if (op === "flag_any" || op === "flag_all" || op === "flag_exclude") {
    const cols = Array.isArray(cond?.columns) ? cond.columns : [];
    const vals = Array.isArray(cond?.values) ? cond.values.map(String).filter(Boolean) : [];
    if (!vals.length) return null;
    const activeCols = cols.filter((c) => ALLOWED_COLUMNS.has(c));
    if (!activeCols.length) return null;

    if (op === "flag_any") {
      const parts = [];
      for (const v of vals) {
        for (const c of activeCols) {
          const p = addParam(ctx, `%${v}%`);
          parts.push(`ih.${quoteIdent(c)} ILIKE ${p}`);
        }
      }
      return parts.length ? `(${parts.join(" OR ")})` : null;
    }

    if (op === "flag_all") {
      const andParts = [];
      for (const v of vals) {
        const orParts = [];
        for (const c of activeCols) {
          const p = addParam(ctx, `%${v}%`);
          orParts.push(`ih.${quoteIdent(c)} ILIKE ${p}`);
        }
        if (orParts.length) andParts.push(`(${orParts.join(" OR ")})`);
      }
      return andParts.length ? andParts.join(" AND ") : null;
    }

    const excludeParts = [];
    for (const v of vals) {
      for (const c of activeCols) {
        const p = addParam(ctx, `%${v}%`);
        excludeParts.push(`ih.${quoteIdent(c)} NOT ILIKE ${p}`);
      }
    }
    return excludeParts.length ? excludeParts.join(" AND ") : null;
  }

  return null;
}

/**
 * @param {unknown[]} conditions
 * @param {{ params?: unknown[], paramOffset?: number }} [options]
 * @returns {{ sql: string, params: unknown[] }}
 */
export function buildInboxScopeExistsSql(conditions, options = {}) {
  const ctx = { params: [...(options.params || [])], paramOffset: options.paramOffset || 0 };
  const parts = [];
  for (const cond of conditions || []) {
    const fragment = compileCondition(cond, ctx);
    if (fragment) parts.push(fragment);
  }
  const where = parts.length ? parts.join(" AND ") : "TRUE";
  const sql = `EXISTS (
    SELECT 1 FROM inbox_hydrated_scoped ih
    WHERE ih.property_id = ${options.propertyAlias || "p"}.property_id::text
      AND (${where})
  )`;
  return { sql, params: ctx.params };
}