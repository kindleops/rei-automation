/**
 * Bounded waiting for IC8's fail-open and fail-closed paths.
 *
 * settleWithin(factory, ms) never rejects: it resolves { value } | { error } |
 * { timedOut: true }. A synchronous throw from the factory is caught. A hung
 * promise is abandoned (its eventual rejection is swallowed). Its timer is a
 * normal one (cleared on settle): whoever awaits the bound must see it fire.
 * Background schedulers that must never keep a process alive use
 * unrefTimeout instead.
 */

export function settleWithin(promiseFactory, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), Math.max(0, Number(timeoutMs) || 0));
    let pending;
    try {
      pending = Promise.resolve(promiseFactory());
    } catch (error) {
      finish({ error });
      return;
    }
    pending.then(
      (value) => finish({ value }),
      (error) => finish({ error }),
    );
  });
}

/** An unref'd timeout: it never keeps the event loop (or a webhook process) alive. */
export function unrefTimeout(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
