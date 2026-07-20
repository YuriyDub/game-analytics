import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) points at a hosted Turso database —
// use that on hosts with ephemeral disks (e.g. Render's free tier), where a
// local SQLite file is wiped on every restart. Unset, it falls back to a local
// file so dev needs no account and no env vars.
let url = process.env.TURSO_DATABASE_URL;
if (!url) {
  const DATA_DIR = process.env.DATA_DIR || "./data";
  fs.mkdirSync(DATA_DIR, { recursive: true });
  url = "file:" + path.join(DATA_DIR, "analytics.db");
}

export const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

// Normalize driver rows to plain objects keyed by column name — the client's
// Row shape isn't guaranteed to JSON.stringify cleanly across versions.
async function all(sql, args = []) {
  const rs = await db.execute({ sql, args });
  return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
}
const get = async (sql, args = []) => (await all(sql, args))[0];

await db.batch(
  [
    `CREATE TABLE IF NOT EXISTS games (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS sessions (
       id          TEXT PRIMARY KEY,
       game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
       player_id   TEXT NOT NULL,
       started_at  INTEGER NOT NULL,
       last_seen   INTEGER NOT NULL,
       referrer    TEXT,
       browser     TEXT,
       os          TEXT,
       screen      TEXT,
       lang        TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_game_time ON sessions(game_id, started_at)`,
    `CREATE TABLE IF NOT EXISTS events (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
       session_id TEXT NOT NULL,
       player_id  TEXT NOT NULL,
       name       TEXT NOT NULL,
       props      TEXT,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_events_game_time ON events(game_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_events_game_name ON events(game_id, name)`,
  ],
  "write"
);

const now = () => Math.floor(Date.now() / 1000);

// id is optional so a game can be re-created with a known id (e.g. after
// moving databases) — shipped clients keep reporting without a rebuild.
export async function createGame(name, id) {
  id = id || randomBytes(6).toString("base64url");
  await db.execute({
    sql: "INSERT INTO games (id, name, created_at) VALUES (?, ?, ?)",
    args: [id, name, now()],
  });
  return getGame(id);
}

export function getGame(id) {
  return get("SELECT * FROM games WHERE id = ?", [id]);
}

export function listGames() {
  return all(
    `SELECT g.*,
            (SELECT COUNT(*) FROM sessions s WHERE s.game_id = g.id) AS sessions,
            (SELECT COUNT(DISTINCT player_id) FROM sessions s WHERE s.game_id = g.id) AS players
     FROM games g ORDER BY g.created_at DESC`
  );
}

// Explicit deletes: SQLite only honours ON DELETE CASCADE with the
// foreign_keys pragma on, which isn't guaranteed on every connection.
export async function deleteGame(id) {
  await db.batch(
    [
      { sql: "DELETE FROM events WHERE game_id = ?", args: [id] },
      { sql: "DELETE FROM sessions WHERE game_id = ?", args: [id] },
      { sql: "DELETE FROM games WHERE id = ?", args: [id] },
    ],
    "write"
  );
}

export async function recordBatch(gameId, sessionId, playerId, meta, events) {
  const t = now();
  const stmts = [
    {
      sql: `INSERT INTO sessions (id, game_id, player_id, started_at, last_seen, referrer, browser, os, screen, lang)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen
            WHERE sessions.game_id = excluded.game_id`,
      args: [
        sessionId,
        gameId,
        playerId,
        t,
        t,
        meta.referrer || null,
        meta.browser || null,
        meta.os || null,
        meta.screen || null,
        meta.lang || null,
      ],
    },
  ];
  for (const ev of events) {
    if (ev.name === "heartbeat") continue; // heartbeats only refresh last_seen
    stmts.push({
      sql: `INSERT INTO events (game_id, session_id, player_id, name, props, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [gameId, sessionId, playerId, ev.name, ev.props ? JSON.stringify(ev.props) : null, t],
    });
  }
  await db.batch(stmts, "write");
}

// Sessions longer than this are treated as idle-tab outliers and left out of
// the median playtime tile. Only the median uses it — the playtime histogram
// and the players table still show these sessions.
const MEDIAN_CAP_S = 2 * 3600;

// Last bucket of the playtime histogram (20 → "200+ min"); the dashboard
// derives its labels from the bucket index, so both ends must agree.
const BUCKET_MAX = 20;

// Per-player table. Sorting and paging both happen in SQL so the order is over
// every player in the period, not just the rows on the current page.
const PLAYER_SORTS = {
  player_id: "s.player_id",
  sessions: "sessions",
  playtime_s: "playtime_s",
  events: "events",
  first_seen: "first_seen",
  last_seen: "last_seen",
};

export async function playerRows(gameId, days = 30, opts = {}) {
  const since = now() - days * 86400;
  const col = PLAYER_SORTS[opts.sort] || PLAYER_SORTS.last_seen;
  const dir = opts.dir === "asc" ? "ASC" : "DESC";
  const limit = Math.min(100, Math.max(1, opts.limit || 25));
  const offset = Math.max(0, opts.offset || 0);

  const [countRow, rows] = await Promise.all([
    get(
      `SELECT COUNT(DISTINCT player_id) AS n FROM sessions
       WHERE game_id = ? AND started_at >= ?`,
      [gameId, since]
    ),
    // The events join is grouped by player, so it stays 1:1 with each player
    // group and can't inflate the session COUNT(*).
    all(
      `SELECT s.player_id,
              COUNT(*) AS sessions,
              SUM(s.last_seen - s.started_at) AS playtime_s,
              MIN(s.started_at) AS first_seen,
              MAX(s.last_seen) AS last_seen,
              COALESCE(e.n, 0) AS events
       FROM sessions s
       LEFT JOIN (
         SELECT player_id, COUNT(*) AS n FROM events
         WHERE game_id = ? AND created_at >= ? AND name NOT IN ('session_start')
         GROUP BY player_id
       ) e ON e.player_id = s.player_id
       WHERE s.game_id = ? AND s.started_at >= ?
       GROUP BY s.player_id
       ORDER BY ${col} ${dir}, s.player_id ASC
       LIMIT ? OFFSET ?`,
      [gameId, since, gameId, since, limit, offset]
    ),
  ]);

  return { total: countRow.n, offset, limit, rows };
}

export async function gameStats(gameId, days = 30) {
  const since = now() - days * 86400;

  const breakdown = (col) =>
    all(
      `SELECT COALESCE(${col}, 'Unknown') AS label, COUNT(*) AS n
       FROM sessions WHERE game_id = ? AND started_at >= ?
       GROUP BY label ORDER BY n DESC LIMIT 8`,
      [gameId, since]
    );

  // Independent queries — run in parallel; against a remote Turso database
  // each one is a network round-trip.
  const [
    totals,
    eventCount,
    medianRow,
    daily,
    browsers,
    os,
    referrers,
    topEvents,
    levelFunnel,
    waveFunnel,
    builds,
    upgrades,
    economy,
    playtime,
    recentSessions,
  ] = await Promise.all([
    get(
      `SELECT COUNT(*) AS sessions,
              COUNT(DISTINCT player_id) AS players,
              COALESCE(SUM(last_seen - started_at), 0) AS playtime_s
       FROM sessions WHERE game_id = ? AND started_at >= ?`,
      [gameId, since]
    ),
    get(
      `SELECT COUNT(*) AS n FROM events
       WHERE game_id = ? AND created_at >= ? AND name NOT IN ('session_start')`,
      [gameId, since]
    ),
    // Median playtime over engaged sessions only: bounces (< 1 min) are
    // excluded so the tile reflects players who actually played, and sessions
    // over MEDIAN_CAP_S are dropped as outliers — playtime is measured by
    // heartbeat, so a tab left open all day reads as one enormous session.
    // The filter must stay identical in the OFFSET subquery, which counts the
    // same population the outer query orders; if they drift, the offset lands
    // on the wrong row and the "median" is silently not the median.
    get(
      `SELECT (last_seen - started_at) AS d FROM sessions
       WHERE game_id = ? AND started_at >= ?
         AND (last_seen - started_at) BETWEEN 60 AND ${MEDIAN_CAP_S}
       ORDER BY d LIMIT 1
       OFFSET (SELECT COUNT(*) FROM sessions
               WHERE game_id = ? AND started_at >= ?
                 AND (last_seen - started_at) BETWEEN 60 AND ${MEDIAN_CAP_S}) / 2`,
      [gameId, since, gameId, since]
    ),
    all(
      `SELECT date(started_at, 'unixepoch') AS day,
              COUNT(*) AS sessions,
              COUNT(DISTINCT player_id) AS players
       FROM sessions WHERE game_id = ? AND started_at >= ?
       GROUP BY day ORDER BY day`,
      [gameId, since]
    ),
    breakdown("browser"),
    breakdown("os"),
    breakdown("referrer"),
    all(
      `SELECT name AS label, COUNT(*) AS n FROM events
       WHERE game_id = ? AND created_at >= ? AND name NOT IN ('session_start')
       GROUP BY name ORDER BY n DESC LIMIT 10`,
      [gameId, since]
    ),
    // Progression funnel: unique players who started each level/wave, read from
    // the JSON props of level_start / wave_start events (a convention, not a
    // requirement — games that don't send them get empty arrays and the
    // dashboard hides the section). Events without a numeric level are skipped
    // (e.g. editor playtests send level: null).
    all(
      `SELECT CAST(json_extract(props, '$.level') AS INTEGER) AS level,
              MAX(json_extract(props, '$.name')) AS name,
              COUNT(DISTINCT player_id) AS players
       FROM events
       WHERE game_id = ? AND created_at >= ? AND name = 'level_start'
         AND json_extract(props, '$.level') IS NOT NULL
       GROUP BY level ORDER BY level`,
      [gameId, since]
    ),
    all(
      `SELECT CAST(json_extract(props, '$.level') AS INTEGER) AS level,
              CAST(json_extract(props, '$.wave') AS INTEGER) AS wave,
              COUNT(DISTINCT player_id) AS players
       FROM events
       WHERE game_id = ? AND created_at >= ? AND name = 'wave_start'
         AND json_extract(props, '$.level') IS NOT NULL
         AND json_extract(props, '$.wave') IS NOT NULL
       GROUP BY level, wave ORDER BY level, wave`,
      [gameId, since]
    ),
    // Build popularity: placements per turret/obstacle type, from the JSON
    // props of 'build' events (same opt-in convention as the funnel).
    all(
      `SELECT COALESCE(json_extract(props, '$.type'), 'unknown') AS label,
              COUNT(*) AS n,
              COUNT(DISTINCT player_id) AS players
       FROM events
       WHERE game_id = ? AND created_at >= ? AND name = 'build'
       GROUP BY label ORDER BY n DESC LIMIT 12`,
      [gameId, since]
    ),
    // Upgrade popularity: purchases per tech node, from 'upgrade' events.
    all(
      `SELECT COALESCE(json_extract(props, '$.id'), 'unknown') AS label,
              COUNT(*) AS n,
              COUNT(DISTINCT player_id) AS players
       FROM events
       WHERE game_id = ? AND created_at >= ? AND name = 'upgrade'
       GROUP BY label ORDER BY n DESC LIMIT 15`,
      [gameId, since]
    ),
    // Economy curve: average currency held at fixed playtime marks, from
    // 'currency_milestone' events ({min, crystals, ...}).
    all(
      `SELECT CAST(json_extract(props, '$.min') AS INTEGER) AS min,
              ROUND(AVG(json_extract(props, '$.crystals'))) AS avg_crystals,
              COUNT(DISTINCT player_id) AS players
       FROM events
       WHERE game_id = ? AND created_at >= ? AND name = 'currency_milestone'
         AND json_extract(props, '$.min') IS NOT NULL
       GROUP BY min ORDER BY min`,
      [gameId, since]
    ),
    // Playtime histogram: players bucketed by their TOTAL time played across
    // all sessions in the period, in 10-minute buckets. Everything past
    // BUCKET_MAX lands in the final overflow bucket.
    all(
      `SELECT bucket, COUNT(*) AS players FROM (
         SELECT MIN(SUM(last_seen - started_at) / 600, ${BUCKET_MAX}) AS bucket
         FROM sessions WHERE game_id = ? AND started_at >= ?
         GROUP BY player_id
       ) GROUP BY bucket ORDER BY bucket`,
      [gameId, since]
    ),
    all(
      `SELECT player_id, started_at, (last_seen - started_at) AS duration_s,
              referrer, browser, os
       FROM sessions WHERE game_id = ?
       ORDER BY started_at DESC LIMIT 25`,
      [gameId]
    ),
  ]);

  return {
    totals: { ...totals, events: eventCount.n, median_playtime_s: medianRow?.d ?? 0 },
    daily,
    browsers,
    os,
    referrers,
    top_events: topEvents,
    progression: { levels: levelFunnel, waves: waveFunnel },
    builds,
    upgrades,
    economy,
    playtime: { bucket_minutes: 10, max_bucket: BUCKET_MAX, buckets: playtime },
    recent_sessions: recentSessions,
  };
}
