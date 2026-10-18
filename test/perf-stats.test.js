// The "Performance & stability" reports (gameStats().perf), against a
// throwaway local database: boot / boot_fail / perf / error events as the
// game sends them, seeded through recordBatch — the same path /api/collect
// takes.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let db;
const GAME = "perftest";
const REAL = { referrer: "https://itch.io" };

const gpu2060 = { v: "nvidia", a: "turing", d: "", r: "NVIDIA GeForce RTX 2060" };
// An older client: no WebGL model, so the label falls back to vendor + arch.
const gpuOld = { v: "nvidia", a: "turing", d: "" };
const gpuMac = { v: "apple", a: "metal-3", d: "" };
const ev = (name, props) => ({ name, props });

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ga-test-"));
  delete process.env.TURSO_DATABASE_URL;
  db = await import("../src/db.js");
  await db.createGame("Perf test", GAME);
  await db.recordBatch(GAME, "sA", "pA", REAL, [
    ev("session_start"),
    ev("boot", { ms: 1000, gpu: gpu2060, os: "win" }),
    ev("perf", { phase: "wave", fps5: 30, tps: 20, bugs: 900, stalls: 60, secs: 10 }),
    ev("perf", { phase: "wave", fps5: 50, tps: 30, bugs: 300, stalls: 0, secs: 10 }),
    ev("perf", { phase: "build", fps5: 5, tps: 30, bugs: 0 }), // not a wave
    ev("error", { kind: "error", msg: "boom", at: "draw (game.js:1:1)" }),
  ]);
  await db.recordBatch(GAME, "sB", "pB", REAL, [
    ev("boot", { ms: 2000, gpu: gpu2060, os: "win" }),
    ev("perf", { phase: "wave", fps5: 40, tps: 29, bugs: 100, stalls: 30, secs: 10 }),
    ev("error", { kind: "error", msg: "boom", at: "draw (game.js:1:1)" }),
    ev("error", { kind: "rejection", msg: "other", at: "" }),
    ev("error_flood", { dropped: 3 }),
  ]);
  await db.recordBatch(GAME, "sC", "pC", REAL, [
    ev("boot", { ms: 3000, gpu: gpuMac, os: "mac" }),
    ev("perf", { phase: "wave", fps5: 60, tps: 30, bugs: 50 }),
    ev("gpu_lost", { reason: "unknown", msg: "", t: 40 }),
  ]);
  await db.recordBatch(GAME, "sF", "pF", REAL, [
    ev("boot", { ms: 1500, gpu: gpuOld, os: "win" }),
    ev("perf", { phase: "wave", fps5: 70, tps: 30, bugs: 10 }),
  ]);
  await db.recordBatch(GAME, "sD", "pD", REAL, [
    ev("boot_fail", { reason: "navigator.gpu is unavailable in this browser", os: "win" }),
  ]);
  // A local dev playtest: hidden from every report.
  await db.recordBatch(GAME, "sE", "pE", { referrer: "localhost" }, [
    ev("boot", { ms: 99000, gpu: gpu2060, os: "win" }),
    ev("perf", { phase: "wave", fps5: 1, tps: 1, bugs: 5000 }),
    ev("error", { kind: "error", msg: "local only", at: "" }),
  ]);
});

const perf = async () => (await db.gameStats(GAME, 30)).perf;

test("totals: boots, failed boots, median boot time, sessions with errors", async () => {
  const t = (await perf()).totals;
  assert.equal(t.boots, 4);
  assert.equal(t.boot_fails, 1);
  assert.equal(t.median_boot_ms, 1500);
  assert.equal(t.error_sessions, 2);
  assert.equal(t.floods, 1);
  assert.equal(t.gpu_lost, 1);
});

test("by GPU: waves joined to the session's boot GPU, medians and slow share", async () => {
  const rows = (await perf()).by_gpu;
  assert.equal(rows.length, 3);
  const [nv, mac, old] = [rows[0], rows.find((r) => r.gpu.startsWith("apple")), rows.find((r) => r.gpu === "nvidia turing")];
  assert.equal(nv.gpu, "NVIDIA GeForce RTX 2060"); // the WebGL model wins
  assert.equal(nv.tps_med, 29); // median of 20, 30, 29
  // Ticks that waited a frame for the GPU, over all ticks the waves ran:
  // (60 + 0 + 30) / (20*10 + 30*10 + 29*10) = 90 / 790.
  assert.equal(nv.stall_share, Math.round((90 / 790) * 1000) / 1000);
  assert.equal(nv.stalls_avg, undefined); // the raw per-wave count is gone
  assert.equal(old.waves, 1); // no model: vendor + architecture
  assert.equal(nv.sessions, 2);
  assert.equal(nv.waves, 3);
  assert.equal(nv.fps5_med, 40);
  assert.equal(nv.bugs_med, 300);
  assert.equal(nv.slow, 1); // tps 20 < 27
  assert.equal(mac.gpu, "apple metal-3");
  assert.equal(mac.waves, 1);
  assert.equal(mac.slow, 0);
});

test("by bug count: buckets of 250", async () => {
  const rows = (await perf()).by_bugs;
  assert.deepEqual(
    rows.map((r) => [r.bucket, r.waves, r.fps5_med, r.slow]),
    [
      [0, 3, 60, 0],
      [1, 1, 50, 0],
      [3, 1, 30, 1],
    ]
  );
});

test("top errors: count, sessions, the GPU it hits most", async () => {
  const rows = (await perf()).errors;
  assert.equal(rows[0].msg, "boom");
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].sessions, 2);
  assert.equal(rows[0].top_gpu, "NVIDIA GeForce RTX 2060");
  assert.equal(rows[0].at, "draw (game.js:1:1)");
  assert.ok(rows[0].last_seen > 0);
  assert.equal(rows[1].msg, "other");
  assert.equal(rows[1].kind, "rejection");
  assert.ok(!rows.some((r) => r.msg === "local only"));
});

test("boot failures by reason and OS; boot time histogram", async () => {
  const p = await perf();
  assert.equal(p.boot_times.max_bucket, 15);
  assert.deepEqual(p.boot_fail_reasons, [{ label: "navigator.gpu is unavailable in this browser", n: 1 }]);
  assert.deepEqual(p.boot_fail_os, [{ label: "win", n: 1 }]);
  assert.deepEqual(
    p.boot_times.buckets.map((b) => [b.bucket, b.n]),
    [
      [1, 2],
      [2, 1],
      [3, 1],
    ]
  );
});
