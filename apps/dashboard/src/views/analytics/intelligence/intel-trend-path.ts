/**
 * How a trend line is drawn across buckets that have no value — pure, so the
 * rule is tested rather than eyeballed.
 *
 * A COUNT with no activity is a real 0 (the engine sends 0), so it never
 * reaches this code as a gap. A RATE / ratio / median has NO value on a day
 * with no denominator (no sellers reached → no reply rate). Before this rule
 * those days broke the line, and an observed day between two empty days drew
 * nothing at all (a path of one point is invisible) — on bursty real traffic
 * the line "stopped" after its first run.
 *
 * The rule: never invent a value, but read as one trend.
 *   solid   consecutive observed buckets, both with enough sample
 *   thin    consecutive observed buckets where one is below the sample floor
 *   bridge  observed → next observed across one or more EMPTY buckets
 *           (drawn as a faint dashed connector; the empty buckets say
 *           "no sellers that day" on hover — the connector is not a value)
 *   lone    an observed, sure bucket with no solid neighbour (drawn as a dot)
 * Nothing is drawn before the first or after the last observed bucket.
 */
export type TrendSegments = {
  /** runs of consecutive indices to draw as one solid polyline */
  solid: number[][]
  /** single steps [a, b] (b = a + 1) where a bucket is below the floor */
  thin: Array<[number, number]>
  /** steps [a, b] (b > a + 1) across empty buckets */
  bridge: Array<[number, number]>
  /** sure buckets with no solid neighbour */
  lone: number[]
  /** for each empty bucket inside a bridge, the bridge it belongs to (index → [a, b]) */
  bridged: Map<number, [number, number]>
}

export function trendSegments(values: Array<number | null>, sure: Array<number | null> = values): TrendSegments {
  const obs: number[] = []
  values.forEach((v, i) => { if (v !== null && v !== undefined && Number.isFinite(v)) obs.push(i) })
  const solid: number[][] = []
  const thin: Array<[number, number]> = []
  const bridge: Array<[number, number]> = []
  const bridged = new Map<number, [number, number]>()
  const inSolid = new Set<number>()
  let run: number[] = []
  const flush = () => { if (run.length > 1) { solid.push(run); run.forEach((i) => inSolid.add(i)) } run = [] }
  const isSure = (i: number) => sure[i] !== null && sure[i] !== undefined
  for (let k = 0; k < obs.length; k += 1) {
    const i = obs[k]
    const prev = k > 0 ? obs[k - 1] : null
    if (prev !== null && i === prev + 1 && isSure(prev) && isSure(i)) {
      if (!run.length) run.push(prev)
      run.push(i)
      continue
    }
    flush()
    if (prev === null) continue
    if (i === prev + 1) thin.push([prev, i])
    else {
      bridge.push([prev, i])
      for (let j = prev + 1; j < i; j += 1) bridged.set(j, [prev, i])
    }
  }
  flush()
  const lone = obs.filter((i) => isSure(i) && !inSolid.has(i))
  return { solid, thin, bridge, lone, bridged }
}
