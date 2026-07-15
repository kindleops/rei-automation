import { normalizePhone } from "@/lib/utils/phones.js";

function clean(value) {
  return String(value ?? "").trim();
}

function quotePostgrestValue(value) {
  return `"${clean(value).replaceAll('"', '""')}"`;
}

/**
 * Flexible suppression lookup compatible with legacy canSend test mocks (count)
 * and production Supabase clients (row data via limit).
 */
export async function queryActiveSuppression(supabase, normalized_to) {
  if (!supabase || !normalized_to) {
    return { suppressed: false, rows: [], lookup_error: null };
  }

  const phone_filter = [
    `phone_number.eq.${quotePostgrestValue(normalized_to)}`,
    `phone_e164.eq.${quotePostgrestValue(normalized_to)}`,
  ].join(",");

  try {
    const base_query = supabase.from("sms_suppression_list").select("id,suppression_reason,suppression_type,is_active");
    let count = 0;
    let rows = [];

    if (typeof base_query.eq === "function") {
      const scoped = base_query.eq("is_active", true);
      if (typeof scoped.or === "function") {
        const filtered = scoped.or(phone_filter);
        const terminal =
          typeof filtered.eq === "function" ? filtered.eq("is_active", true) : filtered;
        if (typeof terminal.limit === "function") {
          const result = await Promise.resolve(terminal.limit(1));
          if (result?.error) throw result.error;
          if (Array.isArray(result?.data)) {
            rows = result.data;
            count = rows.length;
          } else {
            count = Number(result?.count ?? 0);
          }
        } else {
          const result = await Promise.resolve(terminal);
          if (result?.error) throw result.error;
          count = Number(result?.count ?? 0);
          if (Array.isArray(result?.data)) {
            rows = result.data;
            count = rows.length || count;
          }
        }
      }
    }

    if (count === 0 && rows.length === 0 && typeof base_query.or === "function") {
      const filtered = base_query.or(phone_filter);
      const terminal =
        typeof filtered.eq === "function" ? filtered.eq("is_active", true) : filtered;
      if (typeof terminal.limit === "function") {
        const result = await Promise.resolve(terminal.limit(1));
        if (Array.isArray(result?.data)) {
          rows = result.data;
          count = rows.length;
        } else {
          count = Number(result?.count ?? 0);
        }
      } else {
        const result = await Promise.resolve(terminal);
        count = Number(result?.count ?? 0);
        if (Array.isArray(result?.data)) {
          rows = result.data;
          count = rows.length || count;
        }
      }
    }

    return {
      suppressed: count > 0 || rows.length > 0,
      rows,
      lookup_error: null,
      suppression_reason: clean(rows[0]?.suppression_reason) || "phone_suppressed",
    };
  } catch (error) {
    return {
      suppressed: false,
      rows: [],
      lookup_error: error,
    };
  }
}

export function buildPhoneFilter(normalized_to) {
  const phone = normalizePhone(normalized_to) || clean(normalized_to);
  if (!phone) return "";
  return [
    `phone_number.eq.${quotePostgrestValue(phone)}`,
    `phone_e164.eq.${quotePostgrestValue(phone)}`,
  ].join(",");
}

export default queryActiveSuppression;