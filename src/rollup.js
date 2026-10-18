// rollup.js — the dashboard's numbers, kept up to date as events arrive.
//
// The dashboard used to compute everything from the raw `events` table on
// every load: ~20 queries, each scanning every event of the period and the
// whole sessions table. Against Turso, which bills every row a query reads,
// that burned a month of quota in a day (2026-10-18) and, once the table grew,
// ran the database out of memory — taking the collect endpoint down with it.
//
// So the counting moved to write time. recordBatch folds each batch into small
// tables (below), and the dashboard reads those: hundreds of rows a load, not
// millions. The raw `events` table is still written, untouched, for ad-hoc SQL.
//
//   daily_counts   (game, metric, day, key) → n, sum   event names, builds,
//                  upgrades, economy (sum = crystals)
//   daily_uniques  (game, metric, day, key, player)    who started a level /
//                  wave, built, upgraded, hit a milestone — for distinct counts
//   level_names    (game, level) → name
//   t_boots / t_boot_fails / t_perf / t_errors          one compact row per
//                  telemetry event; the GPU resolved at write time from the
//                  session's boot (t_boots), so no read joins events
//
// Local dev sessions are never rolled up (the dashboard always hid them).
// `aggregate` is the single definition of what counts, shared by live writes
// and by the one-off backfill of history (scripts/backfill-rollups.js).

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS daily_counts (
     game_id TEXT NOT NULL, metric TEXT NOT NULL, day TEXT NOT NULL, key TEXT NOT NULL,
     n INTEGER NOT NULL DEFAULT 0, sum REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (game_id, metric, day, key))`,
  `CREATE TABLE IF NOT EXISTS daily_uniques (
     game_id TEXT NOT NULL, metric TEXT NOT NULL, day TEXT NOT NULL, key TEXT NOT NULL,
     player_id TEXT NOT NULL,
     PRIMARY KEY (game_id, metric, day, key, player_id))`,
  `CREATE TABLE IF NOT EXISTS level_names (
     game_id TEXT NOT NULL, level INTEGER NOT NULL, name TEXT,
     PRIMARY KEY (game_id, level))`,
  `CREATE TABLE IF NOT EXISTS t_boots (
     id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, session_id TEXT NOT NULL,
     created_at INTEGER NOT NULL, gpu TEXT NOT NULL, ms INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_t_boots_time ON t_boots(game_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_t_boots_session ON t_boots(session_id)`,
  `CREATE TABLE IF NOT EXISTS t_boot_fails (
     id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, created_at INTEGER NOT NULL,
     reason TEXT, os TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_t_boot_fails_time ON t_boot_fails(game_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS t_perf (
     id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, session_id TEXT NOT NULL,
     created_at INTEGER NOT NULL, gpu TEXT NOT NULL,
     fps5 REAL, tps REAL, bugs INTEGER, stalls REAL, secs REAL)`,
  `CREATE INDEX IF NOT EXISTS idx_t_perf_time ON t_perf(game_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS t_errors (
     id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, session_id TEXT NOT NULL,
     created_at INTEGER NOT NULL, gpu TEXT NOT NULL, msg TEXT, kind TEXT, at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_t_errors_time ON t_errors(game_id, created_at)`,
];

// Columns added to `sessions` (ALTER TABLE has no IF NOT EXISTS: each is tried
// and a "duplicate column" failure ignored).
export const SESSION_COLUMNS = [
  `ALTER TABLE sessions ADD COLUMN local INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sessions ADD COLUMN events INTEGER NOT NULL DEFAULT 0`,
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** A loopback referrer (a dev playtest) — the same rule the old SQL filter applied. */
export function isLocalReferrer(r) {
  if (!r) return false;
  if (LOCAL_HOSTS.has(r)) return true;
  try {
    return LOCAL_HOSTS.has(new URL(r).hostname);
  } catch {
    return false;
  }
}

export const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);

/** The GPU label of a boot's props: the WebGL model, else vendor + arch + description. */
export function gpuLabel(p) {
  const g = (p && p.gpu) || {};
  const r = typeof g.r === "string" ? g.r.trim() : "";
  if (r) return r;
  const s = [g.v, g.a, g.d].map((x) => (x == null ? "" : String(x))).join(" ").trim();
  return s || "Unknown";
}

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const int = (v) => (num(v) == null ? null : Math.trunc(Number(v)));

/** A fresh accumulator for `aggregate`. */
export function newAcc() {
  return {
    counts: new Map(), // `${game}|${metric}|${day}|${key}` → { n, sum }
    uniques: new Map(), // same key + `|${player}` → [game, metric, day, key, player]
    names: new Map(), // `${game}|${level}` → name
    boots: [],
    fails: [],
    perf: [],
    errors: [],
    sessionEvents: new Map(), // session → events counted (players table)
  };
}

function count(acc, game, metric, day, key, n = 1, sum = 0) {
  const k = `${game}|${metric}|${day}|${key}`;
  const c = acc.counts.get(k) || { game, metric, day, key, n: 0, sum: 0 };
  c.n += n;
  c.sum += sum;
  acc.counts.set(k, c);
}
function unique(acc, game, metric, day, key, player) {
  acc.uniques.set(`${game}|${metric}|${day}|${key}|${player}`, [game, metric, day, key, player]);
}

/**
 * Fold events into `acc`. Each event: { game, session, player, name, props, t }.
 * `gpuOf(session)` answers the GPU of a session whose boot is not among these
 * events (live: a lookup; backfill: a map it keeps). Boots seen here are added
 * to `gpus` (a Map) so later events in the same fold resolve without a lookup.
 */
export function aggregate(acc, events, gpus) {
  for (const e of events) {
    if (e.name === "heartbeat") continue;
    const day = dayOf(e.t);
    const p = e.props || {};
    if (e.name !== "session_start") {
      count(acc, e.game, "event", day, e.name);
      acc.sessionEvents.set(e.session, (acc.sessionEvents.get(e.session) || 0) + 1);
    }
    switch (e.name) {
      case "level_start": {
        const lv = int(p.level);
        if (lv == null) break;
        unique(acc, e.game, "level", day, String(lv), e.player);
        if (p.name != null) acc.names.set(`${e.game}|${lv}`, [e.game, lv, String(p.name)]);
        break;
      }
      case "wave_start": {
        const lv = int(p.level),
          w = int(p.wave);
        if (lv == null || w == null) break;
        unique(acc, e.game, "wave", day, `${lv}:${w}`, e.player);
        break;
      }
      case "build":
      case "upgrade": {
        const key = String((e.name === "build" ? p.type : p.id) ?? "unknown");
        count(acc, e.game, e.name, day, key);
        unique(acc, e.game, e.name, day, key, e.player);
        break;
      }
      case "currency_milestone": {
        const m = int(p.min);
        if (m == null) break;
        const c = num(p.crystals);
        count(acc, e.game, "econ", day, String(m), c == null ? 0 : 1, c == null ? 0 : c);
        unique(acc, e.game, "econ", day, String(m), e.player);
        break;
      }
      case "boot": {
        const gpu = gpuLabel(p);
        gpus.set(e.session, gpu);
        acc.boots.push([e.game, e.session, e.t, gpu, int(p.ms)]);
        break;
      }
      case "boot_fail":
        acc.fails.push([e.game, e.t, p.reason ?? null, p.os ?? null]);
        break;
      case "perf":
        if (p.phase !== "wave") break;
        acc.perf.push([
          e.game,
          e.session,
          e.t,
          { session: e.session },
          num(p.fps5),
          num(p.tps),
          int(p.bugs),
          num(p.stalls),
          num(p.secs),
        ]);
        break;
      case "error":
        acc.errors.push([
          e.game,
          e.session,
          e.t,
          { session: e.session },
          p.msg ?? null,
          p.kind ?? null,
          p.at ?? null,
        ]);
        break;
    }
  }
}

/**
 * The write statements for an accumulator. `gpus` resolves sessions whose GPU
 * placeholder ({ session }) is still open; unresolved ones become 'Unknown'.
 * `sessionCounts`: whether to bump sessions.events (backfill does it too).
 */
export function statements(acc, gpus) {
  const gpu = (ph) => gpus.get(ph.session) || "Unknown";
  const out = [];
  for (const c of acc.counts.values())
    out.push({
      sql: `INSERT INTO daily_counts (game_id, metric, day, key, n, sum) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (game_id, metric, day, key) DO UPDATE SET n = n + excluded.n, sum = sum + excluded.sum`,
      args: [c.game, c.metric, c.day, c.key, c.n, c.sum],
    });
  for (const u of acc.uniques.values())
    out.push({
      sql: `INSERT OR IGNORE INTO daily_uniques (game_id, metric, day, key, player_id) VALUES (?, ?, ?, ?, ?)`,
      args: u,
    });
  for (const n of acc.names.values())
    out.push({
      sql: `INSERT INTO level_names (game_id, level, name) VALUES (?, ?, ?)
            ON CONFLICT (game_id, level) DO UPDATE SET name = MAX(name, excluded.name)`,
      args: n,
    });
  for (const b of acc.boots)
    out.push({
      sql: `INSERT INTO t_boots (game_id, session_id, created_at, gpu, ms) VALUES (?, ?, ?, ?, ?)`,
      args: b,
    });
  for (const f of acc.fails)
    out.push({
      sql: `INSERT INTO t_boot_fails (game_id, created_at, reason, os) VALUES (?, ?, ?, ?)`,
      args: f,
    });
  for (const [g, s, t, ph, ...rest] of acc.perf)
    out.push({
      sql: `INSERT INTO t_perf (game_id, session_id, created_at, gpu, fps5, tps, bugs, stalls, secs)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [g, s, t, gpu(ph), ...rest],
    });
  for (const [g, s, t, ph, ...rest] of acc.errors)
    out.push({
      sql: `INSERT INTO t_errors (game_id, session_id, created_at, gpu, msg, kind, at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [g, s, t, gpu(ph), ...rest],
    });
  return out;
}

/** Sessions whose GPU placeholders are still open after a fold (need a lookup). */
export function openSessions(acc, gpus) {
  const s = new Set();
  for (const r of [...acc.perf, ...acc.errors]) if (!gpus.has(r[3].session)) s.add(r[3].session);
  return [...s];
}
