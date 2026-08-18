import assert from "node:assert/strict";
import test from "node:test";

import {
  TZ_STATUS,
  deriveTimezoneFromGeography,
  isCanaryEligibleTimezone,
  isWithinContactWindow,
  resolveContactTimezone,
  timezoneLabelToIana,
} from "@/lib/domain/campaigns/contact-window-timezone.js";

// Window bounds are the existing operator settings (queue_contact_window_start
// = 08:00, queue_contact_window_end = 21:00). These tests use them as given
// and do not assert any new business hours.
const OPEN_HOUR = 8;
const CLOSE_HOUR = 21;

// ── geography → timezone ──────────────────────────────────────────────────

test("a California property resolves Pacific", () => {
  const derived = deriveTimezoneFromGeography("CA", "90011");

  assert.equal(derived.label, "Pacific");
  assert.equal(derived.iana, "America/Los_Angeles");
  assert.equal(derived.confident, true);
});

test("a Texas property resolves Central, and El Paso resolves Mountain", () => {
  const fortWorth = deriveTimezoneFromGeography("TX", "76110");
  assert.equal(fortWorth.label, "Central");
  assert.equal(fortWorth.confident, true);

  // Texas is a split state: El Paso (798xx/799xx) is Mountain.
  const elPaso = deriveTimezoneFromGeography("TX", "79901");
  assert.equal(elPaso.label, "Mountain");
  assert.equal(elPaso.confident, true);
});

test("ZIPs crossing a timezone boundary resolve on the correct side", () => {
  // Florida: peninsula Eastern, panhandle (323-325) Central.
  assert.equal(deriveTimezoneFromGeography("FL", "33101").label, "Eastern"); // Miami
  assert.equal(deriveTimezoneFromGeography("FL", "32401").label, "Central"); // Panama City

  // Tennessee: mostly Central, east (373-374, 376-379) Eastern.
  assert.equal(deriveTimezoneFromGeography("TN", "38103").label, "Central"); // Memphis
  assert.equal(deriveTimezoneFromGeography("TN", "37902").label, "Eastern"); // Knoxville
});

test("Arizona gets a non-DST zone rather than America/Denver", () => {
  const az = deriveTimezoneFromGeography("AZ", "85001");

  assert.equal(az.label, "Mountain");
  assert.equal(az.iana, "America/Phoenix");
});

test("a malformed or missing ZIP in a split state is not guessed", () => {
  for (const zip of ["", null, "abc", "7611"]) {
    const derived = deriveTimezoneFromGeography("TX", zip);
    assert.equal(
      derived.confident,
      false,
      `TX with zip ${JSON.stringify(zip)} must not resolve confidently`
    );
  }
});

test("a malformed ZIP in a single-zone state still resolves", () => {
  // The ZIP adds nothing in Ohio — the state alone is decisive.
  const derived = deriveTimezoneFromGeography("OH", "");

  assert.equal(derived.label, "Eastern");
  assert.equal(derived.confident, true);
});

test("an unknown label has no IANA zone rather than defaulting to Central", () => {
  assert.equal(timezoneLabelToIana("Pacific"), "America/Los_Angeles");
  assert.equal(timezoneLabelToIana("Nonsense"), null);
  assert.equal(timezoneLabelToIana(""), null);
});

// ── resolution status ─────────────────────────────────────────────────────

test("agreeing stored timezone is VALID", () => {
  const resolution = resolveContactTimezone({
    storedTimezone: "Pacific",
    propertyState: "CA",
    propertyZip: "90011",
  });

  assert.equal(resolution.status, TZ_STATUS.VALID);
  assert.equal(resolution.timezone, "Pacific");
  assert.equal(isCanaryEligibleTimezone(resolution), true);
});

test("the production defect shape — OH property stored Pacific — is CORRECTED", () => {
  // Real row: Cleveland OH 44103 with an owner phone of +1415, stored "Pacific"
  // because timezone was inherited from master_owners.routing_timezone.
  const resolution = resolveContactTimezone({
    storedTimezone: "Pacific",
    propertyState: "OH",
    propertyZip: "44103",
  });

  assert.equal(resolution.status, TZ_STATUS.CORRECTED);
  assert.equal(resolution.timezone, "Eastern");
  assert.equal(resolution.stored, "Pacific");
});

test("the unsafe direction — CA property stored Eastern — is CORRECTED, not trusted", () => {
  // Trusting "Eastern" would send at 08:00 ET = 05:00 PT: a pre-dawn text.
  const resolution = resolveContactTimezone({
    storedTimezone: "Eastern",
    propertyState: "CA",
    propertyZip: "90042",
  });

  assert.equal(resolution.status, TZ_STATUS.CORRECTED);
  assert.equal(resolution.timezone, "Pacific");
});

test("a corrected target is excluded from the canary", () => {
  const resolution = resolveContactTimezone({
    storedTimezone: "Pacific",
    propertyState: "TX",
    propertyZip: "76110",
  });

  assert.equal(resolution.status, TZ_STATUS.CORRECTED);
  assert.equal(isCanaryEligibleTimezone(resolution), false);
});

test("an unresolvable split state is AMBIGUOUS and excluded", () => {
  const resolution = resolveContactTimezone({
    storedTimezone: "Central",
    propertyState: "TX",
    propertyZip: "",
  });

  assert.equal(resolution.status, TZ_STATUS.AMBIGUOUS);
  assert.equal(resolution.timezone, null);
  assert.equal(isCanaryEligibleTimezone(resolution), false);
});

test("no geography at all is MISSING and excluded", () => {
  const resolution = resolveContactTimezone({ storedTimezone: "Central" });

  assert.equal(resolution.status, TZ_STATUS.MISSING);
  assert.equal(isCanaryEligibleTimezone(resolution), false);
});

test("a stored timezone is never substituted to make a target sendable", () => {
  // The stored value says Central and is the ONLY timezone information present.
  // Accepting it would be exactly the fail-open this module exists to prevent.
  const resolution = resolveContactTimezone({
    storedTimezone: "Central",
    propertyState: "",
    propertyZip: "",
  });

  assert.notEqual(resolution.timezone, "Central");
  assert.equal(resolution.status, TZ_STATUS.MISSING);
});

// ── contact window ────────────────────────────────────────────────────────

test("a target inside the window is allowed", () => {
  // 2026-07-15 19:00Z = 12:00 in Los Angeles.
  const instant = new Date("2026-07-15T19:00:00Z");
  const verdict = isWithinContactWindow(instant, "America/Los_Angeles", OPEN_HOUR, CLOSE_HOUR);

  assert.equal(verdict.ok, true);
  assert.equal(verdict.local_hour, 12);
});

test("a target before the window is blocked", () => {
  // 2026-07-15 13:00Z = 06:00 in Los Angeles.
  const verdict = isWithinContactWindow(
    new Date("2026-07-15T13:00:00Z"),
    "America/Los_Angeles",
    OPEN_HOUR,
    CLOSE_HOUR
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "before_window");
});

test("a target after the window is blocked", () => {
  // 2026-07-16 05:00Z = 22:00 previous day in Los Angeles.
  const verdict = isWithinContactWindow(
    new Date("2026-07-16T05:00:00Z"),
    "America/Los_Angeles",
    OPEN_HOUR,
    CLOSE_HOUR
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "after_window");
});

test("the window boundaries are exact", () => {
  // 15:00Z = 08:00 PDT exactly — open.
  const atOpen = isWithinContactWindow(
    new Date("2026-07-15T15:00:00Z"),
    "America/Los_Angeles",
    OPEN_HOUR,
    CLOSE_HOUR
  );
  assert.equal(atOpen.ok, true);
  assert.equal(atOpen.local_hour, 8);

  // One minute earlier is closed.
  const beforeOpen = isWithinContactWindow(
    new Date("2026-07-15T14:59:00Z"),
    "America/Los_Angeles",
    OPEN_HOUR,
    CLOSE_HOUR
  );
  assert.equal(beforeOpen.ok, false);

  // 04:00Z next day = 21:00 PDT exactly — closed (last sendable minute 20:59).
  const atClose = isWithinContactWindow(
    new Date("2026-07-16T04:00:00Z"),
    "America/Los_Angeles",
    OPEN_HOUR,
    CLOSE_HOUR
  );
  assert.equal(atClose.ok, false);
  assert.equal(atClose.local_hour, 21);

  const beforeClose = isWithinContactWindow(
    new Date("2026-07-16T03:59:00Z"),
    "America/Los_Angeles",
    OPEN_HOUR,
    CLOSE_HOUR
  );
  assert.equal(beforeClose.ok, true);
  assert.equal(beforeClose.local_hour, 20);
});

test("the same UTC instant is judged differently in summer and winter (DST-aware)", () => {
  // 15:00Z is 08:00 PDT in July but 07:00 PST in January. A fixed-offset
  // implementation would call both the same and text an hour before open.
  const summer = isWithinContactWindow(
    new Date("2026-07-15T15:00:00Z"),
    "America/Los_Angeles",
    OPEN_HOUR,
    CLOSE_HOUR
  );
  const winter = isWithinContactWindow(
    new Date("2026-01-15T15:00:00Z"),
    "America/Los_Angeles",
    OPEN_HOUR,
    CLOSE_HOUR
  );

  assert.equal(summer.local_hour, 8);
  assert.equal(summer.ok, true);
  assert.equal(winter.local_hour, 7);
  assert.equal(winter.ok, false);
});

test("Arizona does not shift with daylight saving", () => {
  // 15:00Z is 08:00 in Phoenix in both July and January, because Arizona keeps
  // MST year-round. Mapping it to America/Denver would break this.
  const summer = isWithinContactWindow(
    new Date("2026-07-15T15:00:00Z"),
    "America/Phoenix",
    OPEN_HOUR,
    CLOSE_HOUR
  );
  const winter = isWithinContactWindow(
    new Date("2026-01-15T15:00:00Z"),
    "America/Phoenix",
    OPEN_HOUR,
    CLOSE_HOUR
  );

  assert.equal(summer.local_hour, 8);
  assert.equal(winter.local_hour, 8);
});

test("no timezone means no send decision", () => {
  const verdict = isWithinContactWindow(new Date("2026-07-15T19:00:00Z"), null);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "no_timezone");
});
