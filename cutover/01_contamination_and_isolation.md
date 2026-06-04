# Branch Contamination & Isolation Report

_Phase: Baseline Cutover Planning & Isolation. Discovery/planning only — no prod mutation, no apply, no archive, no ledger repair, no deploy._

Branch created for this work: **`baseline-cutover-prep`** as an **isolated git worktree** at `/Users/ryankindle/rei-automation-cutover`, so these artifacts cannot be swept by another agent's `git add -A` in the main worktree.

## 1. Worktree topology
| Worktree | Branch | Notes |
|---|---|---|
| `/Users/ryankindle/rei-automation` | `stabilize-inbox-api-runtime-20260529-1414` @ `378af3a` | main; has uncommitted WIP |
| `/Users/ryankindle/rei-automation/.claude/worktrees/agent-ab929b8b5505e218b` | `worktree-agent-…` @ `af1b130` | **locked** — a parallel agent |
| `/Users/ryankindle/rei-automation-cutover` | `baseline-cutover-prep` @ `378af3a` | this phase (isolated) |

A second agent is active. **Do not rewrite shared history.** This phase only adds isolated planning artifacts.

## 2. Primary contamination event: commit `378af3a`
`378af3a` is titled "tactical execution control center UX (Phase 2D)" but is a **99-file / 20,925-insertion mega-commit** that fused ~8 distinct workstreams into one. This is the core contamination: it makes the history non-bisectable and entangles unrelated changes.

### Workstream classification of `378af3a`
| Workstream | Representative paths | Approx. weight |
|---|---|---|
| **workflow-studio** | `api/cockpit/workflow*`, `api/internal/automation/*`, `lib/domain/automation/*`, `lib/domain/workflows/*`, `dashboard/src/modules/workflows/*`, migrations `20260603192516/204321/220146`, `tests/critical/{automation-engine,workflow-studio}.test.mjs` | ~60 files (largest) |
| **execution-engine** | `lib/domain/campaigns/campaign-field-catalog.js`, `lib/domain/queue/process-send-queue.js`, `flows/handle-textgrid-*.js`, `dashboard/.../campaigns/{CampaignControlCenter,CampaignsPage,campaigns.types,campaigns.css,campaignWizardAdapter}`, `lib/api/backendClient.ts` | ~10 files (incl. Phase 2D UX + workstream-B catalog) |
| **inbox-runtime** | `api/cockpit/inbox/thread-state/route.js`, `api/cockpit/threads/[thread_key]/route.js`, `dashboard/src/modules/inbox/{InboxPage.tsx,active-context.ts,components/QueueCommandCenter.tsx,inbox-*.css}` | ~7 files |
| **ui/theme** | `index.css`, `modules/theme/nexus-theme.css`, `styles/light-theme-premium.css`, `styles/nx-glass-system.css`, `kpis/*.css`, `queue/queue-premium.css`, `shared/settings.ts` | ~9 files (very large diffs) |
| **scraper/import** | `dashboard/scraper.mjs`, `scraper2.mjs`, `scraper3.mjs` | 3 files (experimental) |
| **config/tooling** | `apps/api/.env.example`, `lib/config/{env,feature-flags}.js`, `supabase/.temp/cli-latest`, `.claude/scheduled_tasks.lock`, `docs/automation-engine-audit.md` | ~6 files |

> Note: the **clean** execution-engine slice (Phase 2A–2C: state machine, exec lock, progress engine, the two campaign migrations) is correctly isolated in commit **`47e8bd9`**, not in `378af3a`.

## 3. Current uncommitted/untracked work (main worktree)
Small, post-`378af3a`:

| File | Workstream | Status |
|---|---|---|
| `modules/workflows/WorkflowBuilder.tsx` | workflow-studio | modified |
| `modules/workflows/WorkflowList.tsx` | workflow-studio | modified |
| `modules/workflows/WorkflowStudio.tsx` | workflow-studio | modified (**currently breaks `tsc -b`** at 270:11) |
| `modules/workflows/workflow-studio.css` | workflow-studio | modified |
| `index.css` | ui/theme | modified |
| `modules/theme/nexus-theme.css` | ui/theme | modified |
| `styles/light-theme-premium.css` | ui/theme | modified |
| `styles/nexus-theme-tokens.css` | ui/theme | **untracked** |
| `modules/inbox/inbox-premium.css` | inbox-runtime/theme | modified |
| `src/main.tsx` | app-bootstrap | modified |
| `src/shared/settings.ts` | ui/config | modified |
| `apps/dashboard/supabase/.temp/cli-latest` | tooling churn | modified |
| `apps/api/supabase/migrations/00000000000001_baseline_schema.sql` | **baseline (this initiative)** | untracked draft (~970 KB) |

## 4. Overlapping file-ownership map (multi-workstream files)
| File | Workstreams sharing it |
|---|---|
| `dashboard/.../campaigns/campaigns.css` | Phase 1 launch UX + Phase 2D control center + workstream-B catalog labels |
| `dashboard/.../campaigns/CampaignsPage.tsx` | Phase 2D execution + campaign list UX |
| `dashboard/src/lib/api/backendClient.ts` | execution-engine (progress/lifecycle) + inbox + workflow API helpers |
| `apps/api/.../queue/process-send-queue.js` | queue execution engine + automation engine |
| `modules/theme/nexus-theme.css`, `styles/light-theme-premium.css` | global theme touched by every UI feature |
| `src/shared/settings.ts` | multiple UI features + config |
| `modules/inbox/inbox-premium.css` | inbox-runtime + theme |

## 5. High-risk merge-collision zones
Files that are **both** in `378af3a` **and** currently re-modified (active churn — highest rebase/merge collision risk):

- `modules/workflows/WorkflowBuilder.tsx`, `WorkflowList.tsx`, `WorkflowStudio.tsx`, `workflow-studio.css`
- `index.css`, `modules/theme/nexus-theme.css`, `styles/light-theme-premium.css`
- `modules/inbox/inbox-premium.css`
- `src/shared/settings.ts`, `src/main.tsx`

**Isolation guidance for cutover:** the baseline cutover touches **only** `apps/api/supabase/migrations/**` and the prod migration ledger. It has **zero file overlap** with the workflow-studio / ui-theme churn above, so the cutover can proceed on its own branch without colliding with the parallel agent — **provided no one edits `apps/api/supabase/migrations/**` during the freeze** (see safety plan).
