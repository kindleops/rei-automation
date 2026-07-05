-- Reconcile live map_filter_tokens drift: add revocation timestamp if missing.

ALTER TABLE public.map_filter_tokens
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;