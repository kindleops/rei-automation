/* Minimal tslib shim for Supabase bundles that import __awaiter and __rest. */

export function __rest(source: Record<string, unknown>, excluded: Array<string | symbol>) {
  const target: Record<string, unknown> = {}
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key) && excluded.indexOf(key) < 0) {
      target[key] = source[key]
    }
  }

  if (source != null && typeof Object.getOwnPropertySymbols === 'function') {
    for (const symbol of Object.getOwnPropertySymbols(source)) {
      if (
        excluded.indexOf(symbol) < 0 &&
        Object.prototype.propertyIsEnumerable.call(source, symbol)
      ) {
        target[symbol as unknown as string] = (source as Record<string, unknown>)[
          symbol as unknown as string
        ]
      }
    }
  }

  return target
}

export function __awaiter<T>(
  thisArg: unknown,
  args: unknown,
  P: PromiseConstructor,
  generator: (...innerArgs: unknown[]) => Generator<unknown, T, unknown>,
): Promise<T> {
  function adopt(value: unknown): Promise<unknown> {
    return value instanceof P ? value : new P((resolve) => resolve(value))
  }

  return new (P || Promise)(
    (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: unknown) => void,
    ) => {
      const generatorInstance = generator.apply(thisArg, (args as unknown[]) ?? [])

      function fulfilled(value: unknown): void {
        try {
          step(generatorInstance.next(value))
        } catch (error) {
          reject(error)
        }
      }

      function rejected(value: unknown): void {
        try {
          step(generatorInstance.throw?.(value) as IteratorResult<unknown, T>)
        } catch (error) {
          reject(error)
        }
      }

      function step(result: IteratorResult<unknown, T>): void {
        if (result.done) {
          resolve(result.value)
          return
        }
        adopt(result.value).then(fulfilled, rejected)
      }

      step(generatorInstance.next())
    },
  )
}

/*
 * __assign / __spreadArray — required by the Experience System's overlay engine
 * (react-remove-scroll, use-sidecar under Radix Dialog/Popover/Select). Same
 * semantics as tslib's own helpers.
 */
export const __assign: <T extends object>(target: T, ...sources: object[]) => T = Object.assign

export function __spreadArray<T>(to: T[], from: ArrayLike<T>, pack?: boolean): T[] {
  let ar: T[] | undefined
  if (pack || arguments.length === 2) {
    for (let i = 0, l = from.length; i < l; i += 1) {
      if (ar || !(i in from)) {
        if (!ar) ar = Array.prototype.slice.call(from, 0, i) as T[]
        ar[i] = from[i]
      }
    }
  }
  return to.concat(ar || (Array.prototype.slice.call(from) as T[]))
}
