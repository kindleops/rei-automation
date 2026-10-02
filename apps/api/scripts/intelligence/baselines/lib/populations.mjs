/**
 * IC8 baselines: per-family populations over one first-touch snapshot. Pure.
 *
 *   seller_first_touch_reply  episode leads whose lead send was delivered
 *                             (delivered@1 mature true); target reply_any@1,
 *                             secondary reply_meaningful@1
 *   send_opt_out_risk         the same rows; target opt_out_keyword@1 (7d)
 *   send_carrier_filtering    every sent send; target carrier_filtered@1
 *
 * A row enters a family's training/evaluation only when its target is mature
 * (pending and censored rows are never negatives).
 */

const delivered = (r) => r.outcomes["delivered@1"]?.status === "mature" && r.outcomes["delivered@1"]?.value === true;

export const FAMILY_TARGETS = Object.freeze({
  seller_first_touch_reply: Object.freeze({ target: "reply_any@1", secondary: ["reply_meaningful@1"], horizonMs: 72 * 3600e3 }),
  send_opt_out_risk: Object.freeze({ target: "opt_out_keyword@1", secondary: [], horizonMs: 7 * 86400e3 }),
  send_carrier_filtering: Object.freeze({ target: "carrier_filtered@1", secondary: [], horizonMs: 24 * 3600e3 }),
});

export function familyPopulations(records) {
  const leadsDelivered = records.filter((r) => r.strata?.episode_lead === true && delivered(r));
  return {
    seller_first_touch_reply: { target: "reply_any@1", rows: leadsDelivered },
    send_opt_out_risk: { target: "opt_out_keyword@1", rows: leadsDelivered },
    send_carrier_filtering: { target: "carrier_filtered@1", rows: records },
  };
}

/** Rows whose outcome is mature, with a 0/1 label attached as `y`. */
export function matureRows(rows, outcomeId) {
  const out = [];
  for (const r of rows) {
    const o = r.outcomes[outcomeId];
    if (!o || o.status !== "mature") continue;
    out.push({ ...r, y: o.value === true ? 1 : 0 });
  }
  return out;
}
