// A small in-process cache for the dashboard's reads.
//
// Every stats load runs ~20 queries, and each one scans the game's events and
// the sessions table (the local-session filter). Against Turso every row read
// is billed: reloading the dashboard — or, before 2026-10-18, merely resizing
// its window — burned through the free tier's 500M rows a month in a day.
// Stats a few minutes old are fine for a dashboard; the query bill is not.
//
// Keyed by the arguments. Concurrent first calls share one read, and a failed
// read is dropped so the next call tries again.
export function memo(fn, { ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    const hit = cache.get(key);
    if (hit && now() - hit.t < ttlMs) return hit.p;
    const p = Promise.resolve()
      .then(() => fn(...args))
      .catch((e) => {
        if (cache.get(key)?.p === p) cache.delete(key);
        throw e;
      });
    cache.set(key, { t: now(), p });
    return p;
  };
}
