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

// Local dev playtests are hidden from every read below (the data stays in the
// database). A session is local when its referrer is a loopback host — gg.js
// falls back to location.hostname when document.referrer is empty, so a game
// served from localhost reads as 'localhost'. Events have no referrer of their
// own and are filtered through their session.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
const ref = "COALESCE(referrer, '')";
const IS_LOCAL = `(${[
  `${ref} IN (${LOCAL_HOSTS.flatMap((h) => [h, `http://${h}`, `https://${h}`]).map((v) => `'${v}'`).join(", ")})`,
  ...LOCAL_HOSTS.flatMap((h) =>
    ["http", "https"].flatMap((proto) => [`${ref} LIKE '${proto}://${h}:%'`, `${ref} LIKE '${proto}://${h}/%'`])
  ),
].join(" OR ")})`;
const REAL_SESSION = `NOT ${IS_LOCAL}`;
const REAL_EVENT = `session_id NOT IN (SELECT id FROM sessions WHERE ${IS_LOCAL})`;

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
            (SELECT COUNT(*) FROM sessions s WHERE s.game_id = g.id AND ${REAL_SESSION}) AS sessions,
            (SELECT COUNT(DISTINCT player_id) FROM sessions s WHERE s.game_id = g.id AND ${REAL_SESSION}) AS players
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
       WHERE game_id = ? AND started_at >= ? AND ${REAL_SESSION}`,
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
         WHERE game_id = ? AND created_at >= ? AND ${REAL_EVENT} AND name NOT IN ('session_start')
         GROUP BY player_id
       ) e ON e.player_id = s.player_id
       WHERE s.game_id = ? AND s.started_at >= ? AND ${REAL_SESSION}
       GROUP BY s.player_id
       ORDER BY ${col} ${dir}, s.player_id ASC
       LIMIT ? OFFSET ?`,
      [gameId, since, gameId, since, limit, offset]
    ),
  ]);

  return { total: countRow.n, offset, limit, rows };
}

// ---------- performance & stability ----------
// Reads the telemetry convention a game can opt into (Swarmbreaker does):
//   boot      {ms, gpu:{v,a,d}, os, ...}  once per page load that got in
//   boot_fail {reason, os, ...}           a page load that never got in
//   perf      {phase, fps5, tps, bugs, ...} one per wave (phase 'wave')
//   error     {kind, msg, at, ...}        each distinct error once a session
//   error_flood, gpu_lost
// Only `boot` names the GPU, so perf and errors are tied to it through their
// session. Games that send none of these get empty results and the dashboard
// hides the section.
//
// Medians are taken in SQL (window functions) rather than by pulling rows into
// Node: against Turso every row read is billed. "Median" is the lower middle
// element, so an even count never needs averaging.
const SLOW_TPS = 27; // physics ticks/s below this = the game runs in slow motion
const BOOT_BUCKET_MAX = 15; // boot time histogram: 1 s buckets, 15+ in the last

// The GPU label of every session that booted, as a CTE: the card's model when
// the client sent one (gpu.r, from WebGL — "NVIDIA GeForce RTX 2060"), else
// WebGPU's vendor + architecture + description ("nvidia turing"), which is all
// Chrome's adapter info gives and older clients sent.
const GPU_LABEL = `COALESCE(NULLIF(TRIM(json_extract(props, '$.gpu.r')), ''),
                    TRIM(COALESCE(json_extract(props, '$.gpu.v'), '') || ' ' ||
                         COALESCE(json_extract(props, '$.gpu.a'), '') || ' ' ||
                         COALESCE(json_extract(props, '$.gpu.d'), '')))`;
const bootGpus = (where) => `boots AS (
    SELECT session_id, MAX(${GPU_LABEL}) AS gpu FROM events
    WHERE ${where} AND name = 'boot' GROUP BY session_id)`;
// Wave perf rows with their session's GPU.
const wavePerf = (where) => `${bootGpus(where)},
  pe AS (SELECT session_id, props FROM events
         WHERE ${where} AND name = 'perf' AND json_extract(props, '$.phase') = 'wave'),
  waves AS (
    SELECT COALESCE(NULLIF(b.gpu, ''), 'Unknown') AS gpu, pe.session_id,
           CAST(json_extract(pe.props, '$.fps5') AS REAL) AS fps5,
           CAST(json_extract(pe.props, '$.tps') AS REAL) AS tps,
           CAST(json_extract(pe.props, '$.bugs') AS INTEGER) AS bugs,
           CAST(json_extract(pe.props, '$.stalls') AS REAL) AS stalls,
           CAST(json_extract(pe.props, '$.secs') AS REAL) AS secs
    FROM pe LEFT JOIN boots b ON b.session_id = pe.session_id)`;

async function perfStats(gameId, since) {
  const where = `game_id = ? AND created_at >= ? AND ${REAL_EVENT}`;
  const args = [gameId, since];
  const count = (name) =>
    get(`SELECT COUNT(*) AS n FROM events WHERE ${where} AND name = '${name}'`, args);
  const [
    boots,
    bootFails,
    medBoot,
    errSessions,
    floods,
    gpuLost,
    byGpu,
    byBugs,
    errors,
    failReasons,
    failOs,
    bootTimes,
  ] = await Promise.all([
    count("boot"),
    count("boot_fail"),
    get(
      `WITH t AS (
         SELECT CAST(json_extract(props, '$.ms') AS INTEGER) AS ms,
                ROW_NUMBER() OVER (ORDER BY CAST(json_extract(props, '$.ms') AS INTEGER)) AS rn,
                COUNT(*) OVER () AS cnt
         FROM events WHERE ${where} AND name = 'boot')
       SELECT ms FROM t WHERE rn = (cnt + 1) / 2`,
      args
    ),
    get(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE ${where} AND name = 'error'`, args),
    count("error_flood"),
    count("gpu_lost"),
    all(
      `WITH ${wavePerf(where)},
       r AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY gpu ORDER BY fps5) AS rf,
                   ROW_NUMBER() OVER (PARTITION BY gpu ORDER BY bugs) AS rb,
                   ROW_NUMBER() OVER (PARTITION BY gpu ORDER BY tps) AS rt,
                   COUNT(*) OVER (PARTITION BY gpu) AS cnt
         FROM waves)
       SELECT gpu, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS waves,
              MAX(CASE WHEN rf = (cnt + 1) / 2 THEN fps5 END) AS fps5_med,
              MAX(CASE WHEN rb = (cnt + 1) / 2 THEN bugs END) AS bugs_med,
              MAX(CASE WHEN rt = (cnt + 1) / 2 THEN tps END) AS tps_med,
              -- The share of physics ticks that had to wait a frame for the GPU's
              -- readback: stalls over the ticks the waves ran (tps × secs). A
              -- raw count per wave meant nothing — it grows with wave length and
              -- the monitor's refresh rate, and a wait costs no game time as long
              -- as tps holds. Read it beside tps: high share AND low tps = the GPU
              -- is not keeping up with the physics.
              ROUND(SUM(CASE WHEN tps > 0 AND secs > 0 THEN stalls END) * 1.0 /
                    NULLIF(SUM(CASE WHEN tps > 0 AND secs > 0 THEN tps * secs END), 0), 3) AS stall_share,
              SUM(CASE WHEN tps IS NOT NULL AND tps < ${SLOW_TPS} THEN 1 ELSE 0 END) AS slow
       FROM r GROUP BY gpu ORDER BY sessions DESC, waves DESC LIMIT 15`,
      [...args, ...args]
    ),
    all(
      `WITH ${wavePerf(where)},
       r AS (
         SELECT bugs / 250 AS bucket, fps5, tps,
                ROW_NUMBER() OVER (PARTITION BY bugs / 250 ORDER BY fps5) AS rf,
                COUNT(*) OVER (PARTITION BY bugs / 250) AS cnt
         FROM waves WHERE bugs IS NOT NULL)
       SELECT bucket, COUNT(*) AS waves,
              MAX(CASE WHEN rf = (cnt + 1) / 2 THEN fps5 END) AS fps5_med,
              SUM(CASE WHEN tps IS NOT NULL AND tps < ${SLOW_TPS} THEN 1 ELSE 0 END) AS slow
       FROM r GROUP BY bucket ORDER BY bucket`,
      [...args, ...args]
    ),
    all(
      `WITH ${bootGpus(where)},
       e AS (
         SELECT json_extract(props, '$.msg') AS msg, json_extract(props, '$.kind') AS kind,
                json_extract(props, '$.at') AS at, session_id, created_at
         FROM events WHERE ${where} AND name = 'error'),
       g AS (
         SELECT e.msg, COALESCE(NULLIF(b.gpu, ''), 'Unknown') AS gpu, COUNT(*) AS n,
                ROW_NUMBER() OVER (PARTITION BY e.msg ORDER BY COUNT(*) DESC) AS rk
         FROM e LEFT JOIN boots b ON b.session_id = e.session_id GROUP BY e.msg, gpu)
       SELECT e.msg, MAX(e.kind) AS kind, MAX(e.at) AS at, COUNT(*) AS n,
              COUNT(DISTINCT e.session_id) AS sessions, MAX(e.created_at) AS last_seen,
              (SELECT gpu FROM g WHERE g.msg = e.msg AND rk = 1) AS top_gpu
       FROM e GROUP BY e.msg ORDER BY n DESC, sessions DESC LIMIT 20`,
      [...args, ...args]
    ),
    all(
      `SELECT COALESCE(json_extract(props, '$.reason'), 'Unknown') AS label, COUNT(*) AS n
       FROM events WHERE ${where} AND name = 'boot_fail' GROUP BY label ORDER BY n DESC LIMIT 10`,
      args
    ),
    all(
      `SELECT COALESCE(json_extract(props, '$.os'), 'Unknown') AS label, COUNT(*) AS n
       FROM events WHERE ${where} AND name = 'boot_fail' GROUP BY label ORDER BY n DESC LIMIT 8`,
      args
    ),
    all(
      `SELECT MIN(CAST(json_extract(props, '$.ms') AS INTEGER) / 1000, ${BOOT_BUCKET_MAX}) AS bucket,
              COUNT(*) AS n
       FROM events WHERE ${where} AND name = 'boot' AND json_extract(props, '$.ms') IS NOT NULL
       GROUP BY bucket ORDER BY bucket`,
      args
    ),
  ]);
  return {
    totals: {
      boots: boots.n,
      boot_fails: bootFails.n,
      median_boot_ms: medBoot?.ms ?? null,
      error_sessions: errSessions.n,
      floods: floods.n,
      gpu_lost: gpuLost.n,
    },
    slow_tps: SLOW_TPS,
    by_gpu: byGpu,
    by_bugs: byBugs,
    errors,
    boot_fail_reasons: failReasons,
    boot_fail_os: failOs,
    boot_times: { max_bucket: BOOT_BUCKET_MAX, buckets: bootTimes },
  };
}

export async function gameStats(gameId, days = 30) {
  const since = now() - days * 86400;

  const breakdown = (col) =>
    all(
      `SELECT COALESCE(${col}, 'Unknown') AS label, COUNT(*) AS n
       FROM sessions WHERE game_id = ? AND started_at >= ? AND ${REAL_SESSION}
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
    perf,
  ] = await Promise.all([
    get(
      `SELECT COUNT(*) AS sessions,
              COUNT(DISTINCT player_id) AS players,
              COALESCE(SUM(last_seen - started_at), 0) AS playtime_s
       FROM sessions WHERE game_id = ? AND started_at >= ? AND ${REAL_SESSION}`,
      [gameId, since]
    ),
    get(
      `SELECT COUNT(*) AS n FROM events
       WHERE game_id = ? AND created_at >= ? AND ${REAL_EVENT} AND name NOT IN ('session_start')`,
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
       WHERE game_id = ? AND started_at >= ? AND ${REAL_SESSION}
         AND (last_seen - started_at) BETWEEN 60 AND ${MEDIAN_CAP_S}
       ORDER BY d LIMIT 1
       OFFSET (SELECT COUNT(*) FROM sessions
               WHERE game_id = ? AND started_at >= ? AND ${REAL_SESSION}
                 AND (last_seen - started_at) BETWEEN 60 AND ${MEDIAN_CAP_S}) / 2`,
      [gameId, since, gameId, since]
    ),
    all(
      `SELECT date(started_at, 'unixepoch') AS day,
              COUNT(*) AS sessions,
              COUNT(DISTINCT player_id) AS players
       FROM sessions WHERE game_id = ? AND started_at >= ? AND ${REAL_SESSION}
       GROUP BY day ORDER BY day`,
      [gameId, since]
    ),
    breakdown("browser"),
    breakdown("os"),
    breakdown("referrer"),
    all(
      `SELECT name AS label, COUNT(*) AS n FROM events
       WHERE game_id = ? AND created_at >= ? AND ${REAL_EVENT} AND name NOT IN ('session_start')
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
       WHERE game_id = ? AND created_at >= ? AND ${REAL_EVENT} AND name = 'level_start'
         AND json_extract(props, '$.level') IS NOT NULL
       GROUP BY level ORDER BY level`,
      [gameId, since]
    ),
    all(
      `SELECT CAST(json_extract(props, '$.level') AS INTEGER) AS level,
              CAST(json_extract(props, '$.wave') AS INTEGER) AS wave,
              COUNT(DISTINCT player_id) AS players
       FROM events
       WHERE game_id = ? AND created_at >= ? AND ${REAL_EVENT} AND name = 'wave_start'
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
       WHERE game_id = ? AND created_at >= ? AND ${REAL_EVENT} AND name = 'build'
       GROUP BY label ORDER BY n DESC LIMIT 12`,
      [gameId, since]
    ),
    // Upgrade popularity: purchases per tech node, from 'upgrade' events.
    all(
      `SELECT COALESCE(json_extract(props, '$.id'), 'unknown') AS label,
              COUNT(*) AS n,
              COUNT(DISTINCT player_id) AS players
       FROM events
       WHERE game_id = ? AND created_at >= ? AND ${REAL_EVENT} AND name = 'upgrade'
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
       WHERE game_id = ? AND created_at >= ? AND ${REAL_EVENT} AND name = 'currency_milestone'
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
         FROM sessions WHERE game_id = ? AND started_at >= ? AND ${REAL_SESSION}
         GROUP BY player_id
       ) GROUP BY bucket ORDER BY bucket`,
      [gameId, since]
    ),
    all(
      `SELECT player_id, started_at, (last_seen - started_at) AS duration_s,
              referrer, browser, os
       FROM sessions WHERE game_id = ? AND ${REAL_SESSION}
       ORDER BY started_at DESC LIMIT 25`,
      [gameId]
    ),
    perfStats(gameId, since),
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
    perf,
  };
}
