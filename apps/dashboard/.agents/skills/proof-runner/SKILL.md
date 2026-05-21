# Proof Runner Skill

This skill ensures that all changes are verified using the project's proof scripts.

## Running Proofs
- **Local Proofs**: Run `scripts/proof/*.mjs` to verify specific module logic.
- **Root Proofs**: Run `scripts/proof-*.mjs` for integration and system-level checks.

## Mandatory Verification
- All commits MUST have a corresponding proof run.
- If a change affects the inbox, `scripts/test-inbox-full.mjs` must pass.
- If a change affects Supabase, `scripts/test-supabase.mjs` must pass.

## Adding New Proofs
- When adding a feature, create a new script in `scripts/proof/` that outputs a `success` or `failure` status.
