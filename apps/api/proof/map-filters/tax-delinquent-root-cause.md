# Tax Delinquent Quick Filter — Root Cause

**Status:** Removed from launch UI (not in `VERIFIED_QUICK_PRESET_KEYS`).

## Observed failure

- Quick filter `tax_delinquent` triggered preview `500` with `count_query_failed`.
- UI still showed the 124,046-property fallback while preview failed.

## Investigation

### Expression and compile path

The preset expression is valid and compiles:

```json
{
  "fieldKey": "property.tax_delinquent",
  "operator": "is_true",
  "value": true
}
```

Compile succeeds; failure occurs in `countMapFilterEntities()` during entity count phases.

### Actual root cause (production blocker)

Preview was failing for **all** filters — including empty/no-filter — at the **phone** count phase:

```
phase: phone
error: count_query_failed
message: relation "map_filter_property_phone_links" does not exist
```

The `map_filter_property_phone_links` bridge table is required by `buildPhoneCountFromMatchingSql()` in `map-filter-predicate-sql.js`. Migration `20260706120000_map_filter_property_phone_links.sql` existed locally but had not been applied to production.

Tax Delinquent was a visible symptom, not a field-specific SQL bug.

### Secondary issues (now gated)

| Issue | Resolution |
|-------|------------|
| Phone links table missing | Apply migration; table-only migration applied; full rebuild pending |
| UI fallback to 124K on preview error | Fixed: Results/CTA no longer show success counts when preview fails |
| Broken presets visible | `getMapFilterPresets()` now returns verified allowlist only |
| Tax Delinquent in quick filters | Removed until full pipeline proof passes |

## Remediation

1. **Database:** Ensure `map_filter_property_phone_links` exists and is populated via `rebuild_map_filter_property_phone_links()`.
2. **UI:** Hide `tax_delinquent` until it passes `npm run proof:master-filters`.
3. **Proof:** Re-enable only after `preset:tax_delinquent` returns preview 200 + finite `matchingProperties`.

## Direct SQL equivalent (property predicate only)

```sql
SELECT COUNT(DISTINCT property_id)::bigint
FROM properties
WHERE latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND tax_delinquent IS TRUE;
```

Phone/prospect/owner counts still require link-bridge tables even when the property predicate is simple boolean.