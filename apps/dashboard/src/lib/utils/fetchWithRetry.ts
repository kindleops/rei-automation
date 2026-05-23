export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  { retries = 3, delay = 1000 }: { retries?: number, delay?: number } = {}
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i))); // Exponential backoff
      }
    }
  }
  throw lastError;
}
