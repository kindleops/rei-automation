// Module resolution hook (same contract as the read-only server's loader, mcp/leadcommand-mcp/src/loader).
//
// 1. Alias: `@/…` → apps/api/src/…, so the Action MCP runs the EXISTING LeadCommand modules (the Action
//    Gateway domain module and the domain services it calls), not copies.
// 2. CREDENTIAL FENCE. The app modules that read writable credentials from the ambient environment —
//      lib/supabase/client.js            SUPABASE_SERVICE_ROLE_KEY, read when the module is IMPORTED
//      lib/postgres/client.js            a direct pg pool (service-level DB URL)
//      lib/postgres/resolve-database-url DATABASE_URL / SUPABASE_DB_URL / POSTGRES_URL…
//    resolve to MCP-owned stubs that hold no credential and refuse every use, however they are reached.
//    A domain service that falls back to its default client gets a refusal (fail closed), never the
//    service-role client. dotenv cannot be loaded. The Action MCP's ONLY data path is PostgREST under the
//    owner-minted lc_action_gateway token (src/data/client.mjs).
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const API_SRC = path.resolve(HERE, '../../../../apps/api/src')

export const FENCED = Object.freeze({
  [pathToFileURL(path.join(API_SRC, 'lib/supabase/client.js')).href]: pathToFileURL(path.join(HERE, 'fenced/supabase-client.mjs')).href,
  [pathToFileURL(path.join(API_SRC, 'lib/postgres/client.js')).href]: pathToFileURL(path.join(HERE, 'fenced/postgres-client.mjs')).href,
  [pathToFileURL(path.join(API_SRC, 'lib/postgres/resolve-database-url.js')).href]: pathToFileURL(path.join(HERE, 'fenced/resolve-database-url.mjs')).href,
})
const DOTENV = /^dotenv(\/.*)?$|^@dotenvx\//
const REFUSED = pathToFileURL(path.join(HERE, 'fenced/refused.mjs')).href

export async function resolve(specifier, context, nextResolve) {
  if (DOTENV.test(specifier)) return { url: REFUSED, shortCircuit: true }
  const r = specifier.startsWith('@/')
    ? { url: pathToFileURL(path.join(API_SRC, specifier.slice(2))).href, shortCircuit: true }
    : await nextResolve(specifier, context)
  const fenced = FENCED[r.url.split('?')[0]]
  return fenced ? { url: fenced, shortCircuit: true } : r
}
