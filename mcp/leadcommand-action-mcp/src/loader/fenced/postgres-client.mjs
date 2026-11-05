// FENCED stand-in for apps/api/src/lib/postgres/client.js (see ../alias-hooks.mjs). The Action MCP never
// connects to Postgres directly: its only data path is PostgREST as lc_action_gateway.
const refuse = () => Object.assign(new Error('direct database access refused: the Action MCP reaches the database only through PostgREST as lc_action_gateway'), { code: 'DIRECT_DB_REFUSED' })

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
