# Agent Missions API (8.5.18)

Persistent missions run on the R2 durable runtime (`agent.research_job` rows, run by the
`/api/internal/agent/runtime/tick` cron lane). They keep running when the browser is closed:
the browser only creates, watches and cancels them. This document is the contract the
Intelligence Command Missions UI (8.5.17) builds against.

Implementation: `apps/api/src/lib/agent/missions/missions-routes.js` (HTTP) and
`missions-service.js` (shapes). Tests that pin these shapes:
`apps/api/tests/critical/agent-missions.test.mjs` ("Missions API" test).

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/cockpit/agent/missions` | list (newest first) |
| GET | `/api/cockpit/agent/missions/:id` | one mission: status, progress, events, findings, result, cost |
| POST | `/api/cockpit/agent/missions` | create (through the `missions.create` capability → `agent.runtime_enqueue`) |
| POST | `/api/cockpit/agent/missions/:id/cancel` | cancel (cascades to a supervisor's children) |

Every route, in order:

1. **Gate**: `404` with an **empty body** unless `AGENT_ENABLED` and `AGENT_MISSIONS_ENABLED=1`.
2. Ops-dashboard auth (`ensureMutationAuth`, the Worker-attached shared secret).
3. Named-user auth: the operator's Supabase JWT (`Authorization: Bearer …`) verified server-side + the
   operator allowlist (same as `/api/cockpit/agent/actions`). `401` / `403` otherwise.
4. Per-user rate limit (`429`, `retry-after` header). GET uses the `read` bucket, POST the `mutation` bucket.
5. `agent.operator_membership` for the org. A mission is visible to the operator who requested it and to an
   org **owner**; anyone else gets `404 MISSION_NOT_FOUND` (existence is not disclosed).

All responses are `application/json; charset=utf-8`, `cache-control: no-store`.
Errors are always `{ "ok": false, "error": "<CODE>", "detail"?: … }`.

## Mission summary (used by list, get, and `children`)

```json
{
  "mission_id": "mjob_6b0f3c1e-4b7a-4c1d-9a51-2f1f9d6f4a10",
  "kind": "mission.research",
  "state": "running",
  "display_state": "running",
  "title": "Research the distress and equity evidence for property 2124415662 and cite the sources.",
  "requested_by": "11111111-1111-4111-8111-111111111111",
  "trigger": { "kind": "manual", "ref": "manual", "schedule_id": null },
  "progress": { "step": "ask", "pct": 60, "steps_done": 1, "steps_total": 3, "children_done": null, "children_total": null },
  "attempt": 1,
  "max_attempts": 3,
  "cancel_requested": false,
  "budget_cap_usd": 0.5,
  "cost_usd": null,
  "parent_mission_id": null,
  "last_error": null,
  "created_at": "2026-10-14T12:00:00.000Z",
  "updated_at": "2026-10-14T12:00:04.120Z",
  "ended_at": null,
  "next_attempt_at": "2026-10-14T12:00:00.000Z"
}
```

| Field | Notes |
| --- | --- |
| `kind` | `mission.research`, `mission.supervisor`, `acquisition.discovery`, `conversation.review_digest`, `ops.health_check` |
| `state` | the runtime state: `queued` `claimed` `running` `retrying` `waiting_for_approval` `paused` `budget_blocked` `completed` `failed` `cancelled` `dead_letter` |
| `display_state` | what to render: `state`, except `waiting` (a job that yielded between steps, e.g. a supervisor waiting on its sub-missions — runtime state `retrying` with no error) and `cancelling` (cancel requested while running) |
| `title` | the decoded question (≤ 120 chars), or a fixed label for scheduled kinds |
| `progress` | written only by the handler's checkpoints; `pct` 0–100 or `null`; supervisors add `children_done` / `children_total` |
| `cost_usd` | from the job result once completed (supervisor: total incl. children); `null` until then — use `GET :id` → `cost` for live ledger totals |
| `last_error` | `{ "code": "AGENT_SPEND_CAP_JOB" }` etc.; codes only |
| `next_attempt_at` | `null` once terminal; for `waiting` / `retrying` the time the runtime may claim it again |

Terminal states: `completed`, `failed`, `cancelled`, `dead_letter`. `budget_blocked` and `failed` are
re-queueable by an operator (R2 `agent.runtime_requeue`; not exposed by this API yet).

## GET /api/cockpit/agent/missions

Query: `scope=mine|all` (`all` = owner only, else `403 ROLE_NOT_ALLOWED`), `kind=` (repeatable),
`state=` (repeatable), `limit=1..100` (default 50), `before=<mission_id>` (keyset cursor).

`200`:

```json
{ "ok": true, "scope": "mine", "missions": [ /* mission summaries */ ], "next_cursor": "mjob_…" }
```

`next_cursor` is `null` on the last page; pass it as `before=` for the next page.

## GET /api/cockpit/agent/missions/:id

Query: `events_after=<event id>` (incremental polling; default 0 = from the start; ≤ 200 events per call).

`200`:

```json
{
  "ok": true,
  "mission": {
    "…": "every mission-summary field",
    "input": {
      "question": "Research the distress and equity evidence for property 2124415662 and cite the sources.",
      "context": { "property_ids": ["2124415662"] },
      "sub_questions": null,
      "parameters": { "max_model_calls": 4 }
    },
    "result": {
      "mission": "research",
      "outcome": "COMPLETED",
      "state": "completed",
      "answer": "Property 2124415662 is tax delinquent per campaign_target_graph …",
      "cost_usd": 0.004512,
      "model_calls": 2,
      "tool_calls": 1,
      "web_searches": 0,
      "property_refs": ["2124415662"],
      "citations": 0,
      "approvals": [{ "approval_id": "apr_…", "capability_id": "campaigns.prepare_launch_approval", "expires_at": "…", "deduped": false }],
      "drafts": [{ "campaign_id": "…", "status": "draft" }],
      "findings": 2,
      "parent_job_id": null,
      "envelope": { "schema": "lc.ask.result", "version": 1, "blocks": [ { "kind": "answer", "markdown": "…" } ], "evidence": { "internal": { "tools": ["eg.distress_signals"], "property_ids": ["2124415662"] }, "public_web": [] } }
    },
    "cost": {
      "committed_usd": 0.004512,
      "settled_usd": 0.004512,
      "open_reserved_usd": 0,
      "unknown_usd": 0,
      "model_calls": 2,
      "children_committed_usd": 0,
      "total_committed_usd": 0.004512,
      "budget_cap_usd": 0.5
    },
    "children": [],
    "events": [
      { "id": 41, "at": "2026-10-14T12:00:00.100Z", "type": "job.enqueued", "state": "queued", "attempt": 0, "actor": "enqueue:manual", "payload": { "trigger_kind": "manual", "budget_cap_usd": 0.5 } },
      { "id": 44, "at": "…", "type": "job.step", "state": "running", "attempt": 1, "actor": "agent-runtime-tick", "payload": { "step": "ask.done", "outcome": "COMPLETED", "cost_usd": 0.004512, "model_calls": 2, "tool_calls": 1, "approvals": 0 } }
    ],
    "events_cursor": 52,
    "findings": [
      {
        "finding_id": "fnd_…",
        "finding_type": "mission.property_evidence",
        "key": "property.2124415662",
        "value": { "property_ref": "2124415662", "tools_read": ["eg.distress_signals"] },
        "source_id": "agent.research_tools",
        "citation": null,
        "confidence": 1,
        "evidence_status": "internal_record",
        "retrieved_at": "2026-10-14T12:00:05.000Z"
      }
    ]
  }
}
```

`result` is `null` until the mission finishes. Its shape depends on `kind`:

| kind | result fields |
| --- | --- |
| `mission.research` | `mission:"research"`, `outcome`, `state`, `answer` (Markdown, masked), `envelope` (the typed `lc.ask.result` v1 card, same as the Ask surface; `null` if it did not fit), `cost_usd`, `model_calls`, `tool_calls`, `web_searches`, `property_refs`, `citations` (count), `approvals` (pending approvals the ask prepared), `drafts` (draft campaigns it created), `findings` (count), `parent_job_id` |
| `mission.supervisor` | `mission:"supervisor"`, `outcome` (`COMPLETED` / `PARTIAL` / `PARTIAL_TIMEOUT`), `answer` (consolidated), `method` (`model` / `deterministic`), `split_source` (`operator` / `model` / `single`), `children: [{ i, job_id, state, outcome, cost_usd }]`, `property_refs`, `approvals`, `cost_usd` (own), `children_cost_usd`, `total_cost_usd`, `findings` |
| `acquisition.discovery` | `mission:"discovery"`, `generation`, `idle`, `scanned`, `screened`, `excluded: { no_verified_contact, suppressed, deceased_only_or_unverified, prior_touch, no_credible_evidence, already_surfaced }`, `candidates: [{ property_ref, rank, deterministic_score, model_score }]`, `rank_method`, `cost_usd`, `findings`, `draft: { status, campaign_id?, approval?: { approval_id, expires_at, state } , code? }`, `cursor_after`, `pass_done` |
| `conversation.review_digest` | `mission:"review_digest"`, `window`, `missions`, `findings`, `shadow_decisions`, `approvals_waiting`, `findings_recorded` |
| `ops.health_check` | R2 shape: `healthy`, `checked_at`, `heartbeats`, `queue`, `findings` |

Finding types: `mission.answer`, `mission.property_evidence`, `mission.web_citation`,
`mission.approval_pending`, `mission.draft_campaign`, `mission.consolidated`, `mission.sub_mission`,
`discovery.candidate` (value: `property_ref`, `rank`, `deterministic_score`, `model_score`, `why[]`,
`signals[]`, `evidence: [{ source, field, value }]`, `screening: { verified_contact, suppressed,
deceased_only, prior_touch, credible_evidence }`, `generation`), `discovery.batch`, `discovery.draft`,
`digest.morning`, and the R2 `ops.*` types.

Events: the R2 append-only `agent.job_event` stream — `job.enqueued`, `job.claimed`, `job.started`,
`job.step` (payload `step` = `ask` · `ask.done` · `findings` · `split` · `enqueue` · `wait` · `consolidate.done` · `scan.done` · `rank.done` · `draft.done` · `watermark` …),
`job.budget_reserved`, `job.budget_settled`, `job.budget_released`, `job.finding`, `job.retrying`
(a yield or a retry), `job.lease_expired`, `job.cancel_requested`, `job.completed`, `job.failed`,
`job.cancelled`, `job.budget_blocked`, `job.dead_letter`. Payloads hold codes, counts, ids and costs
only. Poll with `events_after=<events_cursor>`; nothing animates state that is not in this stream.

## POST /api/cockpit/agent/missions

Body:

```json
{
  "kind": "mission.research",
  "question": "Research the distress and equity evidence for property 2124415662 and cite the sources.",
  "context": { "campaign_id": "uuid?", "property_ids": ["2124415662"] },
  "budget_usd": 0.5,
  "max_model_calls": 4,
  "priority": 100
}
```

```json
{
  "kind": "mission.supervisor",
  "question": "Compare acquisition evidence across the Dallas, Minneapolis and Houston audiences.",
  "sub_questions": ["Dallas audience evidence.", "Minneapolis audience evidence.", "Houston audience evidence."],
  "per_mission_budget_usd": 0.4,
  "budget_usd": 0.25
}
```

| Field | Rules |
| --- | --- |
| `kind` | `mission.research` or `mission.supervisor` only (`422 KIND_NOT_CREATABLE` otherwise; scheduled kinds are created by schedules) |
| `question` | 1–2000 chars, required |
| `context` | optional; `property_ids` ≤ 10 |
| `sub_questions` | supervisor only, ≤ 3; omitted ⇒ one Haiku split call (≤ 3) |
| `budget_usd` | the mission's own ceiling, 0.01–2.50 (default 0.50 research / 0.25 supervisor) |
| `per_mission_budget_usd` | supervisor: each child's ceiling, 0.01–1.00 (default 0.50) |
| `max_model_calls` | 1–4 (an ask must fit one bounded tick) |

`201` (new) / `200` (same request within the UTC hour — idempotent):

```json
{ "ok": true, "status": "executed", "mission_id": "mjob_…", "state": "queued", "deduped": false }
```

Refusals come from the capability plane, e.g. `423 AGENT_READ_ONLY` / `423 CAPABILITY_WRITES_DISABLED`
(the capability write ceiling), `422 INPUT_INVALID` (`detail` = schema errors), `422 QUESTION_REQUIRED`,
`429 DAILY_CAP` / `RATE_LIMITED`, `403 NOT_A_MEMBER`, `503 CAPABILITIES_UNCONFIGURED`.

## POST /api/cockpit/agent/missions/:id/cancel

No body. `200` (immediate) / `202` (cooperative — the mission was running; it stops at its next step
boundary or heartbeat, an in-flight model call is aborted and its reserve stays counted):

```json
{ "ok": true, "mission_id": "mjob_…", "state": "cancelled", "pending": false, "noop": false, "children": [{ "mission_id": "mjob_…", "state": "cancelled", "pending": false }] }
```

`noop: true` when the mission had already ended. `children` lists a supervisor's sub-missions cancelled
with it (empty otherwise).

## Polling guidance

`GET /missions` every 10–30 s while any listed mission is non-terminal; `GET /missions/:id?events_after=<cursor>`
every 3–5 s while the detail view is open. The runtime tick runs once a minute; a supervisor re-checks its
children every `backoff_base_seconds` (default 30 s) after the tick that yields.
