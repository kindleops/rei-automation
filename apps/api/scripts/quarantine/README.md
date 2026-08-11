# Quarantined one-off operator scripts

Root-level launch/feeder scripts with live `dry_run:false` inserts and direct
service-role access, moved here during the production-readiness hardening pass
(bypass audit P1). They are preserved for forensic reference only.

Do NOT run these. The canonical enqueue paths are the campaign queue plan and
the seller-flow schedulers; the canonical dispatcher is /api/internal/queue/run.
