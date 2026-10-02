/**
 * IC8.1 coverage markets: ZIP3 groupings for every market loaded in the
 * transaction corpora (2026-10-02). The seven named research markets keep the
 * comp-snapshot-v1 ZIP3 definitions (MSP, MN553, DAL, TX751, HOU, JAX, IND);
 * the rest follow the county source folders of the comp imports. Anything
 * else falls into "<STATE>-other", so no transaction is ever dropped.
 */

export const COVERAGE_MARKETS = Object.freeze([
  { market: "MSP", state: "MN", zip3: ["554", "551"], named: true },
  { market: "MN553", state: "MN", zip3: ["553"], named: true },
  { market: "DAL", state: "TX", zip3: ["752"], named: true },
  { market: "TX751", state: "TX", zip3: ["751"], named: true },
  { market: "HOU", state: "TX", zip3: ["770"], named: true },
  { market: "JAX", state: "FL", zip3: ["322"], named: true },
  { market: "IND", state: "IN", zip3: ["462"], named: true },
  { market: "TX750", state: "TX", zip3: ["750"], named: false, note: "DFW north / Collin-Denton" },
  { market: "HOU-OUTER", state: "TX", zip3: ["773", "774", "775"], named: false, note: "Houston metro outer ring" },
  { market: "STL", state: "MO", zip3: ["630", "631"], named: false },
  { market: "ATL", state: "GA", zip3: ["300", "301", "302", "303"], named: false },
  { market: "CLT", state: "NC", zip3: ["280", "281", "282"], named: false },
  { market: "TPA", state: "FL", zip3: ["335", "336", "337", "346"], named: false },
  { market: "LA", state: "CA", zip3: ["900", "902", "906", "907", "908", "910", "913", "917", "935"], named: false },
  { market: "IE", state: "CA", zip3: ["922", "923", "924", "925"], named: false },
  { market: "SAC", state: "CA", zip3: ["956", "957", "958"], named: false },
  { market: "PHX", state: "AZ", zip3: ["850", "852", "853"], named: false },
  { market: "LV", state: "NV", zip3: ["889", "890", "891"], named: false },
]);

const BY_ZIP3 = new Map(COVERAGE_MARKETS.flatMap((m) => m.zip3.map((z) => [`${m.state}|${z}`, m.market])));

export function coverageMarket(zip, state) {
  const st = String(state ?? "").trim().toUpperCase() || "??";
  const z = String(zip ?? "").trim();
  const zip5 = z.length === 4 ? `0${z}` : z;
  const zip3 = /^\d{5}/.test(zip5) ? zip5.slice(0, 3) : null;
  return (zip3 && BY_ZIP3.get(`${st}|${zip3}`)) || `${st}-other`;
}

export const TEXAS_MARKETS = Object.freeze(COVERAGE_MARKETS.filter((m) => m.state === "TX").map((m) => m.market).concat(["TX-other"]));
