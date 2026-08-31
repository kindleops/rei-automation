# Cloudflare Topology Contract - STAGING FIRST

**Status:** DESIGN ONLY. Nothing here is deployed. No Dockerfile is executed on the
development Mac. No DNS is touched. Vercel is retired and is not a fallback.

---

## 1. Target topology

```
Cloudflare Worker  (ops.leadcommand.ai, LATER)
├── /                -> dashboard static assets (Workers Static Assets)
└── /api/*           -> apps/api Container (Next.js 14, Node, unchanged)
```

`apps/api` stays an ordinary Next.js 14 Node application. All 296 routes keep
`runtime = 'nodejs'`. Nothing is rewritten into Workers isolates.

---

## 2. Initial instance count: ONE

The first production topology is deliberately **a single `apps/api` container
instance**, not a pool.

Reason: Cloudflare Containers use explicit instance addressing rather than
automatic stateless autoscaling, so a conservative single-instance start removes
a whole class of routing surprises from the cutover.

### The durability work is STILL required at one instance

A single instance does **not** make the Postgres migration optional:

| Failure | Single instance still affected? |
| --- | --- |
| Container disk is ephemeral | YES |
| Restart loses `/tmp` | YES - every held lock and in-flight claim |
| Webhook retry after a restart | YES - would re-run seller automation |
| Rollout replaces the instance mid-run | YES - old instance's locks vanish |
| Two instances cannot see each other | Not yet, but blocks all future scaling |

Four of those five bite at N=1. That is why run locks and the idempotency ledger
moved to Postgres before any container work started.

---

## 3. Scale-out gate

Instance count may only be raised above 1 after **all** of the following are
green. This list is the gate; no item is waivable by convenience.

- [x] Durable run locks implemented on Postgres (atomic acquire/heartbeat/release)
- [x] Durable idempotency ledger implemented on Postgres (atomic claim)
- [x] Concurrency proof green at >= 20 parallel connections against real Postgres
- [x] Run-lock release fenced on `lease_token` (zombie cannot release a new holder)
- [x] No filesystem correctness state remains in the tree
- [ ] Queue atomic-claim regression green (`queue_atomic_claim_send_row`,
      `FOR UPDATE SKIP LOCKED`, `send_queue` status transitions unchanged)
- [ ] Staging container proves lock survival across a real restart
- [ ] Staging container proves ledger survival across a real restart
- [ ] Production soak clean at N=1

Row-level send authority is **not** provided by run locks. It is
`queue_atomic_claim_send_row` plus `FOR UPDATE SKIP LOCKED` on `send_queue`, and
it was already atomic in Postgres before this work. Run locks are the coarse
"one runner per job" guard.

---

## 4. What staging must prove (cannot be proven natively on the Mac)

| # | Proof | Why it needs a real container |
| --- | --- | --- |
| 1 | Image boots in Cloudflare Container | Runtime/base-image mismatch only shows there |
| 2 | Node server starts, binds, serves | Standalone output + entrypoint correctness |
| 3 | `/api` health + read routes respond | Routing through the Worker binding |
| 4 | Direct Postgres TCP works | Container egress to 5432/6543 |
| 5 | Container lifecycle / restart | Restart semantics are platform-specific |
| 6 | Filesystem ephemerality behaves as expected | Confirms the premise of this whole migration |
| 7 | Postgres **locks survive restart** | The durability claim, end to end |
| 8 | Postgres **idempotency survives restart** | The durability claim, end to end |
| 9 | SMTP TCP reachability on 587/465 | Container egress on non-HTTP ports |

**Proof 9 is CONNECTIVITY ONLY.** Open the TCP socket, read the SMTP greeting,
send `QUIT`. Do not `AUTH`. Do not send mail.

Staging constraints: no DNS cutover, no `ops.leadcommand.ai`, no production
sends, queue execution stays paused.

---

## 5. Local vs remote work split

| Runs on the Mac | Runs on a GitHub-hosted runner |
| --- | --- |
| Source edits | Container image build |
| Focused test suites | Image packaging + push |
| `vite build` (dashboard) | `wrangler containers push` |
| `tsc --noEmit` typecheck | Cloudflare staging deploy |
| `next build` | - |
| Native Node production server | - |
| Native Postgres proofs | - |

Docker never runs on the Mac. `wrangler deploy` against a **registry image
reference** does not require a local Docker engine - that is the model this plan
uses.
