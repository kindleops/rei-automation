import crypto from "node:crypto";

import { buildOpsDashboardSessionToken } from "@/lib/security/dashboard-auth.js";

import { MAP_FILTER_REGISTRY_VERSION, MAP_FILTER_SCHEMA_VERSION } from "./versions.js";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Resolve tenant and authorization scope for filter tokens and saved views.
 * Hash input must include scope — expression JSON alone is never sufficient.
 */
export function resolveMapFilterAuthScope(request) {
  const organizationId =
    clean(request?.headers?.get("x-ops-organization-id")) ||
    clean(process.env.OPS_DASHBOARD_ORGANIZATION_ID) ||
    "default";

  const createdBy =
    clean(request?.headers?.get("x-ops-dashboard-user")) ||
    clean(request?.headers?.get("x-ops-dashboard-actor")) ||
    "ops-dashboard";

  const sessionToken = buildOpsDashboardSessionToken();
  const permissionScope = sessionToken ? "ops_dashboard_authenticated" : "ops_dashboard_unauthenticated";

  return {
    organizationId,
    createdBy,
    permissionScope,
    filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
    registryVersion: MAP_FILTER_REGISTRY_VERSION,
  };
}

/**
 * Stable canonical JSON for hashing (sorted keys).
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/**
 * Full internal SHA-256 digest for token storage and authorization checks.
 */
export function buildFilterTokenDigest({
  organizationId,
  permissionScope,
  filterSchemaVersion = MAP_FILTER_SCHEMA_VERSION,
  registryVersion = MAP_FILTER_REGISTRY_VERSION,
  normalizedExpression,
}) {
  const payload = stableStringify({
    organizationId: clean(organizationId),
    permissionScope: clean(permissionScope),
    filterSchemaVersion,
    registryVersion: clean(registryVersion),
    normalizedExpression,
  });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Expose at least 128 bits (32 hex chars) in URLs. */
export function exposeFilterTokenDigest(fullDigest) {
  return clean(fullDigest).slice(0, 32);
}

export function verifyFilterTokenScope(tokenRecord, authScope) {
  if (!tokenRecord || typeof tokenRecord !== "object") return false;
  return (
    clean(tokenRecord.organizationId) === clean(authScope.organizationId) &&
    clean(tokenRecord.permissionScope) === clean(authScope.permissionScope) &&
    Number(tokenRecord.filterSchemaVersion) === Number(authScope.filterSchemaVersion) &&
    clean(tokenRecord.registryVersion) === clean(authScope.registryVersion)
  );
}