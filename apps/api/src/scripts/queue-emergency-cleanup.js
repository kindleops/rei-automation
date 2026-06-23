import { supabase } from "@/lib/supabase/client.js";
import { reconcileCanonicalQueueLifecycle } from "@/lib/supabase/sms-engine.js";

function clean(value) {
  return String(value ?? "").trim();
}

function asBoolean(value, fallback = false) {
  const v = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const dry_run = asBoolean(process.env.DRY_RUN ?? "true", true);
  const stale_minutes = asNumber(process.env.STALE_MINUTES, 180);
  const lease_minutes = asNumber(process.env.LEASE_MINUTES, 10);
  const max_rows = asNumber(process.env.MAX_ROWS, 5000);

  const result = await reconcileCanonicalQueueLifecycle(
    {
      dry_run,
      stale_minutes,
      lease_minutes,
      max_rows,
    },
    { supabase }
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "queue_emergency_cleanup",
        dry_run,
        stale_minutes,
        lease_minutes,
        max_rows,
        result,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: "queue_emergency_cleanup_failed",
        message: error?.message || "unknown_error",
      },
      null,
      2
    )
  );
  process.exit(1);
});

