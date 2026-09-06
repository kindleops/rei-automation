/**
 * s13-combined-model.mjs
 *
 * ONE formal model of the combined outbound + callback state machine, and a
 * bounded exhaustive reachability search over it.
 *
 * WHAT THIS IS FOR.
 *   Slices 1 and 2 each proved their own half. The dangerous states live at the
 *   SEAM between them: a provider response and a provider callback racing, a
 *   crash between the two, an authority change in the gap. Those states are not
 *   reachable by testing either half alone.
 *
 * WHAT THIS IS NOT.
 *   Not a proof that the code is correct. It is a proof that the MODEL has no
 *   reachable unsafe state, plus a differential (s13-differential) pinning the
 *   model's transitions to the real implementation's semantics. A model that
 *   only proves itself is worthless, which is why the differential is a gate and
 *   not an afterthought.
 *
 * MODELLED FROM THE IMPLEMENTATION, NOT FROM THE DESIGN DOCS.
 *   Where the code and the intent disagree, this models the CODE. The most
 *   important instance: receipt trust is recorded but never gates a transition,
 *   so this model does not pretend a trust threshold exists.
 */

// ── vocabulary, taken from the implementation ─────────────────────────────

export const OUTCOME = Object.freeze({
  UNKNOWN: 'unknown',
  QUEUED: 'queued_by_provider',
  ACCEPTED: 'provider_accepted',
  SENT: 'sent_by_provider',
  DELIVERED: 'delivered',
  FAILED: 'delivery_failed_after_acceptance',
});

const RANK = {
  [OUTCOME.UNKNOWN]: 0, [OUTCOME.QUEUED]: 1, [OUTCOME.ACCEPTED]: 2,
  [OUTCOME.SENT]: 3, [OUTCOME.DELIVERED]: 4, [OUTCOME.FAILED]: 4,
};

export const POSSIBILITY = Object.freeze({
  NONE: null,
  DEFINITELY_NOT_SENT: 'definitely_not_sent',
  MAY_HAVE_BEEN_SENT: 'may_have_been_sent',
  PROVIDER_ACCEPTED: 'provider_accepted',
  DELIVERED: 'delivered',
});

export const RETRY = Object.freeze({
  ALLOWED: 'retry_allowed',
  AFTER: 'retry_after',
  DENIED: 'retry_denied',
  HOLD: 'operator_hold',
  TERMINAL: 'terminal',
});

export const PROVENANCE = Object.freeze({
  LIVE: 'live_provider_receipt',
  REPLAY: 'recorded_callback_replay',
  POLL: 'provider_poll_observation',
  UNDECLARED: 'undeclared',
});

export const TRUST = Object.freeze({
  AUTHENTICATED: 'authenticated_provider_callback',
  UNAUTHENTICATED: 'network_received_unauthenticated',
  REPLAY: 'internal_replay',
});

/** Only these provenances may advance canonical truth. Mirrors the module. */
export const mayAdvance = (p) => p === PROVENANCE.LIVE || p === PROVENANCE.REPLAY;

/** The monotonic gate. Mirrors advanceProviderOutcome exactly. */
export function latticeAction(current, incoming) {
  const from = current || OUTCOME.UNKNOWN;
  const to = incoming || OUTCOME.UNKNOWN;
  if (to === OUTCOME.UNKNOWN) return 'inert';
  if (from === to) return 'idempotent';
  if (RANK[to] > RANK[from]) return 'advance';
  if (RANK[to] < RANK[from]) return 'stale';
  return 'conflict';
}

export function possibilityFor(outcome) {
  switch (outcome) {
    case OUTCOME.DELIVERED: return POSSIBILITY.DELIVERED;
    case OUTCOME.ACCEPTED:
    case OUTCOME.SENT:
    case OUTCOME.QUEUED:
    // A provider `failed` means accepted-then-failed. Never definitely_not_sent.
    case OUTCOME.FAILED: return POSSIBILITY.PROVIDER_ACCEPTED;
    default: return POSSIBILITY.NONE;
  }
}

// ── the state ─────────────────────────────────────────────────────────────

export function initialState(opts = {}) {
  return {
    // logical communication
    terminal: false,
    possibility: POSSIBILITY.NONE,
    retry: RETRY.ALLOWED,
    // attempts: {n, started, sid, completed, outcome}
    attempts: [],
    // durable callback ledger, keyed by fingerprint
    events: [],
    // provider-side callbacks that exist but have not reached us yet
    inflight: [],
    // counters the safety properties are stated over
    providerCalls: 0,
    sellerVisibleSends: 0,
    // runtime + compliance authority, re-evaluated at every allocation
    runtime: true,
    compliance: true,
    authorityChanges: 0,
    // projection (NOT authority)
    queueStatus: 'queued',
    projectionFailed: false,
    // budgets
    crashes: 0,
    ...opts,
  };
}

const clone = (s) => ({
  ...s,
  attempts: s.attempts.map((a) => ({ ...a })),
  events: s.events.map((e) => ({ ...e })),
  inflight: s.inflight.map((c) => ({ ...c })),
});

/**
 * Canonical key for the visited set.
 *
 * SOUNDNESS RULE: every field any invariant reads MUST appear here. An earlier
 * version omitted authorityAtCall, so a state that violated S13 collapsed onto
 * an already-visited safe state with the same abstraction and was silently
 * discarded -- the search reported 0 violations for a defect it had actually
 * reached. An abstraction that hides what the properties read does not make the
 * search smaller, it makes it wrong.
 */
export function key(s) {
  return JSON.stringify([
    s.terminal, s.possibility, s.retry,
    s.attempts.map((a) => [a.n, a.started, a.sid, a.completed, a.outcome,
      a.calledProvider === true, a.authorityAtCall === true, a.abandoned === true]),
    s.events.map((e) => [e.fp, e.status, e.provenance, e.processing, e.bound,
      e.ambiguousAdoption === true, e.strandedOnce === true]).sort(),
    s.inflight.map((c) => [c.status, c.sid, c.provenance]).sort(),
    s.providerCalls, s.sellerVisibleSends, s.runtime, s.compliance,
    s.queueStatus, s.projectionFailed, s.crashes, s.authorityChanges,
  ]);
}

const activeSibling = (s) => s.attempts.some((a) => !a.completed);

/**
 * THE ALLOCATION GUARD. This is the single most safety-critical predicate in
 * §11, so it is written once and both the model and the differential use it.
 */
export function mayAllocateAttempt(s, bounds) {
  const m = bounds.mutation || null;
  // Placed FIRST on purpose: behind the real guards it could never be reached,
  // and a mutation that cannot be reached proves nothing.
  if (m === 'projection_is_authority' && s.projectionFailed
      && s.attempts.length < bounds.maxAttempts) return true;
  if (s.terminal && m !== 'no_stop_reevaluation') return false;
  if (s.attempts.length >= bounds.maxAttempts) return false;
  // An in-flight sibling blocks allocation. Without this, two workers each
  // allocate and each send.
  if (m !== 'no_sibling_guard' && activeSibling(s)) return false;
  // Ambiguity absorbs retry authority.
  if (m !== 'weak_ambiguity_retry') {
    if (s.possibility === POSSIBILITY.MAY_HAVE_BEEN_SENT) return false;
    if (s.possibility === POSSIBILITY.PROVIDER_ACCEPTED) return false;
    if (s.possibility === POSSIBILITY.DELIVERED) return false;
  }
  if (m !== 'weak_ambiguity_retry'
      && s.retry !== RETRY.ALLOWED && s.retry !== RETRY.AFTER) return false;
  // Runtime and compliance are re-evaluated at EVERY allocation, never
  // inherited from the previous attempt.
  if (m !== 'no_stop_reevaluation') {
    if (!s.runtime) return false;
    if (!s.compliance) return false;
  }
  return true;
}

// ── transitions ───────────────────────────────────────────────────────────

/**
 * Provider behaviours. Deliberately adversarial: the provider is not assumed to
 * cooperate, respond, or be truthful about ordering.
 */
const PROVIDER_BEHAVIOURS = [
  // request never left us: provably nothing was sent
  { id: 'never_reached', sid: null, possibility: POSSIBILITY.DEFINITELY_NOT_SENT, retry: RETRY.ALLOWED, callbacks: [] },
  // accepted, response returned with a SID
  { id: 'accepted', sid: 'SID_A', possibility: POSSIBILITY.PROVIDER_ACCEPTED, retry: RETRY.DENIED, callbacks: ['delivered'] },
  // accepted, but our response timed out: ambiguous
  { id: 'timeout', sid: null, possibility: POSSIBILITY.MAY_HAVE_BEEN_SENT, retry: RETRY.DENIED, callbacks: ['delivered'] },
  // accepted then downstream failure
  { id: 'accepted_then_failed', sid: 'SID_A', possibility: POSSIBILITY.PROVIDER_ACCEPTED, retry: RETRY.DENIED, callbacks: ['failed'] },
  // accepted, callback never arrives
  { id: 'silent', sid: 'SID_A', possibility: POSSIBILITY.PROVIDER_ACCEPTED, retry: RETRY.DENIED, callbacks: [] },
  // timeout, and the callback carries a SID we never saw locally
  { id: 'timeout_foreign_sid', sid: null, possibility: POSSIBILITY.MAY_HAVE_BEEN_SENT, retry: RETRY.DENIED, callbacks: ['delivered'], cbSid: 'SID_B' },

  // ── MULTI-CALLBACK BEHAVIOURS ───────────────────────────────────────────
  // Transition 4 may deliver ANY in-flight callback next, so supplying a SET
  // here generates every ORDER of that set. These are the behaviours that make
  // the lattice load-bearing; without them the compare-and-swap and the stale
  // and conflict rules are never exercised and their mutations survive.
  { id: 'sent_then_delivered', sid: 'SID_A', possibility: POSSIBILITY.PROVIDER_ACCEPTED, retry: RETRY.DENIED,
    callbacks: ['sent', 'delivered'] },
  { id: 'delivered_and_failed_conflict', sid: 'SID_A', possibility: POSSIBILITY.PROVIDER_ACCEPTED, retry: RETRY.DENIED,
    callbacks: ['delivered', 'failed'] },
  { id: 'sent_and_failed', sid: 'SID_A', possibility: POSSIBILITY.PROVIDER_ACCEPTED, retry: RETRY.DENIED,
    callbacks: ['sent', 'failed'] },
];

export function transitions(s, bounds) {
  const out = [];
  const emit = (name, mutate) => {
    const n = clone(s);
    mutate(n);
    out.push({ name, next: n });
  };

  // 1. allocate an attempt
  if (mayAllocateAttempt(s, bounds)) {
    emit('allocate', (n) => {
      n.attempts.push({ n: n.attempts.length + 1, started: false, sid: null, completed: false, outcome: null });
    });
  }

  const cur = s.attempts.find((a) => !a.completed);

  // 2. commit provider_request_started BEFORE any network call.
  //
  // runAttempt evaluates RUNTIME authority (step 10) immediately before it
  // persists request-start (step ~243) and calls the provider (step ~275). So
  // allocation and the authority check are NOT separable in time, and the model
  // must not pretend they are: an attempt allocated before a STOP still faces a
  // fresh authority evaluation here.
  if (cur && !cur.started && (bounds.mutation === 'no_stop_reevaluation'
      || (!s.terminal && s.runtime && s.compliance))) {
    emit('commit_request_started', (n) => {
      n.attempts.find((a) => !a.completed).started = true;
    });
  }

  // 2b. authority withdrawn after allocation but before start: the attempt is
  // abandoned, not sent. This is the STOP/brake race.
  if (cur && !cur.started && bounds.mutation !== 'no_stop_reevaluation'
      && (s.terminal || !s.runtime || !s.compliance)) {
    emit('attempt_abandoned_authority_withdrawn', (n) => {
      const a = n.attempts.find((x) => !x.completed);
      a.completed = true;
      a.outcome = OUTCOME.UNKNOWN;
      a.abandoned = true;
      // Nothing was sent and nothing was started, so this stays definitely-not-sent.
      n.possibility = POSSIBILITY.DEFINITELY_NOT_SENT;
    });
  }

  // 3. the network call itself, one branch per provider behaviour
  const m = bounds.mutation || null;
  const authorityOk = m === 'no_stop_reevaluation'
    ? true : (!s.terminal && s.runtime && s.compliance);
  const startedOk = m === 'weak_request_started_ordering' ? true : (cur && cur.started);
  if (cur && startedOk && cur.outcome === null && authorityOk) {
    for (const b of PROVIDER_BEHAVIOURS) {
      emit(`provider:${b.id}`, (n) => {
        const a = n.attempts.find((x) => !x.completed);
        n.providerCalls += 1;
        // A provider that accepted the request produced a seller-visible send.
        if (b.possibility !== POSSIBILITY.DEFINITELY_NOT_SENT) n.sellerVisibleSends += 1;
        a.sid = b.sid;
        a.outcome = b.possibility === POSSIBILITY.DEFINITELY_NOT_SENT ? OUTCOME.UNKNOWN : OUTCOME.ACCEPTED;
        a.completed = true;
        a.behaviour = b.id;
        a.authorityAtCall = n.terminal === false && n.runtime && n.compliance;
        a.calledProvider = true;
        n.possibility = b.possibility;
        n.retry = b.retry;
        if (b.possibility === POSSIBILITY.DEFINITELY_NOT_SENT) n.retry = RETRY.ALLOWED;
        // queue the provider's callbacks as not-yet-delivered
        for (const st of b.callbacks) {
          if (n.inflight.length < bounds.maxCallbacks) {
            n.inflight.push({ status: st, sid: b.cbSid || b.sid || 'SID_A', provenance: PROVENANCE.LIVE, trust: TRUST.AUTHENTICATED });
          }
        }
        n.queueStatus = b.possibility === POSSIBILITY.DEFINITELY_NOT_SENT ? 'queued' : 'sent';
      });
    }
  }

  // 4. a callback arrives (any in-flight one may arrive next: models reordering)
  s.inflight.forEach((cb, idx) => {
    out.push(...deliverCallback(s, cb, idx, bounds));
  });

  // 4b. WE poll the provider for status. This is our question and their answer,
  // never a receipt -- and it must not be able to advance canonical truth.
  if (s.attempts.some((a) => a.sid) && s.inflight.length < bounds.maxCallbacks) {
    const sid = s.attempts.find((a) => a.sid).sid;
    for (const st of ['delivered', 'failed']) {
      emit(`poll_observation:${st}`, (n) => {
        n.inflight.push({ status: st, sid, provenance: PROVENANCE.POLL, trust: TRUST.UNAUTHENTICATED });
      });
    }
  }

  // 5. the provider redelivers a callback we already received (duplication)
  if (s.events.length && s.inflight.length < bounds.maxCallbacks) {
    const e = s.events[0];
    emit('provider_redelivers', (n) => {
      n.inflight.push({ status: e.status, sid: e.sid, provenance: PROVENANCE.LIVE, trust: e.trust });
    });
  }

  // 6. runtime / compliance authority changes between attempts
  if (s.authorityChanges < bounds.maxAuthorityChanges) {
    if (s.runtime) emit('brake_engaged', (n) => { n.runtime = false; n.authorityChanges += 1; });
    if (s.compliance) emit('stop_received', (n) => { n.compliance = false; n.authorityChanges += 1; n.terminal = true; });
  }

  // 7. projection lag / failure / repair. Projection is NOT authority.
  if (!s.projectionFailed) emit('projection_fails', (n) => { n.projectionFailed = true; });
  if (s.projectionFailed) emit('projection_repairs', (n) => { n.projectionFailed = false; });

  // 8. crash + restart. Everything durable survives; everything in-flight is lost.
  if (s.crashes < bounds.maxCrashes) {
    emit('crash_restart', (n) => {
      n.crashes += 1;
      // A crash cannot un-commit durable evidence. An attempt whose request was
      // started but whose outcome was never persisted is exactly the ambiguous
      // case: we cannot prove it did not send.
      const a = n.attempts.find((x) => !x.completed);
      if (a && a.started) {
        a.completed = true;
        a.outcome = OUTCOME.UNKNOWN;
        n.possibility = POSSIBILITY.MAY_HAVE_BEEN_SENT;
        n.retry = RETRY.DENIED;
      }
    });
  }

  return out;
}

/** Callback delivery + the full reconciliation seam, mirroring the real one. */
function deliverCallback(s, cb, idx, bounds) {
  const out = [];
  const n = clone(s);
  n.inflight.splice(idx, 1);

  const status = cb.status;
  const incoming = status === 'delivered' ? OUTCOME.DELIVERED
    : status === 'failed' ? OUTCOME.FAILED
      : status === 'sent' ? OUTCOME.SENT
        : OUTCOME.UNKNOWN;

  // Deterministic fingerprint from provider evidence only.
  const fp = `${cb.sid}|${status}`;
  const existing = n.events.find((e) => e.fp === fp);

  // PROVENANCE GATE, before anything is recorded.
  const m = bounds.mutation || null;
  if (m !== 'poll_may_advance' && !mayAdvance(cb.provenance)) {
    out.push({ name: `callback:${status}:provenance_refused`, next: n });
    return out;
  }

  if (!existing) {
    n.events.push({
      fp, status, sid: cb.sid, provenance: cb.provenance, trust: cb.trust,
      processing: 'pending', bound: null,
    });
  }
  const ev = n.events.find((e) => e.fp === fp);

  // CRASH POINT: evidence durably recorded, semantic application not yet run.
  // This is the exact boundary the Slice 2 stranded-callback defect lived at,
  // and without modelling it the dedupe mutation is unreachable.
  if (!existing && s.crashes < bounds.maxCrashes) {
    const crashed = clone(n);
    crashed.crashes += 1;
    // Mark the stranding so recovery is DISTINGUISHABLE from "applied, then a
    // crash happened later". Without the marker the liveness predicate is
    // satisfied by the wrong scenario and proves nothing.
    const ce = crashed.events.find((e) => e.fp === fp);
    if (ce) ce.strandedOnce = true;
    out.push({ name: `callback:${status}:crash_after_record`, next: crashed });
  }

  // DEDUPE ON PROCESSED, NOT ON RECORDED. A 'pending' row is work to resume.
  //
  // 'dedupe_on_recorded' reproduces the Slice 2 STRANDED-CALLBACK defect: a
  // crash after recording made every redelivery a permanent no-op.
  if (m === 'dedupe_on_recorded' && existing) {
    out.push({ name: `callback:${status}:duplicate_inert`, next: n });
    return out;
  }
  if (m !== 'weak_dedupe' && ev.processing !== 'pending') {
    out.push({ name: `callback:${status}:duplicate_inert`, next: n });
    return out;
  }

  // BINDING. Known SID first, then strict orphan.
  let target = n.attempts.find((a) => a.sid && a.sid === cb.sid);
  if (!target) {
    const candidates = n.attempts.filter((a) => a.started && !a.sid
      && (n.possibility === POSSIBILITY.MAY_HAVE_BEEN_SENT || n.possibility === POSSIBILITY.NONE));
    const adoptable = m === 'orphan_at_least_one'
      ? candidates.length >= 1 : candidates.length === 1;
    if (adoptable) {
      target = candidates[0];
      // Adoption binds the SID onto the existing attempt. It never creates one.
      target.sid = cb.sid;
      ev.bound = target.n;
      // Adopting when the evidence could not distinguish candidates is
      // MISATTRIBUTION: this receipt may describe a different seller message.
      // SID uniqueness cannot see it, so it is recorded explicitly.
      if (candidates.length !== 1) ev.ambiguousAdoption = true;
    } else {
      ev.processing = 'no_action';
      ev.adoption = candidates.length === 0 ? 'orphan_unmatched' : 'orphan_ambiguous';
      out.push({ name: `callback:${status}:${ev.adoption}`, next: n });
      return out;
    }
  } else {
    ev.bound = target.n;
  }

  // THE LATTICE, against the attempt's own stored outcome.
  //
  // 'no_cas' reproduces the Slice 2 DELIVERED/FAILED defect: the verdict is
  // computed against a stale read, so a contradictory terminal callback
  // overwrites a delivery the seller received.
  const action = m === 'no_cas' ? 'advance'
    : m === 'weak_stale_protection' && latticeAction(target.outcome, incoming) === 'stale' ? 'advance'
      : m === 'allow_delivered_regression' && latticeAction(target.outcome, incoming) === 'conflict' ? 'advance'
        : latticeAction(target.outcome, incoming);
  if (action !== 'advance') {
    ev.processing = 'no_action';
    ev.adoption = action;
    out.push({ name: `callback:${status}:${action}`, next: n });
    return out;
  }

  // COMMIT. A callback may raise certainty and nothing else: it never grants
  // retry authority, never allocates, never sends.
  target.outcome = incoming;
  ev.processing = 'applied';
  const poss = possibilityFor(incoming);
  if (poss) n.possibility = poss;
  n.retry = RETRY.DENIED;

  if (!n.projectionFailed) n.queueStatus = incoming === OUTCOME.DELIVERED ? 'delivered' : 'failed';

  out.push({ name: `callback:${status}:applied`, next: n });
  return out;
}

// ── safety invariants ─────────────────────────────────────────────────────

export const INVARIANTS = [
  {
    id: 'S1_SINGLE_SELLER_VISIBLE_SEND',
    why: 'the whole point: one logical communication may reach the seller at most once',
    check: (s) => s.sellerVisibleSends <= 1,
  },
  {
    id: 'S2_REQUEST_STARTED_BEFORE_NETWORK',
    why: 'a provider call with no durable request-start record is unattributable',
    check: (s) => s.attempts.filter((a) => a.calledProvider).every((a) => a.started),
  },
  {
    id: 'S3_AMBIGUITY_ABSORBS_RETRY',
    why: 'may_have_been_sent must never carry retry authority',
    check: (s) => !(s.possibility === POSSIBILITY.MAY_HAVE_BEEN_SENT
      && (s.retry === RETRY.ALLOWED || s.retry === RETRY.AFTER)),
  },
  {
    id: 'S4_PROVIDER_ACCEPTED_ABSORBS_RETRY',
    why: 'the provider took it; retrying would duplicate',
    check: (s) => !(s.possibility === POSSIBILITY.PROVIDER_ACCEPTED
      && (s.retry === RETRY.ALLOWED || s.retry === RETRY.AFTER)),
  },
  {
    id: 'S5_NO_ACTIVE_SIBLING_PAIR',
    why: 'two live attempts on one logical communication is the duplicate-send bug',
    check: (s) => s.attempts.filter((a) => !a.completed).length <= 1,
  },
  {
    id: 'S6_SID_SINGLE_BIND',
    why: 'one provider SID may describe at most one attempt',
    check: (s) => {
      const sids = s.attempts.map((a) => a.sid).filter(Boolean);
      return new Set(sids).size === sids.length;
    },
  },
  {
    id: 'S7_DELIVERED_NEVER_REGRESSES',
    why: 'a late failed must not erase a delivery the seller received',
    check: (s) => !s.deliveredSeen || s.attempts.some((a) => a.outcome === OUTCOME.DELIVERED),
  },
  {
    id: 'S8_FAILED_IS_NOT_DEFINITELY_NOT_SENT',
    why: 'every provider callback describes a message the provider already accepted',
    check: (s) => !(s.attempts.some((a) => a.outcome === OUTCOME.FAILED)
      && s.possibility === POSSIBILITY.DEFINITELY_NOT_SENT),
  },
  {
    id: 'S9_CALLBACK_NEVER_SENDS',
    why: 'provider invocations may only come from allocation, never from reconciliation',
    check: (s) => s.providerCalls === s.attempts.filter((a) => a.calledProvider).length,
  },
  {
    id: 'S10_CALLBACK_NEVER_CREATES_ATTEMPT',
    why: 'a callback increases certainty about existing work; it is not work itself',
    check: (s) => s.events.every((e) => e.bound === null
      || s.attempts.some((a) => a.n === e.bound)),
  },
  {
    id: 'S11_APPLIED_IMPLIES_BOUND',
    why: 'an applied callback with no referent is a claim about nothing',
    check: (s) => s.events.every((e) => e.processing !== 'applied' || e.bound !== null),
  },
  {
    id: 'S12_PROJECTION_IS_NOT_AUTHORITY',
    why: 'a failed or lagging projection must never reopen send authority',
    check: (s) => !(s.projectionFailed && (s.retry === RETRY.ALLOWED)
      && s.possibility === POSSIBILITY.PROVIDER_ACCEPTED),
  },
  {
    id: 'S13_NO_PROVIDER_CALL_WITHOUT_AUTHORITY',
    why: 'transport eligibility never substitutes for runtime/compliance authority; '
      + 'every provider invocation must have held authority at the moment of the call',
    check: (s) => s.attempts.filter((a) => a.calledProvider)
      .every((a) => a.authorityAtCall === true),
  },
  {
    id: 'S15_NO_AMBIGUOUS_ORPHAN_ADOPTION',
    why: 'adopting when candidates could not be distinguished credits a receipt '
      + 'to a seller communication it may not describe',
    check: (s) => s.events.every((e) => e.ambiguousAdoption !== true),
  },
  {
    id: 'S16_ONLY_CANONICAL_PROVENANCE_APPLIES',
    why: 'a poll answer is our question, not the provider pushing us a receipt; '
      + 'it may inform operators but must never advance canonical truth',
    check: (s) => s.events.every((e) => e.processing !== 'applied' || mayAdvance(e.provenance)),
  },
  {
    id: 'S14_ABANDONED_ATTEMPT_SENT_NOTHING',
    why: 'an attempt abandoned because authority was withdrawn must not count as a send',
    check: (s) => {
      const abandoned = s.attempts.filter((a) => a.abandoned).length;
      return s.sellerVisibleSends <= s.attempts.length - abandoned;
    },
  },
];

// ── bounded exhaustive search ─────────────────────────────────────────────

export function search(bounds) {
  const start = initialState();
  const visited = new Map(); // key -> {state, parent, action, depth}
  const queue = [{ state: start, parentKey: null, action: 'INIT', depth: 0 }];
  visited.set(key(start), { state: start, parentKey: null, action: 'INIT', depth: 0 });

  const stats = { states: 0, transitions: 0, maxDepth: 0, pruned: 0 };
  const violations = [];

  while (queue.length) {
    const node = queue.shift();
    const s = node.state;
    stats.states += 1;
    stats.maxDepth = Math.max(stats.maxDepth, node.depth);

    // track delivered-seen as a monotone shadow for the regression invariant
    if (s.attempts.some((a) => a.outcome === OUTCOME.DELIVERED)) s.deliveredSeen = true;

    for (const inv of INVARIANTS) {
      if (!inv.check(s)) {
        violations.push({ invariant: inv.id, why: inv.why, trace: traceTo(visited, key(s)) });
        // BFS explores in order of increasing depth, so the FIRST violation
        // found is already a minimal-length counterexample. For mutation runs we
        // only need existence, so stopping here is not a shortcut -- continuing
        // would just re-derive the same defect from longer traces.
        if (bounds.stopOnFirstViolation) {
          return { stats, violations, visitedCount: visited.size, stoppedEarly: true };
        }
      }
    }

    if (node.depth >= bounds.maxDepth) { stats.pruned += 1; continue; }

    for (const t of transitions(s, bounds)) {
      stats.transitions += 1;
      // propagate the monotone shadow
      if (s.deliveredSeen) t.next.deliveredSeen = true;
      const k = key(t.next);
      if (visited.has(k)) continue;
      const entry = { state: t.next, parentKey: key(s), action: t.name, depth: node.depth + 1 };
      visited.set(k, entry);
      queue.push(entry);
    }
  }

  return { stats, violations, visitedCount: visited.size };
}

/**
 * Reachability: does ANY reachable state satisfy `predicate`?
 *
 * Safety asks "is a bad state reachable". Liveness here asks the dual: "is a
 * GOOD state still reachable". A defect that strands progress produces no
 * unsafe state at all -- it removes the good state from the reachable set, and
 * only this direction can see that.
 */
export function reachable(bounds, predicate) {
  const start = initialState();
  const visited = new Map();
  const queue = [{ state: start, parentKey: null, action: 'INIT', depth: 0 }];
  visited.set(key(start), queue[0]);
  let explored = 0;
  while (queue.length) {
    const node = queue.shift();
    explored += 1;
    if (predicate(node.state)) {
      return { found: true, explored, trace: traceTo(visited, key(node.state)) };
    }
    if (node.depth >= bounds.maxDepth) continue;
    for (const t of transitions(node.state, bounds)) {
      const k = key(t.next);
      if (visited.has(k)) continue;
      const e = { state: t.next, parentKey: key(node.state), action: t.name, depth: node.depth + 1 };
      visited.set(k, e);
      queue.push(e);
    }
  }
  return { found: false, explored, trace: null };
}

/** Minimal reproducing trace: walk parent pointers back to INIT. */
export function traceTo(visited, k) {
  const steps = [];
  let cur = k;
  const guard = new Set();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const e = visited.get(cur);
    if (!e) break;
    steps.unshift(e.action);
    cur = e.parentKey;
  }
  return steps;
}

export default { search, transitions, INVARIANTS, initialState, key, mayAllocateAttempt, latticeAction };
