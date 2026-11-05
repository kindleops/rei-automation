// FENCED stand-in for apps/api/src/lib/postgres/resolve-database-url.js (see ../alias-hooks.mjs).
// The original derives a database URL, password included, from DATABASE_URL /
// SUPABASE_DB_URL / POSTGRES_URL…. This stub derives nothing.
export function resolveDatabaseUrl() {
  return ''
}
