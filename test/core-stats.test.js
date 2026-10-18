// Every number the dashboard shows from events, pinned on a small seeded game
// (2026-10-18). Written against the scan-everything queries before they moved
// to the rollup tables, so the move has to keep every one of them.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let db;
const GAME = "coretest";
import { seed } from "./seed.js";

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ga-core-"));
  delete process.env.TURSO_DATABASE_URL;
  db = await import("../src/db.js");
  await seed(db, GAME);
});

const stats = () => db.gameStats(GAME, 30);

test("totals and top events", async () => {
  const s = await stats();
  assert.equal(s.totals.players, 2);
  assert.equal(s.totals.sessions, 3);
  // Everything but session_start and heartbeats: 7 + 3 + 7 + 1.
  assert.equal(s.totals.events, 18);
  // Ties have no defined order: compare as a map.
  assert.deepEqual(Object.fromEntries(s.top_events.map((e) => [e.label, e.n])), {
    build: 4,
    level_start: 4,
    wave_start: 4,
    upgrade: 3,
    currency_milestone: 2,
    rush: 1,
  });
});

test("breakdowns from sessions", async () => {
  const s = await stats();
  const by = (rows) => Object.fromEntries(rows.map((r) => [r.label, r.n]));
  assert.deepEqual(by(s.browsers), { Chrome: 2, Firefox: 1 });
  assert.deepEqual(by(s.os), { Windows: 2, macOS: 1 });
  assert.equal(s.daily.length, 1);
  assert.equal(s.daily[0].sessions, 3);
  assert.equal(s.daily[0].players, 2);
});

test("progression funnel: unique players per level and wave", async () => {
  const p = (await stats()).progression;
  assert.deepEqual(p.levels, [
    { level: 1, name: "Tomb", players: 2 },
    { level: 2, name: "Deadend", players: 1 },
  ]);
  assert.deepEqual(p.waves, [
    { level: 1, wave: 1, players: 2 },
    { level: 1, wave: 2, players: 1 },
    { level: 2, wave: 1, players: 1 },
  ]);
});

test("builds, upgrades, economy", async () => {
  const s = await stats();
  assert.deepEqual(s.builds, [
    { label: "gun", n: 3, players: 2 },
    { label: "cannon", n: 1, players: 1 },
  ]);
  assert.deepEqual(s.upgrades, [
    { label: "gun_dmg", n: 2, players: 2 },
    { label: "gun_rate", n: 1, players: 1 },
  ]);
  assert.deepEqual(s.economy, [{ min: 5, avg_crystals: 200, players: 2 }]);
});

test("players table: sessions and event counts per player", async () => {
  const r = await db.playerRows(GAME, 30, { sort: "player_id", dir: "asc" });
  assert.equal(r.total, 2);
  assert.deepEqual(
    r.rows.map((x) => [x.player_id, x.sessions, x.events]),
    [
      ["pA", 2, 10],
      ["pB", 1, 8],
    ]
  );
});

test("the game list counts real players and sessions only", async () => {
  const g = (await db.listGames()).find((x) => x.id === GAME);
  assert.equal(g.sessions, 3);
  assert.equal(g.players, 2);
});

test("deleting a game removes its rollups too", async () => {
  const { seedTelemetry } = await import("./seed.js");
  await seed(db, "gone");
  await seedTelemetry(db, "gone");
  await db.deleteGame("gone");
  for (const t of ["daily_counts", "daily_uniques", "level_names", "t_boots", "t_boot_fails", "t_perf", "t_errors"]) {
    const r = await db.db.execute({ sql: `SELECT COUNT(*) FROM ${t} WHERE game_id = ?`, args: ["gone"] });
    assert.equal(Number(r.rows[0][0]), 0, t);
  }
  // The other game's numbers are untouched.
  assert.equal((await stats()).totals.events, 18);
});
