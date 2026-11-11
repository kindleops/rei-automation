/**
 * system-control.js
 *
 * Runtime feature-flag helpers backed by the public.system_control Supabase table.
 * Every critical send path should call getSystemFlag() / requireSystemFlag() before
 * executing destructive work.
 *
 * Usage:
 *   import { requireSystemFlag } from '@/lib/system-control.js';
 *   await requireSystemFlag('outbound_sms_enabled', 'sms-send');
 *
 * getSystemFlag() returns true only when value is one of:
 * true, 1, yes, on, enabled (case-insensitive).
 */

import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { warn, info } from "@/lib/logging/logger.js";
import {
  stripOperatorOwnedSystemKeys,
  SYSTEM_CONTROL_AUTHORITIES,
} from "@/lib/domain/queue/operator-brake-authority.js";

const TABLE = "system_control";

// In-process cache so we don't hammer Supabase on every message send.
const CACHE_TTL_MS = 30_000; // 30 seconds

const _cache = new Map(); // key -> { value, expires_at }
const _value_cache = new Map(); // key -> { value, expires_at }
// Test-only primed values for kill-switch keys (see primeSystemControlValue).
// Kill switches never use _cache/_value_cache, so tests that prime them need
// a store the fresh path consults. Production never writes here.
const _primed_kill_switch_values = new Map(); // key -> value
const _primed_kill_switch_flags = new Map(); // key -> boolean

const TRUE_FLAG_VALUES = new Set(["true", "1", "yes", "on", "enabled"]);

function clean(value) {
  return String(value ?? "").trim();
}

// ── KILL SWITCHES: always fresh, and a failed read never reads as "clear" ────
//
// The 30s cache above is fine for tuning values, but it is wrong for the keys
// that STOP sends. Two defects (send-authorization audit, 2026-11-11):
//   1. STALE. setSystemValues invalidates the cache only in the lambda that did
//      the write; every other warm lambda served the pre-stop value for up to
//      30s, so an operator's stop was not seen there.
//   2. FAIL OPEN. getSystemValue swallowed every read error, returned null and
//      CACHED that null for 30s. For a brake, null means "clear", so a Supabase
//      error made an active emergency stop / global shutdown read as inactive,
//      and the authorities' own try/catch ("control_plane_unreadable") never
//      fired because nothing was ever thrown.
//
// Kill-switch keys are therefore never cached, and a failed read of a STOP key
// returns KILL_SWITCH_UNREADABLE, a non-clear marker every brake evaluator
// (isEmergencyStopActive) treats as ACTIVE. Mode keys return null on failure,
// which their consumers already normalize to the closed posture
// (queue_processor_mode -> off, queue_execution_mode -> stopped,
// manual_send_mode -> disabled, outbound_sms_enabled -> false).

/** Marker a failed STOP-key read resolves to. Not a clear marker, so it denies. */
export const KILL_SWITCH_UNREADABLE = "control_plane_unreadable";

/** Keys whose ACTIVE value stops sends: absence is "clear", so an unreadable read must be "active". */
export const STOP_KILL_SWITCH_KEYS = Object.freeze([
  "queue_emergency_stop_at",
  "global_send_shutdown_at",
]);

/** Every key read fresh (never cached). */
export const KILL_SWITCH_KEYS = Object.freeze([
  ...STOP_KILL_SWITCH_KEYS,
  "queue_processor_mode",
  "queue_execution_mode",
  "manual_send_mode",
  "outbound_sms_enabled",
]);

const KILL_SWITCH_KEY_SET = new Set(KILL_SWITCH_KEYS);
const STOP_KILL_SWITCH_KEY_SET = new Set(STOP_KILL_SWITCH_KEYS);

export function isKillSwitchKey(key) {
  return KILL_SWITCH_KEY_SET.has(clean(key));
}

function isProductionRuntime() {
  return (
    clean(process.env.VERCEL_ENV).toLowerCase() === "production" ||
    clean(process.env.NODE_ENV).toLowerCase() === "production"
  );
}

function killSwitchReadFailedValue(key) {
  return STOP_KILL_SWITCH_KEY_SET.has(key) ? KILL_SWITCH_UNREADABLE : null;
}

async function readKillSwitchValue(key, opts = {}) {
  if (_primed_kill_switch_values.has(key)) return _primed_kill_switch_values.get(key);
  const { supabase = defaultSupabase } = opts;
  if (!opts.supabase && !hasSupabaseConfig()) {
    // No control plane at all. Outside production (tests, local dev) this is
    // the historical "no opinion"; in production it is a read failure.
    return isProductionRuntime() ? killSwitchReadFailedValue(key) : null;
  }
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) {
      warn("system_control.kill_switch_read_failed", { key, message: error.message });
      return killSwitchReadFailedValue(key);
    }
    return data ? clean(data.value) : null;
  } catch (err) {
    warn("system_control.kill_switch_read_failed", { key, message: err?.message });
    return killSwitchReadFailedValue(key);
  }
}

function getCachedFlag(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires_at) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedFlag(key, value) {
  _cache.set(key, { value, expires_at: Date.now() + CACHE_TTL_MS });
}

function parseSystemControlValue(raw) {
  const normalized = clean(raw).toLowerCase();
  return TRUE_FLAG_VALUES.has(normalized);
}

/**
 * Fetch a single system_control flag from Supabase.
 *
 * @param {string} key - The flag key (e.g. "outbound_sms_enabled").
 * @param {{ failClosedOnError?: boolean, supabase?: object }} [opts]
 *   - failClosedOnError: when true, DB errors treat the flag as disabled (false).
 *     Defaults to false so a Supabase outage does not accidentally stop sends.
 * @returns {Promise<boolean>}
 */
export async function getSystemFlag(key, opts = {}) {
  const { supabase = defaultSupabase } = opts;
  const normalized_key = clean(key);

  if (KILL_SWITCH_KEY_SET.has(normalized_key)) {
    // Fresh every time; an unreadable or absent flag is disabled (false).
    if (_primed_kill_switch_flags.has(normalized_key)) return _primed_kill_switch_flags.get(normalized_key);
    return parseSystemControlValue(await readKillSwitchValue(normalized_key, opts));
  }

  const cached = getCachedFlag(normalized_key);
  if (cached !== null) return cached;

  if (!opts.supabase && !hasSupabaseConfig()) {
    setCachedFlag(normalized_key, false);
    return false;
  }

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("value")
      .eq("key", normalized_key)
      .maybeSingle();

    if (error) {
      warn("system_control.fetch_error", { key: normalized_key, message: error.message });
      setCachedFlag(normalized_key, false);
      return false;
    }

    if (!data) {
      setCachedFlag(normalized_key, false);
      return false;
    }

    const parsed = parseSystemControlValue(data.value);
    setCachedFlag(normalized_key, parsed);
    return parsed;
  } catch (err) {
    warn("system_control.unexpected_error", { key: normalized_key, message: err?.message });
    setCachedFlag(normalized_key, false);
    return false;
  }
}

function getCachedValue(key) {
  const entry = _value_cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires_at) {
    _value_cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCachedValue(key, value) {
  _value_cache.set(key, { value, expires_at: Date.now() + CACHE_TTL_MS });
}

export async function getSystemValue(key, opts = {}) {
  const { supabase = defaultSupabase } = opts;
  const normalized_key = clean(key);
  if (KILL_SWITCH_KEY_SET.has(normalized_key)) return readKillSwitchValue(normalized_key, opts);
  const cached = getCachedValue(normalized_key);
  if (cached !== undefined) return cached;

  if (!opts.supabase && !hasSupabaseConfig()) {
    setCachedValue(normalized_key, null);
    return null;
  }

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("value")
      .eq("key", normalized_key)
      .maybeSingle();
    if (error) {
      warn("system_control.fetch_value_error", { key: normalized_key, message: error.message });
      setCachedValue(normalized_key, null);
      return null;
    }
    const resolved = data ? clean(data.value) : null;
    setCachedValue(normalized_key, resolved);
    return resolved;
  } catch (err) {
    warn("system_control.fetch_value_unexpected_error", { key: normalized_key, message: err?.message });
    setCachedValue(normalized_key, null);
    return null;
  }
}

/**
 * Uncached read of a single system_control value.
 *
 * getSystemValue() memoizes for CACHE_TTL_MS. That is correct for hot-path
 * reads, but it is wrong for an authority that an operator flips immediately
 * before a bounded, attended dispatch: a value warmed seconds earlier is served
 * from cache and the operator's change is invisible until the TTL lapses.
 *
 * This reader queries the table every time and writes nothing to _value_cache,
 * so it can neither serve nor poison the cached path. Fails closed: any error,
 * missing row, or absent Supabase configuration returns null, which every
 * execution-mode consumer normalizes to the fail-closed posture.
 */
export async function getSystemValueFresh(key, opts = {}) {
  const { supabase = defaultSupabase } = opts;
  const normalized_key = clean(key);
  // A STOP key that cannot be read must not read as "clear" here either.
  if (KILL_SWITCH_KEY_SET.has(normalized_key)) return readKillSwitchValue(normalized_key, opts);
  if (!opts.supabase && !hasSupabaseConfig()) return null;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("value")
      .eq("key", normalized_key)
      .maybeSingle();
    if (error) {
      warn("system_control.fetch_value_fresh_error", { key: normalized_key, message: error.message });
      return null;
    }
    return data ? clean(data.value) : null;
  } catch (err) {
    warn("system_control.fetch_value_fresh_unexpected_error", {
      key: normalized_key,
      message: err?.message,
    });
    return null;
  }
}

/**
 * Write system_control values.
 *
 * Authority is RESTRICTIVE BY DEFAULT: a caller that does not declare an
 * authority cannot write operator-owned keys (the execution posture). Only the
 * explicit operator control plane passes SYSTEM_CONTROL_AUTHORITIES.OPERATOR.
 *
 * Note on failure direction: dropping an operator's stop would leave dispatch
 * armed, so a blocked write is NOT silent — it is logged at error level and
 * returned in `blocked_keys`, and every operator control-plane call site declares
 * OPERATOR authority explicitly (see app/api/cockpit/queue/control/route.js).
 *
 * @param {object} pairs key -> value
 * @param {{ supabase?: object, authority?: string, context?: string }} [opts]
 */
export async function setSystemValues(pairs = {}, opts = {}) {
  const { supabase = defaultSupabase } = opts;
  const authority = clean(opts.authority) || SYSTEM_CONTROL_AUTHORITIES.CAMPAIGN_AUTOMATION;

  let incoming = pairs;
  let blocked_keys = [];
  if (authority !== SYSTEM_CONTROL_AUTHORITIES.OPERATOR) {
    const filtered = stripOperatorOwnedSystemKeys(pairs);
    incoming = filtered.patch;
    blocked_keys = filtered.removed;
    if (blocked_keys.length > 0) {
      // Error, not warn: either an automation path tried to clobber a brake, or
      // an operator path forgot to declare OPERATOR authority. Both need eyes.
      warn("system_control.operator_owned_write_blocked", {
        authority,
        context: clean(opts.context) || "unknown",
        keys: blocked_keys,
      });
    }
  }

  const entries = Object.entries(incoming)
    .map(([key, value]) => ({ key: clean(key), value: clean(value) }))
    .filter((row) => row.key);
  if (entries.length === 0) return { ok: true, updated: 0, blocked_keys };

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(entries, { onConflict: "key" })
    .select("key,value,updated_at");
  if (error) {
    warn("system_control.set_values_error", { message: error.message, count: entries.length });
    return { ok: false, error, blocked_keys };
  }
  // Invalidate BOTH caches. _value_cache was previously left stale for up to
  // CACHE_TTL_MS, so an operator writing queue_execution_mode='stopped' was not
  // observed by the dispatch gate in a warm lambda for up to 30s.
  entries.forEach((row) => {
    _cache.delete(row.key);
    _value_cache.delete(row.key);
  });
  return { ok: true, updated: data?.length || 0, rows: data || [], blocked_keys };
}

/**
 * Fetch multiple flags in a single query.
 *
 * @param {string[]} keys
 * @param {{ failClosedOnError?: boolean, supabase?: object }} [opts]
 * @returns {Promise<Record<string, boolean>>}
 */
export async function getSystemFlags(keys, opts = {}) {
  const { supabase = defaultSupabase } = opts;
  const normalized_keys = keys.map(clean).filter(Boolean);
  if (!normalized_keys.length) return {};

  // Check cache first — only fetch missing keys.
  const result = {};
  const to_fetch = [];

  for (const key of normalized_keys) {
    if (KILL_SWITCH_KEY_SET.has(key)) {
      result[key] = await getSystemFlag(key, opts);
      continue;
    }
    const cached = getCachedFlag(key);
    if (cached !== null) {
      result[key] = cached;
    } else {
      to_fetch.push(key);
    }
  }

  if (!to_fetch.length) return result;

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("key, value")
      .in("key", to_fetch);

    if (error) {
      warn("system_control.fetch_multi_error", { message: error.message });
      for (const key of to_fetch) {
        result[key] = false;
        setCachedFlag(key, false);
      }
      return result;
    }

    const found = new Map((data ?? []).map((row) => [row.key, parseSystemControlValue(row.value)]));

    for (const key of to_fetch) {
      const parsed = found.has(key) ? found.get(key) : false;
      result[key] = parsed;
      setCachedFlag(key, parsed);
    }
  } catch (err) {
    warn("system_control.unexpected_multi_error", { message: err?.message });
    for (const key of to_fetch) {
      result[key] = false;
      setCachedFlag(key, false);
    }
  }

  return result;
}

/**
 * Assert a flag is enabled.  Throws a structured error with status 423 when disabled.
 *
 * @param {string} key - Flag key.
 * @param {string} context - Human-readable caller context for logs (e.g. "queue-runner").
 * @param {{ failClosedOnError?: boolean, supabase?: object }} [opts]
 * @throws {SystemControlDisabledError} when the flag is false.
 */
export async function requireSystemFlag(key, context = "unknown", opts = {}) {
  const enabled = await getSystemFlag(key, opts);

  if (!enabled) {
    info("system_control.disabled", { key, context });
    const err = new SystemControlDisabledError(key, context);
    throw err;
  }
}

/**
 * Structured error thrown by requireSystemFlag().
 * Callers can catch this and return HTTP 423.
 */
export class SystemControlDisabledError extends Error {
  constructor(key, context = "unknown") {
    super(`System flag '${key}' is disabled. Context: ${context}`);
    this.name = "SystemControlDisabledError";
    this.status = 423;
    this.flag_key = key;
    this.context = context;
  }
}

/**
 * Build a NextResponse-compatible 423 JSON body for disabled routes.
 */
export function buildDisabledResponse(key, context = "unknown") {
  return {
    ok: false,
    status: 423,
    error: "system_control_disabled",
    flag_key: key,
    context,
    message: `Operation '${context}' is currently disabled via system_control['${key}'].`,
  };
}

/** Invalidate the in-process cache (useful in tests or after manual flag updates). */
export function clearSystemControlCache() {
  _cache.clear();
  _value_cache.clear();
  _primed_kill_switch_values.clear();
  _primed_kill_switch_flags.clear();
}

/** Prime a flag directly into the cache (test-only — avoids hitting Supabase). */
export function primeSystemControlCache(key, value) {
  const normalized_key = clean(key);
  if (KILL_SWITCH_KEY_SET.has(normalized_key)) {
    _primed_kill_switch_flags.set(normalized_key, Boolean(value));
    return;
  }
  setCachedFlag(String(key), Boolean(value));
}

/** Prime a raw system_control value (test-only — avoids hitting Supabase). */
export function primeSystemControlValue(key, value) {
  const normalized_key = clean(key);
  const normalized_value = value == null ? null : clean(value);
  if (KILL_SWITCH_KEY_SET.has(normalized_key)) {
    _primed_kill_switch_values.set(normalized_key, normalized_value);
    return;
  }
  setCachedValue(String(key), normalized_value);
}
