-- lc-fixture: pretest
-- FLEET SNAPSHOT between the seed and the evidence backfill (Sender Routing 2.0 r3 chain), into the
-- runner's scratch schema lc_mt (absent in production: this fails fast anywhere else). The posttest
-- proves the seed + backfill never touched status / daily_limit / health_state of any number.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production — not even
-- inside BEGIN … ROLLBACK. Run through the migration test runner on a disposable database.
\set ON_ERROR_STOP on
DO $$ BEGIN IF to_regnamespace('lc_mt') IS NULL THEN RAISE EXCEPTION 'lc_mt scratch schema missing: run only through scripts/db/run-migration-test.mjs'; END IF; END $$;
DROP TABLE IF EXISTS lc_mt.pretest_fleet_before;
CREATE TABLE lc_mt.pretest_fleet_before AS SELECT id, phone_number, status, daily_limit, health_state FROM public.textgrid_numbers;
