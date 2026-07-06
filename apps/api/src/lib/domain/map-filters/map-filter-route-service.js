import { compileMapFilter } from "./map-filter-compiler.js";
import { buildMapFilterExpressionFromInboxFilters } from "./inbox-to-map-filter-expression.js";
import { countMapFilterEntities } from "./map-filter-count-service.js";
import { resolveMapFilterAuthScope } from "./filter-scope.js";
import { getMapFilterPreset } from "./map-filter-presets.js";
import {
  compiledFromTokenRecord,
  loadMapFilterToken,
  upsertMapFilterToken,
} from "./map-filter-token-store.js";

function clean(value) {
  return String(value ?? "").trim();
}

function parseBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const lat_min = Number(bounds.lat_min);
  const lat_max = Number(bounds.lat_max);
  const lng_min = Number(bounds.lng_min);
  const lng_max = Number(bounds.lng_max);
  if (![lat_min, lat_max, lng_min, lng_max].every(Number.isFinite)) return null;
  return { lat_min, lat_max, lng_min, lng_max };
}

export async function resolveCompiledMapFilter(request, body = {}) {
  const authScope = resolveMapFilterAuthScope(request);

  const filterToken = clean(body.filterToken || body.token || body.filter);
  if (filterToken) {
    const loaded = await loadMapFilterToken(filterToken, authScope);
    if (!loaded.ok) {
      return { ok: false, status: loaded.error === "token_scope_denied" ? 403 : 404, error: loaded.error };
    }
    return {
      ok: true,
      authScope,
      compiled: compiledFromTokenRecord(loaded.token),
      token: loaded.token,
      timing: { validationMs: 0, normalizationMs: 0, compilationMs: 0 },
    };
  }

  let expression = body.expression;
  if (body.inboxFilters && typeof body.inboxFilters === "object") {
    expression = buildMapFilterExpressionFromInboxFilters(body.inboxFilters, {
      mapStatus: clean(body.mapStatus) || "all",
    });
  }
  const presetKey = clean(body.presetKey || body.preset);
  if (presetKey) {
    const preset = getMapFilterPreset(presetKey);
    if (!preset) {
      return { ok: false, status: 404, error: "preset_not_found", key: presetKey };
    }
    expression = preset.expression;
  }

  if (!expression || typeof expression !== "object") {
    return { ok: false, status: 400, error: "missing_expression" };
  }

  const compileStarted = Date.now();
  const compiledResult = compileMapFilter(expression);
  const compilationMs = Date.now() - compileStarted;

  if (!compiledResult.ok) {
    return {
      ok: false,
      status: 400,
      error: "compile_failed",
      issues: compiledResult.errors,
    };
  }

  return {
    ok: true,
    authScope,
    compiled: compiledResult.compiled,
    expression,
    timing: {
      validationMs: compilationMs,
      normalizationMs: compilationMs,
      compilationMs,
    },
  };
}

export async function compileAndStoreMapFilterToken(request, body = {}) {
  const resolved = await resolveCompiledMapFilter(request, body);
  if (!resolved.ok) return resolved;

  const stored = await upsertMapFilterToken({
    authScope: resolved.authScope,
    compiled: resolved.compiled,
    ttlHours: body.ttlHours,
  });

  return {
    ok: true,
    authScope: resolved.authScope,
    compiled: resolved.compiled,
    token: stored,
    timing: resolved.timing,
  };
}

export async function previewMapFilterCounts(request, body = {}) {
  const resolved = await resolveCompiledMapFilter(request, body);
  if (!resolved.ok) return resolved;

  const bounds = parseBounds(body.bounds);

  try {
    const countResult = await countMapFilterEntities(resolved.compiled, { bounds });
    return {
      ok: true,
      authScope: resolved.authScope,
      compiled: resolved.compiled,
      counts: countResult.counts,
      semantics: countResult.semantics,
      timing: {
        ...resolved.timing,
        ...countResult.timing,
        totalMs: (resolved.timing?.compilationMs || 0) + (countResult.timing?.totalMs || 0),
      },
      meta: countResult.meta,
      bounds,
    };
  } catch (error) {
    const code = error?.code || "count_query_failed";
    const status = code.endsWith("_timeout") ? 504 : 500;
    return {
      ok: false,
      status,
      error: code,
      phase: error?.phase || null,
      message: error?.message || code,
    };
  }
}