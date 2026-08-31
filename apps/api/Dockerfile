# apps/api container image.
#
# BUILT REMOTELY ONLY (GitHub-hosted Ubuntu runner). This file is never built on
# a development machine -- Cloudflare deploys from a registry image reference, so
# `wrangler deploy` needs no local Docker engine.
#
# Expects `next build` to have already produced .next/standalone with
# experimental.outputFileTracingRoot set to the repo root. Without that root the
# standalone bundle contains NO node_modules (apps/api/node_modules is a symlink
# in this monorepo) and the server dies with MODULE_NOT_FOUND here, even though
# it boots fine on a dev machine that has a parent node_modules to fall back on.

# Node 22+ is REQUIRED, not a preference. @supabase/realtime-js needs native
# WebSocket, which only exists from Node 22; on Node 20 every createClient()
# call throws at import. The whole test suite failed this way on the first CI
# run (434/434 files, identical error) -- and the container would have failed
# the same way at runtime on any route that touches Supabase.
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # The durability layer must never silently fall back to in-process state.
    RUNTIME_STATE_BACKEND=postgres \
    DEPLOYMENT_PROVIDER=cloudflare

WORKDIR /app

# Run unprivileged.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone layout (tracing root = repo root):
#   .next/standalone/node_modules
#   .next/standalone/apps/api/server.js
#   .next/standalone/apps/api/.next
# Build context is apps/api (`wrangler containers build apps/api`), so these
# paths are relative to apps/api -- NOT to the repo root.
#
# With outputFileTracingRoot = repo root, .next/standalone contains:
#   node_modules/            (439 traced packages)
#   apps/api/server.js
#   apps/api/.next/
COPY --chown=nextjs:nodejs .next/standalone ./
COPY --chown=nextjs:nodejs .next/static ./apps/api/.next/static
# NOTE: apps/api has no public/ directory. A COPY of it would fail the remote
# build, so it is deliberately absent rather than commented-in "just in case".

USER nextjs
EXPOSE 3000

# Container disk is ephemeral by design. Nothing correctness-critical may live
# on it: run locks and the idempotency ledger are in Postgres precisely so a
# restart here cannot lose a held lock or an in-flight claim.
CMD ["node", "apps/api/server.js"]
