import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { selectBuyerCandidate, setBuyerDisposition } from '../buyer-match-actions'
import { callBackend } from '../../../lib/api/backendClient'
import { Icon } from '../../../shared/icons'
import {
  classifyCandidatesResponse,
  describeMatchCount,
  readCandidatesEnvelope,
  type BuyerMatchState,
  type CandidatesEnvelope,
} from '../buyer-match-subject'
import {
  dedupeByBuyerEntity,
  describeActivity,
  describeDisposition,
  describeGeography,
  describeMatchGrade,
  matchReasons,
  type BuyerMatchCandidate,
} from '../buyer-match-presentation'
import './buyer-match-mobile.css'

/**
 * BUYER MATCH — MOBILE LENS.
 *
 * §5: another lens over the SAME product, not a second product. It calls the
 * same canonical endpoint the desktop workspace calls
 * (`/api/cockpit/buyer-match/property/{id}/candidates`), reads the same
 * canonical fields, and ranks by nothing — the engine already ordered by
 * match_score and this renders that order.
 *
 * §12: imagery is the SELECTED PROPERTY's only. There is deliberately no
 * per-buyer image: 25 buyer cards would mean 25 Street View requests, which is
 * the fan-out this codebase has already paid for twice.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export interface BuyerMatchMobileProps {
  propertyId: string
  address: string
  market?: string | null
  propertyType?: string | null
  estimatedValue?: number | null
  /** The selected property's visual. One property, one request. */
  propertyVisual?: React.ReactNode
}

const PAGE_SIZE = 50

type Filter = 'all' | 'strong' | 'nearby' | 'recent' | 'not_contacted'

const money = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? null
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v))

export function BuyerMatchMobile({
  propertyId,
  address,
  market,
  propertyType,
  estimatedValue,
  propertyVisual,
}: BuyerMatchMobileProps) {
  const [state, setState] = useState<BuyerMatchState>({ kind: 'loading' })
  const [candidates, setCandidates] = useState<BuyerMatchCandidate[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const requestSeq = useRef(0)

  /**
   * §4 — the fetch is keyed on propertyId and a sequence number, so switching
   * A -> B cannot leave B showing A's buyers if A's response lands late.
   */
  const load = useCallback(async (id: string) => {
    const seq = ++requestSeq.current
    setState({ kind: 'loading' })
    setCandidates([])
    setOpenId(null)
    try {
      /**
       * `callBackend` hands back the WHOLE response body as `res.data`, so the
       * canonical payload is `res.data.data` — the pattern
       * views/map/master-filters/api.ts already uses. Reading one level shallow
       * made `run_id` undefined, which this surface then classified as "no
       * match run" for a property with 25 candidates. Worse, an envelope-level
       * `ok: false` would have rendered as an empty result, which is exactly
       * the error-as-empty failure §16 forbids. Both levels are checked.
       */
      const res = await callBackend<CandidatesEnvelope<BuyerMatchCandidate>>(
        `/api/cockpit/buyer-match/property/${encodeURIComponent(id)}/candidates?limit=${PAGE_SIZE}`,
      )
      if (seq !== requestSeq.current) return

      const read = readCandidatesEnvelope<BuyerMatchCandidate>(res)
      if (!read.ok) {
        setState(classifyCandidatesResponse({ propertyId: id, ok: false, message: read.message }))
        return
      }

      const rows = dedupeByBuyerEntity(read.candidates)
      setCandidates(rows)
      setState(classifyCandidatesResponse({
        propertyId: id,
        ok: true,
        runId: read.runId,
        total: read.total,
        loaded: rows.length,
      }))
    } catch (error) {
      if (seq !== requestSeq.current) return
      // §16/§25 — a thrown request is a FAILURE, never zero matches.
      setState(classifyCandidatesResponse({
        propertyId: id, ok: false, message: error instanceof Error ? error.message : 'Buyer match request failed',
      }))
    }
  }, [])

  useEffect(() => { void load(propertyId) }, [propertyId, load])

  /**
   * §14/§22 — only filters the canonical data can actually answer. Each is a
   * predicate over a field the engine populates on every row.
   */
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return candidates.filter((c) => {
      if (filter === 'strong' && String(c.match_grade ?? '').toUpperCase() !== 'A') return false
      if (filter === 'nearby' && !(Number(c.distance_miles) <= 5)) return false
      if (filter === 'recent' && !(Number(c.purchase_count_365d) > 0)) return false
      if (filter === 'not_contacted' && describeDisposition(c).contacted) return false
      if (!needle) return true
      const haystack = [
        c.buyer_name, c.buyer_type, c.reason_for_match, c.mailing_state,
        ...(c.markets_active ?? []), ...(c.zips_active ?? []),
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [candidates, query, filter])

  const [acting, setActing] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  /**
   * Disposition writes reuse the shared authority — no second copy of the
   * update, and a failed write SAYS so instead of leaving the row looking
   * unchanged (which reads identically to "nothing happened").
   */
  const act = async (candidate: BuyerMatchCandidate, action: 'interested' | 'passed' | 'select') => {
    const id = candidate.buyer_match_candidate_id
    setActing(id)
    setActionError(null)
    const res = action === 'select'
      ? await selectBuyerCandidate(id)
      : await setBuyerDisposition(id, action)
    setActing(null)
    if (!res.ok) {
      setActionError(res.message || 'Could not update this buyer')
      return
    }
    setCandidates((prev) => prev.map((c) => (c.buyer_match_candidate_id === id ? { ...c, ...res.updates } : c)))
  }

  const open = openId ? candidates.find((c) => c.buyer_match_candidate_id === openId) ?? null : null

  const propertyHeader = (
    <header className="bmm__subject">
      {propertyVisual ? <div className="bmm__subject-visual">{propertyVisual}</div> : null}
      <div className="bmm__subject-copy">
        <span className="bmm__subject-label">Finding buyers for</span>
        <strong className="bmm__subject-address">{address}</strong>
        <span className="bmm__subject-meta">
          {[market, propertyType, money(estimatedValue)].filter(Boolean).join(' · ') || 'Property details unavailable'}
        </span>
      </div>
    </header>
  )

  /** §16 — four distinct states, none of them "no buyers found". */
  const renderState = () => {
    if (state.kind === 'loading') {
      return <div className="bmm__state">Loading canonical buyer matches…</div>
    }
    if (state.kind === 'failed') {
      return (
        <div className="bmm__state is-error" role="alert">
          <Icon name="alert" size={18} />
          <strong>Buyer match could not be loaded</strong>
          <p>{state.message}</p>
          <p className="bmm__state-note">This is a request failure, not an empty result — the property may still have matches.</p>
          <button type="button" className="bmm__retry" onClick={() => void load(propertyId)}>Try again</button>
        </div>
      )
    }
    if (state.kind === 'no_run') {
      return (
        <div className="bmm__state">
          <Icon name="search" size={18} />
          <strong>No match run for this property yet</strong>
          <p>The buyer match engine has not been run against {address}. Run it from the full Buyer Match workspace.</p>
        </div>
      )
    }
    if (state.kind === 'no_candidates') {
      return (
        <div className="bmm__state">
          <Icon name="users" size={18} />
          <strong>The match run returned no buyers</strong>
          <p>A run completed for this property and found no qualifying buyers. That is different from never having run.</p>
        </div>
      )
    }
    return null
  }

  const ready = state.kind === 'ready'

  return (
    <section className="bmm">
      {propertyHeader}

      {ready && (
        <div className="bmm__runbar">
          <span className="bmm__count">{describeMatchCount(state.total, state.loaded)}</span>
          {state.loaded < state.total && (
            <span className="bmm__cap" title="The canonical total is larger than the loaded page">
              capped at {PAGE_SIZE}
            </span>
          )}
        </div>
      )}

      {ready && (
        <div className="bmm__controls">
          <label className="bmm__search">
            <Icon name="search" size={13} />
            <input
              type="search"
              value={query}
              placeholder="Buyer, market, ZIP, reason…"
              aria-label="Search buyer matches"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="bmm__filters" role="tablist" aria-label="Buyer match filters">
            {([
              ['all', 'All'],
              ['strong', 'Strong'],
              ['nearby', 'Nearby'],
              ['recent', 'Recent buyer'],
              ['not_contacted', 'Not contacted'],
            ] as Array<[Filter, string]>).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                className={cls('bmm__filter', filter === id && 'is-active')}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {renderState()}

      {ready && (
        <div className="bmm__list">
          {filtered.length === 0 ? (
            <div className="bmm__state">
              <strong>No buyers match these filters</strong>
              <p>{describeMatchCount(state.total, state.loaded)} for this property. Clear the search or filter to see them.</p>
            </div>
          ) : filtered.map((c) => {
            const grade = describeMatchGrade(c)
            const reasons = matchReasons(c, 3)
            const activity = describeActivity(c)
            const geography = describeGeography(c)
            const disposition = describeDisposition(c)
            return (
              <button
                key={c.buyer_match_candidate_id}
                type="button"
                className="bmm__card"
                onClick={() => setOpenId(c.buyer_match_candidate_id)}
              >
                <div className="bmm__card-top">
                  <strong className="bmm__buyer">{c.buyer_name || 'Unnamed buyer entity'}</strong>
                  <span className={cls('bmm__grade', `is-${grade.tone}`)}>
                    {grade.label}{grade.score ? ` · ${grade.score}` : ''}
                  </span>
                </div>
                <div className="bmm__card-meta">
                  {c.buyer_type ? <span className="bmm__chip">{c.buyer_type}</span> : null}
                  {geography ? <span className="bmm__chip">{geography}</span> : null}
                  <span className={cls('bmm__chip', disposition.contacted ? 'is-contacted' : 'is-open')}>
                    {disposition.label}
                  </span>
                </div>
                {reasons.length > 0 && (
                  <ul className="bmm__reasons">
                    {reasons.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                )}
                {activity ? <span className="bmm__activity">{activity}</span> : null}
              </button>
            )
          })}
        </div>
      )}

      {open && (
        <div className="bmm-sheet-root" role="presentation">
          <button type="button" className="bmm-sheet__backdrop" aria-label="Close buyer" onClick={() => setOpenId(null)} />
          <div className="bmm-sheet" role="dialog" aria-label={open.buyer_name || 'Buyer'}>
            <header className="bmm-sheet__head">
              <div>
                <strong>{open.buyer_name || 'Unnamed buyer entity'}</strong>
                <span className="bmm-sheet__sub">
                  {describeMatchGrade(open).label}
                  {describeMatchGrade(open).score ? ` · score ${describeMatchGrade(open).score}` : ''}
                </span>
              </div>
              <button type="button" className="bmm-sheet__close" aria-label="Close" onClick={() => setOpenId(null)}>
                <Icon name="x" size={14} />
              </button>
            </header>
            <div className="bmm-sheet__body">
              <section>
                <h4>Why matched</h4>
                {matchReasons(open, 8).length ? (
                  <ul className="bmm__reasons">{matchReasons(open, 8).map((r) => <li key={r}>{r}</li>)}</ul>
                ) : <p className="bmm__muted">The engine recorded no reason text for this candidate.</p>}
              </section>
              <section>
                <h4>Activity</h4>
                <p>{describeActivity(open) ?? 'No purchase activity recorded.'}</p>
                {describeGeography(open) ? <p>{describeGeography(open)}</p> : null}
              </section>
              <section>
                <h4>Purchase profile</h4>
                <dl className="bmm__dl">
                  {open.purchase_count != null && <><dt>Purchases</dt><dd>{open.purchase_count}</dd></>}
                  {open.purchase_count_365d != null && <><dt>Last 12mo</dt><dd>{open.purchase_count_365d}</dd></>}
                  {money(open.median_purchase_price) && <><dt>Median price</dt><dd>{money(open.median_purchase_price)}</dd></>}
                  {(open.preferred_asset_classes?.length ?? 0) > 0 && (
                    <><dt>Asset classes</dt><dd>{open.preferred_asset_classes!.join(', ')}</dd></>
                  )}
                  {(open.markets_active?.length ?? 0) > 0 && (
                    <><dt>Active markets</dt><dd>{open.markets_active!.slice(0, 4).join(', ')}</dd></>
                  )}
                </dl>
              </section>
              <section>
                <h4>Outreach</h4>
                <p>{describeDisposition(open).label}</p>
                {open.package_sent_at ? (
                  /**
                   * `package_sent_at` is set by the desktop "Send Package"
                   * button, which only stamps the row — nothing is
                   * transmitted. Rendering it as "Package sent" would repeat
                   * that claim, so the label says what the stamp actually is.
                   */
                  <p className="bmm__muted">
                    Flagged package-sent {new Date(open.package_sent_at).toLocaleDateString()} — no message was
                    transmitted by this system
                  </p>
                ) : null}
                <p className="bmm__muted">
                  Buyer identity {open.buyer_entity_id} · candidate {open.buyer_match_candidate_id}
                </p>
              </section>
            </div>
            {/**
              * §13 — the disposition actions, reachable on mobile.
              *
              * These three are the actions that mean what they say: each writes
              * a status to the candidate row. "Send Package" is deliberately
              * NOT here — see buyer-match-actions.ts; it transmits nothing, so
              * a thumb-sized version of it would only manufacture evidence of
              * outreach that never happened.
              */}
            <footer className="bmm-sheet__actions">
              {actionError ? <p className="bmm-sheet__error" role="status">{actionError}</p> : null}
              <div className="bmm-sheet__actions-row">
                <button
                  type="button"
                  className="bmm-act is-interested"
                  aria-label="Mark buyer interested"
                  disabled={acting !== null}
                  onClick={() => void act(open, 'interested')}
                >
                  Interested
                </button>
                <button
                  type="button"
                  className="bmm-act is-passed"
                  aria-label="Mark buyer passed"
                  disabled={acting !== null}
                  onClick={() => void act(open, 'passed')}
                >
                  Pass
                </button>
              </div>
              <button
                type="button"
                className="bmm-act is-select"
                aria-label="Select as buyer"
                disabled={acting !== null || open.selected === true}
                onClick={() => void act(open, 'select')}
              >
                {open.selected === true ? 'Selected buyer' : 'Select as buyer'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  )
}
