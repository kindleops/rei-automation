# Verified Launch Filter Matrix

Only filters marked **PASS** may render in the production Filters UI.

Generated from `VERIFIED_LAUNCH_FILTER_DEFINITIONS` in `apps/api/src/lib/domain/map-filters/operator-filter-catalog.js`.

## Properties

| UI Label | Field | Control | Operator | Canonical Value | Launch |
|----------|-------|---------|----------|-----------------|--------|
| Property Type | `property.property_type` | enum_picker | equals | `"Multifamily 5+"`, `"Multifamily 2-4"`, `"Single Family"`, `"Commercial"`, `"Storage Units"`, `"Land"` | yes |
| Equity Percentage | `property.equity_percent` | number_range | greater_than_or_equal | `50`, `70` | yes |
| Units Count | `property.units_count` | number_range | greater_than_or_equal | `2`, `5` | yes |
| Estimated Value | `property.estimated_value` | currency_range | greater_than_or_equal | `250000` | yes |

## Prospects

| UI Label | Field | Control | Operator | Canonical Value | Launch |
|----------|-------|---------|----------|-----------------|--------|
| SMS Eligible | `prospect.sms_eligible` | boolean_segment | is_true | `true` | yes |
| Has Phone | `prospect.has_phone` | boolean_segment | has_data | `true` | yes |
| Has Email | `prospect.has_email` | boolean_segment | has_data | `true` | yes |
| Primary Prospect | `prospect.is_primary_prospect` | boolean_segment | is_true | `true` | yes |

## Master Owners

| UI Label | Field | Control | Operator | Canonical Value | Launch |
|----------|-------|---------|----------|-----------------|--------|
| Property Count | `master_owner.property_count` | number_range | greater_than_or_equal | `2`, `5` | yes |
| Portfolio Units | `master_owner.portfolio_total_units` | number_range | greater_than_or_equal | `10`, `20` | yes |

## Phones

| UI Label | Field | Control | Operator | Canonical Value | Launch |
|----------|-------|---------|----------|-----------------|--------|
| Has Canonical Phone | `phone.has_canonical_phone` | boolean_segment | has_data | `true` | yes |

## Quick Filters (verified only)

| Key | Label | Status |
|-----|-------|--------|
| `all_properties` | All Properties | launch |
| `multifamily_5_plus` | 5+ Multifamily | launch |
| `multifamily_2_4` | 2–4 Unit Owners | launch |
| `high_equity` | High Equity | launch |
| `sms_eligible` | SMS Eligible | launch |
| `has_phone` | Has Phone | launch |
| `portfolio_owner` | Portfolio Owner | launch |

## Explicitly excluded until proof passes

- Tax Delinquent (`property.tax_delinquent`) — see `tax-delinquent-root-cause.md`
- Active Lien, Vacant, Property Flags, Building Condition
- Uncontacted, Contacted
- All score/status/phone-line-type fields not in allowlist

## Pipeline gate

Each launch filter must pass:

1. Expression build
2. Compile 200
3. Preview 200 with numeric `matchingProperties`
4. Token digest creation
5. Map apply (runtime integration proof)

Run: `npm run proof:master-filters` from `apps/api`.