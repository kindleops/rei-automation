// ─── resolve-canonical-inbound-thread.js ─────────────────────────────────────
// Ensures inbound traffic always attaches to the active E.164 thread key and
// never creates new activity on archived non-E.164 aliases (e.g. 6128072000
// after replaced_by_thread_key = +16128072000).

import { normalizeUsPhoneToE164 } from "@/lib/sms/sanitize.js";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Resolve the canonical E.164 thread key for an inbound From number.
 *
 * Precedence:
 *  1. Normalize to E.164
 *  2. Prefer active (non-archived) inbox_thread_state for that E.164 key
 *  3. If only an archived alias exists with replaced_by_thread_key, use that
 *  4. Never return a bare 10-digit form when E.164 is available
 *
 * @returns {{ thread_key: string, normalized_e164: string|null, resolved_from: string, alias_redirected: boolean }}
 */
export function resolveCanonicalInboundThreadKey({
  inbound_from = null,
  threads = [],
} = {}) {
  const raw = clean(inbound_from);
  const e164 = normalizeUsPhoneToE164(raw) || null;
  const digits = raw.replace(/\D/g, "");
  const bare10 =
    digits.length === 10
      ? digits
      : digits.length === 11 && digits.startsWith("1")
        ? digits.slice(1)
        : null;

  const preferred = e164 || (bare10 ? `+1${bare10}` : raw) || null;
  if (!preferred) {
    return {
      thread_key: null,
      normalized_e164: null,
      resolved_from: "missing",
      alias_redirected: false,
    };
  }

  const list = Array.isArray(threads) ? threads : [];
  const byKey = new Map(list.map((t) => [clean(t.thread_key), t]));

  // Active E.164 thread wins
  const activeE164 = byKey.get(preferred);
  if (activeE164 && activeE164.is_archived !== true) {
    return {
      thread_key: preferred,
      normalized_e164: preferred.startsWith("+") ? preferred : e164,
      resolved_from: "active_e164_thread",
      alias_redirected: false,
    };
  }

  // Archived alias with redirect
  const alias =
    (bare10 && byKey.get(bare10)) ||
    byKey.get(raw) ||
    (activeE164?.is_archived === true ? activeE164 : null);

  if (alias) {
    const replaced = clean(
      alias.metadata?.replaced_by_thread_key || alias.replaced_by_thread_key
    );
    if (replaced) {
      return {
        thread_key: replaced,
        normalized_e164: normalizeUsPhoneToE164(replaced) || preferred,
        resolved_from: "archived_alias_redirect",
        alias_redirected: true,
        retired_alias: clean(alias.thread_key),
      };
    }
    if (alias.is_archived === true) {
      // Archived without redirect: still force E.164 so we never attribute to bare alias
      return {
        thread_key: preferred,
        normalized_e164: preferred,
        resolved_from: "archived_alias_forced_e164",
        alias_redirected: true,
        retired_alias: clean(alias.thread_key),
      };
    }
  }

  return {
    thread_key: preferred,
    normalized_e164: preferred.startsWith("+") ? preferred : e164,
    resolved_from: "normalized_e164_default",
    alias_redirected: false,
  };
}

export default resolveCanonicalInboundThreadKey;
