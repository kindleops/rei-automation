# Acquisition Multilingual Template Routing

**Version:** 2.0.0  
**Status:** Implemented — catalog-driven, no EN/ES/RU allowlists

## Design Principles

1. **Catalog-driven languages** — runtime discovers languages from Supabase template data
2. **Central adapter** — all paths normalize through `canonical-language-adapter.js`
3. **ISO-style codes** — canonical display names map to ISO 639-1 (`en`, `es`, `pt`, `he`, `ja`, `zh`, …)
4. **Locale preservation** — `pt-BR`, `zh-CN`, `zh-TW`, `he-IL` preserved when materially relevant
5. **Exact language match** — no silent English fallback in acquisition resolver/feeder scoring
6. **No workflow rewrite per language** — new languages available via template data only

## Canonical Language Adapter

**Module:** `apps/api/src/lib/domain/templates/canonical-language-adapter.js`

```javascript
resolveCanonicalLanguage(raw) → {
  canonical,   // e.g. "Portuguese"
  iso,         // e.g. "pt"
  locale,      // e.g. "pt-BR" or null
  raw,
  malformed,
  unsupported
}
```

Extends legacy `language_aliases.js` (16 verified languages). New catalog values register via `registerCatalogLanguage()` without code deployment.

### ISO Mapping (primary)

| Canonical | ISO |
|-----------|-----|
| English | en |
| Spanish | es |
| Portuguese | pt |
| Italian | it |
| French | fr |
| German | de |
| Hebrew | he |
| Mandarin | zh |
| Japanese | ja |
| Russian | ru |
| Arabic | ar |
| Vietnamese | vi |
| Greek | el |
| Polish | pl |
| Korean | ko |
| Asian Indian (Hindi or Other) | hi |

## Template Lifecycle (selection gate)

Only `enabled` templates are selectable. Removed gates:

- ~~`review_required`~~ → maps to `draft`
- ~~`approved_for_automatic_reply`~~ → maps to `enabled`
- `safe_for_auto_reply` — backward-compatible metadata only; does not block enabled templates

## Runtime Template Selection Contract

**Module:** `apps/api/src/lib/domain/templates/template-runtime-resolver.js`

### Primary match key (deterministic)

1. `stage_code` (S1–S6)
2. `canonical language` (exact match; locale when both specify)
3. `use_case` / inbound classification
4. `touch_number` / attempt class
5. `asset_type` / `scenario` (when applicable)
6. `lifecycle = enabled`
7. Required merge variables available

### Optional ranking factors

- Delivery rate / success rate
- Reply rate / historical reply rate
- Recent use penalty (rotation)
- Deterministic hash tie-breaker

### Resolver output

```javascript
{
  ok: true,
  template_id,
  candidate_pool_size,
  match_dimensions: { stage_code, use_case, language, touch_number, ... },
  ranking_reason: ['exact_language_match', 'touch_match', ...],
  excluded_candidates: [{ template_id, reason }],
  resolver_version: '2.0.0'
}
```

## Auto-Reply Policy

**Module:** `apps/api/src/lib/domain/acquisition/auto-reply-policy.js`

### Normal path

Enabled template + sufficient confidence → `queue_auto_reply`

### Low-confidence path (automated — not manual review)

```
classification confidence < threshold
  → resolveClarificationUseCase(stage, language)
  → queue_clarification (same stage, same language)
  → re-classify next inbound
  → continue workflow
```

Max clarification attempts: 2 (configurable per stage). Exhaustion → `automated_fallback`.

### Exception path (operator/system only)

- Opt-out / suppression → `terminal_suppression`
- Hostile/legal → `operator_exception`
- Configured `operator_exception` flag → `operator_exception`

`requires_human_review` deprecated in favor of `requires_operator_exception`.

## Modules Updated (EN/ES/RU assumptions removed)

| Module | Change |
|--------|--------|
| `template-metadata-normalization.js` | Delegates language to adapter |
| `template-auto-reply-selector.js` | Uses runtime resolver |
| `auto-reply-policy.js` | Catalog-driven; clarification path |
| `supabase-feeder-support.js` | Exact language match only |
| `canonical-workflow-event.js` | `automation_action`, `requires_operator_exception` |

## Feeder Language Pool

Outbound feeder mock tests now include Portuguese and Hebrew templates. Feeder scoring rejects cross-language candidates (no English +30 fallback in `supabase-feeder-support.js`).

## Adding a New Language

1. Insert templates into Supabase `sms_templates` with `language` field
2. Adapter auto-registers on first resolver inventory pass
3. No code deployment required if alias exists in `language_aliases.js`; otherwise add alias to adapter data config