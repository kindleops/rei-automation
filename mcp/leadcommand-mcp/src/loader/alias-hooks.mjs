// Module resolution hook.
//
// 1. Alias: `@/…` → apps/api/src/… (the same alias the API and its test loader use), so
//    the gateway imports the existing LeadCommand modules themselves, not copies.
//
// 2. CREDENTIAL FENCE. Three app modules read writable credentials from the ambient
//    environment:
//      lib/supabase/client.js            SUPABASE_SERVICE_ROLE_KEY, read when the module is IMPORTED
//      lib/postgres/client.js            a direct pg pool (service-level DB URL)
//      lib/postgres/resolve-database-url DATABASE_URL / SUPABASE_DB_URL / POSTGRES_URL…
//    Each one, however it is reached (alias, relative or dynamic import), resolves
//    instead to an MCP-owned stub (./fenced/). The stub holds no credential, reads no
//    environment and refuses every use. A service that falls back to its default client
//    when no deps.supabase is given gets a refusal, not the service-role client. dotenv
//    cannot be loaded at all.
//    So the server can never silently derive a writable credential from apps/api/.env*
//    or the launch environment. test/credential.test.mjs proves it on a real subprocess.
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
