/**
 * Contact-window timezone resolution for property-based outreach.
 *
 * ROOT CAUSE THIS ADDRESSES
 * `campaign_targets.timezone` is inherited from `master_owners.routing_timezone`,
 * which is derived from the OWNER'S phone area code — not from where the
 * property is. For an absentee owner that is simply the wrong geography.
 *
 * Measured in production (2026-08-17, read-only), 20 ready targets disagree with
 * their own property's state. In every one of them `target.timezone` equals
 * `master_owners.routing_timezone` exactly, while `properties.property_address_state`
 * and `property_address_zip` are correct. Examples:
 *
 *     property Cleveland OH 44103, owner phone +1415 ... stored "Pacific"
 *     property Fort Worth TX 76110, owner phone +1626 ... stored "Pacific"
 *     property Los Angeles CA 90011, owner phone +1623 ... stored "Mountain"
 *
 * A stored "Pacific" on an Ohio property means an 08:00 local send fires at
 * 11:00 Eastern — late, not early, so that direction is merely wrong rather
 * than unsafe. The reverse (CA property stored "Eastern") sends at 08:00
 * Eastern = 05:00 Pacific, which is a pre-dawn text. That is the failure mode
 * worth engineering against.
 *
 * WHAT THIS MODULE DOES NOT DO
 * It does not invent business hours. The window is the existing operator
 * setting (queue_contact_window_start/end, currently 08:00-21:00) and the
 * label→IANA mapping is the existing `mapQueueTimezoneToIana`. This module only
 * answers "which timezone is this target actually in, and how sure are we".
 *
 * FAIL CLOSED
 * `mapQueueTimezoneToIana` silently returns America/Chicago for anything it
 * does not recognise. That default is fine for scheduling arithmetic but is
 * not acceptable as a compliance decision, because an unresolvable timezone
 * becomes a confident Central send. Here, unresolvable is its own outcome and
 * the caller is expected to exclude it.
 */

const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();

/** Resolution confidence. */
export const TZ_STATUS = {
  VALID: "VALID", // derived confidently, stored value agrees
  CORRECTED: "CORRECTED", // derived confidently, stored value disagreed
  AMBIGUOUS: "AMBIGUOUS", // cannot derive confidently (split state, unusable ZIP)
  MISSING: "MISSING", // no usable geography at all
};

/**
 * States that sit entirely in one zone. Confident from the state alone.
 * Arizona is deliberately absent: it is Mountain but does not observe DST, so
 * it needs its own IANA zone and is handled below.
 */
const SINGLE_ZONE_STATES = {
  // Eastern
  CT: "Eastern", DE: "Eastern", DC: "Eastern", GA: "Eastern", ME: "Eastern",
  MD: "Eastern", MA: "Eastern", NH: "Eastern", NJ: "Eastern", NY: "Eastern",
  NC: "Eastern", OH: "Eastern", PA: "Eastern", RI: "Eastern", SC: "Eastern",
  VT: "Eastern", VA: "Eastern", WV: "Eastern",
  // Central
  AL: "Central", AR: "Central", IL: "Central", IA: "Central", LA: "Central",
  MN: "Central", MS: "Central", MO: "Central", OK: "Central", WI: "Central",
  // Mountain
  CO: "Mountain", MT: "Mountain", NM: "Mountain", UT: "Mountain", WY: "Mountain",
  // Pacific
  CA: "Pacific", WA: "Pacific", NV: "Pacific",
  // Non-contiguous
  AK: "Alaska", HI: "Hawaii",
};

/**
 * States split across zones. Resolving these requires the ZIP, and an
 * unresolvable ZIP here is AMBIGUOUS rather than a guess.
 *
 * Each entry lists the minority-zone ZIP-3 prefixes; anything else in that
 * state falls to `majority`. Ranges are inclusive and expressed as ZIP-3
 * integers, which is the granularity at which US timezone boundaries are
 * commonly published.
 */
const SPLIT_ZONE_STATES = {
  FL: { majority: "Eastern", minority: "Central", prefixes: [[323, 325]] }, // panhandle
  TX: { majority: "Central", minority: "Mountain", prefixes: [[798, 799], [885, 885]] }, // El Paso / Hudspeth
  TN: { majority: "Central", minority: "Eastern", prefixes: [[373, 374], [376, 379]] }, // east TN
  KY: { majority: "Eastern", minority: "Central", prefixes: [[420, 427]] }, // western KY
  IN: { majority: "Eastern", minority: "Central", prefixes: [[463, 464], [476, 478]] },
  MI: { majority: "Eastern", minority: "Central", prefixes: [[498, 499]] }, // western UP
  KS: { majority: "Central", minority: "Mountain", prefixes: [[677, 679]] },
  NE: { majority: "Central", minority: "Mountain", prefixes: [[691, 693]] },
  ND: { majority: "Central", minority: "Mountain", prefixes: [[586, 588]] },
  SD: { majority: "Central", minority: "Mountain", prefixes: [[576, 577]] },
  OR: { majority: "Pacific", minority: "Mountain", prefixes: [[977, 979]] },
  ID: { majority: "Mountain", minority: "Pacific", prefixes: [[838, 838]] }, // northern ID
};

/** Arizona observes no DST, so it cannot share America/Denver. */
const ARIZONA = { label: "Mountain", iana: "America/Phoenix" };

/**
 * Label → IANA. Mirrors the queue's existing mapping, but WITHOUT the silent
 * Central fallback: an unknown label returns null so the caller can fail closed.
 */
const LABEL_TO_IANA = {
  Eastern: "America/New_York",
  Central: "America/Chicago",
  Mountain: "America/Denver",
  Pacific: "America/Los_Angeles",
  Alaska: "America/Anchorage",
  Hawaii: "Pacific/Honolulu",
};

export function timezoneLabelToIana(label) {
  return LABEL_TO_IANA[clean(label)] || null;
}

function zip3(zip) {
  const digits = clean(zip).replace(/[^0-9]/g, "");
  if (digits.length < 5) return null; // a 3- or 4-char ZIP is malformed, not a prefix
  const prefix = Number.parseInt(digits.slice(0, 3), 10);
  return Number.isFinite(prefix) ? prefix : null;
}

function inRanges(prefix, ranges = []) {
  return ranges.some(([low, high]) => prefix >= low && prefix <= high);
}

/**
 * Derive the timezone a property actually sits in.
 *
 * @returns {{label: string|null, iana: string|null, basis: string, confident: boolean}}
 */
export function deriveTimezoneFromGeography(state, zip) {
  const st = upper(state);
  if (!st) return { label: null, iana: null, basis: "no_state", confident: false };

  if (st === "AZ") {
    return { label: ARIZONA.label, iana: ARIZONA.iana, basis: "state_az_no_dst", confident: true };
  }

  const single = SINGLE_ZONE_STATES[st];
  if (single) {
    return { label: single, iana: timezoneLabelToIana(single), basis: "state_single_zone", confident: true };
  }

  const split = SPLIT_ZONE_STATES[st];
  if (split) {
    const prefix = zip3(zip);
    if (prefix === null) {
      // Split state with no usable ZIP. Picking the majority zone here would be
      // right most of the time, which is exactly what makes it dangerous.
      return { label: null, iana: null, basis: "split_state_zip_unusable", confident: false };
    }
    const label = inRanges(prefix, split.prefixes) ? split.minority : split.majority;
    return { label, iana: timezoneLabelToIana(label), basis: "state_zip_split_zone", confident: true };
  }

  return { label: null, iana: null, basis: "state_unrecognised", confident: false };
}

/**
 * Resolve the contact-window timezone for one target.
 *
 * @param {object} input
 * @param {string} input.storedTimezone  campaign_targets.timezone (owner-phone derived)
 * @param {string} input.propertyState   properties.property_address_state
 * @param {string} input.propertyZip     properties.property_address_zip
 * @param {string} [input.targetState]   campaign_targets.state, used only as a
 *                                       fallback when the joined property row
 *                                       is unavailable.
 */
export function resolveContactTimezone(input = {}) {
  const stored = clean(input.storedTimezone);
  const state = clean(input.propertyState) || clean(input.targetState);
  const zip = clean(input.propertyZip);

  if (!state && !zip) {
    return {
      status: TZ_STATUS.MISSING,
      timezone: null,
      iana: null,
      stored: stored || null,
      basis: "no_geography",
      reason: "no property state or zip to derive from",
    };
  }

  const derived = deriveTimezoneFromGeography(state, zip);

  if (!derived.confident) {
    return {
      status: TZ_STATUS.AMBIGUOUS,
      timezone: null,
      iana: null,
      stored: stored || null,
      basis: derived.basis,
      reason: `cannot confidently derive timezone for state=${upper(state) || "?"} zip=${zip || "?"}`,
    };
  }

  if (!stored) {
    // We know where the property is; the target simply had no stored value.
    // That is a correction, not an ambiguity.
    return {
      status: TZ_STATUS.CORRECTED,
      timezone: derived.label,
      iana: derived.iana,
      stored: null,
      basis: derived.basis,
      reason: "no stored timezone; derived from property geography",
    };
  }

  if (clean(stored) === derived.label) {
    return {
      status: TZ_STATUS.VALID,
      timezone: derived.label,
      iana: derived.iana,
      stored,
      basis: derived.basis,
      reason: "stored timezone agrees with property geography",
    };
  }

  return {
    status: TZ_STATUS.CORRECTED,
    timezone: derived.label,
    iana: derived.iana,
    stored,
    basis: derived.basis,
    reason: `stored "${stored}" disagrees with property geography ("${derived.label}"); geography wins`,
  };
}

/**
 * Is `instant` inside the contact window for this IANA zone?
 *
 * DST-correct: local wall-clock hour/minute is read via Intl in the target
 * zone, so the same UTC instant yields different local hours in July and
 * January without any offset arithmetic here.
 *
 * Window bounds come from the operator settings; this function does not choose
 * them. `endHour` is treated as exclusive-at-the-minute — 21:00 means the last
 * sendable minute is 20:59, matching "no texts after 9pm".
 */
export function isWithinContactWindow(instant, iana, startHour = 8, endHour = 21) {
  if (!iana) return { ok: false, reason: "no_timezone" };

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: iana,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);

  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  // Intl can render midnight as hour 24 in some locales/zones; normalise it.
  const hour = get("hour") % 24;
  const minute = get("minute");

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { ok: false, reason: "unreadable_local_time" };
  }

  const minutes = hour * 60 + minute;
  const open = startHour * 60;
  const close = endHour * 60;

  return {
    ok: minutes >= open && minutes < close,
    reason: minutes < open ? "before_window" : minutes >= close ? "after_window" : "within_window",
    local_hour: hour,
    local_minute: minute,
  };
}

/**
 * Canary policy: only a VALID resolution may be contacted in the first live
 * canary.
 *
 * CORRECTED is safe for ordinary operation — geography is the better source and
 * the correction is recorded — but a target whose stored timezone had to be
 * overridden is not the right subject for the first five real messages. The
 * canary exists to test the send path, not the correction logic.
 */
export function isCanaryEligibleTimezone(resolution) {
  return resolution?.status === TZ_STATUS.VALID;
}
