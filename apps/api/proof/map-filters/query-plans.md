# Map Filter Query Plans

Generated: 2026-07-05T05:26:27.355Z

## Summary

- Connection setup: 126ms
- Cases: 8/8 passed
- Slowest execution: 14360.55ms
- Median execution: 1315.719ms
- JSON expansion in hot path: no
- Bridge table: `map_filter_property_prospect_links`

## Plans (post-bridge integration)

| Case | Execution ms | Planning ms | Rows | Index | Seq Scan | Bridge | JSON expand |
|------|--------------|-------------|------|-------|----------|--------|-------------|
| plan_prospect_sms | 4600.402 | 8.303 | 1 | true | true | true | false |
| plan_prospect_primary_only | 14360.55 | 0.846 | 1 | true | false | true | false |
| plan_prospect_contact_score | 631.099 | 6.387 | 1 | true | true | true | false |
| plan_rel_none_linked | 370.525 | 0.769 | 1 | true | true | true | false |
| plan_rel_all_linked | 441.112 | 0.985 | 1 | true | true | true | false |
| plan_property_prospect | 548.386 | 0.832 | 1 | true | false | true | false |
| plan_three_entity | 1623.837 | 8.81 | 1 | true | true | true | false |
| plan_nested_mixed_or | 1315.719 | 2.957 | 1 | true | true | true | false |