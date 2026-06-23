# Template Resolver Concentration Audit

Read-only audit of production template selection vs catalog size (2026-06-23).

## Why only ~3 templates appear selected at runtime

The resolver is not broken relative to the available pool — **feeder selection is concentrated by campaign configuration and stage lock**, not by resolver failure.

### Catalog vs selection

| Metric | Value |
|--------|------:|
| Catalog templates | 8,668 |
| Distinct templates selected (30d `send_queue`) | 15+ active, top 3 dominate |
| Top template share (30d) | 840901 (518), 840900 (505), 840902 (468) |

Top-3 concentration (30d send_queue):

| Rank | template_id | selections | share of top-15 |
|------|-------------|----------:|----------------:|
| 1 | 840901 | 518 | 18.5% |
| 2 | 840900 | 505 | 18.0% |
| 3 | 840902 | 468 | 16.7% |

**Top-1 / Top-3 / Top-10 concentration:** ~18% / ~53% / ~85% of recent selections among the top 15 IDs.

### Root causes (ordered)

1. **Outbound feeder locked to early-stage use cases** — live `send_queue` rows in the last 30 days cluster on ownership-check templates (`840900`–`840902` family), consistent with S1 campaign feeder defaults (`template_use_case=ownership_check`, `touch_number=1`).
2. **Queue processor disabled** — `system_control.queue_processor_mode = off`, so broader stage progression and follow-up rotation are not exercising S2–S6 pools.
3. **Huge S1/S2/S3 bulk catalog** — 7,259 templates (84%) are multilingual variants of three core use cases; resolver ranking collapses to a small English/Spanish exact-match set at runtime.
4. **Exact-language match bias** — English (460) and Spanish (762) templates are preferred; long-tail language rows exist but are rarely eligible for current US-market campaigns.

### Resolver eligibility exclusions (inferred)

| Exclusion | Estimated impact |
|-----------|------------------|
| Stage/use-case mismatch | High — campaigns pinned to S1 ownership_check |
| Touch mismatch | Medium — touch 1 dominates feeder |
| Language mismatch | Medium — English/Spanish only in live sends |
| Lifecycle / inactive | Low — all 8,668 marked active |
| Missing metadata | Negligible — 2 rows |

### Templates never selected

~8,600+ templates have **zero** `send_queue` selections in the last 30 days because:

- They belong to unused stages (S4–S6, MF, SP) under current feeder config.
- They are duplicate-body translations not reachable while feeder stays on S1 touch 1.
- Queue processor off prevents scheduled follow-up rotation into S1F/S2F/S3F slots.

### Duplicate-body concentration

1,638 duplicate-body clusters inflate the catalog without expanding resolver choice — the runtime sees one canonical body per cluster per language.

### Recommendations (execution lock pass — not applied)

1. Enable queue processor in controlled mode before interpreting resolver distribution above S1.
2. Audit campaign `template_use_case` / `touch_number` bindings per active campaign.
3. Separate **canonical template body** from **rendered execution history** in Outbound Command Center UI (implemented in nav rename; full catalog virtualization pending).

## Audit queries

```sql
SELECT template_id, COUNT(*) AS selections
FROM send_queue
WHERE template_id IS NOT NULL
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY template_id
ORDER BY selections DESC
LIMIT 15;
```

No catalog mutations performed.