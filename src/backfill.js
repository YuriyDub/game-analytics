// The one-off backfill of history into the rollup tables (src/rollup.js).
//
// Live rollups start at `meta.rollup_from_id` — the newest event id when the
// tables were created. Everything up to it is history, folded in here through
// the same `aggregate` the live path uses, so both count alike.
//
// Page by page in id order, each page one write batch that also records how far
// it got (`meta.backfill_done_id`): an interrupted run resumes where it stopped,
// and a finished one does nothing when run again. Reads every historical event
// once — run it by hand (scripts/backfill-rollups.js), not on the server.
import { aggregate, newAcc, openSessions, statements } from "./rollup.js";

const metaGet = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM meta WHERE key = ?", args: [key] })).rows[0]?.[0];

export async function backfill(db, { pageSize = 5000, log = () => {} } = {}) {
  const until = Number((await metaGet(db, "rollup_from_id")) ?? 0);
  let done = Number((await metaGet(db, "backfill_done_id")) ?? 0);
  const local = new Set(
    (await db.execute("SELECT id FROM sessions WHERE local = 1")).rows.map((r) => r[0])
  );
  const gpus = new Map(); // session → GPU, from boots folded so far
  let pages = 0,
    events = 0;
  while (done < until) {
    const rs = await db.execute({
      sql: `SELECT id, game_id, session_id, player_id, name, props, created_at FROM events
            WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`,
      args: [done, until, pageSize],
    });
    if (!rs.rows.length) break;
    const rows = rs.rows.map((r) => ({
      id: Number(r[0]),
      game: r[1],
      session: r[2],
      player: r[3],
      name: r[4],
      props: r[5] ? safeJson(r[5]) : null,
      t: Number(r[6]),
    }));
    const acc = newAcc();
    aggregate(
      acc,
      rows.filter((e) => !local.has(e.session)),
      gpus
    );
    // A boot from a page before this run (a resumed backfill) is in t_boots.
    for (const sid of openSessions(acc, gpus)) {
      const b = await db.execute({
        sql: "SELECT gpu FROM t_boots WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        args: [sid],
      });
      if (b.rows.length) gpus.set(sid, b.rows[0][0]);
    }
    const last = rows[rows.length - 1].id;
    const stmts = statements(acc, gpus);
    for (const [sid, n] of acc.sessionEvents)
      stmts.push({ sql: "UPDATE sessions SET events = events + ? WHERE id = ?", args: [n, sid] });
    stmts.push({
      sql: `INSERT INTO meta (key, value) VALUES ('backfill_done_id', ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      args: [String(last)],
    });
    await db.batch(stmts, "write");
    done = last;
    pages++;
    events += rows.length;
    log(`page ${pages}: events up to id ${done} of ${until}`);
  }
  return { pages, events, until };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
