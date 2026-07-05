-- Master Filters saved library — persisted expression stacks per organization scope.

CREATE TABLE IF NOT EXISTS public.map_filter_saved_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  created_by text NOT NULL,
  permission_scope text NOT NULL DEFAULT 'ops_dashboard_authenticated',
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  expression_json jsonb NOT NULL,
  summary text NOT NULL DEFAULT '',
  is_favorite boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'organization')),
  filter_schema_version integer NOT NULL,
  registry_version text NOT NULL,
  active_rule_count integer NOT NULL DEFAULT 0,
  last_known_property_count bigint,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_map_filter_saved_filters_org_scope
  ON public.map_filter_saved_filters (organization_id, permission_scope, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_map_filter_saved_filters_favorites
  ON public.map_filter_saved_filters (organization_id, is_favorite, updated_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE public.map_filter_saved_filters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.map_filter_saved_filters FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.map_filter_saved_filters TO service_role;