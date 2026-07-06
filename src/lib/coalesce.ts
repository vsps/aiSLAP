// Wraps an async function so concurrent callers share one in-flight call
// instead of firing duplicate requests, with at most one trailing re-run
// queued for callers that arrive while a call is already in progress.
export function coalesceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  let trailing: Promise<T> | null = null;

  const run = (): Promise<T> => {
    const p = fn().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    return p;
  };

  return function coalesced(): Promise<T> {
    if (!inFlight) {
      inFlight = run();
      return inFlight;
    }
    if (!trailing) {
      trailing = inFlight
        .catch(() => undefined)
        .then(() => {
          trailing = null;
          return run();
        });
    }
    return trailing;
  };
}
