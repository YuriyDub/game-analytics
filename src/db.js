import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "analytics.db"));
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
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
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_game_time ON sessions(game_id, started_at);

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    player_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    props      TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_game_time ON events(game_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_game_name ON events(game_id, name);
`);

const now = () => Math.floor(Date.now() / 1000);

export function createGame(name) {
  const id = randomBytes(6).toString("base64url");
  db.prepare("INSERT INTO games (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now());
  return getGame(id);
}

export function getGame(id) {
  return db.prepare("SELECT * FROM games WHERE id = ?").get(id);
}

export function listGames() {
  return db
    .prepare(
      `SELECT g.*,
              (SELECT COUNT(*) FROM sessions s WHERE s.game_id = g.id) AS sessions,
              (SELECT COUNT(DISTINCT player_id) FROM sessions s WHERE s.game_id = g.id) AS players
       FROM games g ORDER BY g.created_at DESC`
    )
    .all();
}

export function deleteGame(id) {
  db.prepare("DELETE FROM games WHERE id = ?").run(id);
}

const upsertSession = db.prepare(`
  INSERT INTO sessions (id, game_id, player_id, started_at, last_seen, referrer, browser, os, screen, lang)
  VALUES (@id, @game_id, @player_id, @now, @now, @referrer, @browser, @os, @screen, @lang)
  ON CONFLICT(id) DO UPDATE SET last_seen = @now
  WHERE sessions.game_id = @game_id
`);

const insertEvent = db.prepare(`
  INSERT INTO events (game_id, session_id, player_id, name, props, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export const recordBatch = db.transaction((gameId, sessionId, playerId, meta, events) => {
  upsertSession.run({
    id: sessionId,
    game_id: gameId,
    player_id: playerId,
    now: now(),
    referrer: meta.referrer || null,
    browser: meta.browser || null,
    os: meta.os || null,
    screen: meta.screen || null,
    lang: meta.lang || null,
  });
  for (const ev of events) {
    if (ev.name === "heartbeat") continue; // heartbeats only refresh last_seen
    insertEvent.run(
      gameId,
      sessionId,
      playerId,
      ev.name,
      ev.props ? JSON.stringify(ev.props) : null,
      now()
    );
  }
});

export function gameStats(gameId, days = 30) {
  const since = now() - days * 86400;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              COUNT(DISTINCT player_id) AS players,
              COALESCE(SUM(last_seen - started_at), 0) AS playtime_s
       FROM sessions WHERE game_id = ? AND started_at >= ?`
    )
    .get(gameId, since);

  const eventCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE game_id = ? AND created_at >= ? AND name NOT IN ('session_start')`
    )
    .get(gameId, since).n;

  const medianPlaytime =
    db
      .prepare(
        `SELECT (last_seen - started_at) AS d FROM sessions
         WHERE game_id = ? AND started_at >= ?
         ORDER BY d LIMIT 1
         OFFSET (SELECT COUNT(*) FROM sessions WHERE game_id = ? AND started_at >= ?) / 2`
      )
      .get(gameId, since, gameId, since)?.d ?? 0;

  const daily = db
    .prepare(
      `SELECT date(started_at, 'unixepoch') AS day,
              COUNT(*) AS sessions,
              COUNT(DISTINCT player_id) AS players
       FROM sessions WHERE game_id = ? AND started_at >= ?
       GROUP BY day ORDER BY day`
    )
    .all(gameId, since);

  const breakdown = (col) =>
    db
      .prepare(
        `SELECT COALESCE(${col}, 'Unknown') AS label, COUNT(*) AS n
         FROM sessions WHERE game_id = ? AND started_at >= ?
         GROUP BY label ORDER BY n DESC LIMIT 8`
      )
      .all(gameId, since);

  const topEvents = db
    .prepare(
      `SELECT name AS label, COUNT(*) AS n FROM events
       WHERE game_id = ? AND created_at >= ? AND name NOT IN ('session_start')
       GROUP BY name ORDER BY n DESC LIMIT 10`
    )
    .all(gameId, since);

  const recentSessions = db
    .prepare(
      `SELECT player_id, started_at, (last_seen - started_at) AS duration_s,
              referrer, browser, os
       FROM sessions WHERE game_id = ?
       ORDER BY started_at DESC LIMIT 25`
    )
    .all(gameId);

  return {
    totals: { ...totals, events: eventCount, median_playtime_s: medianPlaytime },
    daily,
    browsers: breakdown("browser"),
    os: breakdown("os"),
    referrers: breakdown("referrer"),
    top_events: topEvents,
    recent_sessions: recentSessions,
  };
}
