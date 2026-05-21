# REI Automation Monorepo

## Boundaries
- `apps/api` is the backend source of truth.
- `apps/dashboard` is cockpit UI only.
- `packages/shared` is for shared types/constants only.
- Dashboard must not perform production mutations.

## Safety
- No dashboard mutation of production queue/message/thread-state tables.
- Seller-facing automation, SMS, classification, and template execution belong to API.
