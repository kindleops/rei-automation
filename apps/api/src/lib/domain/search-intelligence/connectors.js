/**
 * SEARCH INTELLIGENCE — read-only provider connectors (§16, §18–20, §32).
 *
 * Interfaces and connection states only. No connector performs a network call
 * in V1: each checks its secret reference through the server-only secret store
 * and reports NOT_CONFIGURED when nothing is configured (the case for every
 * property today). Connectors are read-only by declared scope; none exposes a
 * write method. Nothing here couples to LeadCommand seller/campaign tables.
 */
import { createSecretStore, isSecretRef, looksLikeSecretMaterial } from './secret-store.js';

export const PROVIDERS = Object.freeze(['SEARCH_CONSOLE', 'GA4', 'FIRST_PARTY', 'CLOUDFLARE', 'EXTERNAL_RESEARCH', 'LEADCOMMAND']);

export const READ_ONLY_SCOPE = Object.freeze({
  SEARCH_CONSOLE: 'https://www.googleapis.com/auth/webmasters.readonly',
  GA4: 'https://www.googleapis.com/auth/analytics.readonly',
  CLOUDFLARE: 'Account Analytics:Read',
  EXTERNAL_RESEARCH: 'vendor read-only API plan',
  FIRST_PARTY: 'internal aggregate read',
  LEADCOMMAND: 'internal aggregate read (bridge)',
});

/**
 * Connection state for one configured connection row:
 *   { property_id, provider, state?, secret_ref?, provider_property? }
 * Returns a status object safe to send to the dashboard (no values).
 */
export function connectionStatus(row, { secrets = createSecretStore() } = {}) {
  const base = { property_id: row.property_id, provider: row.provider, scope: READ_ONLY_SCOPE[row.provider] ?? null };
  if (!PROVIDERS.includes(row.provider)) return { ...base, state: 'ERROR', reason: 'unknown_provider' };
  if (row.state === 'NOT_APPLICABLE' || row.state === 'PAUSED') return { ...base, state: row.state, reason: null };
  if (row.secret_ref != null && looksLikeSecretMaterial(row.secret_ref)) return { ...base, state: 'ERROR', reason: 'secret_material_in_row' };
  if (row.provider === 'FIRST_PARTY' || row.provider === 'LEADCOMMAND') {
    // internal sources: "connected" only when their tables/bridge exist; V1 has neither
    return { ...base, state: 'NOT_CONFIGURED', reason: row.provider === 'FIRST_PARTY' ? 'telemetry_not_deployed' : 'bridge_not_built' };
  }
  if (!row.secret_ref) return { ...base, state: 'NOT_CONFIGURED', reason: 'no_secret_reference' };
  if (!isSecretRef(row.secret_ref)) return { ...base, state: 'ERROR', reason: 'invalid_secret_reference' };
  const d = secrets.describe(row.secret_ref);
  if (!d.configured) return { ...base, state: 'AWAITING_ACCESS', reason: 'secret_not_configured' };
  if (!row.provider_property) return { ...base, state: 'AWAITING_ACCESS', reason: 'provider_property_missing' };
  // a credential and a property exist; verification happens on first sync (not in V1)
  return { ...base, state: 'VERIFYING', reason: 'first_sync_pending' };
}

/** A Search Console connector. In V1 every method refuses: nothing is configured and no network is used. */
export function createSearchConsoleConnector({ secretRef, property, secrets = createSecretStore() } = {}) {
  const status = connectionStatus({ provider: 'SEARCH_CONSOLE', secret_ref: secretRef, provider_property: property }, { secrets });
  const refuse = () => Promise.reject(Object.assign(new Error(`search console ${status.reason ?? 'unavailable'}`), { code: status.reason ?? 'unavailable' }));
  return Object.freeze({
    provider: 'SEARCH_CONSOLE',
    scope: READ_ONLY_SCOPE.SEARCH_CONSOLE,
    status,
    // the approved implementation adds an injected fetch and calls the API only from here
    listProperties: () => refuse(),
    searchAnalytics: () => refuse(),
  });
}
