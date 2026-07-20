# @rei/seller-engine (Phase 3 foundation)

Local, deploy-inert seller intelligence engine. **Not** imported by `apps/api` or `apps/dashboard`; not part of any build/deploy; never touches production Supabase; produces no production queue/outreach behavior. Draft DDL lives in `supabase/migrations-draft/seller-engine/` (DO NOT APPLY).

- `npm --workspace packages/seller-engine test` — full suite (`node --test`)
- `node corpus/manifest.mjs propose [--deep]` — corpus discovery/manifest (finalize requires `--approve` + explicit selection)
- `node importers/run.mjs --dir <exportDir> [--only …] [--dry-run] [--pilot N] [--resume]` — staging importers → NDJSON under `var/` (gitignored)
- `node backtest/demo.mjs` — demonstration scoring/backtest on staged data (harness validation only; see report disclaimer)

Design authority: `docs/seller-engine/phase{1,2,3}/`. Weights are `provisional_domain_weight` only (see `config/deterministic_v1.config.json`).
