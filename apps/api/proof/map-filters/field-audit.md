# Map Filter Field Audit (Pooler SQL)

Generated: 2026-07-05T05:36:23.972Z
Mode: live-pooler
Registry fields: 174
Drift items: 0
Failed fields: 0
OK: true

## Resolved population drift (registry v2026-07-05.1)

- **Field:** `property.master_owner_id`
- **Previous baseline:** 124,046 (100% coverage — incorrectly assumed all properties carry an owner link)
- **Live populated:** 41,530 (33.5% coverage)
- **Difference:** -82,516
- **Cause:** Stale registry coverage metadata, not schema failure or filter semantics change
- **Action:** Updated `populatedRows` to 41,530 in registry v2026-07-05.1; filter predicates unchanged
