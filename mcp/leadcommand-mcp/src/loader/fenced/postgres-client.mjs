// FENCED stand-in for apps/api/src/lib/postgres/client.js (see ../alias-hooks.mjs).
// The original opens a direct pg pool from DATABASE_URL / SUPABASE_DB_URL. LeadCommand MCP
// never connects to Postgres directly: its only data path is PostgREST under the
// role-enforced reader token. "No database URL" makes callers that probe first
// (readEntityContacts, factsState) skip their direct path. Any direct use is refused.
const refuse = () => Object.assign(new Error('direct database access refused: LeadCommand MCP reads only through PostgREST as lc_mcp_reader'), { code: 'DIRECT_DB_REFUSED' })

export function getDatabaseUrl() {
  return ''
}
export function hasDatabaseUrl() {
  return false
}
export function getPgPool() {
  throw refuse()
}
export async function queryWithTimeout() {
  throw refuse()
}
