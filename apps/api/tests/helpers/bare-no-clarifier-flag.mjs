// Round 10 (owner 2026-10-08): BARE_NO_AUTO_CLARIFIER is OFF by default, so a
// bare "No" holds. Tests that exercise the clarifier itself (the "once the
// owner validates it" behaviour) turn BOTH gates on for their duration only:
// the env ceiling and the system_control.bare_no_auto_clarifier switch (primed
// in the system-control cache; no database).
import { primeSystemControlCache } from "@/lib/system-control.js";

export async function withBareNoClarifierOn(fn) {
  const prev = process.env.BARE_NO_AUTO_CLARIFIER;
  process.env.BARE_NO_AUTO_CLARIFIER = "true";
  primeSystemControlCache("bare_no_auto_clarifier", true);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BARE_NO_AUTO_CLARIFIER;
    else process.env.BARE_NO_AUTO_CLARIFIER = prev;
    primeSystemControlCache("bare_no_auto_clarifier", false);
  }
}
