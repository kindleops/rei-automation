// Test helpers (FIXTURE data only). Builds the real app over the fixture source
// and connects the official SDK Client through the SDK's in-memory transport.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildApp } from '../src/app.mjs'
import { FIXTURE, FIXTURE_ORG, FIXTURE_OWNER, FIXTURE_NOW, FIXTURE_CAMPAIGN, FIXTURE_THREADS } from '../fixtures/dataset.mjs'
import { SCOPE_NAMES } from '../src/authz/scopes.mjs'

/** Every scope, the opt-in ones included (contact status + the four rc-8.5.21 operations reads). */
export const ALL_SCOPES = SCOPE_NAMES.join(' ')

export function fixtureEnv(over = {}) {
  return { LEADCOMMAND_MCP_DATA: 'fixture', LEADCOMMAND_MCP_PRINCIPAL_USER_ID: FIXTURE_OWNER, LEADCOMMAND_MCP_ORG_ID: FIXTURE_ORG, LEADCOMMAND_MCP_SCOPES: ALL_SCOPES, ...over }
}

export async function connect({ env = fixtureEnv(), fixture = FIXTURE, faults = {}, now = () => FIXTURE_NOW, ...rest } = {}) {
  const audit = []
  const app = await buildApp({ env, fixture, faults, auditSink: (r) => audit.push(r), now, ...rest })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await app.server.connect(st)
  const client = new Client({ name: 'leadcommand-mcp-test', version: '1.0.0' })
  await client.connect(ct)
  return { app, client, audit, async close() { await client.close(); await app.close() } }
}

export const call = (client, name, args = {}) => client.callTool({ name, arguments: args })

/** One valid call per tool (FIXTURE ids). */
export const HAPPY = {
  leadcommand_search_leads: { market: 'Fixture Metro, TX', limit: 5 },
  leadcommand_get_lead: { property_id: 'FX1001' },
  leadcommand_search_properties: { zip: '75001', limit: 5 },
  leadcommand_get_property: { property_id: 'FX1001' },
  leadcommand_get_acquisition_score: { property_id: 'FX1001' },
  leadcommand_get_market_intelligence: { zip: '75001' },
  leadcommand_search_comps: { property_id: 'FX1001' },
  leadcommand_get_campaign_metrics: { campaign_id: FIXTURE_CAMPAIGN },
  leadcommand_get_lead_contact_status: { property_id: 'FX1001' },
  leadcommand_get_ops_supervisor_status: {},
  leadcommand_search_action_center: { limit: 5 },
  leadcommand_get_thread_hold_status: { thread_id: FIXTURE_THREADS.held },
  leadcommand_get_followup_intent_health: {},
  leadcommand_get_lead_conversation: { property_id: 'FX1001' },
  leadcommand_search_conversation_worklist: { category: 'unanswered_inbound', window_days: 30 },
  leadcommand_get_pipeline_summary: { dimension: 'market' },
  leadcommand_get_opportunity_ranking: { window_days: 30 },
  leadcommand_get_corpus_census: {},
  leadcommand_search_lead_screen: { limit: 10 },
}
