const withTimeout = (promiseFn, ms, timeoutErrorString) => {
  const controller = new AbortController();
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutErrorString));
    }, ms);
  });
  
  const safePromise = promiseFn(controller.signal).catch(err => {
    if (err.name === 'AbortError' || err.message?.includes('AbortError')) {
      return null;
    }
    throw err;
  });

  return Promise.race([
    safePromise,
    timeoutPromise
  ]).finally(() => {
    clearTimeout(timeoutId);
  });
};

async function run() {
  const start = Date.now();
  try {
    const p = (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('AbortError')));
      setTimeout(resolve, 5000);
    });
    await withTimeout(p, 1000, 'timeout');
  } catch (e) {
    console.log("Caught:", e.message);
  }
  console.log("Time:", Date.now() - start);
}
run();
