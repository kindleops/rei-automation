-- Advanced Map Filters: secure token persistence (no executable SQL stored).

CREATE TABLE IF NOT EXISTS public.map_filter_tokens (
  filter_token_digest text PRIMARY KEY,
  filter_token_exposed text NOT NULL,
  organization_id text NOT NULL,
  created_by text NOT NULL,
  permission_scope text NOT NULL,
  filter_schema_version integer NOT NULL,
  registry_version text NOT NULL,
  normalized_expression jsonb NOT NULL,
  compiled_predicate_ast jsonb NOT NULL,
  filter_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  referenced_field_keys text[] NOT NULL DEFAULT '{}',
  referenced_entities text[] NOT NULL DEFAULT '{}',
  summary text NOT NULL DEFAULT '',
  active_rule_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_map_filter_tokens_exposed
  ON public.map_filter_tokens (filter_token_exposed);

CREATE INDEX IF NOT EXISTS idx_map_filter_tokens_org_scope
  ON public.map_filter_tokens (organization_id, permission_scope, expires_at DESC);

ALTER TABLE public.map_filter_tokens ENABLE ROW LEVEL SECURITY;

-- No policies for anon/authenticated — service_role only via API.

REVOKE ALL ON TABLE public.map_filter_tokens FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.map_filter_tokens TO service_role;