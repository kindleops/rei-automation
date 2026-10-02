/**
 * IC8 comp micro-market layer v0 (offline research prototype).
 *
 * Built AS OF a date T from valid single-family sales strictly before T:
 *   1. ~1 km grid cells holding time-, size- and regime-adjusted log price
 *      levels (market-index.js);
 *   2. an adjacency graph between occupied cells (Chebyshev <= 2, so a single
 *      empty cell does not cut the graph);
 *   3. agglomerative merging of adjacent cells into micro-markets: two
 *      clusters merge only while their median level gap is NOT significant
 *      given their support (z-test on shrunk robust SDs) and below a hard cap;
 *   4. boundary classification between final micro-markets with a seeded
 *      bootstrap CI of the median level gap: discontinuity / different /
 *      similar / unknown (low support). Discontinuities are learned from
 *      transaction evidence only; no road, river or boundary data is read;
 *   5. a pooling hierarchy cell -> micro-market -> ZIP -> market with
 *      shrinkage, and a confidence per assignment (strong / weak / unknown);
 *   6. EFFECTIVE MARKET DISTANCE: shortest-path cost over the cell graph where
 *      crossing between micro-markets costs extra in proportion to the level
 *      gap and a learned discontinuity adds a barrier cost.
 *
 * Pure and deterministic (seeded bootstrap; sorted iteration everywhere).
 */
import { makeGrid, haversineKm } from './geo.js';
import { bootstrapMedianGap, hashString, median, robustSd } from './stats.js';
import { buildMarketContext, MARKET_CONTEXT_PARAMS } from './market-index.js';
import { subtractMonths } from './comp-records.js';

export const MICRO_MARKET_VERSION = 'comp-micromarket-layer-v0.1.0';

export const MICRO_MARKET_PARAMS = Object.freeze({
  cellKm: 1,
  lookbackMonths: 24,
  linkRange: 2,
  zCritMerge: 1.645,
  gapCapMerge: 0.35,
  maxClusterSales: 150,
  maxClusterCells: 16,
  priorSdWeight: 3,
  bootstrapIterations: 200,
  bootstrapAlpha: 0.1,
  discontinuityMinGap: 0.15,
  similarMaxGap: 0.08,
  edgeGapPenalty: 0.5,
  barrierKm: 4,
  barrierMaxMultiple: 3,
  unknownEdgeFactor: 1.5,
  minEdgeSupport: 3,
  shrinkCell: 4,
  shrinkCluster: 6,
  shrinkZip: 10,
  maxCostKm: 60,
});

/** Evidence the layer learns from: valid, single-family, sized, priced, before T, inside the lookback. */
export function isLayerEvidence(sale, asOf, lookbackStart) {
  return (
    sale.valid &&
    sale.family === 'sfr' &&
    !sale.attached &&
    sale.price > 0 &&
    sale.sqft > 0 &&
    Number.isFinite(sale.lat) &&
    Number.isFinite(sale.lng) &&
    sale.dedup_role !== 'loser' &&
    sale.known_date < asOf &&
    sale.sale_date >= lookbackStart
  );
}

class MinHeap {
  constructor(compare) {
    this.items = [];
    this.compare = compare;
  }

  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.compare(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.compare(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }

  get size() {
    return this.items.length;
  }
}

function mergeSorted(a, b) {
  const out = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i] <= b[j] ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

function medianOfSorted(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function shrunkSd(sorted, sigma, k) {
  const n = sorted.length;
  const s = n >= 3 ? robustSd(sorted) ?? sigma : sigma;
  return Math.sqrt((n * s * s + k * sigma * sigma) / (n + k));
}

/**
 * @param {Array} sales internal sales (comp-records.toSale); anything not
 *                      valid single-family evidence before `asOf` is ignored.
 * @param {object} opts { asOf: 'YYYY-MM-DD', params, marketParams, refLat }
 */
export function buildMicroMarketModel(sales, { asOf, params = MICRO_MARKET_PARAMS, marketParams = MARKET_CONTEXT_PARAMS, refLat = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) throw new Error('micro_market_as_of_required');
  const lookbackStart = subtractMonths(asOf, params.lookbackMonths);
  const evidence = sales
    .filter((s) => isLayerEvidence(s, asOf, lookbackStart))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const latRef = refLat ?? (evidence.length ? median(evidence.map((s) => s.lat)) : 40);
  const grid = makeGrid({ refLat: latRef, cellKm: params.cellKm });
  const market = buildMarketContext(evidence, { asOf, cellOf: grid.cellOf, params: marketParams });
  const sigma = market.sigmaWithin;

  // 1) cells
  const cells = new Map();
  const zipLevels = new Map();
  const allLevels = [];
  for (const s of evidence) {
    const level = market.levelOf(s);
    if (level === null) continue;
    const c = grid.cellOf(s.lat, s.lng);
    if (!cells.has(c.key)) cells.set(c.key, { key: c.key, ix: c.ix, iy: c.iy, center: grid.center(c.ix, c.iy), z: [], zips: new Map() });
    const cell = cells.get(c.key);
    cell.z.push(level);
    if (s.zip) {
      cell.zips.set(s.zip, (cell.zips.get(s.zip) ?? 0) + 1);
      if (!zipLevels.has(s.zip)) zipLevels.set(s.zip, []);
      zipLevels.get(s.zip).push(level);
    }
    allLevels.push(level);
  }
  const cellKeys = [...cells.keys()].sort();
  for (const key of cellKeys) {
    const cell = cells.get(key);
    cell.z.sort((a, b) => a - b);
    cell.n = cell.z.length;
    cell.med = medianOfSorted(cell.z);
    cell.zip = [...cell.zips.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  }
  const marketLevel = median(allLevels) ?? 0;
  const zipStats = new Map();
  for (const [zip, levels] of [...zipLevels.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const med = median(levels);
    const n = levels.length;
    zipStats.set(zip, { zip, n, med, pooled: (n * med + params.shrinkZip * marketLevel) / (n + params.shrinkZip) });
  }

  // 2) cell adjacency (Chebyshev <= linkRange)
  const cellNeighbors = new Map(cellKeys.map((k) => [k, []]));
  for (const key of cellKeys) {
    const a = cells.get(key);
    for (let dx = -params.linkRange; dx <= params.linkRange; dx += 1) {
      for (let dy = -params.linkRange; dy <= params.linkRange; dy += 1) {
        if (!dx && !dy) continue;
        const otherKey = grid.key(a.ix + dx, a.iy + dy);
        if (!cells.has(otherKey) || otherKey <= key) continue;
        const b = cells.get(otherKey);
        const km = haversineKm(a.center.lat, a.center.lng, b.center.lat, b.center.lng);
        cellNeighbors.get(key).push({ other: otherKey, km });
        cellNeighbors.get(otherKey).push({ other: key, km });
      }
    }
  }
  for (const list of cellNeighbors.values()) list.sort((x, y) => (x.other < y.other ? -1 : 1));

  // 3) agglomerative merging
  const clusters = new Map();
  const clusterOfCell = new Map();
  cellKeys.forEach((key, id) => {
    const cell = cells.get(key);
    clusters.set(id, { id, cells: [key], z: cell.z.slice(), n: cell.n, sd: shrunkSd(cell.z, sigma, params.priorSdWeight), version: 0, neighbors: new Set() });
    clusterOfCell.set(key, id);
  });
  for (const key of cellKeys) {
    const id = clusterOfCell.get(key);
    for (const { other } of cellNeighbors.get(key)) clusters.get(id).neighbors.add(clusterOfCell.get(other));
  }
  const pairScore = (a, b) => {
    const gap = Math.abs(medianOfSorted(a.z) - medianOfSorted(b.z));
    const se = 1.2533 * Math.sqrt((a.sd * a.sd) / a.n + (b.sd * b.sd) / b.n);
    return { gap, se, score: se > 0 ? gap / se : Infinity };
  };
  const admissible = (a, b, s) =>
    s.gap <= params.gapCapMerge &&
    s.gap <= params.zCritMerge * s.se &&
    a.n + b.n <= params.maxClusterSales &&
    a.cells.length + b.cells.length <= params.maxClusterCells;
  const heap = new MinHeap((x, y) => x.score - y.score || x.gap - y.gap || x.a - y.a || x.b - y.b);
  const pushPair = (a, b) => {
    const s = pairScore(a, b);
    if (!admissible(a, b, s)) return;
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    heap.push({ score: s.score, gap: s.gap, a: lo.id, b: hi.id, va: lo.version, vb: hi.version });
  };
  for (const cluster of clusters.values()) {
    for (const nid of cluster.neighbors) if (nid > cluster.id) pushPair(cluster, clusters.get(nid));
  }
  let merges = 0;
  while (heap.size) {
    const top = heap.pop();
    const a = clusters.get(top.a);
    const b = clusters.get(top.b);
    if (!a || !b || a.version !== top.va || b.version !== top.vb) continue;
    a.z = mergeSorted(a.z, b.z);
    a.n += b.n;
    a.sd = shrunkSd(a.z, sigma, params.priorSdWeight);
    a.cells = [...a.cells, ...b.cells].sort();
    a.version += 1;
    for (const key of b.cells) clusterOfCell.set(key, a.id);
    for (const nid of b.neighbors) {
      if (nid === a.id) continue;
      a.neighbors.add(nid);
      const neighbor = clusters.get(nid);
      neighbor.neighbors.delete(b.id);
      neighbor.neighbors.add(a.id);
    }
    a.neighbors.delete(b.id);
    a.neighbors.delete(a.id);
    clusters.delete(b.id);
    merges += 1;
    for (const nid of [...a.neighbors].sort((x, y) => x - y)) pushPair(a, clusters.get(nid));
  }

  // 4) final micro-markets, pooled levels, boundary classes
  const clusterIds = [...clusters.keys()].sort((x, y) => x - y);
  const microMarkets = new Map();
  for (const id of clusterIds) {
    const c = clusters.get(id);
    const zipCounts = new Map();
    for (const key of c.cells) {
      for (const [zip, n] of cells.get(key).zips) zipCounts.set(zip, (zipCounts.get(zip) ?? 0) + n);
    }
    const zip = [...zipCounts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null;
    const zipLevel = zip && zipStats.has(zip) ? zipStats.get(zip).pooled : marketLevel;
    const med = medianOfSorted(c.z);
    microMarkets.set(id, {
      id,
      cells: c.cells,
      n: c.n,
      med,
      level: (c.n * med + params.shrinkCluster * zipLevel) / (c.n + params.shrinkCluster),
      sd: c.sd,
      zip,
      z: c.z,
      neighbors: [...c.neighbors].sort((x, y) => x - y),
    });
  }
  // Pooled dispersion of individual sale levels around their micro-market's
  // median: the spread a single new sale shows around a well-estimated level.
  const mmResiduals = [];
  for (const id of clusterIds) {
    const mm = microMarkets.get(id);
    if (mm.n < 5) continue;
    for (const z of mm.z) mmResiduals.push(z - mm.med);
  }
  const sigmaMicroMarket = Math.min(0.8, Math.max(sigma, robustSd(mmResiduals) ?? sigma));

  const boundary = new Map();
  const boundaryKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  for (const id of clusterIds) {
    const a = microMarkets.get(id);
    for (const nid of a.neighbors) {
      if (nid < id) continue;
      const b = microMarkets.get(nid);
      const key = boundaryKey(id, nid);
      const gap = b.level - a.level;
      let cls;
      let ci = null;
      if (a.n < params.minEdgeSupport || b.n < params.minEdgeSupport) {
        cls = 'unknown';
      } else if (Math.abs(gap) <= params.similarMaxGap) {
        cls = 'similar';
      } else {
        ci = bootstrapMedianGap(b.z, a.z, { iterations: params.bootstrapIterations, alpha: params.bootstrapAlpha, seed: hashString(`${asOf}|${key}`) });
        const excludesZero = ci.lo > 0 || ci.hi < 0;
        if (excludesZero && Math.abs(gap) >= params.discontinuityMinGap) cls = 'discontinuity';
        else if (!excludesZero) cls = 'similar';
        else cls = 'different';
      }
      boundary.set(key, { a: id, b: nid, gap, cls, ci: ci ? { lo: ci.lo, hi: ci.hi } : null, n: [a.n, b.n] });
    }
  }

  // 5) cell-graph edge costs
  const edgeCost = (fromKey, toKey, km) => {
    const ca = clusterOfCell.get(fromKey);
    const cb = clusterOfCell.get(toKey);
    if (ca === cb) return { cost: km, crossing: false, gap: 0, cls: 'same' };
    const edge = boundary.get(boundaryKey(ca, cb));
    if (!edge) return { cost: km * params.unknownEdgeFactor, crossing: false, gap: 0, cls: 'unknown' };
    const absGap = Math.abs(edge.gap);
    if (edge.cls === 'unknown') return { cost: km * params.unknownEdgeFactor, crossing: false, gap: absGap, cls: 'unknown' };
    let cost = km * (1 + (params.edgeGapPenalty * absGap) / 0.1);
    const crossing = edge.cls === 'discontinuity';
    if (crossing) cost += params.barrierKm * Math.min(params.barrierMaxMultiple, absGap / params.discontinuityMinGap);
    return { cost, crossing, gap: absGap, cls: edge.cls };
  };

  const nearestOccupied = (lat, lng, range) => {
    const c = grid.cellOf(lat, lng);
    if (cells.has(c.key)) return [{ key: c.key, km: 0, own: true }];
    const found = [];
    for (let dx = -range; dx <= range; dx += 1) {
      for (let dy = -range; dy <= range; dy += 1) {
        const key = grid.key(c.ix + dx, c.iy + dy);
        const cell = cells.get(key);
        if (cell) found.push({ key, km: haversineKm(lat, lng, cell.center.lat, cell.center.lng), own: false });
      }
    }
    return found.sort((x, y) => x.km - y.km || (x.key < y.key ? -1 : 1)).slice(0, 4);
  };

  const pooledCellLevel = (key) => {
    const cell = cells.get(key);
    const mm = microMarkets.get(clusterOfCell.get(key));
    return (cell.n * cell.med + params.shrinkCell * mm.level) / (cell.n + params.shrinkCell);
  };

  /** Pooling hierarchy: cell -> micro-market -> ZIP -> market. */
  const assign = (lat, lng, zip = null) => {
    const c = grid.cellOf(lat, lng);
    if (cells.has(c.key)) {
      const cell = cells.get(c.key);
      const mm = microMarkets.get(clusterOfCell.get(c.key));
      const confidence = mm.n >= 20 && cell.n >= 2 ? 'strong' : mm.n >= 6 ? 'weak' : 'unknown';
      return { tier: 'cell', cell_key: c.key, micro_market_id: mm.id, level: pooledCellLevel(c.key), micro_market_level: mm.level, n_cell: cell.n, n_micro_market: mm.n, confidence };
    }
    const near = nearestOccupied(lat, lng, 1)[0];
    if (near) {
      const mm = microMarkets.get(clusterOfCell.get(near.key));
      return { tier: 'neighbor_cell', cell_key: near.key, micro_market_id: mm.id, level: mm.level, micro_market_level: mm.level, n_cell: 0, n_micro_market: mm.n, confidence: mm.n >= 6 ? 'weak' : 'unknown' };
    }
    if (zip && zipStats.has(zip) && zipStats.get(zip).n >= 10) {
      const z = zipStats.get(zip);
      return { tier: 'zip', cell_key: null, micro_market_id: null, level: z.pooled, micro_market_level: null, n_cell: 0, n_micro_market: 0, n_zip: z.n, confidence: 'weak' };
    }
    return { tier: 'market', cell_key: null, micro_market_id: null, level: marketLevel, micro_market_level: null, n_cell: 0, n_micro_market: 0, confidence: 'unknown' };
  };

  /**
   * Effective market distance from a point to every reachable occupied cell
   * (Dijkstra, cost cap params.maxCostKm). Returns a resolver for any target.
   */
  const distancesFrom = (lat, lng, { maxCostKm = params.maxCostKm } = {}) => {
    const best = new Map();
    const heap = new MinHeap((x, y) => x.cost - y.cost || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const anchors = nearestOccupied(lat, lng, params.linkRange);
    for (const anchor of anchors) {
      const cost = anchor.own ? 0 : anchor.km * params.unknownEdgeFactor;
      heap.push({ key: anchor.key, cost, crossings: 0, maxGap: 0 });
    }
    while (heap.size) {
      const cur = heap.pop();
      if (best.has(cur.key)) continue;
      best.set(cur.key, cur);
      for (const { other, km } of cellNeighbors.get(cur.key)) {
        if (best.has(other)) continue;
        const e = edgeCost(cur.key, other, km);
        const cost = cur.cost + e.cost;
        if (cost > maxCostKm) continue;
        heap.push({ key: other, cost, crossings: cur.crossings + (e.crossing ? 1 : 0), maxGap: Math.max(cur.maxGap, e.gap) });
      }
    }
    const origin = anchors[0] ? clusterOfCell.get(anchors[0].key) : null;
    return {
      anchored: anchors.length > 0,
      origin_micro_market_id: origin,
      to(tLat, tLng) {
        const geoKm = haversineKm(lat, lng, tLat, tLng);
        const targets = nearestOccupied(tLat, tLng, params.linkRange);
        let hit = null;
        for (const t of targets) {
          const reached = best.get(t.key);
          if (!reached) continue;
          const cost = reached.cost + (t.own ? 0 : t.km * params.unknownEdgeFactor);
          if (!hit || cost < hit.cost) hit = { ...reached, cost, key: t.key };
        }
        if (!anchors.length || !targets.length) {
          return { geoKm, effKm: geoKm * params.unknownEdgeFactor, crossings: null, maxGap: null, reachable: false, micro_market_id: null, anchor: 'none' };
        }
        if (!hit) return { geoKm, effKm: Infinity, crossings: null, maxGap: null, reachable: false, micro_market_id: clusterOfCell.get(targets[0].key), anchor: 'beyond_cap' };
        return {
          geoKm,
          effKm: Math.max(geoKm, hit.cost),
          crossings: hit.crossings,
          maxGap: hit.maxGap,
          reachable: true,
          micro_market_id: clusterOfCell.get(hit.key),
          anchor: targets[0].own ? 'cell' : 'near',
        };
      },
    };
  };

  const microMarketOf = (lat, lng) => {
    const near = nearestOccupied(lat, lng, params.linkRange)[0];
    return near ? clusterOfCell.get(near.key) : null;
  };

  const boundaryBetween = (idA, idB) => (idA === null || idB === null || idA === idB ? null : boundary.get(boundaryKey(idA, idB)) ?? null);

  /**
   * Support-aware level comparison of two micro-markets: shrunk level gap
   * (b - a), its analytic SE from shrunk robust SDs, whether the gap is
   * significant at ~90%, and whether the two are adjacent.
   */
  const comparePair = (idA, idB) => {
    const a = microMarkets.get(idA);
    const b = microMarkets.get(idB);
    if (!a || !b) return null;
    const gap = b.level - a.level;
    const se = 1.2533 * Math.sqrt((a.sd * a.sd) / a.n + (b.sd * b.sd) / b.n);
    const edge = boundaryBetween(idA, idB);
    return {
      gap,
      se,
      significant: Math.abs(gap) >= params.zCritMerge * se,
      adjacent: Boolean(edge),
      boundary_class: edge?.cls ?? null,
      low_support: a.n < params.minEdgeSupport || b.n < params.minEdgeSupport,
    };
  };

  const clusterSizes = [...microMarkets.values()].map((m) => m.n).sort((x, y) => x - y);
  const classes = {};
  for (const e of boundary.values()) classes[e.cls] = (classes[e.cls] ?? 0) + 1;
  const summary = Object.freeze({
    version: MICRO_MARKET_VERSION,
    as_of: asOf,
    lookback_start: lookbackStart,
    evidence_sales: evidence.length,
    cells: cells.size,
    sales_per_cell_median: median(cellKeys.map((k) => cells.get(k).n)),
    micro_markets: microMarkets.size,
    micro_market_sales_median: median(clusterSizes),
    merges,
    boundaries: boundary.size,
    boundary_classes: classes,
    beta: Math.round(market.beta * 1000) / 1000,
    beta_raw: market.betaRaw === null ? null : Math.round(market.betaRaw * 1000) / 1000,
    regime_reference: market.regimeReference,
    rho: market.rho,
    sigma_within: Math.round(sigma * 1000) / 1000,
    sigma_micro_market: Math.round(sigmaMicroMarket * 1000) / 1000,
    index: market.index,
  });

  const fingerprint = () =>
    hashString(JSON.stringify({
      asOf,
      n: evidence.length,
      cells: cellKeys.map((k) => [k, cells.get(k).n, clusterOfCell.get(k)]),
      boundaries: [...boundary.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, e]) => [k, e.cls, Math.round(e.gap * 1e6)]),
      beta: market.beta,
      rho: market.rho,
      index: market.index,
    }));

  return Object.freeze({
    version: MICRO_MARKET_VERSION,
    asOf,
    params,
    grid,
    market,
    summary,
    sigmaMicroMarket,
    assign,
    distancesFrom,
    microMarketOf,
    microMarket: (id) => microMarkets.get(id) ?? null,
    boundaryBetween,
    comparePair,
    levelGapPct: (idA, idB) => {
      const a = microMarkets.get(idA);
      const b = microMarkets.get(idB);
      if (!a || !b) return null;
      return Math.round((Math.exp(b.level - a.level) - 1) * 1000) / 10;
    },
    fingerprint,
  });
}
