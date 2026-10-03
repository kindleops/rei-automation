-- ROLLBACK for 20260930120000_map_world_providers_and_cameras.sql (in the repo,
-- NEVER applied to production as of 2026-10-03 — see the 8.2 Map capability matrix).
--
-- Status (8.4 review): the migration is REUSED as-is, not superseded. Its schema
-- matches the canonical camera model the MN/TX adapters now produce
-- (camera-model.finalizeCamera), it stores metadata only (no imagery), and every
-- object is service_role-only (RLS on, anon/authenticated revoked) — the Map reads
-- cameras only through the operator-gated /api/cockpit/map/cameras* routes.
-- Until it is applied the API serves the same reads from an in-process inventory
-- (camera-memory-store.js, MAP_CAMERAS_STORE unset = memory). To switch:
--   1. apply 20260930120000 (pretest: this rollback in a rolled-back transaction);
--   2. schedule POST /api/internal/map/cameras/refresh (it is cadence-aware);
--   3. set MAP_CAMERAS_STORE=db on the API.
--
-- All objects are new; rollback is a drop, functions first.
DROP FUNCTION IF EXISTS public.map_camera_duplicate_pairs(text, double precision);
DROP FUNCTION IF EXISTS public.map_cameras_nearby(double precision, double precision, double precision, integer);
DROP FUNCTION IF EXISTS public.map_camera_grid(double precision, double precision, double precision, double precision, double precision);
DROP FUNCTION IF EXISTS public.map_cameras_in_bbox(double precision, double precision, double precision, double precision, integer);
DROP TABLE IF EXISTS public.map_world_provider_runs;
DROP TABLE IF EXISTS public.map_cameras;
DROP TABLE IF EXISTS public.map_world_providers;
