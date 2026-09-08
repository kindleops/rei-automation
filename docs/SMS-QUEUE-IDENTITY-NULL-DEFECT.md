# Defect — `resolveQueueRowIdentity` threw on a null queue row

**Found:** during EMAIL-3 pre-flight.
**Fixed:** commit `d2e28e0`.
**Regression test:** `apps/api/tests/critical/queue-row-identity-null-regression.test.mjs`.

Documented separately from the EMAIL-3 work because it is an **SMS** defect. It
was repaired first because EMAIL-3 rests entirely on cross-channel identity
being correct, and it would have been dishonest to build on a resolver that
could throw.

---

## The defect

```js
export function resolveQueueRowIdentity(queue_row = {}) {
  const md = readMetadata(queue_row);
  …
```

A default parameter is applied only when the argument is `undefined`. It does
nothing for `null`. So `resolveQueueRowIdentity(null)` reached `readMetadata`
with `null`, read a property off it, and threw a `TypeError`.

## Why it mattered more than a `TypeError` usually does

This function sits on the SMS send path and answers *which action a queue row
schedules*. Its whole contract is to return a **readable refusal** for a row it
cannot name — that is what stops an unnameable row being evaluated as though it
were sendable.

A `TypeError` escaping instead is not a louder version of that refusal. It is a
**different kind of failure**, and a caller that catches it cannot tell it apart
from a transport error — which is precisely the reading that justifies a
**retry**. A null row that throws could therefore become a duplicate send rather
than a refusal.

## The fix

```js
export function resolveQueueRowIdentity(input) {
  const queue_row = input && typeof input === 'object' ? input : {};
  const md = readMetadata(queue_row);
```

Deliberately narrow. It does not change any refusal reason, any anchor rule, or
any fail-closed behaviour: a null row now produces the same refusal an empty row
already did. The regression test proves the throw first, then proves the
refusal, and separately asserts that no hostile shape produces `ok: true`.

## The wider finding

This turned out to be the sixth instance of the same defect in this codebase,
and a subsequent sweep found **eleven more** live entry points in the email
domain — including `buildLogicalCommunicationKey`, on the canonical send seam.

Every one had been written by someone who knew about the trap, in a file that
already worked around it elsewhere. Knowing is evidently not enough. It is now
covered as a class rather than as instances:

* `apps/api/src/lib/hostile-input.js` — the shared `asObject` guard
* `apps/api/tests/critical/email-hostile-input-contract.test.mjs` — every public
  entry point called with thirteen hostile shapes, asserting none throws, none
  returns `undefined`, and none reports success

Arrays are excluded from the guard on purpose: `[].anything` is `undefined`
rather than a throw, so an array would otherwise slide through as "an object
with no fields" and be reported as missing data when the real fault is a caller
passing a list.
