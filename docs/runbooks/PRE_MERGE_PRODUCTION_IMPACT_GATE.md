# Pre-merge production-impact gate

**Complete this before every merge to `main` (or any production-connected branch).**

Added after the 2026-08-03 incident in which merging PR #64 auto-deployed the operator
dashboard to production under an explicit "do not deploy" instruction. See
[`docs/incidents/2026-08-03-unauthorized-dashboard-production-deploy.md`](../incidents/2026-08-03-unauthorized-dashboard-production-deploy.md).

---

## The rule

> **A merge to a production-connected branch IS a production deployment.**
>
> Authorization to merge is **not** authorization to deploy. If the branch auto-deploys,
> you need both, explicitly.

Corollary, and the actual lesson from the incident:

> **Verify a safety property by checking the mechanism that would violate it, not by
> checking that it has not been violated yet.**
>
> "No production deployment exists in the deployment history" does not establish "this
> merge will not create one." Only the project's git-integration settings establish that.

---

## Gate — all five must be answered before merging

### 1. Which Vercel projects are connected to this branch?

```bash
npx vercel project ls --scope <team>
```

In a monorepo, **more than one project can be connected to the same branch**, and a
project can rebuild even when your diff does not touch its directory. Do not infer
connection from the paths you changed.

### 2. Does the target branch auto-deploy to production?

Check the project's Git integration (Vercel dashboard → Project → Settings → Git):
production branch, and whether "Automatically expose System Environment Variables" /
auto-deploy is enabled for it.

Empirical cross-check — look for production deployments whose age lines up with recent
merges to the branch:

```bash
npx vercel ls <project> --scope <team> | head -10
```

Two production deployments matching your last two merge times means the branch
auto-deploys. **This check alone is not sufficient before the fact** — it is confirmation,
not prediction. The settings are the source of truth.

### 3. Which applications will actually deploy?

Record for each connected project: will it build, and will that build be Preview or
Production? Note that a project may build on any push to the branch regardless of which
subdirectory changed, unless it has an "Ignored Build Step" configured.

Known state for this repository as of 2026-08-03 (re-verify; do not trust this table
blindly):

| Project | Production URL | Auto-deploys production from `main`? |
|---|---|---|
| `rei-automation-dashboard` | https://ops.leadcommand.ai | **Yes — confirmed twice** |
| `api` | api-steel-three-96.vercel.app | **No** — PR #63 changed only `apps/api/**` and produced no production deploy |
| `real-estate-automation` | real-estate-automation-three.vercel.app | Unknown — stale (37d+) |

### 4. Is promotion to production automatic, or manual?

If production promotion is manual, a merge produces only a Preview and the gate is
satisfied by merge authorization alone. If it is automatic, continue to (5).

### 5. Has explicit production authorization been given?

Required when (4) is automatic. It must be **explicit and specific to this change** —
general approval to merge, to "proceed", or to complete a lane does not count.

State to the operator, and get an answer, before merging:

- that merging will deploy to production
- which project(s) will deploy and to which URL
- the exact code scope going live
- test, review and verification status
- the rollback target (the current production deployment id)
- any operator-visible behaviour changes

---

## If the gate cannot be satisfied

Do not merge. Report:

- the blocker,
- what would unblock it,
- and the state of everything else, so the work is not lost.

Leaving a reviewed PR unmerged is cheap. An unauthorized production deployment is not.

---

## After any merge to a production-connected branch

Immediately verify what actually deployed and report it — including when you expected
nothing to deploy:

```bash
npx vercel ls <project> --scope <team> | head -5
```

Record the deployment id, environment, and timestamp. If a production deployment appeared
without authorization, say so plainly and immediately, and take no corrective action
against production until the operator decides — a rollback is itself a production action
with its own blast radius.
