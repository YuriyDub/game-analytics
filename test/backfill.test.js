// The one-off backfill of history into the rollup tables
// (scripts/backfill-rollups.js): events written before live rollups existed
// must produce exactly the numbers live rollups would have.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seed, seedTelemetry } from "./seed.js";

let d, backfill;
const GAME = "bftest";
const ROLLUPS = ["daily_counts", "daily_uniques", "level_names", "t_boots", "t_boot_fails", "t_perf", "t_errors"];

// Turn the seeded database into "history": rollups gone, session counters
// zeroed, and the live boundary moved to the newest event.
async function forget() {
  for (const t of ROLLUPS) await d.db.execute(`DELETE FROM ${t}`);
  await d.db.execute("UPDATE sessions SET events = 0");
  await d.db.execute("DELETE FROM meta WHERE key IN ('rollup_from_id', 'backfill_done_id')");
  await d.db.execute(
    "INSERT INTO meta (key, value) SELECT 'rollup_from_id', COALESCE(MAX(id), 0) FROM events"
  );
}
const snapshot = async () => ({
  stats: await d.gameStats(GAME, 30),
  players: await d.playerRows(GAME, 30, { sort: "player_id", dir: "asc" }),
});
const strip = (x) => {
  // recent_sessions carry wall-clock times only; the rest must match exactly.
  const { stats, players } = x;
  return { ...stats, recent_sessions: stats.recent_sessions.length, players };
};

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ga-bf-"));
  delete process.env.TURSO_DATABASE_URL;
  d = await import("../src/db.js");
  ({ backfill } = await import("../src/backfill.js"));
  await seed(d, GAME);
  await seedTelemetry(d, GAME);
});

test("a backfill of history matches what live rollups recorded", async () => {
  const live = await snapshot();
  await forget();
  const empty = await snapshot();
  assert.equal(empty.stats.totals.events, 0); // really forgotten
  const r = await backfill(d.db, { pageSize: 4 }); // small pages: several rounds
  assert.ok(r.pages > 3);
  assert.deepEqual(strip(await snapshot()), strip(live));
});

test("running it again adds nothing", async () => {
  const before = strip(await snapshot());
  const r = await backfill(d.db, { pageSize: 4 });
  assert.equal(r.events, 0);
  assert.deepEqual(strip(await snapshot()), before);
});

test("events after the boundary are left to live rollups", async () => {
  const before = (await d.gameStats(GAME, 30)).totals.events;
  await d.recordBatch(GAME, "z1", "pZ", { referrer: "https://itch.io" }, [{ name: "rush" }]);
  const r = await backfill(d.db, { pageSize: 4 });
  assert.equal(r.events, 0);
  assert.equal((await d.gameStats(GAME, 30)).totals.events, before + 1);
});
