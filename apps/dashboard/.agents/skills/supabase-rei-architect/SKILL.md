# Supabase REI Architect Skill

This skill governs the management of the Supabase database architecture for the Real Estate Investing (REI) platform.

## Strict Repo Rules

- **Idempotency**: All SQL scripts must be idempotent (e.g., `CREATE TABLE IF NOT EXISTS`, `DROP VIEW IF EXISTS`).
- **No Destructive Migrations**: Avoid `DROP TABLE` or `ALTER TABLE ... DROP COLUMN` in production migrations unless absolutely necessary and backed by a verified rollback plan.
- **No Fake Joins**: Use actual foreign keys and explicit `JOIN` syntax. Never rely on application-level filtering where a database join is appropriate.
- **No Schema Assumptions**: Always query `information_schema` if metadata is needed; otherwise, use explicit table/column references.
- **Explicit Joins**: Mandatory use of explicit `INNER JOIN`, `LEFT JOIN`, etc. No comma-separated table lists.
- **Mandatory Proof Queries**: Every migration or schema change must be accompanied by a proof query in `scripts/proof/` that verifies the change.

## SQL Templates

### Migration Template
```sql
-- migration: name_of_migration
-- description: Brief description of the change

BEGIN;

-- Example: CREATE TABLE IF NOT EXISTS some_table (...);

COMMIT;
```

## Checklists

### Migration Checklist
- [ ] Script is idempotent.
- [ ] No destructive operations included.
- [ ] Foreign keys are explicitly defined.
- [ ] Rollback script is prepared and tested.
- [ ] Proof query is included.

### View Checklist
- [ ] Use `CREATE OR REPLACE VIEW`.
- [ ] Ensure underlying tables use explicit joins.
- [ ] Reference `inbox_threads_hydrated` for unified thread state.

### Proof Checklist
- [ ] Proof query returns non-zero results for valid data.
- [ ] Edge cases (null values, empty strings) are handled.

### Rollback Checklist
- [ ] Reverts schema to the exact previous state.
- [ ] Ensures no data loss during the rollback process.
