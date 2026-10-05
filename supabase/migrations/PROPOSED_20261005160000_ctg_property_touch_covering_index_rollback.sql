-- ROLLBACK for PROPOSED_20261005160000_ctg_property_touch_covering_index.sql
-- Same method as the apply: one statement, outside a transaction (MCP execute_sql / psql autocommit).
-- Also cleans up an INVALID index left by a cancelled CONCURRENTLY build.
-- Effect: reads go back to the seq-scan plans (correct, slower). No data change.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_ctg_property_touch_phone;
