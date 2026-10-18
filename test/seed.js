// A small seeded game shared by the stats tests: two players over three
// sessions, the funnel / build / upgrade / economy events, a telemetry slice
// (boot, perf, error), and a local dev session that must count for nothing.
export const REAL = { referrer: "https://itch.io", browser: "Chrome", os: "Windows" };
const ev = (name, props) => ({ name, props });

export async function seed(d, game) {
  await d.createGame("Core test", game);
  // Player A: two sessions.
  await d.recordBatch(game, "a1", "pA", REAL, [
    ev("session_start"),
    ev("level_start", { level: 1, name: "Tomb" }),
    ev("wave_start", { level: 1, wave: 1 }),
    ev("wave_start", { level: 1, wave: 2 }),
    ev("build", { type: "gun" }),
    ev("build", { type: "gun" }),
    ev("upgrade", { id: "gun_dmg" }),
    ev("currency_milestone", { min: 5, crystals: 100 }),
  ]);
  await d.recordBatch(game, "a2", "pA", { ...REAL, browser: "Firefox" }, [
    ev("session_start"),
    ev("level_start", { level: 2, name: "Deadend" }),
    ev("wave_start", { level: 2, wave: 1 }),
    ev("build", { type: "cannon" }),
  ]);
  // Player B: one session, the same level again.
  await d.recordBatch(game, "b1", "pB", { ...REAL, os: "macOS" }, [
    ev("session_start"),
    ev("level_start", { level: 1, name: "Tomb" }),
    ev("wave_start", { level: 1, wave: 1 }),
    ev("build", { type: "gun" }),
    ev("upgrade", { id: "gun_dmg" }),
    ev("upgrade", { id: "gun_rate" }),
    ev("currency_milestone", { min: 5, crystals: 300 }),
    ev("level_start", { level: null }), // editor playtest: no level
  ]);
  // A second batch in a session already open: heartbeats do not count.
  await d.recordBatch(game, "b1", "pB", REAL, [ev("heartbeat"), ev("rush", { wave: 3 })]);
  // A local dev playtest: out of every number.
  await d.recordBatch(game, "l1", "pL", { referrer: "localhost" }, [
    ev("session_start"),
    ev("level_start", { level: 1, name: "Tomb" }),
    ev("build", { type: "gun" }),
  ]);
}

// Telemetry on top: a boot, two waves and an error, plus a later batch whose
// perf has to find the GPU from the earlier boot.
export async function seedTelemetry(d, game) {
  const gpu = { v: "nvidia", a: "turing", d: "", r: "NVIDIA GeForce RTX 2060" };
  await d.recordBatch(game, "t1", "pT", REAL, [
    ev("boot", { ms: 2100, gpu, os: "win" }),
    ev("perf", { phase: "wave", fps5: 40, tps: 25, bugs: 600, stalls: 30, secs: 10 }),
  ]);
  await d.recordBatch(game, "t1", "pT", REAL, [
    ev("perf", { phase: "wave", fps5: 50, tps: 30, bugs: 300, stalls: 0, secs: 10 }),
    ev("error", { kind: "error", msg: "boom", at: "draw (game.js:1:1)" }),
    ev("boot_fail", { reason: "no webgpu", os: "win" }),
  ]);
}
