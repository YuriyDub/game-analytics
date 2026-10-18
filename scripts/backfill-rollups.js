// Fold the events written before live rollups into the rollup tables, once.
//
//   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… node scripts/backfill-rollups.js
//
// Reads every historical event once (Turso bills those rows). Safe to stop and
// run again: it resumes where it got to, and does nothing once finished.
// Importing src/db.js also creates the rollup tables and sets the boundary.
const { db } = await import("../src/db.js");
const { backfill } = await import("../src/backfill.js");
const r = await backfill(db, { pageSize: 5000, log: (m) => console.log(m) });
console.log(`done: ${r.events} events in ${r.pages} pages (history up to event id ${r.until})`);
