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

const TABLE = "system_control";

// In-process cache so we don't hammer Supabase on every message send.
const CACHE_TTL_MS = 30_000; // 30 seconds

const _cache = new Map(); // key -> { value, expires_at }
const _value_cache = new Map(); // key -> { value, expires_at }

const TRUE_FLAG_VALUES = new Set(["true", "1", "yes", "on", "enabled"]);

function clean(value) {
  return String(value ?? "").trim();
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

export async function setSystemValues(pairs = {}, opts = {}) {
  const { supabase = defaultSupabase } = opts;
  const entries = Object.entries(pairs)
    .map(([key, value]) => ({ key: clean(key), value: clean(value) }))
    .filter((row) => row.key);
  if (entries.length === 0) return { ok: true, updated: 0 };

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(entries, { onConflict: "key" })
    .select("key,value,updated_at");
  if (error) {
    warn("system_control.set_values_error", { message: error.message, count: entries.length });
    return { ok: false, error };
  }
  entries.forEach((row) => _cache.delete(row.key));
  return { ok: true, updated: data?.length || 0, rows: data || [] };
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
}

/** Prime a flag directly into the cache (test-only — avoids hitting Supabase). */
export function primeSystemControlCache(key, value) {
  setCachedFlag(String(key), Boolean(value));
}

/** Prime a raw system_control value (test-only — avoids hitting Supabase). */
export function primeSystemControlValue(key, value) {
  setCachedValue(String(key), value == null ? null : clean(value));
}
