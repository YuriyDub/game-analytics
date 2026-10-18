// The dashboard's reads are cached (2026-10-18): every stats load scanned the
// whole events and sessions tables ~20 times over, and the free Turso quota
// (500M rows read a month) ran out in a day of looking at the dashboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memo } from "../src/cache.js";

test("memo answers repeats from the cache until the TTL runs out", async () => {
  let calls = 0;
  let now = 1000;
  const f = memo(async (a, b) => (calls++, `${a}:${b}`), { ttlMs: 600_000, now: () => now });
  assert.equal(await f("g", 30), "g:30");
  assert.equal(await f("g", 30), "g:30");
  assert.equal(calls, 1);
  assert.equal(await f("g", 7), "g:7"); // other arguments: their own entry
  assert.equal(calls, 2);
  now += 600_001;
  assert.equal(await f("g", 30), "g:30"); // expired: read again
  assert.equal(calls, 3);
});

test("concurrent first calls share one read", async () => {
  let calls = 0;
  const f = memo(async () => (calls++, new Promise((r) => setTimeout(() => r(1), 20))));
  await Promise.all([f("x"), f("x"), f("x")]);
  assert.equal(calls, 1);
});

test("a failed read is not cached", async () => {
  let calls = 0;
  const f = memo(async () => {
    calls++;
    if (calls === 1) throw new Error("db down");
    return "ok";
  });
  await assert.rejects(f("k"));
  assert.equal(await f("k"), "ok");
  assert.equal(calls, 2);
});
