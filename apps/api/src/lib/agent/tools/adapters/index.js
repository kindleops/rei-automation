// Integration boundary adapters per app (S1: read-tool stubs).
import { entityGraphTools } from './entity-graph.js'
import { campaignTools } from './campaigns.js'
import { inboxTools } from './inbox.js'
import { pipelineTools } from './pipeline.js'
import { mapTools } from './map.js'
import { marketIntelTools } from './market-intel.js'
import { queueTools } from './queue.js'
import { notificationTools } from './notifications.js'
import { createToolRegistry, readOnlyViolation } from '../registry.js'
import { defineTool } from '../define-tool.js'

export const ADAPTER_TOOL_SPECS = Object.freeze({
  'entity-graph': entityGraphTools,
  campaigns: campaignTools,
  inbox: inboxTools,
  pipeline: pipelineTools,
  map: mapTools,
  'market-intel': marketIntelTools,
  queue: queueTools,
  notifications: notificationTools,
})

/**
 * The S1 registry: read tools only, sealed. Read-only (AGENT_READ_ONLY) unless
 * explicitly lifted: a tool that is not a small T0 read (e.g. eg.property_ids,
 * max_rows 5000) is NOT REGISTERED at all — unreachable, not merely refused.
 * `registry.excluded` lists what was left out and why.
 */
export function createDefaultToolRegistry({ readOnly = true } = {}) {
  const registry = createToolRegistry({ readOnly })
  const excluded = []
  for (const specs of Object.values(ADAPTER_TOOL_SPECS)) {
    for (const spec of specs) {
      const why = readOnly ? readOnlyViolation(defineTool(spec)) : null
      if (why) excluded.push(Object.freeze({ name: spec.name, reason: why }))
      else registry.register(spec)
    }
  }
  registry.excluded = Object.freeze(excluded)
  return registry.seal()
}
