/**
 * Scheduling core — runtime wiring for API routes.
 *
 * Registers every client brand's adapter once and builds the service. Adding
 * a brand (Reivesti, Everline, SignPro) means adding its adapter here and its
 * event types/pools as data — nothing in the core changes.
 */

import { createProminentSchedulingAdapter } from '@/lib/domain/seller-portal/prominent-scheduling-adapter.js';

import { createSchedulingService, registerBrandAdapter } from './scheduling-service.js';
import { createTestBrandAdapter } from './test-brand-adapter.js';

let registered = false;

export function registerSchedulingBrands(env = process.env) {
  if (registered) return;
  registerBrandAdapter(createProminentSchedulingAdapter({ env }));
  if (String(env.NODE_ENV) !== 'production' || String(env.SCHEDULING_ALLOW_TEST_TYPES) === '1') registerBrandAdapter(createTestBrandAdapter());
  registered = true;
}

export function createDefaultSchedulingService(deps = {}) {
  registerSchedulingBrands(deps.env ?? process.env);
  return createSchedulingService(deps);
}

/** Brands that may call the scheduling API, each with its own secret. */
export function schedulingClients(env = process.env) {
  try {
    const parsed = JSON.parse(String(env.SCHEDULING_CLIENT_SECRETS || '{}'));
    return Object.fromEntries(Object.entries(parsed).filter(([k, v]) => k && typeof v === 'string' && v.length >= 32));
  } catch {
    return {};
  }
}
