/**
 * CAMERA ADAPTERS — adapter_type → adapter. One adapter can serve many
 * providers (every state on the same 511 platform shares one).
 *
 * The contract every adapter meets (pinned by a contract test per provider on
 * a real official-response fixture):
 *
 *   listRaw({ provider, fetch, apiKey, now }) → Promise<unknown[]>
 *       One bounded inventory pull through the service's fetch helpers (metadata
 *       hosts only, timed out, size-capped). Throws on failure; the service
 *       keeps the known inventory and backs off.
 *   normalize(raw, { provider, now }) → partial canonical camera | null
 *       Pure. Reads only what the provider publishes; unknown fields ignored;
 *       a record that cannot be placed returns null.
 *   snapshotRequest?(cameraRow, { provider, apiKey }) → { url, headers? } | null
 *       Only for providers whose stills must be built server-side (e.g. keyed).
 *       Otherwise the stored still_url is used.
 */

import { mndotIrisAdapter } from './adapters/mndot-iris.js'
import { txdotItsAdapter } from './adapters/txdot-its.js'
import { austinMobilityAdapter } from './adapters/austin-mobility.js'
import { caltransCwwp2Adapter } from './adapters/caltrans-cwwp2.js'

/** @type {Record<string, { listRaw: Function, normalize: Function, snapshotRequest?: Function }>} */
export const CAMERA_ADAPTERS = {
  mndot_iris: mndotIrisAdapter,
  txdot_its: txdotItsAdapter,
  austin_mobility: austinMobilityAdapter,
  caltrans_cwwp2: caltransCwwp2Adapter,
}
