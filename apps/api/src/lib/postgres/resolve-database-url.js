function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Prefer explicit DATABASE_URL, then rewrite legacy direct Supabase hosts to the
 * transaction pooler when MAP_FILTER_DB_POOLER_HOST is set or derivable.
 */
export function resolveDatabaseUrl() {
  const explicit =
    clean(process.env.DATABASE_URL) ||
    clean(process.env.SUPABASE_DB_URL) ||
    clean(process.env.SUPABASE_URL_NO_POOL) ||
    "";

  if (!explicit) return "";

  const poolerHost =
    clean(process.env.MAP_FILTER_DB_POOLER_HOST) ||
    clean(process.env.SUPABASE_DB_POOLER_HOST) ||
    "aws-1-us-west-2.pooler.supabase.com";

  const directMatch = explicit.match(
    /^postgresql:\/\/postgres:([^@]+)@db\.([a-z0-9]+)\.supabase\.co(?::\d+)?\/(.+)$/i,
  );
  if (!directMatch) return explicit;

  const [, password, projectRef, database] = directMatch;
  const port = clean(process.env.SUPABASE_DB_POOLER_PORT) || "6543";
  return `postgresql://postgres.${projectRef}:${password}@${poolerHost}:${port}/${database}`;
}